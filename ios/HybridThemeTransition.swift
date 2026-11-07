import Foundation
import NitroModules
import QuartzCore
import UIKit

/**
 * Native theme-change transition for iOS.
 *
 * ── Why it is built this way ──
 * A Unistyles theme change is a whole-app style re-evaluation plus a shadow-tree
 * commit, synchronous on the JS thread. It cannot be animated frame by frame.
 * So the theme swap stays exactly as it is, and the ANIMATION is applied to a
 * copy of the screen instead.
 *
 * The copy is a `UIView.snapshotView(afterScreenUpdates:)`, which is backed by a
 * render-server-side copy — no bitmap is ever read back to the CPU, encoded, or
 * decoded. Earlier attempts at this effect all round-tripped full-screen pixels
 * through JavaScript, and that latency is what made them feel laggy.
 *
 * Every animation here is UIKit/Core Animation. Once submitted they are
 * interpolated by the render server, so a busy (or blocked) JS thread cannot
 * drop a frame of them.
 *
 * ── What is captured, and where the copies live ──
 * The capture is a snapshot of the app's WHOLE WINDOW, and the copies are hosted
 * in a separate window one level above it:
 *
 *     overlay window (ours)
 *       ├─ snapshot A   ← oldest change, TOP-most, animating away to reveal B
 *       └─ snapshot B   ← next change, animating away to reveal the live app
 *     app window
 *       ├─ presentation container   ← a Modal, a sheet, an alert
 *       └─ rootViewController.view  ← live app, already on the newest theme
 *
 * Both halves of that arrangement are load-bearing.
 *
 * Capturing the WINDOW rather than `rootViewController.view` is what makes
 * modals work. A presented view controller is not inside the root view — UIKit
 * hosts it in a container of its own, whose exact shape is a private detail that
 * has changed across releases. The one thing guaranteed is that if it is on
 * screen in this window, it is in this window's layer tree, so a window-level
 * snapshot cannot miss it. Copying only the root view produced a picture with
 * the modal cut out of it, pinned on top of the live modal — the modal vanished
 * for the length of the animation and reappeared, already re-themed, at the end.
 *
 * Hosting the copies OUTSIDE that window is what keeps the whole-window capture
 * honest: a snapshot must contain the app *without* the other snapshots, or each
 * capture would bake in a frozen copy of the animations still running above it.
 * It also settles z-order for good — UIKit appends a presentation's container to
 * the app window as it is presented, which would otherwise put a modal opened
 * mid-transition on top of the copy meant to be covering it.
 *
 * ── Concurrent transitions ──
 * Switching again before a reveal finishes does NOT cancel anything. Each change
 * gets its own snapshot and its own animation, and they play at the same time.
 * Each snapshot reveals whatever sits directly beneath it, which is exactly the
 * state the app was in one step later. Newer snapshots therefore go BELOW older
 * ones, and the stack stays visually consistent no matter how fast the user taps.
 */

/**
 * Timing shared by every kind, and by both platforms — the Android side uses the
 * same four numbers so the transitions look identical.
 *
 * ── Why not a snappier curve ──
 * This was `(0.2, 0, 0, 1)`, and it front-loads far too much: half the reveal is
 * over by 20% of the duration, 94% by 62%, and the remainder crawls. At 600ms+
 * that reads as "brisk"; at the 200–300ms a production app actually wants, the
 * visible part of the motion collapses into two or three frames and the change
 * looks instant, with a long tail where nothing appears to happen.
 *
 * `(0.4, 0, 0.2, 1)` spreads the motion out — 50% done at 35% of the duration —
 * so a short transition still reads as movement from one state to another rather
 * than as a cut.
 */
private enum Curve {
  static let controlPoint1 = CGPoint(x: 0.4, y: 0)
  static let controlPoint2 = CGPoint(x: 0.2, y: 1)

  static var media: CAMediaTimingFunction {
    CAMediaTimingFunction(
      controlPoints:
        Float(controlPoint1.x), Float(controlPoint1.y),
        Float(controlPoint2.x), Float(controlPoint2.y)
    )
  }

  /**
   * Progress 0…1 through the shared cubic. Used to bake easing into keyframe
   * values for effects that cannot use `UIViewPropertyAnimator` directly
   * (`pixlated`'s paired scale transforms must stay inverses of each other).
   */
  static func progress(at linearT: CGFloat) -> CGFloat {
    let t = min(1, max(0, linearT))
    return unitBezierY(t: t, p1: controlPoint1, p2: controlPoint2)
  }

  /// Cubic Bézier Y for a given linear T, solving X(t) = linearT by Newton.
  private static func unitBezierY(t linearT: CGFloat, p1: CGPoint, p2: CGPoint) -> CGFloat {
    var guess = linearT
    for _ in 0..<5 {
      let x = bezier(guess, p1.x, p2.x)
      let dx = bezierDerivative(guess, p1.x, p2.x)
      guard abs(dx) > 1e-6 else { break }
      guess -= (x - linearT) / dx
      guess = min(1, max(0, guess))
    }
    return bezier(guess, p1.y, p2.y)
  }

  private static func bezier(_ t: CGFloat, _ a: CGFloat, _ b: CGFloat) -> CGFloat {
    let u = 1 - t
    return 3 * u * u * t * a + 3 * u * t * t * b + t * t * t
  }

  private static func bezierDerivative(_ t: CGFloat, _ a: CGFloat, _ b: CGFloat) -> CGFloat {
    let u = 1 - t
    return 3 * u * u * a + 6 * u * t * (b - a) + 3 * t * t * (1 - b)
  }
}

/**
 * The shortest each kind is allowed to run, in milliseconds — mirrored in
 * `Timing` on the Android side.
 *
 * ── Why the library clamps at all ──
 * The curve fix (see `Curve`) made short transitions read as motion rather than
 * as a cut, but there is a floor below which no curve helps: a full-screen copy
 * being taken apart needs enough frames for the eye to register the shape of the
 * motion, not just its start and end. At 120ms a reveal is six frames — the
 * circle is already half-way in frame two, and what the user sees is a flicker
 * with a hard edge in it.
 *
 * The floors differ because the kinds do not carry the same amount of
 * information. A fade has one moving quantity; a wipe has a moving boundary the
 * eye tracks across the whole screen; `pixlated` has to grow a mosaic, swap the
 * colours behind it, and take the mosaic back down again, so it needs roughly
 * three times a fade to complete that arc.
 *
 * A caller asking for `0` still means "no animation" — the clamp only applies to
 * a genuine request, so an app can always opt out.
 */
private enum Timing {
  static func floorMs(for kind: ThemeTransitionKind) -> Double {
    switch kind {
    case .fade: return 200
    case .zoom: return 240
    case .circularreveal, .circularrevealinverse, .iris: return 260
    case .slide, .split, .barndoor: return 260
    // More boundaries to follow than a plain wipe has.
    case .blinds: return 300
    case .blur: return 300
    // Three beats in sequence — down, hold for the swap, back up — so it needs
    // noticeably more room than kinds that do one continuous motion.
    case .liquidglass: return 620
    // Grain has no shape to follow, so the eye reads it as texture rather than
    // motion until it has had time to thin out.
    case .dissolve, .stripes: return 420
    case .ripple, .shatter: return 480
    case .pixlated: return 520
    }
  }

  /// The length to actually animate for, in seconds. Zero stays zero.
  static func seconds(for kind: ThemeTransitionKind, requestedMs: Double) -> Double {
    guard requestedMs > 0 else { return 0 }
    return max(requestedMs, floorMs(for: kind)) / 1000
  }
}

/**
 * The geometry behind `slide` and `split`: a straight boundary sweeping across
 * the screen, at any angle.
 *
 * ── One idea, used twice ──
 * Both kinds are "stop drawing the old screen on one side of a line". A wipe has
 * one such line travelling across the whole screen; a split has two, starting
 * together at the middle and parting. Expressing them as half-planes rather than
 * as rectangles is what lets the line be tilted at all — an axis-aligned
 * `clipRect` has no way to say "40° off level".
 *
 * A half-plane is `dot(p, n) >= threshold`, where `n` is a unit normal pointing
 * the way the surviving side lies. Sweeping is then nothing but moving
 * `threshold` from one end of the screen's projection onto `n` to the other:
 * at the low end every corner satisfies it, at the high end none do, whatever
 * the angle. That is the whole reason this generalises for free.
 *
 * Each half-plane comes back as a four-point quad. That matters on this platform
 * specifically: Core Animation interpolates a `path` animation point by point,
 * so as long as the two endpoints have the same structure — and they do, since
 * only `threshold` differs — the sweep is submitted once and interpolated by the
 * render server, with nothing running per frame.
 */
private enum Sweep {
  /**
   * The direction the surviving side of the screen lies in, tilted by `angleDeg`.
   *
   * Un-tilted this is simply the edge the old screen leaves through, which is
   * what makes `angleDeg: 0` reduce exactly to the rectangle clip this replaced.
   * The rotation is the standard matrix, which reads as CLOCKWISE on screen
   * because y grows downward here.
   */
  static func normal(
    for direction: ThemeTransitionDirection,
    angleDeg: Double
  ) -> CGVector {
    let base: CGVector
    switch direction {
    case .top: base = CGVector(dx: 0, dy: -1)
    case .bottom: base = CGVector(dx: 0, dy: 1)
    case .left: base = CGVector(dx: -1, dy: 0)
    case .right: base = CGVector(dx: 1, dy: 0)
    }

    let radians = CGFloat(angleDeg) * .pi / 180
    guard radians != 0 else { return base }

    let cosine = cos(radians)
    let sine = sin(radians)
    return CGVector(
      dx: base.dx * cosine - base.dy * sine,
      dy: base.dx * sine + base.dy * cosine
    )
  }

  /// How far the rect's corners project along `n` — the full travel of the sweep.
  static func projection(of bounds: CGRect, along n: CGVector) -> (min: CGFloat, max: CGFloat) {
    let corners = [
      CGPoint(x: bounds.minX, y: bounds.minY),
      CGPoint(x: bounds.maxX, y: bounds.minY),
      CGPoint(x: bounds.minX, y: bounds.maxY),
      CGPoint(x: bounds.maxX, y: bounds.maxY),
    ]

    let projections = corners.map { $0.x * n.dx + $0.y * n.dy }
    return (projections.min() ?? 0, projections.max() ?? 0)
  }

  /**
   * The quad covering `from <= dot(p, n) <= to` — a band between two parallel
   * boundaries.
   *
   * `barnDoor` is one of these closing on the middle; `blinds` is a row of them
   * each closing on its own far edge. Four points either way, so the same
   * interpolation argument as `halfPlane` applies.
   */
  static func slab(_ bounds: CGRect, n: CGVector, from: CGFloat, to: CGFloat) -> UIBezierPath {
    let reach = 2 * (bounds.width + bounds.height)
    let perpendicular = CGVector(dx: -n.dy, dy: n.dx)

    /*
     * ⚠ Never let the band close completely.
     *
     * A zero-area subpath has nothing to draw, and Core Graphics is free to drop
     * it — which changes the path's STRUCTURE between the two ends of the
     * animation, so Core Animation ends up interpolating points against the
     * wrong subpath. This is the same trap the circle avoids by clamping its
     * radius to 0.01 rather than 0, and it is exactly what made `blinds` come
     * out as slanted wedges instead of level louvres: every one of its slabs
     * collapses at the end, where a wipe's half-plane merely moves. `barnDoor`
     * has the same ending and was quietly wrong for the same reason.
     *
     * The surviving sliver is a hundredth of a point — far below one device
     * pixel, so it is never visible.
     */
    let near = min(from, to - 0.01)

    func corner(_ along: CGFloat, _ across: CGFloat) -> CGPoint {
      CGPoint(
        x: n.dx * along + perpendicular.dx * across,
        y: n.dy * along + perpendicular.dy * across
      )
    }

    let path = UIBezierPath()
    path.move(to: corner(near, reach))
    path.addLine(to: corner(near, -reach))
    path.addLine(to: corner(to, -reach))
    path.addLine(to: corner(to, reach))
    path.close()
    return path
  }

  /**
   * The quad covering `dot(p, n) >= threshold`.
   *
   * Deliberately far larger than the screen: it is only ever used as a mask on a
   * layer that clips to its own bounds, so overshooting costs nothing and saves
   * having to intersect the half-plane with the rectangle — which would change
   * the point count as the line crossed each corner, and break the interpolation
   * this depends on.
   */
  static func halfPlane(_ bounds: CGRect, n: CGVector, threshold: CGFloat) -> UIBezierPath {
    let reach = 2 * (bounds.width + bounds.height)
    let perpendicular = CGVector(dx: -n.dy, dy: n.dx)
    let anchor = CGPoint(x: threshold * n.dx, y: threshold * n.dy)

    func corner(_ along: CGFloat, _ across: CGFloat) -> CGPoint {
      CGPoint(
        x: anchor.x + n.dx * along + perpendicular.dx * across,
        y: anchor.y + n.dy * along + perpendicular.dy * across
      )
    }

    let path = UIBezierPath()
    path.move(to: corner(0, reach))
    path.addLine(to: corner(0, -reach))
    path.addLine(to: corner(reach, -reach))
    path.addLine(to: corner(reach, reach))
    path.close()
    return path
  }
}

/**
 * The outlines `iris` collapses the old screen into.
 *
 * ── Why they are all polygons ──
 * `circularReveal` animates a `path` from a big circle to a tiny one, and Core
 * Animation interpolates that point by point. Anything `iris` draws has to
 * survive the same treatment, which rules out building shapes from arcs or
 * `UIBezierPath(roundedRect:cornerRadius:)`: the number of segments those emit
 * depends on the radius, so the two endpoints would not match and the
 * interpolation would produce garbage.
 *
 * So every shape here is a fixed-vertex polygon on the unit circle, scaled by
 * the radius. The vertex count never changes, each vertex moves along a straight
 * line toward the centre, and the whole reveal is one submitted animation with
 * nothing running per frame — the same guarantee the circle has.
 */
private enum IrisShape {
  /// Unit outline, centred on the origin.
  static func polygon(for shape: ThemeTransitionShape) -> [CGPoint] {
    switch shape {
    // Enough segments to read as a circle, few enough to stay cheap. A true arc
    // would be smoother and would not interpolate — see above.
    case .circle: return regular(sides: 48, rotation: 0)
    case .diamond: return regular(sides: 4, rotation: -.pi / 2)
    case .hexagon: return regular(sides: 6, rotation: -.pi / 2)
    case .roundedrect: return squircle(samples: 32)
    }
  }

  private static func regular(sides: Int, rotation: CGFloat) -> [CGPoint] {
    (0..<sides).map { index in
      let angle = rotation + 2 * .pi * CGFloat(index) / CGFloat(sides)
      return CGPoint(x: cos(angle), y: sin(angle))
    }
  }

  /// A superellipse — the rounded square people mean by "rounded rect".
  private static func squircle(samples: Int) -> [CGPoint] {
    (0..<samples).map { index in
      let angle = 2 * .pi * CGFloat(index) / CGFloat(samples)
      let c = cos(angle)
      let s = sin(angle)
      // |cos|^0.5 with the sign put back: exponent 2/n for n = 4.
      return CGPoint(
        x: (c < 0 ? -1 : 1) * pow(abs(c), 0.5),
        y: (s < 0 ? -1 : 1) * pow(abs(s), 0.5)
      )
    }
  }

  /**
   * The largest disc that fits inside the unit outline.
   *
   * The reveal has to start with the old screen fully covered, and a polygon's
   * edges are closer to the centre than its vertices are — scaling it to the
   * distance of the furthest corner would leave the corners poking out. Dividing
   * the required radius by this puts the EDGES at that distance instead.
   */
  static func inradius(of polygon: [CGPoint]) -> CGFloat {
    var smallest = CGFloat.greatestFiniteMagnitude

    for index in polygon.indices {
      let a = polygon[index]
      let b = polygon[(index + 1) % polygon.count]
      let dx = b.x - a.x
      let dy = b.y - a.y
      let lengthSquared = dx * dx + dy * dy
      guard lengthSquared > 0 else { continue }
      // Distance from the origin to the SEGMENT a-b, not the infinite line: a
      // custom outline can be concave, where the line would under-measure.
      let t = min(max(-(a.x * dx + a.y * dy) / lengthSquared, 0), 1)
      smallest = min(smallest, hypot(a.x + t * dx, a.y + t * dy))
    }

    return smallest.isFinite && smallest > 0 ? smallest : 1
  }

  /// The outline at `radius`, centred on `origin`.
  static func path(_ polygon: [CGPoint], radius: CGFloat, origin: CGPoint) -> UIBezierPath {
    let path = UIBezierPath()

    for (index, point) in polygon.enumerated() {
      let target = CGPoint(x: origin.x + point.x * radius, y: origin.y + point.y * radius)
      if index == 0 {
        path.move(to: target)
      } else {
        path.addLine(to: target)
      }
    }

    path.close()
    return path
  }
}

/**
 * The pre-built alpha masks behind `dissolve`, `stripes`, `ripple` and
 * `shatter`.
 *
 * ── Matching the Skia package without a shader ──
 * The reference dissolve is a fragment shader that discards a pixel when its
 * cell's noise falls below the current threshold:
 *
 * ```
 * cell = floor(xy / grain)
 * n    = fract(sin(dot(cell, vec2(12.9898, 78.233))) * 43758.5453)
 * if (n < threshold) discard
 * ```
 *
 * The hash below is the same one, so the speckle pattern matches. What makes it
 * work without a shader is that the value is **static**: a cell's threshold
 * never changes, so a cell simply has a fixed time at which it disappears. Every
 * frame the effect can ever draw is therefore known in advance, and the whole
 * thing collapses to a pre-built stack of alpha masks.
 *
 * ── Why four effects share one implementation ──
 * Nothing above depends on the value being NOISE. Any per-cell number in 0…1 is
 * a valid disappearing order, so the four patterns differ only in how that
 * number is computed:
 *
 *   dissolve  the hash, unmodified — no order at all
 *   stripes   position along `direction`, roughened by a little of the hash
 *   ripple    distance from the origin, with a sine riding on it
 *   shatter   the hash of the nearest of a fixed set of seeds — Voronoi cells
 *
 * Everything after `thresholds(for:)` is identical for all four.
 */
private enum GrainMask {
  /// Cell size in points. Five is the reference default: coarse enough to read
  /// as grain, fine enough not to look like a mosaic.
  static let cellPoints: CGFloat = 5

  /**
   * Distinct masks in a ladder.
   *
   * These are played back as discrete keyframes, so this is the effect's frame
   * rate: 40 over a 650ms transition is one step every ~16ms, which is a frame.
   * Going finer would only add memory.
   */
  static let steps = 40

  enum Pattern: Hashable {
    case dissolve
    case stripes
    case ripple
    case shatter
  }

  /**
   * What a ladder is a function of — and therefore what it can be reused for.
   *
   * `dissolve` and `shatter` depend on the grid alone, so their ladders are
   * built once and then serve every transition for the life of the process.
   * `stripes` adds the axis (four possibilities) and `ripple` the origin, which
   * is why the cache holds several rather than one. The origin is stored in CELL
   * coordinates, so taps a few points apart share a ladder instead of each
   * rebuilding one.
   */
  struct Key: Hashable {
    let pattern: Pattern
    let cols: Int
    let rows: Int
    let axis: Int
    let originCol: Int
    let originRow: Int

    static func make(
      pattern: Pattern,
      cols: Int,
      rows: Int,
      direction: ThemeTransitionDirection = .bottom,
      origin: CGPoint = .zero
    ) -> Key {
      let axis: Int
      switch direction {
      case .top: axis = 0
      case .bottom: axis = 1
      case .left: axis = 2
      case .right: axis = 3
      }

      // Only the patterns that actually use a term include it, so a dissolve
      // never misses the cache because the user tapped somewhere new.
      return Key(
        pattern: pattern,
        cols: cols,
        rows: rows,
        axis: pattern == .stripes ? axis : 0,
        originCol: pattern == .ripple ? Int(origin.x) : 0,
        originRow: pattern == .ripple ? Int(origin.y) : 0
      )
    }
  }

  /// Most recent first. Small on purpose: each entry is ~2 MB of masks.
  private static var cache: [(key: Key, ladder: [CGImage])] = []
  private static let cacheLimit = 4

  /**
   * Drops every cached ladder under memory pressure.
   *
   * A full cache is around 9 MB — forty RGBA masks per entry, four entries —
   * held for the life of the process so that repeated transitions never rebuild
   * them. That is a deliberate trade, but it is not worth a jetsam kill, and
   * the only cost of dropping them is that the next transition of that kind
   * spends a few milliseconds on a background queue rebuilding one.
   *
   * Registered once, lazily, the first time a ladder is stored — so an app that
   * never uses these kinds never installs an observer.
   */
  private static var memoryObserver: NSObjectProtocol?

  private static func observeMemoryPressure() {
    guard memoryObserver == nil else { return }

    memoryObserver = NotificationCenter.default.addObserver(
      forName: UIApplication.didReceiveMemoryWarningNotification,
      object: nil,
      queue: .main
    ) { _ in
      cache.removeAll()
    }
  }

  static func grid(forPoints size: CGSize) -> (cols: Int, rows: Int) {
    (
      max(1, Int(ceil(size.width / cellPoints))),
      max(1, Int(ceil(size.height / cellPoints)))
    )
  }

  /// Main-thread only.
  static func cachedLadder(for key: Key) -> [CGImage]? {
    guard let index = cache.firstIndex(where: { $0.key == key }) else { return nil }

    // Move to front, so the limit evicts what has gone unused rather than what
    // happens to be oldest.
    let entry = cache.remove(at: index)
    cache.insert(entry, at: 0)
    return entry.ladder
  }

  /// Main-thread only.
  static func store(_ ladder: [CGImage], for key: Key) {
    observeMemoryPressure()
    cache.removeAll { $0.key == key }
    cache.insert((key, ladder), at: 0)
    if cache.count > cacheLimit { cache.removeLast(cache.count - cacheLimit) }
  }

  /**
   * The ladder resampled onto an evenly spaced timeline, so it can be played as
   * discrete keyframes with uniform `keyTimes`.
   *
   * This is where these effects pick up the shared easing. Core Animation holds
   * each value for the same slice of the duration, so the curve has to live in
   * WHICH rung each slice points at — early slices advance slowly, the middle
   * ones quickly. Rungs repeat and get skipped accordingly, which is the intent.
   */
  static func keyframes(from ladder: [CGImage]) -> [CGImage] {
    guard ladder.count > 1 else { return ladder }

    let last = ladder.count - 1
    return (0...last).map { frame in
      let linear = CGFloat(frame) / CGFloat(last)
      let eased = Curve.progress(at: linear)
      let rung = min(last, max(0, Int((eased * CGFloat(last)).rounded())))
      return ladder[rung]
    }
  }

  /// The 0…1 hash the reference shader uses, for a pair of integers.
  private static func hash(_ x: Double, _ y: Double) -> Double {
    let scaled = sin(x * 12.9898 + y * 78.233) * 43758.5453
    return scaled - floor(scaled)
  }

  /**
   * When each cell disappears, as a value in 0…1. Pure, so it is safe off the
   * main thread — which is where it runs.
   */
  private static func thresholds(for key: Key) -> [Double] {
    let cols = key.cols
    let rows = key.rows
    var out = [Double](repeating: 0, count: cols * rows)

    switch key.pattern {
    case .dissolve:
      for row in 0..<rows {
        for col in 0..<cols {
          out[row * cols + col] = hash(Double(col), Double(row))
        }
      }

    case .stripes:
      // Mostly position, with enough hash mixed in to keep the leading edge
      // ragged. All position would just be a wipe; all hash would be dissolve.
      let grain = 0.32
      for row in 0..<rows {
        for col in 0..<cols {
          let across = cols > 1 ? Double(col) / Double(cols - 1) : 0
          let down = rows > 1 ? Double(row) / Double(rows - 1) : 0

          // Cells nearest the edge the old screen leaves through go LAST, which
          // is what makes this read as the same motion a wipe has.
          let position: Double
          switch key.axis {
          case 0: position = 1 - down
          case 1: position = down
          case 2: position = 1 - across
          default: position = across
          }

          out[row * cols + col] =
            position * (1 - grain) + hash(Double(col), Double(row)) * grain
        }
      }

    case .ripple:
      let originX = Double(key.originCol)
      let originY = Double(key.originRow)
      let corners = [
        (0.0, 0.0), (Double(cols), 0.0), (0.0, Double(rows)), (Double(cols), Double(rows)),
      ]
      let furthest =
        corners.map { hypot($0.0 - originX, $0.1 - originY) }.max() ?? 1
      let span = max(furthest, 1)

      // Rings, but never enough to reverse the front: the sine's slope is
      // `2 * pi * rings * amplitude`, which has to stay under 1 or cells further
      // out would clear before nearer ones and the wave would break up.
      let rings = 5.0
      let amplitude = 0.028

      for row in 0..<rows {
        for col in 0..<cols {
          let distance = hypot(Double(col) - originX, Double(row) - originY) / span
          let rippled = distance + amplitude * sin(distance * 2 * .pi * rings)
          out[row * cols + col] = min(1, max(0, rippled))
        }
      }

    case .shatter:
      // Voronoi: every cell takes the disappearing time of its nearest seed, so
      // whole shards leave together.
      let seedCount = 48
      var seedX = [Double](repeating: 0, count: seedCount)
      var seedY = [Double](repeating: 0, count: seedCount)
      var seedTime = [Double](repeating: 0, count: seedCount)

      for seed in 0..<seedCount {
        seedX[seed] = hash(Double(seed), 1) * Double(cols)
        seedY[seed] = hash(Double(seed), 2) * Double(rows)
        seedTime[seed] = hash(Double(seed), 3)
      }

      for row in 0..<rows {
        for col in 0..<cols {
          var nearest = 0
          var best = Double.greatestFiniteMagnitude

          for seed in 0..<seedCount {
            let dx = Double(col) - seedX[seed]
            let dy = Double(row) - seedY[seed]
            let distance = dx * dx + dy * dy
            if distance < best {
              best = distance
              nearest = seed
            }
          }

          out[row * cols + col] = seedTime[nearest]
        }
      }
    }

    return out
  }

  /// Pure, and therefore safe to run on a background queue.
  static func build(for key: Key) -> [CGImage]? {
    let cols = key.cols
    let rows = key.rows
    let count = cols * rows
    let order = thresholds(for: key)

    var ladder: [CGImage] = []
    ladder.reserveCapacity(steps)

    for step in 0..<steps {
      // Thresholds are spaced LINEARLY, so the ladder is a plain lookup table.
      // The shared easing is applied when the keyframes are laid out — see
      // `keyframes(from:)`. Baking it in here as well would apply it twice.
      let threshold = Double(step) / Double(max(1, steps - 1))

      var pixels = [UInt32](repeating: 0, count: count)
      pixels.withUnsafeMutableBufferPointer { out in
        for index in 0..<count {
          // Opaque white where the old screen survives, clear where it has gone.
          out[index] = order[index] < threshold ? 0 : 0xFFFF_FFFF
        }
      }

      guard let image = mask(from: pixels, cols: cols, rows: rows) else { return nil }
      ladder.append(image)
    }

    return ladder
  }

  private static func mask(from pixels: [UInt32], cols: Int, rows: Int) -> CGImage? {
    let data = pixels.withUnsafeBufferPointer { Data(buffer: $0) }

    guard let provider = CGDataProvider(data: data as CFData) else { return nil }

    return CGImage(
      width: cols,
      height: rows,
      bitsPerComponent: 8,
      bitsPerPixel: 32,
      bytesPerRow: cols * 4,
      space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
      provider: provider,
      decode: nil,
      shouldInterpolate: false,
      intent: .defaultIntent
    )
  }
}

/**
 * Waits `frames` 120Hz frames of wall-clock time, then fires once on the first
 * display frame at or past that point.
 *
 * Its own `NSObject` because `CADisplayLink` needs an ObjC selector target, and
 * Nitro's generated `HybridThemeTransitionSpec_base` is a plain Swift class —
 * `@objc` members are not available on it.
 *
 * ── Why time, not callbacks ──
 * Counting callbacks made the hold depend on two things the caller cannot see.
 * A 60Hz iPhone delivers half as many callbacks per second as a ProMotion one,
 * so the same count held twice as long. And a display link skips the callbacks
 * of every frame the main thread was too busy to service — exactly what happens
 * while a theme or language change mounts its commit underneath — so each
 * blocked frame stretched the hold further. A request for ~320ms ran for
 * 650ms and more on an iPhone 16.
 */
private final class FrameWaiter: NSObject {
  private static let frameUnit: CFTimeInterval = 1.0 / 120.0

  private var link: CADisplayLink?
  private let deadline: CFTimeInterval
  private var work: (() -> Void)?

  init(frames: Int, work: @escaping () -> Void) {
    self.deadline = CACurrentMediaTime() + Double(frames) * Self.frameUnit
    self.work = work
    super.init()

    let link = CADisplayLink(target: self, selector: #selector(onFrame))
    link.add(to: .main, forMode: .common)
    self.link = link
  }

  @objc private func onFrame(_ link: CADisplayLink) {
    // `targetTimestamp` is when the frame being prepared reaches the screen, so
    // whatever `work` starts lands on the first frame at or past the deadline.
    guard link.targetTimestamp >= deadline else { return }

    let work = self.work
    cancel()
    work?()
  }

  func cancel() {
    link?.invalidate()
    link = nil
    work = nil
  }
}

/**
 * Drives a 0…1 progress callback every display frame along the shared curve.
 *
 * Needed for `pixlated`: the Skia-matching mosaic is not a CA-animatable
 * property, so each frame rebuilds a tiny cell grid (not a full-screen filter).
 */
private final class ProgressDriver: NSObject {
  private var link: CADisplayLink?
  private let duration: CFTimeInterval
  private var startTime: CFTimeInterval?
  private var onProgress: ((CGFloat) -> Void)?
  private var onComplete: (() -> Void)?

  init(
    duration: CFTimeInterval,
    onProgress: @escaping (CGFloat) -> Void,
    onComplete: @escaping () -> Void
  ) {
    self.duration = max(duration, 0.001)
    self.onProgress = onProgress
    self.onComplete = onComplete
    super.init()

    let link = CADisplayLink(target: self, selector: #selector(tick))
    link.add(to: .main, forMode: .common)
    self.link = link
  }

  @objc private func tick(_ link: CADisplayLink) {
    if startTime == nil { startTime = link.timestamp }
    guard let startTime else { return }

    let linear = min(1, CGFloat((link.timestamp - startTime) / duration))
    onProgress?(Curve.progress(at: linear))

    guard linear >= 1 else { return }

    let complete = onComplete
    cancel()
    complete?()
  }

  func cancel() {
    link?.invalidate()
    link = nil
    onProgress = nil
    onComplete = nil
  }
}

/**
 * The geometry `pixlated` works in — and the reason it is cheap.
 *
 * ── The insight ──
 * The mosaic never draws a cell finer than `minBlock` points, at either end of
 * its triangle. A grid of exactly that resolution therefore already contains
 * every pixel any level of the effect can display: `cell = (floor(xy / block) +
 * 0.5) * block` with `block == minBlock` IS that grid, and every coarser level
 * is a subsample of it.
 *
 * So nothing here ever touches a screen-resolution bitmap. The outgoing copy and
 * the incoming theme are both captured straight into this grid — one draw at
 * roughly 200×440 instead of 1206×2622 — and the levels are built from it.
 *
 * The previous version sampled full-resolution buffers (12.6 MB each at 3x) and
 * rebuilt two `CGImage`s from them on every display frame, which is what made
 * this the one kind that dropped frames.
 */
private enum MosaicGrid {
  /// Cell size at the ends and at the peak of the triangle, in points.
  static let minBlock: CGFloat = 2
  static let maxBlock: CGFloat = 52

  /**
   * How many distinct mosaics are built.
   *
   * The level index is picked from the triangle, so at 60fps over a 650ms
   * transition the index advances a little over one step per frame — finer than
   * the eye can follow, and the alpha crossfade underneath is still continuous.
   * Levels shrink as `1/step²`, so all 24 together cost about 1.5× the finest
   * one alone.
   */
  static let levels = 24

  /// The finest grid — one cell per `minBlock` points — for a view this size.
  static func size(forPoints size: CGSize) -> (cols: Int, rows: Int) {
    (
      max(1, Int(ceil(size.width / minBlock))),
      max(1, Int(ceil(size.height / minBlock)))
    )
  }

  /// How many of the finest cells make up one cell at `index`.
  static func step(_ index: Int) -> CGFloat {
    guard levels > 1 else { return 1 }
    let t = CGFloat(index) / CGFloat(levels - 1)
    return (minBlock + t * (maxBlock - minBlock)) / minBlock
  }

  /// Which level a triangle value 0…1 lands on.
  static func level(forTriangle tri: CGFloat) -> Int {
    let raw = Int((min(1, max(0, tri)) * CGFloat(levels - 1)).rounded())
    return min(levels - 1, max(0, raw))
  }
}

/**
 * A small premultiplied-RGBA grid, and the only pixel buffer `pixlated` holds.
 *
 * One word per pixel rather than four bytes: every operation here copies whole
 * pixels, so there is no reason to touch the channels individually except when
 * averaging.
 */
private struct MosaicBuffer {
  let width: Int
  let height: Int
  let pixels: [UInt32]

  static func from(_ image: UIImage) -> MosaicBuffer? {
    guard let cgImage = image.cgImage else { return nil }
    let width = cgImage.width
    let height = cgImage.height
    guard width > 0, height > 0 else { return nil }

    var pixels = [UInt32](repeating: 0, count: width * height)
    let ok = pixels.withUnsafeMutableBytes { raw -> Bool in
      guard
        let ctx = CGContext(
          data: raw.baseAddress,
          width: width,
          height: height,
          bitsPerComponent: 8,
          bytesPerRow: width * 4,
          space: CGColorSpaceCreateDeviceRGB(),
          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )
      else { return false }
      ctx.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
      return true
    }

    guard ok else { return nil }
    return MosaicBuffer(width: width, height: height, pixels: pixels)
  }

  /**
   * Sparse mean RGB — used to detect when a capture of the live app has stopped
   * matching the outgoing snapshot, i.e. when the new theme has actually painted.
   *
   * `premultipliedLast` with the default byte order puts R in the low byte on a
   * little-endian device, so the shifts below read R, G, B in that order.
   */
  func meanRGB() -> (r: Double, g: Double, b: Double) {
    var r = 0.0
    var g = 0.0
    var b = 0.0
    var n = 0.0
    let step = max(1, width / 24)
    var y = 0
    while y < height {
      var x = 0
      while x < width {
        let pixel = pixels[y * width + x]
        r += Double(pixel & 0xFF)
        g += Double((pixel >> 8) & 0xFF)
        b += Double((pixel >> 16) & 0xFF)
        n += 1
        x += step
      }
      y += step
    }
    guard n > 0 else { return (0, 0, 0) }
    return (r / n, g / n, b / n)
  }
}

/**
 * Every mosaic level the effect can draw, built once.
 *
 * Matches Skia's `pixelize`, `cell = (floor(xy / blockSize) + 0.5) * blockSize`,
 * except that the source is already quantised to the finest block — so level 0
 * is the source itself and level `i` samples it every `step(i)` cells, which is
 * the same arithmetic one indirection later.
 *
 * Each level is a tiny `cols×rows` image, stretched to the screen with
 * nearest-neighbour filtering by the image view that shows it. Playing the
 * effect is then a matter of assigning a different one of these per frame; no
 * pixel is touched once the ladder exists.
 */
private enum PixelizeMosaic {
  /// Nil if any level failed to build — an incomplete ladder cannot be indexed
  /// by level, so the caller falls back rather than drawing the wrong one.
  static func ladder(from source: MosaicBuffer) -> [UIImage]? {
    var images: [UIImage] = []
    images.reserveCapacity(MosaicGrid.levels)

    for index in 0..<MosaicGrid.levels {
      guard let image = level(from: source, index: index) else { return nil }
      images.append(image)
    }

    return images
  }

  private static func level(from source: MosaicBuffer, index: Int) -> UIImage? {
    let step = MosaicGrid.step(index)
    let cols = max(1, Int(ceil(CGFloat(source.width) / step)))
    let rows = max(1, Int(ceil(CGFloat(source.height) / step)))

    var out = [UInt32](repeating: 0, count: cols * rows)

    // Column centres are the same on every row, so they are resolved once.
    var columnOffsets = [Int](repeating: 0, count: cols)
    for col in 0..<cols {
      columnOffsets[col] = min(source.width - 1, Int((CGFloat(col) + 0.5) * step))
    }

    source.pixels.withUnsafeBufferPointer { src in
      out.withUnsafeMutableBufferPointer { dst in
        for row in 0..<rows {
          let sourceRow = min(source.height - 1, Int((CGFloat(row) + 0.5) * step)) * source.width
          let outRow = row * cols
          for col in 0..<cols {
            dst[outRow + col] = src[sourceRow + columnOffsets[col]]
          }
        }
      }
    }

    return image(from: out, cols: cols, rows: rows)
  }

  private static func image(from pixels: [UInt32], cols: Int, rows: Int) -> UIImage? {
    let data = pixels.withUnsafeBufferPointer { Data(buffer: $0) }

    guard
      let provider = CGDataProvider(data: data as CFData),
      let cgImage = CGImage(
        width: cols,
        height: rows,
        bitsPerComponent: 8,
        bitsPerPixel: 32,
        bytesPerRow: cols * 4,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
        provider: provider,
        decode: nil,
        shouldInterpolate: false,
        intent: .defaultIntent
      )
    else { return nil }

    return UIImage(cgImage: cgImage, scale: 1, orientation: .up)
  }
}

/**
 * The window the snapshots live in.
 *
 * They are deliberately NOT in the app's own window. The capture is a snapshot
 * of that whole window — which is the only way to be certain a presented view
 * controller is included, whatever container UIKit chose to host it in — and a
 * whole-window capture would otherwise copy the snapshots already animating
 * inside it, freezing a half-finished animation into the next one.
 *
 * Sitting one level above the app also removes an ordering problem: UIKit
 * appends a presentation's container to the window as it is presented, so a
 * modal opened mid-transition would land on top of the copy that is meant to be
 * covering it. A separate window is always above, with nothing able to insert
 * itself in between.
 *
 * It never takes touches: `hitTest` returns nil, so the system moves on to the
 * window below and the live app underneath stays fully interactive.
 */
private final class OverlayWindow: UIWindow {
  override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
    nil
  }
}

/**
 * An empty root for the overlay window.
 *
 * A window is documented to take its content from a root view controller, so it
 * gets one rather than relying on bare subviews. It stays out of everything
 * else: the window is never made key, so the scene continues to take its status
 * bar appearance from the app's own window and this controller is never asked.
 */
private final class OverlayRootViewController: UIViewController {
  override func loadView() {
    let view = UIView()
    view.backgroundColor = .clear
    view.isUserInteractionEnabled = false
    self.view = view
  }
}

/// One in-flight transition: the snapshot and whatever is animating it.
private final class Transition {
  let view: UIView
  /**
   * Where the surface the touch came from sits in the window, captured at
   * `begin()` — see `surfaceOffset(in:)`.
   *
   * Recorded with the snapshot rather than read at animation time: a sheet can
   * be dragged to another detent, or dismissed entirely, between the capture and
   * the reveal, and the origin has to mean what it meant when the user touched.
   */
  let originOffset: CGPoint
  /// Retained so the animator is not deallocated mid-flight, and so it can be
  /// stopped if this snapshot is torn down early.
  var animator: UIViewPropertyAnimator?

  /// Tears down layer animations owned by effects that are not a
  /// `UIViewPropertyAnimator` (currently `pixlated`).
  var cancelEffect: (() -> Void)?

  init(view: UIView, originOffset: CGPoint) {
    self.view = view
    self.originOffset = originOffset
  }

  func stop() {
    cancelEffect?()
    cancelEffect = nil

    if let animator, animator.state == .active {
      animator.stopAnimation(true)
    }
    animator = nil

    view.layer.mask?.removeAllAnimations()
    view.layer.removeAllAnimations()
    view.layer.mask = nil
    view.removeFromSuperview()
  }
}

final class HybridThemeTransition: HybridThemeTransitionSpec {
  /**
   * Live snapshots, oldest first.
   *
   * Oldest is the top-most view and finishes first; newest is the bottom-most,
   * sitting directly above the live app.
   */
  private var transitions: [Transition] = []

  /// Captured by `begin()`, waiting for its `commit()`. Never more than one:
  /// callers always pair the two within a single synchronous block.
  private var pending: Transition?

  /// Created with the first snapshot, released with the last.
  private var overlay: OverlayWindow?

  /**
   * Ceiling on simultaneous snapshots.
   *
   * Each one is a full-screen layer the GPU composites every frame, ON TOP of
   * the live app still drawing underneath — so the stack is straight overdraw.
   * Beyond the cap the OLDEST is dropped, which is the least visible choice: by
   * then it is the furthest through its animation.
   *
   * Six was tried at three, and three was the wrong trade: the overdraw is GPU
   * work, it was never what a fast tapper felt, and dropping a copy early is a
   * visible pop. The cost that actually hurt under rapid switching was on the
   * CPU and is fixed elsewhere.
   */
  private static let maxOverlays = 6

  /**
   * How far the mean colour has to move before the incoming theme counts as
   * painted. Low enough to catch a subtle palette change, high enough not to
   * fire on a blinking cursor.
   */
  private static let pixelizeMinDelta: Double = 12

  /// Display frames between new-theme probes, and how many to take.
  private static let pixelizeProbeInterval = 2
  private static let pixelizeMaxProbes = 6

  // MARK: - Spec

  func begin() throws -> Bool {
    // UIKit is main-thread only, and this must be SYNCHRONOUS: when `begin()`
    // returns, the screen has to already be covered, so no frame can render
    // between the capture and the caller's theme change.
    var didCapture = false
    onMainSync { didCapture = self.capture() }
    return didCapture
  }

  func commit(options: ThemeTransitionOptions) throws -> Promise<Void> {
    let promise = Promise<Void>()

    DispatchQueue.main.async { [weak self] in
      guard let self, let transition = self.pending else {
        // `begin()` never succeeded, or `abort()` already ran. The theme change
        // still happened — there is simply nothing to animate.
        promise.resolve(withResult: ())
        return
      }

      self.pending = nil

      // Hold for a few frames so the theme swap — committed on the JS thread and
      // mounted a frame or two later — has actually painted underneath.
      // Revealing early would animate down to the OLD colours.
      self.waitFrames(Int(options.settleFrames)) { [weak self] in
        guard let self, self.transitions.contains(where: { $0 === transition }) else {
          // Dropped by the overlay cap or by `dispose()` while we waited.
          promise.resolve(withResult: ())
          return
        }

        self.animate(transition, options: options) {
          promise.resolve(withResult: ())
        }
      }
    }

    return promise
  }

  func abort() throws {
    onMainSync {
      guard let transition = self.pending else { return }
      self.pending = nil
      self.remove(transition)
    }
  }

  /// Called if JS disposes the object mid-transition — never strand an overlay.
  func dispose() {
    onMainSync {
      self.pending = nil
      self.transitions.forEach { $0.stop() }
      self.transitions.removeAll()
      self.releaseOverlay()
    }
  }

  // MARK: - Capture

  /// Must run on the main thread.
  private func capture() -> Bool {
    // A previous `begin()` never reached its `commit()`. Don't leak it.
    if let stranded = pending {
      pending = nil
      remove(stranded)
    }

    guard
      let window = appWindow(),
      let snapshot = captureCurrentAppearance(sizedTo: window)
    else { return false }

    // Only now, so a failed capture never leaves an empty window on the scene.
    guard let host = overlayWindow(over: window) else { return false }

    snapshot.frame = host.bounds
    snapshot.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    // Belt and braces: the overlay window already refuses every touch.
    snapshot.isUserInteractionEnabled = false

    // Newest goes BELOW every existing snapshot, directly above the live app.
    if let bottomMost = transitions.last {
      host.insertSubview(snapshot, belowSubview: bottomMost.view)
    } else {
      host.addSubview(snapshot)
    }

    let transition = Transition(view: snapshot, originOffset: Self.surfaceOffset(in: window))
    transitions.append(transition)
    pending = transition

    enforceOverlayCap()

    return true
  }

  /**
   * The copy of what is on screen right now.
   *
   * Two ways of getting it, and the first one is the one that matters:
   *
   * 1. **The screen itself.** When none of our own copies are on screen — the
   *    overwhelmingly common case, one theme change at a time — "the screen" and
   *    "the app" are the same picture, and `UIScreen.snapshotView` is literally
   *    what the display is showing. It cannot miss a window, a presentation
   *    container, or anything else UIKit decided to draw, which is exactly the
   *    guarantee a modal needs. Only used when the app fills the screen, so the
   *    copy is never stretched (Split View, Slide Over).
   *
   * 2. **Window by window.** Once a transition is already running, the screen
   *    contains our own copies too, and copying those would bake a frozen frame
   *    of a live animation into the next one. So the fallback walks the scene's
   *    windows and skips ours.
   *
   * Both produce the same thing — everything the app is drawing, and nothing we
   * drew ourselves.
   */
  private func captureCurrentAppearance(sizedTo appWindow: UIWindow) -> UIView? {
    if
      transitions.isEmpty,
      let screen = appWindow.windowScene?.screen,
      // A partial-width app would otherwise be copied at screen size and then
      // squashed into the window.
      appWindow.frame == screen.bounds
    {
      // `UIScreen`'s version returns a non-optional, unlike `UIView`'s.
      return screen.snapshotView(afterScreenUpdates: false)
    }

    return captureVisibleWindows(sizedTo: appWindow)
  }

  /**
   * The fallback copy: every window the scene is currently showing, in draw
   * order, minus our own.
   *
   * ── Why whole WINDOWS, and not `rootViewController.view` ──
   * A presented view controller — a React Native `Modal`, a router modal, a form
   * sheet, an alert — is not inside the root view controller's view. UIKit hosts
   * it in a container of its own, and the exact shape of that container is a
   * private detail that has changed across iOS releases; some presentations are
   * hosted in a separate window entirely. Walking those containers by hand is
   * guesswork.
   *
   * What is guaranteed is simpler: if it is on screen, it is in the layer tree
   * of one of the scene's windows. Copying the windows themselves therefore
   * cannot miss it, whatever UIKit chose to do — and it picks up the dimming
   * behind a sheet for free.
   *
   * This is what the earlier root-view-only capture got wrong: the copy came out
   * with the modal cut out of it and was then pinned on top of the live one, so
   * the modal vanished for the length of the animation and only reappeared,
   * already re-themed, once the reveal finished.
   *
   * Our own overlay windows are skipped. A copy must contain the app *without*
   * the other copies, or each capture would bake in a frozen frame of the
   * animations still running above it.
   *
   * `afterScreenUpdates: false` is deliberate. `true` forces a synchronous
   * layout + render pass of the entire app on the main thread — exactly the
   * stall this design exists to avoid — and is unnecessary, because the screen is
   * already displaying the state we want to preserve.
   */
  private func captureVisibleWindows(sizedTo appWindow: UIWindow) -> UIView? {
    guard let scene = appWindow.windowScene else {
      return appWindow.snapshotView(afterScreenUpdates: false)
    }

    let visible = scene.windows.filter {
      !($0 is OverlayWindow) && !$0.isHidden && $0.alpha > 0 && $0.bounds.width > 0
    }

    // The common case by far: the app is the only thing on screen.
    if visible.count <= 1 {
      return (visible.first ?? appWindow).snapshotView(afterScreenUpdates: false)
    }

    // Lowest level first, and stable within a level, so the copy is stacked the
    // way the screen is. `sorted(by:)` is not a stable sort, hence the index.
    let ordered =
      visible
      .enumerated()
      .sorted {
        $0.element.windowLevel.rawValue == $1.element.windowLevel.rawValue
          ? $0.offset < $1.offset
          : $0.element.windowLevel.rawValue < $1.element.windowLevel.rawValue
      }
      .map(\.element)

    let container = UIView(frame: appWindow.bounds)
    container.backgroundColor = .clear
    container.isUserInteractionEnabled = false

    var captured = false

    for source in ordered {
      guard let piece = source.snapshotView(afterScreenUpdates: false) else { continue }

      // Window frames share the scene's coordinate space; the container is
      // anchored on the app window, so shift into its space rather than assuming
      // it starts at the origin (it does not in Slide Over or Split View).
      piece.frame = source.frame.offsetBy(
        dx: -appWindow.frame.minX,
        dy: -appWindow.frame.minY
      )
      piece.alpha = source.alpha
      piece.isUserInteractionEnabled = false
      container.addSubview(piece)

      captured = true
    }

    return captured ? container : nil
  }

  /**
   * The window the snapshots are hosted in, created on first use.
   *
   * One level above the app's window: high enough that nothing the app presents
   * can be inserted above a copy that is supposed to be covering it, low enough
   * that the OS keeps drawing the keyboard, alerts and the status bar above
   * everything — those are not part of the capture and must stay live.
   */
  private func overlayWindow(over window: UIWindow) -> UIWindow? {
    guard let scene = window.windowScene else { return nil }

    // A scene change (a new window, an iPad multi-window move) invalidates it.
    if let existing = overlay, existing.windowScene === scene {
      existing.frame = window.frame
      return existing
    }

    releaseOverlay()

    let host = OverlayWindow(windowScene: scene)
    host.frame = window.frame
    host.windowLevel = UIWindow.Level(rawValue: window.windowLevel.rawValue + 1)
    host.backgroundColor = .clear
    host.isOpaque = false
    host.isUserInteractionEnabled = false
    host.rootViewController = OverlayRootViewController()
    // Never `makeKeyAndVisible`: taking key status away from the app would move
    // the first responder and dismiss the keyboard. Un-hiding is all a window
    // needs to be displayed.
    host.isHidden = false

    overlay = host
    return host
  }

  /**
   * Where the surface a touch came from sits inside the window.
   *
   * ── The problem this solves ──
   * React Native reports touches relative to the SURFACE they happened in, and a
   * presented screen is its own surface. A form sheet resting at its half detent
   * starts ~450pt down the window, and a press on a button inside it arrives as
   * `pageY ≈ 380` rather than `≈ 834`. The snapshot covers the whole window, so a
   * reveal centred on that raw value opens half a screen above the finger.
   *
   * JavaScript cannot correct for this on its own: inside a sheet even
   * `measureInWindow` reports positions in the sheet's surface, so every value
   * available to the app is already in the wrong space. Measured on an iPhone 16
   * Pro: `page 213,380`, `measureInWindow 158,371` — the same offset, the sheet's
   * own origin, missing from both.
   *
   * The presentation's frame is the missing term, and only UIKit knows it. It is
   * read fresh for every capture, so dragging the sheet between detents needs no
   * special handling — the offset is simply whatever the sheet's frame is at the
   * moment the user touched it.
   *
   * Zero when nothing is presented, and zero for a full-screen presentation such
   * as RN's `Modal` with `overFullScreen`, whose view already fills the window —
   * which is why modals were correct while sheets were not.
   */
  private static func surfaceOffset(in window: UIWindow) -> CGPoint {
    var controller = window.rootViewController
    while let presented = controller?.presentedViewController {
      controller = presented
    }

    guard
      let controller,
      controller !== window.rootViewController,
      let view = controller.viewIfLoaded,
      view.window === window
    else { return .zero }

    return view.convert(view.bounds, to: window).origin
  }

  /// Drops the overlay window as soon as nothing is left to show in it.
  private func releaseOverlay() {
    overlay?.isHidden = true
    overlay = nil
  }

  private func enforceOverlayCap() {
    while transitions.count > Self.maxOverlays, let oldest = transitions.first {
      remove(oldest)
    }
  }

  /**
   * The window the app itself draws into.
   *
   * It fixes the scene to work in, the geometry the copy is sized to, and the
   * level the overlay window sits above. Not simply "the key window": presenting
   * can move key status elsewhere, and our own overlay must never be picked —
   * that would anchor the overlay above itself.
   */
  private func appWindow() -> UIWindow? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }

    let scene =
      scenes.first(where: { $0.windows.contains(where: \.isKeyWindow) })
      ?? scenes.first(where: { $0.activationState == .foregroundActive })
      ?? scenes.first

    guard let scene else { return nil }

    let candidates = scene.windows.filter {
      !($0 is OverlayWindow) && !$0.isHidden && $0.alpha > 0.01 && $0.rootViewController != nil
    }

    return candidates.first(where: { $0.windowLevel == .normal })
      ?? candidates.first(where: \.isKeyWindow)
      ?? candidates.first
  }

  /// Drops a transition from the stack and the view hierarchy.
  private func remove(_ transition: Transition) {
    transitions.removeAll { $0 === transition }
    transition.stop()

    // Nothing left to show: give the window back rather than leaving an empty
    // one attached to the scene, where other code that enumerates windows would
    // still see it.
    if transitions.isEmpty { releaseOverlay() }
  }

  // MARK: - Animation

  private func animate(
    _ transition: Transition,
    options: ThemeTransitionOptions,
    completion: @escaping () -> Void
  ) {
    // Zero still means "no animation". Anything else is clamped up to the
    // shortest length this kind can read as motion rather than as a cut.
    let duration = Timing.seconds(for: options.kind, requestedMs: options.durationMs)

    let finish: () -> Void = { [weak self] in
      self?.remove(transition)
      completion()
    }

    guard duration > 0 else {
      finish()
      return
    }

    switch options.kind {
    case .circularreveal where !options.customShape.isEmpty:
      animateIris(transition, options: options, inverse: false, duration: duration, finish: finish)
    case .circularrevealinverse where !options.customShape.isEmpty:
      animateIris(transition, options: options, inverse: true, duration: duration, finish: finish)
    case .circularreveal:
      animateCircularReveal(
        transition, options: options, inverse: false, duration: duration, finish: finish)
    case .circularrevealinverse:
      animateCircularReveal(
        transition, options: options, inverse: true, duration: duration, finish: finish)
    case .fade:
      run(transition, duration: duration, finish: finish) { view in
        view.alpha = 0
      }
    case .iris:
      animateIris(transition, options: options, inverse: false, duration: duration, finish: finish)
    case .slide:
      animateSweep(transition, options: options, mode: .wipe, duration: duration, finish: finish)
    case .split:
      animateSweep(transition, options: options, mode: .split, duration: duration, finish: finish)
    case .barndoor:
      animateSweep(transition, options: options, mode: .barnDoor, duration: duration, finish: finish)
    case .blinds:
      animateSweep(transition, options: options, mode: .blinds, duration: duration, finish: finish)
    case .blur:
      animateBlur(transition, options: options, duration: duration, finish: finish)
    case .liquidglass:
      if #available(iOS 26.0, *) {
        animateLiquidGlass(transition, options: options, duration: duration, finish: finish)
      } else {
        // Liquid Glass is the material; without it there is nothing to refract
        // through, and a blur is the closest thing this OS has.
        animateBlur(transition, options: options, duration: duration, finish: finish)
      }
    case .zoom:
      animateZoom(transition, duration: duration, finish: finish)
    case .pixlated:
      animatePixlated(transition, duration: duration, finish: finish)
    case .dissolve:
      animateGrain(transition, options: options, pattern: .dissolve, duration: duration, finish: finish)
    case .stripes:
      animateGrain(transition, options: options, pattern: .stripes, duration: duration, finish: finish)
    case .ripple:
      animateGrain(transition, options: options, pattern: .ripple, duration: duration, finish: finish)
    case .shatter:
      animateGrain(transition, options: options, pattern: .shatter, duration: duration, finish: finish)
    }
  }

  /// Runs `animations` on the snapshot with the shared curve, retaining the
  /// animator on the transition so it survives and can be stopped.
  private func run(
    _ transition: Transition,
    duration: Double,
    finish: @escaping () -> Void,
    animations: @escaping (UIView) -> Void
  ) {
    let view = transition.view
    let animator = UIViewPropertyAnimator(
      duration: duration,
      controlPoint1: Curve.controlPoint1,
      controlPoint2: Curve.controlPoint2
    ) {
      animations(view)
    }

    // `position != .end` means it was stopped early by a teardown, which has
    // already removed the view — finishing again would double-resolve.
    animator.addCompletion { position in
      if position == .end { finish() }
    }

    transition.animator = animator
    animator.startAnimation()
  }

  /**
   * Sweeps a straight boundary across the screen, uncovering the new theme.
   *
   * `split == false` is the wipe: one line crossing the whole screen, leaving
   * through `direction`. `split == true` is two lines, starting together at the
   * middle and parting until they reach opposite edges — so `direction` names
   * the axis rather than an edge, and `'top'` and `'bottom'` mean the same
   * thing (as do `'left'` and `'right'`).
   *
   * Nothing translates in either case. This is a MASK animation: the old pixels
   * stay exactly where they are and simply stop being drawn as a boundary passes
   * over them, and the new theme is already sitting underneath. Translating the
   * snapshot instead would drag the whole UI sideways, which reads as a page
   * transition rather than a theme change.
   *
   * See `Sweep` for the geometry, and for why the tilt costs nothing.
   */
  /**
   * Where a shape-based reveal is centred, in the snapshot's own space.
   *
   * The caller's point is in the coordinate space of whatever surface the touch
   * happened in; the snapshot is in window space. For a plain screen or a
   * full-screen modal these are the same and the offset is zero — for a sheet at
   * a detent it is the whole difference. See `surfaceOffset(in:)`.
   */
  private static func revealOrigin(
    _ transition: Transition,
    options: ThemeTransitionOptions,
    in bounds: CGRect
  ) -> CGPoint {
    guard options.originX >= 0, options.originY >= 0 else {
      return CGPoint(x: bounds.midX, y: bounds.midY)
    }

    return CGPoint(
      x: options.originX + transition.originOffset.x,
      y: options.originY + transition.originOffset.y
    )
  }

  /// The radius that still reaches the farthest corner from `origin`.
  private static func cornerRadius(from origin: CGPoint, in bounds: CGRect) -> CGFloat {
    max(
      hypot(origin.x, origin.y),
      hypot(bounds.maxX - origin.x, origin.y),
      hypot(origin.x, bounds.maxY - origin.y),
      hypot(bounds.maxX - origin.x, bounds.maxY - origin.y)
    )
  }

  /// Which arrangement of boundaries `animateSweep` draws.
  enum SweepMode {
    /// One line crossing the whole screen.
    case wipe
    /// Two lines parting from the centre, old screen retreating to both edges.
    case split
    /// Two lines closing IN on the centre, old screen shrinking to a band.
    case barnDoor
    /// `bands` slabs, each wiping across itself in unison.
    case blinds
  }

  private func animateSweep(
    _ transition: Transition,
    options: ThemeTransitionOptions,
    mode: SweepMode,
    duration: Double,
    finish: @escaping () -> Void
  ) {
    let bounds = transition.view.bounds
    let normal = Sweep.normal(for: options.direction, angleDeg: options.angleDeg)
    let span = Sweep.projection(of: bounds, along: normal)
    let opposite = CGVector(dx: -normal.dx, dy: -normal.dy)

    // Enough louvres to read as blinds, few enough that each band is visible.
    let bands = min(24, max(2, Int(options.bands.rounded())))

    let path: (CGFloat) -> CGPath = { t in
      switch mode {
      case .wipe:
        let threshold = span.min + t * (span.max - span.min)
        return Sweep.halfPlane(bounds, n: normal, threshold: threshold).cgPath

      case .split:
        // Both boundaries start on the centre line and travel outward together.
        let middle = (span.min + span.max) / 2
        let reach = (span.max - span.min) / 2 * t

        let path = Sweep.halfPlane(bounds, n: normal, threshold: middle + reach)
        // `dot(p, n) <= middle - reach` is the same half-plane read the other way.
        path.append(Sweep.halfPlane(bounds, n: opposite, threshold: -(middle - reach)))
        return path.cgPath

      case .barnDoor:
        // The same two boundaries as a split, run the other way: they start at
        // the edges and close, so the old screen survives as a shrinking band.
        let middle = (span.min + span.max) / 2
        return Sweep.slab(
          bounds,
          n: normal,
          from: span.min + t * (middle - span.min),
          to: span.max - t * (span.max - middle)
        ).cgPath

      case .blinds:
        let width = (span.max - span.min) / CGFloat(bands)
        let path = UIBezierPath()

        for band in 0..<bands {
          let start = span.min + CGFloat(band) * width
          // Each slab's own boundary sweeps from its near edge to its far one,
          // all at the same moment — which is what louvres closing look like.
          path.append(Sweep.slab(bounds, n: normal, from: start + t * width, to: start + width))
        }

        return path.cgPath
      }
    }

    animateMask(
      transition,
      from: path(0),
      to: path(1),
      duration: duration,
      finish: finish
    )
  }

  /**
   * `circularReveal` with a shape other than a circle — a built-in `shape`, or
   * `options.customShape` (from the caller's SVG path) when present, which also
   * serves `circularRevealInverse`.
   *
   * Identical in every other respect — same origin handling, same mask, same
   * single submitted animation. Only the path builder differs, and `IrisShape`
   * explains why every outline it produces is a fixed-vertex polygon.
   */
  private func animateIris(
    _ transition: Transition,
    options: ThemeTransitionOptions,
    inverse: Bool,
    duration: Double,
    finish: @escaping () -> Void
  ) {
    let bounds = transition.view.bounds
    let origin = Self.revealOrigin(transition, options: options, in: bounds)
    // Read once: the generated getter copies the whole C++ vector into a new
    // Swift array on EVERY access.
    let custom = options.customShape
    let polygon =
      custom.count >= 6
      ? stride(from: 0, to: custom.count - 1, by: 2).map {
        CGPoint(x: custom[$0], y: custom[$0 + 1])
      }
      : IrisShape.polygon(for: options.shape)

    // Scale so the polygon's EDGES clear the furthest corner, not its vertices.
    let radius = Self.cornerRadius(from: origin, in: bounds) / IrisShape.inradius(of: polygon)

    let path: (CGFloat) -> CGPath = { radius in
      // Never exactly zero: a degenerate polygon has no drawable area, which
      // would change the path's structure and break the interpolation.
      let shape = IrisShape.path(polygon, radius: max(radius, 0.01), origin: origin)
      guard inverse else { return shape.cgPath }
      // Even-odd, as in `animateCircularReveal`: the polygon punches a hole.
      let path = UIBezierPath(rect: bounds)
      path.append(shape)
      return path.cgPath
    }

    animateMask(
      transition,
      from: path(inverse ? 0 : radius),
      to: path(inverse ? radius : 0),
      fillRule: inverse ? .evenOdd : .nonZero,
      duration: duration,
      finish: finish
    )
  }

  /**
   * A sheet of glass slides down over the screen, the theme changes behind it,
   * and the sheet slides back up.
   *
   * ── Three beats, in order ──
   *   1. The sheet comes down from above until it covers everything.
   *   2. It HOLDS, and the old screen fades out behind it — so the swap happens
   *      entirely out of sight, refracted.
   *   3. Only once the swap is finished does the sheet go back up the way it
   *      came.
   *
   * The hold is the whole thing. Overlap the fade with either slide and it stops
   * being a sheet of glass doing a job and becomes a wipe again — which is
   * exactly how five earlier versions read.
   *
   * ── The sheet is an object, not a boundary ──
   * It never reveals anything by passing over it: the old screen is still there,
   * intact, while the sheet travels. What changes underneath happens while it is
   * stationary. That is the difference between a pane of glass being drawn over
   * a screen and a mask sweeping across one, and it is the reason this is the
   * version that works.
   *
   * The sheet is taller than the screen and its BOTTOM corners are rounded, so
   * it reads as a physical pane with a leading edge — and the overhang keeps
   * those corners off screen while it is covering, where they would otherwise
   * leave two lit notches of the old theme showing through.
   *
   * Everything is a layer animation submitted once, so nothing runs per frame.
   */
  @available(iOS 26.0, *)
  private func animateLiquidGlass(
    _ transition: Transition,
    options: ThemeTransitionOptions,
    duration: Double,
    finish: @escaping () -> Void
  ) {
    let view = transition.view
    let bounds = view.bounds

    guard let host = view.superview, bounds.width > 0, bounds.height > 0 else {
      animateBlur(transition, options: options, duration: duration, finish: finish)
      return
    }

    // Enough to keep the rounded bottom corners below the screen once the sheet
    // has arrived.
    let overhang: CGFloat = 56
    let sheet = bounds.height + overhang

    /*
     * `.clear` rather than `.regular`.
     *
     * The regular style is a frosted material: it hides what is behind it, which
     * made the covered stretch read as a flat grey panel and buried the swap it
     * is supposed to be showing. Clear keeps the screen readable through the
     * sheet and puts the emphasis on refraction and the lit rim, which is what
     * makes it look like glass rather than like a scrim.
     *
     * The trade is that the fade underneath is now genuinely visible — which is
     * the point of the middle beat, but it does mean the swap cannot hide behind
     * frost. That is why it is eased, and why it gets a stretch of the timeline
     * to itself rather than overlapping either slide.
     */
    let glass = UIVisualEffectView(effect: UIGlassEffect(style: .clear))
    glass.frame = CGRect(x: 0, y: 0, width: bounds.width, height: sheet)
    glass.isUserInteractionEnabled = false
    glass.clipsToBounds = true
    glass.layer.cornerRadius = 34
    glass.layer.cornerCurve = .continuous
    // The leading edge only — a pane, not a floating card.
    glass.layer.maskedCorners = [.layerMinXMaxYCorner, .layerMaxXMaxYCorner]

    host.insertSubview(glass, aboveSubview: view)

    // Down, hold, up. The hold is a little longer than either slide, so the
    // swap never looks rushed and the sheet never looks like it is scraping the
    // theme off on its way past.
    let covered = 0.34
    let swapped = 0.64

    let hold = CAMediaTimingFunction(name: .linear)

    let travel = CAKeyframeAnimation(keyPath: "transform.translation.y")
    travel.values = [-sheet, 0, 0, -sheet]
    travel.keyTimes = [0, NSNumber(value: covered), NSNumber(value: swapped), 1]
    travel.timingFunctions = [
      // Arrives on the shared curve, like every other kind here…
      Curve.media,
      hold,
      // …and leaves accelerating, so the exit reads as the sheet being pulled
      // rather than drifting off.
      CAMediaTimingFunction(name: .easeIn),
    ]
    travel.duration = duration
    // Rests off the top, which is where it has to end up.
    glass.layer.transform = CATransform3DMakeTranslation(0, -sheet, 0)
    glass.layer.add(travel, forKey: "themeTransitionSheet")

    CATransaction.begin()
    CATransaction.setCompletionBlock {
      transition.cancelEffect = nil
      glass.removeFromSuperview()
      finish()
    }

    let swap = CAKeyframeAnimation(keyPath: "opacity")
    swap.values = [1, 1, 0, 0]
    swap.keyTimes = [0, NSNumber(value: covered), NSNumber(value: swapped), 1]
    swap.timingFunctions = [
      hold,
      CAMediaTimingFunction(name: .easeInEaseOut),
      hold,
    ]
    swap.duration = duration
    view.layer.opacity = 0
    view.layer.add(swap, forKey: "themeTransitionSwap")

    CATransaction.commit()

    transition.cancelEffect = { [weak glass] in glass?.removeFromSuperview() }
  }

  /**
   * The old screen scales up and fades out.
   *
   * The cheapest kind here by a distance — two animatable properties and nothing
   * else. It is also the one that reads least like a theme change: growth plus a
   * fade is the vocabulary of a navigation push, which is why the rest of the
   * library animates masks instead of moving the copy about.
   */
  private func animateZoom(
    _ transition: Transition,
    duration: Double,
    finish: @escaping () -> Void
  ) {
    run(transition, duration: duration, finish: finish) { view in
      view.alpha = 0
      view.transform = CGAffineTransform(scaleX: 1.12, y: 1.12)
    }
  }

  /**
   * The four mask-ladder effects: `dissolve`, `stripes`, `ripple` and `shatter`.
   *
   * They differ only in the order their cells disappear in — see `GrainMask`.
   * Everything from here on is shared, because once the ladder exists there is
   * nothing pattern-specific left to do.
   *
   * The whole effect is submitted to the render server in one go, as a discrete
   * keyframe animation on the mask layer's `contents`. That puts these in the
   * same class as the reveals and the wipe: nothing runs per frame, so a busy JS
   * thread — or a busy MAIN thread — cannot stutter them. `pixlated` cannot do
   * this, because its two mosaics have to be cross-faded against each other;
   * these only ever show a single image.
   */
  private func animateGrain(
    _ transition: Transition,
    options: ThemeTransitionOptions,
    pattern: GrainMask.Pattern,
    duration: Double,
    finish: @escaping () -> Void
  ) {
    let bounds = transition.view.bounds
    let grid = GrainMask.grid(forPoints: bounds.size)

    // `ripple` is the only one that needs the touch point, and it needs it in
    // MASK CELLS rather than points.
    let point = Self.revealOrigin(transition, options: options, in: bounds)
    let originCell = CGPoint(
      x: (point.x / GrainMask.cellPoints).rounded(),
      y: (point.y / GrainMask.cellPoints).rounded()
    )

    let key = GrainMask.Key.make(
      pattern: pattern,
      cols: grid.cols,
      rows: grid.rows,
      direction: options.direction,
      origin: originCell
    )

    if let ladder = GrainMask.cachedLadder(for: key) {
      runGrain(transition, ladder: ladder, duration: duration, finish: finish)
      return
    }

    // A ladder this key has not seen before: ~560k thresholds and 40 small
    // images. Off the main thread, then kept for every transition that matches.
    DispatchQueue.global(qos: .userInitiated).async {
      let ladder = GrainMask.build(for: key)

      DispatchQueue.main.async { [weak self] in
        guard let self, self.transitions.contains(where: { $0 === transition }) else {
          finish()
          return
        }

        guard let ladder else {
          // No mask to draw with; an effect that cannot mask is a fade.
          self.run(transition, duration: duration, finish: finish) { $0.alpha = 0 }
          return
        }

        GrainMask.store(ladder, for: key)
        self.runGrain(transition, ladder: ladder, duration: duration, finish: finish)
      }
    }
  }

  private func runGrain(
    _ transition: Transition,
    ladder: [CGImage],
    duration: Double,
    finish: @escaping () -> Void
  ) {
    let values = GrainMask.keyframes(from: ladder)

    guard let first = values.first, let last = values.last else {
      run(transition, duration: duration, finish: finish) { $0.alpha = 0 }
      return
    }

    let mask = CALayer()
    mask.frame = transition.view.bounds
    // One mask cell covers several points, and it must stay a hard-edged speck
    // rather than being smoothed into a cloud.
    mask.magnificationFilter = .nearest
    mask.minificationFilter = .nearest
    mask.contents = first
    transition.view.layer.mask = mask

    CATransaction.begin()
    CATransaction.setCompletionBlock { finish() }

    let animation = CAKeyframeAnimation(keyPath: "contents")
    animation.values = values
    // A sequence of stills, not something to blend between — interpolating two
    // masks would cross-fade the cells into a haze.
    animation.calculationMode = .discrete
    animation.duration = duration
    // Uniform keyTimes: the easing lives in which rung each slice points at.

    // Set the model value too, so the mask stays fully cleared if the completion
    // block is delayed — otherwise the old screen flashes back.
    mask.contents = last
    mask.add(animation, forKey: "themeTransitionGrain")

    CATransaction.commit()
  }

  /**
   * Blurs the outgoing screen as it dissolves.
   *
   * A `UIVisualEffectView` over the snapshot: its backdrop is the snapshot
   * itself (opaque, directly beneath), so animating `effect` from `nil` to a
   * blur ramps the blur up on exactly that content. `UIViewPropertyAnimator` is
   * the only way to interpolate `effect` — it is not a plain animatable
   * property.
   *
   * The slight scale-up stops it reading as a flat cross-fade; the old screen
   * feels like it is receding rather than just vanishing.
   */
  private func animateBlur(
    _ transition: Transition,
    options: ThemeTransitionOptions,
    duration: Double,
    finish: @escaping () -> Void
  ) {
    let view = transition.view

    guard options.blurStyle == .sweep, let host = view.superview else {
      let effectView = UIVisualEffectView(effect: nil)
      effectView.frame = view.bounds
      effectView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
      effectView.isUserInteractionEnabled = false
      // A subview, so it travels with the snapshot's scale.
      view.addSubview(effectView)

      run(transition, duration: duration, finish: finish) { snapshot in
        // Adapts to light/dark, so the blur tints toward the incoming theme.
        effectView.effect = UIBlurEffect(style: .systemThinMaterial)
        snapshot.alpha = 0
        snapshot.transform = CGAffineTransform(scaleX: 1.04, y: 1.04)
      }
      return
    }

    /*
     * `.sweep`: a wipe that brings the NEW theme in out of focus, and pulls it
     * sharp as it arrives.
     *
     * ── The blur is on the incoming side, not the outgoing one ──
     * This is the part that is easy to get backwards, and the first version did.
     * The old screen is never blurred at all — it stays crisp right up to the
     * edge and is simply taken away by the mask. What is out of focus is the
     * theme arriving behind it, which sharpens as the wipe crosses. Blurring the
     * outgoing copy instead produces the opposite reading: the screen you are
     * leaving goes soft, which looks like it is being smeared off rather than
     * like the new one is coming into focus.
     *
     * ── Which means the blur cannot live on the snapshot ──
     * The incoming theme is the LIVE app, underneath everything we own. So the
     * effect view is a sibling BELOW the snapshot: its backdrop is the app
     * window, and it is only visible where the mask has already taken the old
     * screen away. Animating its `effect` to `nil` ramps the blur DOWN, which is
     * the whole point — high at first, gone by the end.
     */
    let bounds = view.bounds

    let incoming = UIVisualEffectView(effect: UIBlurEffect(style: .systemThinMaterial))
    incoming.frame = bounds
    incoming.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    incoming.isUserInteractionEnabled = false
    host.insertSubview(incoming, belowSubview: view)

    // Finishes a little before the wipe does, so the last sliver to be uncovered
    // is already sharp and the transition does not end on a soft frame.
    let sharpen = UIViewPropertyAnimator(
      duration: duration * 0.85,
      controlPoint1: Curve.controlPoint1,
      controlPoint2: Curve.controlPoint2
    ) {
      incoming.effect = nil
    }

    transition.animator = sharpen
    transition.cancelEffect = { [weak incoming] in incoming?.removeFromSuperview() }
    sharpen.startAnimation()

    let normal = Sweep.normal(for: options.direction, angleDeg: options.angleDeg)
    let span = Sweep.projection(of: bounds, along: normal)

    animateMask(
      transition,
      from: Sweep.halfPlane(bounds, n: normal, threshold: span.min).cgPath,
      to: Sweep.halfPlane(bounds, n: normal, threshold: span.max).cgPath,
      duration: duration
    ) {
      transition.cancelEffect = nil
      incoming.removeFromSuperview()
      finish()
    }
  }

  /**
   * Pixelize — matches the Skia package's `pixelize`, without Skia.
   *
   * Two mosaiced layers (new underneath, old on top). Shared `blockSize`
   * triangle peaks at the midpoint; the OLD layer's alpha is `1 - progress`,
   * so the colour swap is a fade *behind* the pixels across the whole
   * duration (obviously half-swapped at mid). A short last-15% container
   * fade only unwraps onto the live app once both themes already match.
   *
   * The incoming theme is captured only after React Native has painted it:
   * we poll `captureNewThemeImage` until its mean colour differs from the
   * outgoing snapshot (or we hit a short frame budget). Capturing once after
   * the default settle often still sampled the OLD colours — which made the
   * mid crossfade a no-op and the real swap appear only on the final fade.
   */
  private func animatePixlated(
    _ transition: Transition,
    duration: Double,
    finish: @escaping () -> Void
  ) {
    let replicant = transition.view
    let grid = MosaicGrid.size(forPoints: replicant.bounds.size)

    // Every path that cannot produce a mosaic still has to end the transition:
    // a plain dissolve if we are still alive, otherwise just resolve.
    let fallback: () -> Void = { [weak self] in
      guard let self else {
        finish()
        return
      }
      self.run(transition, duration: duration, finish: finish) { $0.alpha = 0 }
    }

    guard
      let oldImage = Self.mosaicCapture(of: replicant, cols: grid.cols, rows: grid.rows),
      let oldBuffer = MosaicBuffer.from(oldImage),
      let hostWindow = replicant.superview
    else {
      fallback()
      return
    }

    // Both sides of the comparison are grid-sized buffers sampled the same way,
    // so the only thing the delta can reflect is the colours themselves.
    let oldMean = oldBuffer.meanRGB()

    func diverged(from buffer: MosaicBuffer) -> Bool {
      let mean = buffer.meanRGB()
      let delta =
        abs(oldMean.r - mean.r) + abs(oldMean.g - mean.g) + abs(oldMean.b - mean.b)
      return delta >= Self.pixelizeMinDelta
    }

    /// Both ladders in one hop off the main thread — ~270k pixel copies and 48
    /// small `CGImage`s, which is a few milliseconds the UI thread should not be
    /// spending while an overlay is frozen over the app.
    func buildLadders(newBuffer: MosaicBuffer) {
      DispatchQueue.global(qos: .userInitiated).async {
        let oldLadder = PixelizeMosaic.ladder(from: oldBuffer)
        let newLadder = PixelizeMosaic.ladder(from: newBuffer)

        DispatchQueue.main.async { [weak self] in
          guard let self, self.transitions.contains(where: { $0 === transition }) else {
            // Torn down while we were building. `stop()` has already removed the
            // view; resolving is all that is left to do.
            finish()
            return
          }

          guard let oldLadder, let newLadder else {
            fallback()
            return
          }

          self.startPixelizeCrossfade(
            transition,
            hostWindow: hostWindow,
            oldLadder: oldLadder,
            newLadder: newLadder,
            duration: duration,
            finish: finish
          )
        }
      }
    }

    /**
     * Wait for the incoming theme to actually paint underneath.
     *
     * Capturing once after `settleFrames` often still samples the OLD colours
     * when the theme is React-driven, which makes the crossfade a no-op — so
     * this polls until the mean colour moves.
     *
     * The polling is the part that used to cost everything: it ran every frame
     * for 24 frames, and each attempt forced a layout of the whole React tree
     * and rendered the entire app into a full-resolution CPU bitmap. Both are
     * gone. Each attempt now draws into the mosaic grid — ~200×440 rather than
     * 1206×2622 — every other frame, with a budget of six: the same ~12 frames
     * of tolerance for a slow theme, at a fraction of a percent of the work.
     *
     * The attempt captures at the size the mosaic actually needs rather than
     * probing smaller first, so the frame that finally diverges is the frame
     * that produces the buffer. There is no second capture, and nothing has to
     * reconcile two different sampling scales.
     */
    func attempt(_ probes: Int) {
      guard transitions.contains(where: { $0 === transition }) else {
        finish()
        return
      }

      let exhausted = probes >= Self.pixelizeMaxProbes

      if
        let newImage = captureNewThemeImage(cols: grid.cols, rows: grid.rows),
        let newBuffer = MosaicBuffer.from(newImage),
        diverged(from: newBuffer) || exhausted
      {
        buildLadders(newBuffer: newBuffer)
        return
      }

      guard !exhausted else {
        fallback()
        return
      }

      waitFrames(Self.pixelizeProbeInterval) {
        attempt(probes + 1)
      }
    }

    attempt(0)
  }

  /**
   * The crossfade itself, once both ladders exist.
   *
   * Two nearest-neighbour image views, new underneath and old on top. The
   * `blockSize` triangle peaks at the midpoint and the OLD layer's alpha is
   * `1 - progress`, so the colour swap is a fade *behind* the pixels across the
   * whole duration and is obviously half-swapped at the middle. The last 15%
   * fades the container, so unwrapping onto the live app only happens once both
   * themes already match.
   *
   * A frame costs one integer comparison and — only when the level actually
   * changes — two `image` assignments of an already-built `UIImage`. Nothing is
   * sampled, allocated or rasterised while the animation runs.
   */
  private func startPixelizeCrossfade(
    _ transition: Transition,
    hostWindow: UIView,
    oldLadder: [UIImage],
    newLadder: [UIImage],
    duration: Double,
    finish: @escaping () -> Void
  ) {
    let replicant = transition.view

    let container = UIView(frame: replicant.frame)
    container.isUserInteractionEnabled = false
    container.clipsToBounds = true
    container.backgroundColor = .clear

    func makeImageView() -> UIImageView {
      let imageView = UIImageView(frame: container.bounds)
      imageView.contentMode = .scaleToFill
      imageView.isUserInteractionEnabled = false
      imageView.layer.magnificationFilter = .nearest
      imageView.layer.minificationFilter = .nearest
      imageView.layer.allowsEdgeAntialiasing = false
      return imageView
    }

    let newView = makeImageView()
    let oldView = makeImageView()
    container.addSubview(newView)
    container.addSubview(oldView)

    hostWindow.insertSubview(container, aboveSubview: replicant)
    replicant.isHidden = true

    var currentLevel = -1

    func apply(progress p: CGFloat) {
      let tri: CGFloat
      if p < 0.5 {
        tri = p / 0.5
      } else {
        let t = (p - 0.5) / 0.5
        let inv = 1 - t
        tri = inv * inv * inv
      }

      let level = MosaicGrid.level(forTriangle: tri)
      if level != currentLevel {
        currentLevel = level
        newView.image = newLadder[level]
        oldView.image = oldLadder[level]
      }

      let endFade: CGFloat = p <= 0.85 ? 1 : 1 - (p - 0.85) / 0.15
      oldView.alpha = (1 - p) * endFade
      newView.alpha = endFade
    }

    apply(progress: 0)

    let driver = ProgressDriver(duration: duration) { progress in
      apply(progress: progress)
    } onComplete: {
      transition.cancelEffect = nil
      container.removeFromSuperview()
      finish()
    }

    transition.cancelEffect = {
      driver.cancel()
      container.removeFromSuperview()
    }
  }

  /**
   * The outgoing copy, drawn straight into the finest mosaic grid.
   *
   * `_UIReplicantView` does not expose a `CGImage` in `layer.contents`
   * (`contentsType` is a private snapshot token), so it has to be rasterised —
   * but only ever at mosaic resolution. Rendering it at screen scale first, as
   * this used to, produced a 12.6 MB buffer to build ~350 KB of mosaic out of.
   *
   * `afterScreenUpdates: false` is safe here specifically because the view has
   * already been on screen; a freshly made snapshot view would come out blank.
   */
  private static func mosaicCapture(of view: UIView, cols: Int, rows: Int) -> UIImage? {
    let size = CGSize(width: cols, height: rows)
    guard view.bounds.width > 0, view.bounds.height > 0 else { return nil }

    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    format.opaque = false

    let renderer = UIGraphicsImageRenderer(size: size, format: format)
    let image = renderer.image { ctx in
      let target = CGRect(origin: .zero, size: size)
      if !view.drawHierarchy(in: target, afterScreenUpdates: false) {
        ctx.cgContext.scaleBy(
          x: size.width / view.bounds.width,
          y: size.height / view.bounds.height
        )
        view.layer.render(in: ctx.cgContext)
      }
    }

    return image.size.width > 0 && image.size.height > 0 ? image : nil
  }

  /**
   * The live app in its NEW theme, drawn into a `cols×rows` bitmap.
   *
   * `afterScreenUpdates: true` so React Native's just-committed theme is flushed
   * into the layer tree before it is sampled. That is safe here, unlike in
   * `begin()`, because the outgoing overlay still covers the screen — the extra
   * layout pass is invisible.
   *
   * The size is the caller's choice and it is what makes polling affordable: a
   * probe asks for something like 25×55, and the full mosaic grid is only ever
   * requested once, after the colours have already been seen to move. Skipping
   * `OverlayWindow` keeps our own copies out of the result.
   */
  private func captureNewThemeImage(cols: Int, rows: Int) -> UIImage? {
    guard
      let appWindow = appWindow(),
      appWindow.bounds.width > 0,
      appWindow.bounds.height > 0
    else { return nil }

    let size = CGSize(width: cols, height: rows)
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    format.opaque = true

    let renderer = UIGraphicsImageRenderer(size: size, format: format)

    let windows: [UIWindow] = {
      guard let scene = appWindow.windowScene else { return [appWindow] }
      return scene.windows.filter {
        !($0 is OverlayWindow) && !$0.isHidden && $0.alpha > 0 && $0.bounds.width > 0
      }
    }()

    let ordered =
      windows
      .enumerated()
      .sorted {
        $0.element.windowLevel.rawValue == $1.element.windowLevel.rawValue
          ? $0.offset < $1.offset
          : $0.element.windowLevel.rawValue < $1.element.windowLevel.rawValue
      }
      .map(\.element)

    // Window frames are in scene space; scale them into the small bitmap so a
    // dialog still lands where it belongs within it.
    let scaleX = size.width / appWindow.bounds.width
    let scaleY = size.height / appWindow.bounds.height

    let image = renderer.image { _ in
      for source in ordered {
        let frame = source.frame.offsetBy(
          dx: -appWindow.frame.minX,
          dy: -appWindow.frame.minY
        )
        let scaled = CGRect(
          x: frame.minX * scaleX,
          y: frame.minY * scaleY,
          width: frame.width * scaleX,
          height: frame.height * scaleY
        )
        _ = source.drawHierarchy(in: scaled, afterScreenUpdates: true)
      }
    }

    return image.size.width > 0 && image.size.height > 0 ? image : nil
  }

  /**
   * The circle at `origin`, uncovering whatever sits beneath this snapshot.
   *
   *   inverse == false  the OLD screen shrinks INTO the circle — the new theme
   *                     arrives from the edges and closes in on the touch point.
   *   inverse == true   a HOLE opens at the circle and grows — the new theme
   *                     spreads outward from the touch point.
   *
   * Same shape, run the other way round, and they are each other's natural
   * counterpart: whichever one is used for light→dark, the other reads as
   * "undo" for dark→light.
   *
   * The inverse is the same mask with the fill rule flipped. Both paths are
   * `rect + circle` so they have identical subpath structure, which is what
   * lets Core Animation interpolate between them — a `CABasicAnimation` on
   * `path` produces garbage if the two paths differ in point count or order.
   * (The rect subpath is constant; only the circle moves.)
   */
  private func animateCircularReveal(
    _ transition: Transition,
    options: ThemeTransitionOptions,
    inverse: Bool,
    duration: Double,
    finish: @escaping () -> Void
  ) {
    let bounds = transition.view.bounds
    let origin = Self.revealOrigin(transition, options: options, in: bounds)
    let maxRadius = Self.cornerRadius(from: origin, in: bounds)

    let circle: (CGFloat) -> UIBezierPath = { radius in
      UIBezierPath(
        arcCenter: origin,
        // Never exactly zero: a degenerate arc has no drawable subpath, which
        // would change the path's structure and break the interpolation.
        radius: max(radius, 0.01),
        startAngle: 0,
        endAngle: .pi * 2,
        clockwise: true
      )
    }

    let path: (CGFloat) -> CGPath = { radius in
      guard inverse else { return circle(radius).cgPath }
      // Even-odd: covered by the rect but NOT the circle stays drawn, so the
      // circle punches a hole through the old screen.
      let path = UIBezierPath(rect: bounds)
      path.append(circle(radius))
      return path.cgPath
    }

    animateMask(
      transition,
      from: path(inverse ? 0 : maxRadius),
      to: path(inverse ? maxRadius : 0),
      fillRule: inverse ? .evenOdd : .nonZero,
      duration: duration,
      finish: finish
    )
  }

  /**
   * Animates a `CAShapeLayer` mask on the snapshot from one path to another.
   *
   * Shared by the circle and the wipe: both are "stop drawing the old screen in
   * this shape", they only differ in the shape. The mask goes on the SNAPSHOT,
   * never on the live view — masking the real tree would make RN's views
   * re-composite every frame, whereas the snapshot is a single flattened layer
   * the render server can mask essentially for free.
   */
  private func animateMask(
    _ transition: Transition,
    from startPath: CGPath,
    to endPath: CGPath,
    fillRule: CAShapeLayerFillRule = .nonZero,
    duration: Double,
    finish: @escaping () -> Void
  ) {
    let layer = transition.view.layer

    let mask = CAShapeLayer()
    mask.frame = transition.view.bounds
    mask.fillColor = UIColor.white.cgColor
    mask.fillRule = fillRule
    mask.path = startPath
    layer.mask = mask

    CATransaction.begin()
    CATransaction.setCompletionBlock { finish() }

    let animation = CABasicAnimation(keyPath: "path")
    animation.fromValue = startPath
    animation.toValue = endPath
    animation.duration = duration
    animation.timingFunction = Curve.media

    // Set the model value too, so the mask stays collapsed if the completion
    // block is delayed — otherwise the old screen would flash back for a frame.
    mask.path = endPath
    mask.add(animation, forKey: "themeTransitionReveal")

    CATransaction.commit()
  }

  // MARK: - Frame waiting

  /**
   * Runs `work` after `frames` display frames. Must be called on the main thread.
   *
   * The waiter needs no tracking here: `CADisplayLink` retains its target, so it
   * stays alive until it invalidates itself on fire. Several can be in flight at
   * once, one per concurrent transition, and each `work` closure re-checks that
   * its overlay is still in the stack before touching it.
   */
  private func waitFrames(_ frames: Int, work: @escaping () -> Void) {
    guard frames > 0 else {
      work()
      return
    }

    _ = FrameWaiter(frames: frames, work: work)
  }

  // MARK: - Threading

  /// Runs `block` on the main thread synchronously, without deadlocking when the
  /// caller is already on it.
  private func onMainSync(_ block: () -> Void) {
    if Thread.isMainThread {
      block()
    } else {
      DispatchQueue.main.sync(execute: block)
    }
  }
}
