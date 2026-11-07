# Handover — react-native-nitro-theme-transition

Everything a next maintainer needs: what exists, why it is built this way, what
was actually verified, what was not, and where to take it next.

This is the canonical repo. The same code is also vendored as a local package
inside a consumer app (SpeedyHire), which carries its own copy of this document
with the integration-specific sections rewritten — keep the two in step when the
implementation changes.

---

## 1. What it does

Animates a theme change instead of snapping it. Sixteen effects, all running on
the OS render thread rather than in JavaScript.

They come from four families, and the families matter far more than the count —
adding a kind is nearly always a matter of picking one and changing a few lines:

| Family | Kinds | The one idea |
| --- | --- | --- |
| Shape mask | `circularReveal`, `circularRevealInverse`, `iris` | a shrinking outline at a point |
| Straight boundaries | `slide`, `split`, `barnDoor`, `blinds` | half-planes sweeping along a normal (§4c) |
| Mask ladder | `dissolve`, `stripes`, `ripple`, `shatter` | a per-cell disappearing ORDER, pre-built (§4d) |
| Whole-layer | `fade`, `zoom`, `blur`, `liquidGlass`, `pixlated` | animate the copy itself |

No Skia, no Reanimated, no JS animation library. The only dependency is Nitro.

## 2. The core idea

**A theme change cannot be animated frame by frame.**

Unistyles applies a theme as a whole-app style re-evaluation plus a shadow-tree
commit, synchronously on the JS thread. There is no intermediate state to
interpolate — no "40% dark". Four earlier attempts in a sibling project tried to
animate the theme itself, or to cover it with a JS-drawn overlay, and all were
visibly laggy.

So this package does not animate the theme at all:

1. take a **GPU-side copy** of the current screen and pin it on top;
2. run the caller's callback — the theme changes underneath, invisibly;
3. animate the **copy** away with the platform's own animator.

Because step 3 is submitted to the OS once and interpolated by the render
thread, a busy or blocked JS thread cannot stutter it. That is the whole value
proposition, and it is the thing to protect in any future change.

## 3. Map of the code

| File                                    | Lines    | Role                                                                         |
| --------------------------------------- | -------- | ---------------------------------------------------------------------------- |
| `src/specs/ThemeTransition.nitro.ts`    | ~157     | **Source of truth.** Nitro spec — changing it requires codegen               |
| `src/index.ts`                          | ~267     | JS API: `withThemeTransition`, `isThemeTransitionAvailable`, option defaults |
| `ios/HybridThemeTransition.swift`       | ~2323    | Whole iOS implementation — every effect, and all four shared geometries      |
| `android/.../HybridThemeTransition.kt`  | ~1304    | Android orchestration: capture, stack, animators                             |
| `android/.../SnapshotView.kt`           | ~910     | Android snapshot view: capture + clipped draw + mosaic, and `SurfacePool`    |
| `android/.../PixelizeMosaic.kt`         | ~169     | Mosaic grid + ladder builder (matches iOS / Skia sampling)                   |
| `android/.../DissolveGrain.kt`          | ~307     | Mask ladders for `dissolve` / `stripes` / `ripple` / `shatter` (§4d)         |
| `android/.../SweepGeometry.kt`          | ~126     | Half-planes and slabs for `slide` / `split` / `barnDoor` / `blinds` (§4c)    |
| `android/.../IrisShape.kt`              | ~92      | Fixed-vertex outlines for `iris` (§4c)                                       |
| `android/.../ThemeTransitionPackage.kt` | 32       | Exists only to `System.loadLibrary`                                          |
| `android/src/main/cpp/cpp-adapter.cpp`  | —        | `JNI_OnLoad` → nitrogen's `registerAllNatives()`                             |
| `nitrogen/generated/**`                 | many     | Generated bridge. **Committed on purpose**                                   |

The three-method native surface is deliberately tiny:

```ts
begin(): boolean                     // snapshot now, synchronously
commit(options): Promise<void>       // hold N frames, then animate it away
abort(): void                        // drop the snapshot, no animation
```

`begin()` **must** be synchronous — when it returns, the screen has to already be
covered, or a frame can render between the capture and the theme change.

`withThemeTransition` has one kind-specific special case: for `pixlated` it
defers `commit` by two `requestAnimationFrame` ticks so a React-driven theme can
commit before native settle + second capture starts. Other kinds commit
immediately after the callback.

## 4. How it works on iOS

| Step    | API                                                                          |
| ------- | ---------------------------------------------------------------------------- |
| Capture | `UIScreen.snapshotView(afterScreenUpdates: false)`, or window-by-window      |
| Host    | a dedicated `OverlayWindow`, one level above the app's window                |
| Animate | Core Animation / `UIViewPropertyAnimator`                                    |

`afterScreenUpdates: false` is deliberate. `true` forces a synchronous layout +
render pass of the whole app on the main thread — exactly the stall this design
avoids — and is unnecessary, because the screen already shows the state we want.

### ⚠ Never capture `rootViewController.view` — this is what makes modals work

A presented view controller — RN `Modal`, a router modal, a form sheet, an alert
— is **not** inside `rootViewController.view`. RN's own Fabric modal is a plain
`[reactViewController presentViewController:…]`, and UIKit hosts the result in a
container of its own, whose exact shape is a private detail that has changed
across releases.

Two attempts got this wrong, and both failed identically: the copy came out with
the modal cut out of it, was pinned on top of the live modal, and so the modal
**vanished for the length of the animation** and reappeared already re-themed at
the end. First `rootViewController.view` alone; then a hand-rolled walk of the
window's direct children — still guessing at UIKit's private containers.

`captureCurrentAppearance(sizedTo:)` stops guessing, with two paths:

1. **`UIScreen.snapshotView`** when no transition is already running — which is
   the normal case. It is literally what the display is showing, so no window,
   container or private view can be missing from it. Used only when the app fills
   the screen, so the copy is never stretched (Split View, Slide Over).
   (Note: `UIScreen`'s version returns a non-optional, unlike `UIView`'s.)
2. **Window by window**, skipping our own `OverlayWindow`s, once copies are
   already on screen — a screen snapshot would then contain them, baking a frozen
   frame of a live animation into the next copy.

Both yield the same thing: everything the app is drawing, nothing we drew.

Verified on an iPhone 16 Pro simulator with a transparent RN `Modal` open and an
8000 ms reveal: mid-animation frames show the modal card **and its dimming**
inside the copy, in the outgoing theme, with the incoming theme visible outside
the reveal boundary. Native instrumentation confirmed the shape of the problem
at the same time — `windows=1`, `presented=RCTFabricModalHostViewController`,
`path=screen` — i.e. the modal is a presented view controller in the app's only
window, exactly where a root-view capture cannot see it.

### Why the overlay lives in its own window

`OverlayWindow` is created with the first snapshot and released with the last, at
`appWindow.windowLevel + 1`. It is never made key — that would move the first
responder and dismiss the keyboard — and its `hitTest` returns `nil`, so touches
fall through to the live app.

It is not cosmetic. Two things depend on it:

- **The whole-window capture stays honest.** A copy must contain the app
  *without* the other copies. Snapshots living in the captured window would each
  bake in a frozen frame of the animations still running above them.
- **Z-order stops being a race.** UIKit appends a presentation's container to the
  app window as it is presented, so a modal opened mid-transition would land on
  top of the copy meant to be covering it. A separate window is always above,
  with nothing able to insert itself in between.

The level matters too: `+1` is above everything the app draws and below the
status bar (1000), alerts (2000) and the keyboard, which the OS keeps drawing
live above the copy. They are not part of the capture and must not be frozen.

### ⚠ The origin arrives in SURFACE space, not window space

`surfaceOffset(in:)` exists because of this, and it is easy to delete by mistake.

React Native reports a touch relative to the surface it happened in. A form sheet
at its half detent starts ~450pt down the window, so a press on a button inside
it arrives as `pageY ≈ 380` when the button is really at `≈ 834`. The snapshot
covers the whole window, so a reveal centred on the raw value opens half a screen
above the finger.

**JavaScript cannot fix this.** Inside a sheet, `measureInWindow` reports in that
sheet's surface too. Measured on an iPhone 16 Pro at the half detent:

```
page 213,380    measureInWindow 158,371    true window y ≈ 834
```

Both are short by the same ~454pt — the sheet's own origin. Two rounds of
JavaScript "fixes" (measure `currentTarget`, then measure `target`) were spent
before that was clear; they cancel out to exactly `pageX/pageY` and are gone.

So the correction is native: the frontmost presented view controller's view
origin in window space, added to the incoming point. It is read at **capture**
time and stored on the `Transition`, because a sheet can be dragged to another
detent, or dismissed, between the touch and the reveal.

Consequences worth knowing:

- It is zero when nothing is presented, and zero for a full-screen presentation
  such as RN's `Modal` with `overFullScreen` — which is exactly why modals looked
  correct while sheets did not.
- Detents need no special handling. The offset is whatever the sheet's frame is
  at that moment, so every snap point works for free.
- An app that passes a genuinely window-space origin while a sheet is open (a
  hard-coded corner, say) will be shifted by the sheet's offset. That is the
  documented trade: the option means "a point in the surface the user touched".

### The easing curve, and why short durations looked broken

Both platforms share four numbers — `Curve` in Swift, `curve()` in Kotlin — so
the transitions look identical. They were `(0.2, 0, 0, 1)`, which front-loads the
motion severely: **50% of the reveal is over by 20% of the duration, 94% by 62%**,
and the rest crawls.

At 650 ms that reads as "brisk". At the 200–300 ms a production app actually
wants, the visible part of the motion collapses into two or three frames followed
by a long tail where nothing appears to move — which is exactly what a user
describes as "it feels like an instant change" and "it doesn't start and end
where it should".

`(0.4, 0, 0.2, 1)` spreads it: 50% done at 35% of the duration. Verified by
recording the simulator at 60 fps and extracting frames — a 250 ms transition now
occupies ~14 consecutive frames with visibly distinct intermediate states, rather
than jumping half-way in the first two.

If you change these numbers, change them in **both** files, and check a 200 ms
transition frame by frame, not a 1000 ms one — a curve that is fine when slow can
be useless when fast.

### Duration floors — where the curve stops being able to help

The curve fixed the *shape* of a short transition. It cannot fix a transition
with too few frames in it. At 120 ms a reveal is seven frames: the circle is
half-way in frame two and the user sees a flicker with a hard edge, not motion.

So each kind clamps up to a minimum, in `Timing` (Swift) and `floorDuration()`
(Kotlin) — **keep the two tables identical**:

| Kind                            | Floor  |
| ------------------------------- | ------ |
| `fade`                          | 200 ms |
| `circularReveal` / its inverse  | 260 ms |
| `slide`                         | 260 ms |
| `blur`                          | 300 ms |
| `pixlated`                      | 520 ms |

They differ because the kinds do not carry the same amount of information. A
fade has one moving quantity; a wipe has a boundary the eye tracks across the
whole screen; `pixlated` has to grow a mosaic, swap the colours behind it, and
take the mosaic back down, so it needs roughly three times a fade to finish that
arc.

`durationMs: 0` still means "no animation" and is **not** clamped — an app can
always opt out.

Per kind:

| Kind                    | Mechanism                                                               |
| ----------------------- | ----------------------------------------------------------------------- |
| `fade`                  | `UIViewPropertyAnimator` on `alpha`                                     |
| `circularReveal`        | `CAShapeLayer` mask + `CABasicAnimation` on `path`                      |
| `circularRevealInverse` | same mask, `fillRule = .evenOdd`, `rect + circle` path                  |
| `iris`                  | the same mask, a fixed-vertex polygon instead of a circle (see §4c)     |
| `slide`                 | animated mask **half-plane** — nothing translates (see §4c)             |
| `split`                 | two half-planes parting from the centre (see §4c)                       |
| `barnDoor`              | one slab closing on the centre — `split` run the other way (see §4c)    |
| `blinds`                | `bands` slabs, each wiping across itself (see §4c)                      |
| `blur`                  | `UIVisualEffectView` from `nil`; `blurStyle` decides uniform vs swept   |
| `zoom`                  | `alpha` and a 1.12 scale — the cheapest kind here                       |
| `liquidGlass`           | a sliding `UIGlassEffect` sheet, swap held behind it (§4e), iOS 26+     |
| `pixlated`              | dual mosaiced layers + alpha crossfade (see §4b)                        |
| `dissolve` `stripes` `ripple` `shatter` | `CAKeyframeAnimation` on a mask layer's `contents` (see §4d) |

Two subtleties worth not breaking:

- **Path interpolation needs identical structure.** Both endpoints of the circle
  animation are built the same way (`rect + circle` for the inverse), and the
  radius is clamped to `0.01` rather than `0` — a degenerate arc has no drawable
  subpath, which changes the point count and makes Core Animation produce
  garbage.
- **`FrameWaiter` is its own `NSObject`** because `CADisplayLink` needs an ObjC
  selector target and nitrogen's generated Swift base class is a plain Swift
  class.
- **`FrameWaiter` waits by time, not callbacks.** A frame is `1/120s` of
  wall-clock time; it fires on the first display frame whose `targetTimestamp`
  reaches the deadline. Counting callbacks doubled the hold on 60Hz iPhones and
  stretched it further whenever the main thread was busy mounting the change,
  because a display link drops the callbacks of frames it could not service.

### 4b. `pixlated` — dual snapshot, Skia look without Skia

The other kinds only need the **outgoing** snapshot: peel/cut it away and the
live app (already on the new theme) shows through. Pixelize needs **both**
themes composited at once, like the Skia package's `pixelize` shader:

```
cell = (floor(xy / blockSize) + 0.5) * blockSize
// then draw old mosaic over new mosaic; old.alpha = 1 - progress
```

#### ⚠ Nothing in this effect may touch a screen-resolution bitmap

**This is the thing to protect.** The first version of `pixlated` was the only
kind that dropped frames, and under rapid switching it took the UI to zero. Every
reason was the same reason: it worked at the screen's real resolution.

The fix is one observation. **The mosaic never draws a cell finer than 2 pt**, at
either end of its triangle — so a grid at exactly that resolution (~200×440,
not 1206×2622) already contains every pixel the effect can ever display. It *is*
the `blockSize == 2` mosaic, and every coarser level is a subsample of it.

So the grid is the working resolution for the whole pipeline:

| Step | Then | Now |
| --- | --- | --- |
| Outgoing frame | full-res rasterise → 12.6 MB CPU buffer | drawn straight into the grid (iOS), GPU-downscaled then read back (Android) |
| New-theme poll | full-screen `drawHierarchy(afterScreenUpdates:true)` **every frame for 24 frames**, plus a forced layout of the whole React tree each time | rasterised into the grid, every 2nd frame, 6 attempts, no forced layout |
| Android poll readback | 10 MB GPU→CPU per attempt | ~290 KB |
| Per animation frame | rebuild **two** mosaics — ~90k cell samples each, two image allocations | assign a pre-built image; nothing sampled, nothing allocated |

Pipeline as it stands:

1. Capture the outgoing copy into the grid. On iOS that is `mosaicCapture(of:)`
   on the `_UIReplicantView` (never set `layer.contents` on one — UIKit rejects
   it with *"Snapshot layer doesn't allow its contents to be set"*). On Android
   it is `SnapshotView.downscaledCopy`, which rescales through the same
   offscreen GPU path the capture uses so only the small result is read back —
   a hardware Bitmap cannot be read by the CPU at all, and that readback is a
   stall.
2. **Poll** for the incoming theme until a capture's sparse mean RGB differs
   from the outgoing one (min delta ~12), every second frame, six attempts. A
   single capture after `settleFrames` alone often still samples the OLD colours
   when the theme is React-driven — the mid crossfade then becomes a no-op and
   the real swap appears only when the overlay is removed.

   Each attempt captures **at the grid**, not at some smaller probe size. The
   grid is already ~1/36 of the screen, so a smaller probe saves almost nothing
   in absolute terms, and capturing at the size the mosaic actually needs buys
   two things: the frame that finally diverges is the frame that produces the
   buffer (no second capture), and both sides of the comparison are grid-sized
   buffers sampled identically — so the delta can only reflect the colours, not
   two different rasterisation scales.
3. Build the **ladder** — 24 levels, from the grid, in one hop off the main
   thread (`DispatchQueue.global` / a single daemon `ExecutorService`). Level 0
   is the grid itself; level *i* samples it every `step(i)` cells, which is the
   shader's arithmetic one indirection later.
4. Hide the replicant and drive two nearest-neighbour views. The level index
   comes from the same triangle as before (`2 → 52 → 2`), so it advances a
   little over one step per frame at 60 fps — finer than the eye follows, and
   the alpha crossfade underneath is continuous regardless. Old mosaic alpha is
   `1 − progress` over the full duration (Skia-style blend); the last ~15% fades
   the container so unmount does not pop.
5. The new-theme capture uses `afterScreenUpdates: true` (iOS) / an `invalidate`
   of the live trees (Android), which is only safe because the overlay already
   covers the screen — unlike `begin()`, where it would stall. Both skip our own
   copies: `OverlayWindow` on iOS, hidden `SnapshotView`s on Android.

Two ownership rules that are easy to break:

- **Android's `setMosaic` does not take ownership.** The ladder belongs to
  `Transition.mosaics` and is recycled once, after both views are detached. The
  old code recycled on assignment, which is correct for a freshly built frame
  per tick and catastrophic for a shared ladder — every level is needed again on
  the way back down the triangle.
- **A ladder build that finds its transition gone must still resolve the
  promise** and drop its bitmaps. It runs off the main thread, so it can always
  land after a teardown.

### 4c. Straight boundaries — `slide`, `split`, `barnDoor`, `blinds`, and `iris`

All four sweep kinds are "stop drawing the old screen on one side of a line",
and they differ only in how many lines there are and where they start:

| Kind | Boundaries | Motion |
| --- | --- | --- |
| `slide` | one | crosses the whole screen |
| `split` | two | start together at the middle, part to opposite edges |
| `barnDoor` | two | start at the edges, close on the middle |
| `blinds` | `bands` × 2 | each slab's own boundary crosses that slab, all at once |

`Sweep` (Swift) and `SweepGeometry.kt` hold the shared geometry — **keep them in
step**, or the platforms stop wiping identically. `halfPlane` covers the first
two; `slab` (a band between two parallel boundaries) covers the other two, and
is the only thing that had to be added for them.

The whole thing rests on one substitution. A half-plane is
`dot(p, n) >= threshold`, where `n` is a unit normal pointing the way the
surviving side lies; sweeping is then just moving `threshold` from one end of the
screen's projection onto `n` to the other. At the low end every corner satisfies
it, at the high end none do — **whatever the angle**. That is why `angleDeg` was
almost free to add, and why the sweep still ends fully uncovered when tilted:
it measures its own travel along its own normal rather than assuming the screen's
width or height.

Consequences worth knowing:

- **`angleDeg: 0` reduces exactly to the old rectangle clip.** Verified by
  algebra for all four directions, and Android still takes the plain `clipRect`
  path in that case because it is cheaper than a path clip and is the common one.
- **Positive is clockwise on screen.** The rotation is the standard matrix, which
  reads as clockwise here because y grows downward.
- **The quads deliberately overshoot the screen.** They are only ever used as a
  mask on a layer that clips to its own bounds. Intersecting the half-plane with
  the rectangle instead would change the point count as the line crossed each
  corner — which would break the interpolation the next point depends on.
- ⚠ **A slab must never close completely.** `blinds` and `barnDoor` both END with
  their bands at zero height, and a zero-area subpath has nothing to draw — so
  Core Graphics is free to drop it. That changes the path's STRUCTURE between the
  two ends of the animation, and Core Animation then interpolates points against
  the wrong subpath. The symptom is specific and worth recognising: **level
  louvres come out as slanted wedges**, because one corner of a band ends up
  paired with a corner of its neighbour. `Sweep.slab` keeps a hundredth of a
  point of thickness, which is far below one device pixel. This is the same trap
  the circle avoids by clamping its radius to `0.01` rather than `0` — the two
  fixes are the same fix, and anything new that collapses a subpath needs it
  too. Android is immune: it rebuilds the clip path per frame and never
  interpolates one, which is exactly why this shipped broken on one platform
  only.
- **iOS keeps this in Core Animation.** Both endpoints are the same structure (a
  4-point quad, or two of them), and only `threshold` differs, so a `path`
  animation interpolates it as a pure translation. The sweep is submitted once
  and nothing runs per frame — the property that a busy JS thread cannot stutter.
- **`direction` means the axis** for everything but `slide`, not an edge, since
  both edges are used. `top` and `bottom` are therefore the same, as are `left`
  and `right`.
- **`blinds` is capped at 2…24 slabs.** Below two it is a wipe; far above two
  dozen the louvres are thinner than the eye resolves and it degrades into a
  fade with extra path nodes.

#### `iris` — the same idea for the shape masks

`iris` is `circularReveal` with a different outline, and it carries one
constraint worth understanding because it is easy to break.

`circularReveal` animates a `path` from a big circle to a tiny one, and Core
Animation interpolates that **point by point**. So an outline built from arcs, or
from `UIBezierPath(roundedRect:cornerRadius:)`, is unusable: the number of
segments those emit depends on the radius, so the two endpoints would not match
and the interpolation would produce garbage.

Every shape in `IrisShape` is therefore a **fixed-vertex polygon** on the unit
circle, scaled by the radius — 4 points for the diamond, 6 for the hexagon, 32
sampled from a superellipse for the squircle, 48 for the circle. The vertex count
never changes, each vertex travels a straight line to the centre, and the reveal
stays a single submitted animation.

One subtlety: a polygon's **edges** sit closer to the centre than its vertices,
so scaling it to the furthest corner's distance would leave the corners poking
out at the start. `IrisShape.inradius` measures the largest disc that fits inside
the unit outline, and the radius is divided by it.

### 4d. The mask ladder — `dissolve`, `stripes`, `ripple`, `shatter`

Matches the Skia package's dissolve shader, which discards a pixel when its
cell's noise falls below the current threshold:

```
cell = floor(xy / grain)
n    = fract(sin(dot(cell, vec2(12.9898, 78.233))) * 43758.5453)
if (n < threshold) discard
```

`GrainMask` (Swift) and `DissolveGrain.kt` use the same hash, so the speckle
pattern matches. What makes it work **without a shader** is that the noise is
*static*: a cell's value never changes, so a cell simply has a fixed time at
which it disappears. Every frame the effect can ever draw is therefore knowable
up front, and the effect collapses into a pre-built stack of alpha masks —
`pixlated`'s ladder trick, one step further.

#### Why four kinds share one implementation

Nothing above depends on the value being NOISE. **Any per-cell number in 0…1 is a
valid disappearing order**, so four kinds differ only in how that number is
computed, and everything after `thresholds(for:)` is identical:

| Kind | Order | Depends on |
| --- | --- | --- |
| `dissolve` | the hash, unmodified | the grid |
| `stripes` | position along `direction`, roughened by 32% hash | grid + axis |
| `ripple` | distance from `origin`, with a sine riding on it | grid + origin |
| `shatter` | the hash of the nearest of 48 seeds — Voronoi cells | the grid |

Two numbers in there are load-bearing:

- **`stripes` mixes 32% hash into the position.** All position is just a wipe;
  all hash is just dissolve. The mix is what makes the leading edge ragged.
- **`ripple`'s sine amplitude must satisfy `2π · rings · amplitude < 1`.** That
  is the slope of the ripple against the slope of the base distance; go over it
  and cells further out clear *before* nearer ones, so the wavefront breaks up
  into rings that pop in and out. At 5 rings the ceiling is 0.032, and it is set
  to 0.028.

Because the order depends on more than the grid now, the ladder cache is keyed on
`(pattern, grid, axis, origin-cell)` and holds four entries rather than one. The
key deliberately zeroes the terms a pattern does not use, so a `dissolve` never
misses the cache because the user tapped somewhere new.

Three things follow, and they are the whole design:

- **The ladder is cached for the life of the process.** The masks depend only on
  the GRID, never on what was captured, so one ladder serves every dissolve and
  six concurrent transitions share the same images. Only the first dissolve at a
  given size pays for building it, and it pays off the main thread. **Nothing
  recycles these** — an owner that recycled its ladder would corrupt every other
  transition using it.
- **iOS runs it entirely on the render server.** A `CAKeyframeAnimation` on the
  mask layer's `contents` with `calculationMode = .discrete` submits all forty
  stills at once, so nothing runs per frame — the same guarantee as the reveals.
  `calculationMode` must stay `.discrete`: interpolating two noise masks
  cross-fades the specks into a haze. `pixlated` cannot do this because its two
  mosaics have to be cross-faded against each other; this one only ever shows
  one image.
- **Android costs one offscreen layer per frame.** A `clipPath` cannot express a
  per-cell alpha (it would need one subpath per surviving cell, thousands of
  them), so `onDraw` composites the mask with `DST_IN` inside a `saveLayer`. That
  is GPU work, not CPU work, and it is the price of the effect on this platform.

⚠ **The easing is applied exactly once, but in a different place per platform.**
Both ladders are built with LINEAR thresholds, so they are plain lookup tables.
Android then indexes with the already-eased `t` from the animator's
interpolator; iOS resamples the ladder onto a uniform keyframe timeline
(`DissolveGrain.keyframes(from:)`), because discrete keyframes hold each value
for an equal slice of the duration. Baking the curve into the ladder *as well*
would apply it twice, and the effect would visibly stall at the start.

### 4e. `liquidGlass` — a sliding sheet, iOS 26+

A sheet of glass comes down over the screen, **holds** while the theme changes
behind it, then goes back up the way it came. `UIGlassEffect` is iOS 26+, so
everything else — older iOS, and all of Android — falls back to `blur`.

#### ⚠ The hold is the whole design

Three beats, strictly in order: the sheet arrives, it stops, the old screen fades
out behind it, and only then does it leave. **Overlap the fade with either slide
and it stops being a sheet of glass doing a job and becomes a wipe again.**

That is the difference this kind took six attempts to find. The sheet never
reveals anything by passing over it — the old screen is still there, intact,
while it travels. What changes underneath happens while the glass is stationary.
A pane being drawn over a screen; not a mask sweeping across one.

#### Six rejected versions, and what they have in common

| Version | Why it was rejected |
| --- | --- |
| A band sweeping across | A wipe with a glass edge — the boundary revealed as it passed. |
| Eighteen small droplets blooming | At that size refraction reads as a rendering glitch, and on a dark theme the beads barely registered. |
| The same droplets, erasing rather than fading | Fixed the mud; the noise remained. |
| Five lobes bursting apart | Technically the most interesting, and still busy — five overlapping shapes give the eye nowhere to rest. |
| One pane opening from the touch | Simple at last, and still a shape crossing the screen. |
| A fixed lens, content collapsing behind it | The glass finally stopped moving, but the motion behind it read as a plain scale. |

Every one of the first five had **the glass revealing something as it moved**.
The current version is the first where the glass and the swap never happen at the
same time.

#### Two details worth keeping

**The sheet is taller than the screen, and only its BOTTOM corners are rounded**,
so it reads as a physical pane with a leading edge. The overhang keeps those
corners off screen while it is covering — without it they leave two lit notches
of the old theme showing through at the bottom of the screen during the swap.

**It uses `UIGlassEffect.Style.clear`, not `.regular`.** The regular style is a
frosted material: it hides what is behind it, which made the covered stretch read
as a flat grey panel and buried the very swap it is meant to be presenting. Clear
keeps the screen readable through the sheet and puts the emphasis on refraction
and the lit rim, which is what makes it look like glass rather than like a scrim.
The trade is that the fade underneath is genuinely visible now — that is the
point of the middle beat, but it does mean the swap can no longer hide behind
frost, which is another reason it must not overlap either slide.

## 5. How it works on Android

| Step    | API                                                                                       |
| ------- | ----------------------------------------------------------------------------------------- |
| Capture | `RenderNode` recording → `HardwareRenderer` → `ImageReader` → `Bitmap.wrapHardwareBuffer` |
| Host    | sibling of the RN root inside `android.R.id.content`, at child index 1                    |
| Animate | `ViewAnimationUtils` / `ValueAnimator`                                                    |

### ⚠ The trap — the capture must be rasterized

**This is the single most important thing in this document.** It cost a full
debugging cycle and it fails in a way that looks like a broken _animation_, not a
broken _capture_.

Recording the view into a `RenderNode` and drawing that node **does not work**:

```
View.draw(Canvas) → dispatchDraw → drawChild
   → canvas.drawRenderNode(child.renderNode)     // a REFERENCE, not pixels
```

On a hardware canvas each child is emitted as a _reference_ to its live
RenderNode. The result is a live mirror of the app: the moment the theme
changes, the "snapshot" changes with it. Every mask, clip and opacity animation
then plays over content identical to what is underneath, so **nothing appears to
happen** — except `blur`, where the effect itself is visible even though it is
blurring the wrong frame.

The symptom reported was exactly: _"none of the animations work, only blur, and
it's not perfect."_

The fix is step two: render the recording into an offscreen surface with
`HardwareRenderer`, which resolves every referenced RenderNode into real pixels,
then wrap the resulting `HardwareBuffer` as a hardware `Bitmap`. Still GPU-only —
nothing is read back to the CPU.

Below API 29 there is no public `HardwareRenderer`, so it falls back to a
software `Canvas`, which rasterizes for the same reason.

Per kind:

| Kind                    | Mechanism                                                                      |
| ----------------------- | ------------------------------------------------------------------------------ |
| `fade`                  | `ViewPropertyAnimator` → `alpha`, interpolated on the RenderThread             |
| `circularReveal`        | `ViewAnimationUtils.createCircularReveal` — RenderThread                       |
| `circularRevealInverse` | `Canvas.clipOutPath` in `onDraw` (no platform API for it)                      |
| `slide`                 | `Canvas.clipRect` when un-tilted, `clipOutPath` on a half-plane when not       |
| `split`                 | `Canvas.clipPath` over two half-planes (§4c)                                   |
| `blur`                  | `RenderEffect.createBlurEffect`, API 31+; below that, same motion without blur. `blurStyle` decides uniform vs swept |
| `pixlated`              | dual `SnapshotView` mosaics + alpha (see below)                                |
| `dissolve`              | pre-built `ALPHA_8` masks composited `DST_IN` in a `saveLayer` (§4d)           |

Two per-frame notes:

- **`fade` uses `ViewPropertyAnimator`, not `ValueAnimator`.** Alpha is a
  RenderNode property, so handing the whole animation to the platform means the
  UI thread does no per-frame work at all. It is also the fallback for every
  `pixlated` path that cannot complete, which is a second reason for it to be
  the cheapest thing here.
- **`blur` reassigns its `RenderEffect` only on whole-pixel steps.** The effect
  is not interpolatable, so the radius has to be re-set as it moves — but a
  sub-pixel step is invisible in a blur and each one allocates a native effect
  object and dirties the render node for nothing.

### `pixlated` on Android

Same visual contract and same pipeline as iOS (§4b). Differences that matter:

- Old frame comes from `SnapshotView.downscaledCopy()` — a hardware Bitmap
  cannot be sampled by the CPU, so it is rescaled through an offscreen GPU
  surface first and only the small result is read back.
- New frame via `captureNewTheme(...)`: temporarily hide all snapshot overlays
  (and their underlays), invalidate the live trees, then `SnapshotView.capture`
  of the RN root + any showing `ReactModalHostView` dialogs, **rasterized at the
  requested size** — `capture` takes `targetWidth`/`targetHeight` for exactly
  this.
- The window list is resolved **once** per transition, not per probe.
  `showingDialogs` walks the whole view tree; a dialog cannot appear and settle
  inside the dozen frames the poll lives for.
- `Transition.underlay` and `Transition.mosaics` are both cleaned in `stop()`,
  the ladders after the views are detached.

### `SurfacePool` — why captures stopped allocating

Each capture used to build its own `ImageReader` and `HardwareRenderer`. The
reader is the expensive half: at 1080×2400 its buffer is ~10 MB of graphics
memory, allocated and mapped **on the UI thread, inside the synchronous window
`begin()` holds the JS thread open for**. One theme change absorbs that; a user
flicking the toggle pays it every time, which is when the drop is most visible.

The screen size does not change between captures, so a returned lease is almost
always the right shape for the next one. Constraints worth keeping:

- A lease carries its `Image` until `SnapshotView.release()`, because
  `wrapHardwareBuffer` taking its own reference is not something every
  implementation can be trusted on. Closing the image is what frees the reader's
  only slot, so it happens in `recycle()` and never later.
- Idle leases are graphics memory doing nothing: at most two, only ones worth
  keeping (`MIN_POOLED_PIXELS` — the small ones `pixlated` uses are cheap to
  rebuild), all destroyed after 3 s without a theme change.
- Main thread only, like everything else here.

Other Android-specific details:

- **Z-order is child index.** In a `FrameLayout` at equal elevation, later
  children draw on top — hence `snapshot.elevation = root.elevation` and
  `addView(snapshot, 1)`. Without the elevation line a raised root would draw
  over its own snapshot.
- **dp → px.** JS reports `pageX/pageY` in dp; the View system works in px. The
  conversion happens natively so JS stays platform-agnostic. iOS points need no
  conversion, which is why the code only exists on this side.
- **`onMainSync` has a 250 ms timeout, and `begin()` does not use it.** The JS
  thread blocks on the main thread; if the main thread is too busy to service the
  post, the theme still changes, just instantly.

  ⚠ The timeout reports failure but **does not cancel the posted work**, so it is
  only safe for blocks whose side effect is *removal* — a late teardown still
  tears down, which is what the caller wanted. A late **capture** is a different
  story: it attaches a snapshot and sets `pending` after JavaScript has already
  been told there is none, so no `commit()` or `abort()` ever comes for it and a
  frozen copy of the screen stays pinned over the live app until the next theme
  change happens to clear it. `begin()` therefore has its own version, where the
  waiter and the capture race for the right to decide (`AtomicBoolean`) and the
  loser cleans up. Only reachable when the main thread is a quarter of a second
  behind — i.e. precisely the rapid-switching case.

## 6. Concurrency

Switching again mid-animation **cancels nothing**. Each change gets its own
snapshot and they play simultaneously:

```
iOS: OverlayWindow                   Android: android.R.id.content
  ├─ snapshot A  ← oldest, TOP-most      ├─ [2] snapshot A  ← oldest, TOP-most
  └─ snapshot B  ← next                  ├─ [1] snapshot B  ← next
     app window                          └─ [0] React Native root
       ├─ presentation container
       └─ rootViewController.view
```

Every snapshot reveals whatever is directly beneath it — which is exactly the
state the app was in one step later. So **newer snapshots go below older ones**,
and the stack stays consistent however fast the user taps.

This is also why the copies are kept out of what is captured — on iOS in a window
of their own, on Android as siblings of the RN root: a snapshot must contain the
live app _without_ the other snapshots, or each capture would bake in a frozen
copy of the animations still running above.

Capped at **six** (`maxOverlays` / `MAX_OVERLAYS`); past that the **oldest** is
dropped, because by then it is furthest through its animation and least visible.

The cap was briefly lowered to three on the theory that the overdraw was what a
fast tapper felt. It was not, and it went back: the overdraw is GPU work, the
cost that actually hurt under rapid switching was on the CPU (see §4b and the
`useStyles` note below), and dropping a copy early is a visible pop. Do not
re-litigate this without a profile.

## 7. Memory

Each snapshot is a full-screen GPU layer — on Android roughly **10 MB** at
1080×2400, so a full stack of three is ~30 MB transient, plus at most two idle
pooled surfaces (~20 MB) for three seconds after the last theme change.

`release()` frees the buffer immediately rather than leaving it to the garbage
collector:

- `bitmap.recycle()` — drops the Bitmap's reference
- returning the lease closes the `Image`, which hands the slot back to the
  reader, and then either parks the reader in `SurfacePool` for the next capture
  or closes it outright (see §5)

Order matters: `Transition.stop()` **detaches the views before releasing**, so
nothing can be asked to re-record a display list referencing a recycled bitmap.
`pixlated`'s mosaic ladders are recycled after that, for the same reason.

## 8. Integrating it

The package is deliberately unopinionated: it snapshots, runs a callback, and
animates the snapshot away. It knows nothing about themes, Unistyles, or React.
Every consumer therefore adds a thin policy layer of its own — see
[`example/src/theme/transition.ts`](./example/src/theme/transition.ts), which is
that layer written out in full and meant to be copied.

The pattern that has worked in two apps now:

| Layer         | Responsibility                                                      |
| ------------- | ------------------------------------------------------------------- |
| Policy module | Which kind, how long, where it starts, when to skip (Reduce Motion) |
| Theme setter  | Wraps its existing body in `withThemeTransition(...)`               |
| The control   | Parks the touch point for the reveal origin                         |

Four decisions worth copying:

1. **Wrap the WHOLE swap**, not just the style call. If the consumer also updates
   React state, that belongs inside the callback too, so the re-render happens
   under the snapshot and the reveal uncovers a settled screen.
2. **Do not animate startup rehydration.** There is no previous screen to reveal,
   and snapshotting a half-mounted app flashes over the first paint.
3. **Park the origin, don't thread it.** A theme change usually travels
   UI → store → styling runtime, and the press event is long gone by the time the
   theme is applied. Park the coordinate in a module variable and consume it
   once, with a short TTL (250 ms works) so a stale point can never be reused by
   an unrelated change.
4. **Switches need `onTouchStart`, not `onPress`.** A toggle reports only its new
   boolean. RN touch events bubble, so a wrapping row still sees the coordinate.
   A **native** SwiftUI/Compose control emits no RN touch at all, so measure the
   row instead — `measureInWindow` on a wrapper gives a usable origin.
5. **Pass the touch's `pageX/pageY` and let the native side place it.** RN
   reports touches relative to the surface they happened in, and a presented
   screen is its own surface. Do NOT try to convert in JavaScript — inside a
   sheet even `measureInWindow` reports positions in that sheet's surface, so
   every value the app can reach is already in the wrong space. See §4.

### The example app

`example/` is an Expo Router app whose job is to make each of these situations
observable rather than described. Its shape matters when changing anything here:

| Path                                | What it is for                                                     |
| ----------------------------------- | ------------------------------------------------------------------ |
| `src/theme/transition.ts`           | The policy layer — origin parking, Reduce Motion, `runThemed()`    |
| `src/theme/store.ts`                | A module-level store, so the setter is synchronous in the callback |
| `src/components/ui.tsx`             | The primitives, `TileGrid`, and `useStyles` — read the note below before touching it |
| `app/(drawer)/(tabs)/_layout.tsx`   | Native bottom tabs — native chrome that must re-tint in one commit |
| `app/(drawer)/(tabs)/cases/*`       | Sixteen case screens, one per situation                            |
| `app/modal.tsx` / `sheet.tsx`       | Router presentations — captured on both platforms                  |
| `example/README.md`                 | The map, and the table of what each case tests                     |

Four of the case screens exist specifically to keep this document honest:
`settle` (settle-frame tuning), `surfaces` (the Android live-mirror regression),
`availability` (every failure path) and `rotation` (an explicitly unverified
path, made reproducible rather than hidden).

### ⚠ A theme change re-renders the whole app — do not also rebuild its styles

The library's animation is immune to JS load, but the *consumer's* theme swap is
not, and the swap is the thing the user is waiting on. This is where a fast
tapper's stutter actually came from, and it was not in the library at all.

`useStyles` was `useMemo(() => factory(theme), [factory, theme])`. That memoises
per component **instance**, which is the wrong axis: a theme change invalidates
every one of those memos simultaneously, so the app rebuilt one full
`StyleSheet` per mounted component that reads styles. Thirty-nine call sites, of
twenty to forty entries each; a screen with sixty live instances rebuilt a couple
of thousand style objects per change — on the JS thread, at the exact moment the
JS thread also had to reconcile and commit the whole tree. Multiply by the tap
rate.

The results depend only on `(factory, theme)` and there are four themes, so they
are now cached on that pair (`WeakMap<factory, Map<ThemeName, sheet>>`). Each
sheet is built once for the life of the process. Components still re-render —
their colours genuinely changed — but the render is a map lookup, and the style
objects are referentially stable, which lets the renderer diff them cheaply too.

`useStackOptions` had the same shape and got the same treatment; those objects go
to a **native** navigator, which compares them to decide whether to re-apply the
header.

Two rules that keep this working:

- **Every `useStyles` caller must pass a module-level factory**, never an inline
  arrow. An inline one is a new key on every render, so nothing is ever cached
  and the `WeakMap` churns. All thirty-nine call sites currently pass the
  file's own `makeStyles` constant.
- **A factory must be a pure function of the theme.** It is now shared across
  every instance that asks for it, so anything instance-specific has to stay out
  of it — that is what the `style` prop is for.

This is what a real styling runtime (Unistyles, and every StyleSheet-based
library) does natively. The transition library does not care either way; it only
requires that the swap itself is synchronous.

### The effect grid — use `TileGrid`, not `Row`

`Row` defaults to `alignItems: 'center'`, which is wrong for a wrapping grid:
tiles float at their own height within each line, so a tile with a one-line hint
sits centred against a neighbour with three, leaving ragged gaps above and below
it. `TileGrid` is the same flex-wrap with `alignItems: 'stretch'`, so every tile
in a line takes the height of the tallest.

Two smaller rules that keep it tidy:

- **The selected tile must not change size.** It used to go from a 1px to a 2px
  border, which nudged every tile in the row by a pixel on selection — visible
  as a twitch precisely when the user is looking at it. The border width is now
  constant and only the colours change.
- **Hints are clamped to two lines** (`numberOfLines={2}`) and written short.
  A tile is a chip, not documentation; the long-form explanation belongs in the
  section under the grid, which is where the wipe's angle note went.

## 9. Verified vs not verified

Be honest about this line when handing over.

**Verified:**

- The example app builds and runs on an Android emulator; all six kinds render
  correctly in both directions, with the touch origin landing where expected
- **`pixlated` mid-transition colour swap.** Verified on iOS Simulator and
  Android Emulator: without the second-capture poll (and the JS double-rAF),
  old and new mean RGB were identical (`deltaSum ≈ 0`) so the crossfade was
  invisible and the theme appeared only on unmount. With the poll, the
  mosaics differ and the colour change is visible mid-pixelation on both
  platforms
- Six concurrent overlays with no crash, no flicker, and no `recycled bitmap`
  exceptions under rapid stacking
- iOS: `pod install` links the pod and `xcodebuild -scheme NitroThemeTransition`
  compiles; the effects were confirmed visually on a simulator recording
- Published tarball contents (`npm pack --dry-run`): 69 files including
  `nitrogen/generated/**`, `nitro.json`, `react-native.config.js` and the podspec
- Consumed cleanly from a second, unrelated app as a workspace package
- The rewritten Expo Router example: `tsc --noEmit` clean, `expo export` produces
  a bundle for **both** platforms, `expo prebuild --clean` regenerates the native
  projects and `pod install` links them
- **Modals are captured and animated on iOS.** Verified on an iPhone 16 Pro
  simulator: with a transparent RN `Modal` open and an 8000 ms reveal, the
  mid-animation frames contain the modal card and its dimming in the OUTGOING
  theme, with the incoming theme visible outside the reveal boundary. The same
  run confirmed `windows=1` and `presented=RCTFabricModalHostViewController`,
  so the modal is a presented view controller inside the app's only window
- **The origin is correct inside a presented sheet** when converted with
  `measureInWindow`. Verified with a marker view inside a form sheet: the reveal
  opens centred exactly on it
- **Short durations read as motion.** A 250 ms reveal recorded at 60 fps occupies
  ~14 consecutive frames with distinct intermediate states, after the easing
  change (§4)
- **The example now runs on an iOS simulator under automation** (`expo run:ios`,
  iPhone 16 Pro / iOS 18.6): it builds, installs, launches, reports
  `isThemeTransitionAvailable() === true`, and screenshots confirm the native tab
  bar, native stack headers, the case list, and `@expo/ui` pickers and sliders all
  re-tinting on a theme change. Tapping an effect tile plays a transition and
  selects the tile in the same commit

**Verified by the maintainer on BOTH platforms — all fifteen kinds.** This is the
only line in this section that covers real Android hardware; everything else
below was checked on an iOS simulator only.

**Verified on iOS — the effects added after the performance work** (same
simulator, transitions slowed to 2600–3000ms per the §14 recipe so intermediate
frames could be read):

- **`dissolve`** renders the grain: hard-edged specks of one cell size, randomly
  scattered, thinning out over the transition. Matches the reference shader's
  look
- **`split`** parts from the centre, in the right direction. The incoming band
  measured 0 → 8 → 60 → 84 px across consecutive frames on a fixed scanline, so
  the gap opens in the middle and the old screen retreats to both edges — not
  the inverse
- **`angleDeg` tilts the wipe.** At 40° with `direction: 'bottom'` the boundary
  is a clean straight diagonal with the outgoing theme surviving lower-left,
  which is where the rotated normal says it should be
- The Playground's new angle control renders and drives the setting
- **`shatter`** breaks the screen into irregular Voronoi shards that fall away in
  random order, over ~10 captured frames. That one run also stands for `stripes`
  and `ripple`: the three differ only in the threshold function, and everything
  after it is the same code
- **`zoom`**, **`blinds`** and **`iris`** all play and select correctly
- **`blinds` after the degenerate-slab fix** (§4c): six level, parallel louvres
  of uniform thickness, captured mid-sweep. Before the fix the same capture
  showed slanted wedges of varying thickness
- ⚠ **`liquidGlass` is NOT visually verified in its current form.** The lens
  version compiles and the earlier shape-based versions were each captured frame
  by frame, but synthetic input to the simulator stopped responding before this
  one could be recorded. Play it before trusting it

**Verified on iOS after the performance rewrite** (iPhone 17 Pro simulator,
iOS 26.5, `expo run:ios` against the working-tree pod):

- **The mosaic ladder looks right.** Mid-burst frames show hard, correctly-sized
  cells with no smearing, and the OS status bar stays crisp above the overlay
  (it is not part of the capture). 24 discrete levels are not distinguishable
  from the old continuous block size in motion
- **`pixlated` survives rapid switching.** Twelve transitions at ~5/second
  (196 ms apart, synthetic clicks) left the app responsive, on the right theme,
  with the right tile selected and no stranded overlay. Frames captured through
  the burst are all distinct — it animates rather than freezing
- **The style cache produces a correct, distinct sheet per palette.** Confirmed
  across light, dark and midnight; every primitive re-tints, including the
  native tab bar and its badge
- **Both mutations land in one commit.** Tapping an effect tile changes the theme
  *and* moves the selection under the same snapshot
- **Nothing in the system log.** No CoreAnimation path warnings, no
  *"Snapshot layer doesn't allow its contents to be set"*, no exceptions
- Both platforms compile (`compileDebugKotlin`; the pod via `xcodebuild`, with
  the new Swift symbols confirmed in `libNitroThemeTransition.a`) and
  `tsc --noEmit` is clean

**NOT verified — the performance rewrite specifically:**

The work was derived by reading the code against a reported symptom, not by
profiling, and the Android half was not run at all. Still open:

- **The Android internals**, beyond the maintainer's visual pass: the GPU
  downscale, `SurfacePool` reuse and the `begin()` abandonment race are all
  code paths whose failure modes are memory- or timing-shaped rather than
  visible. Reusing an `ImageReader` and a `HardwareRenderer` across captures is
  the intended API contract, but the original code's belt-and-braces comment
  about holding the reader open suggests someone hit an implementation quirk
  here before
- **`dissolve`'s `saveLayer` cost on Android specifically.** It is one
  full-screen offscreen render target per frame, which is the price of an
  arbitrary alpha mask on this platform — but it has not been measured, and it
  is the one place in the library that knowingly adds per-frame GPU work
- **`split` and the angled `slide` on Android** use `clipPath` rather than
  `clipRect`. Path clipping is stencil work on a hardware canvas; fine in
  principle, unmeasured in practice
- **A measured frame profile.** The simulator confirms it does not stutter or
  strand; it is not a substitute for Instruments or Systrace on a real low-end
  device, and it cannot tell you how much of the remaining `begin()` cost is the
  GPU present wait versus the consumer's own re-render
- **The divergence threshold still discriminates.** Both means now come from
  grid-sized buffers, which should make the comparison *more* reliable than
  before, but "delta ≥ 12" was tuned against the old full-resolution sampling
- **The poll budget on a much larger React tree.** Six attempts was enough here;
  the example is not a big app

**NOT verified — pre-existing:**

- The drawer's header button. Synthetic clicks landed on the screen body but never
  on either header button, so `openDrawer()` was never exercised — the button
  tries `openDrawer()` and falls back to `DrawerActions.openDrawer()`, and both
  paths still want a human tap
- Everything below the surface of the other case screens: they render, but the
  behaviours they demonstrate (Reduce Motion, stacking, keyboard, rotation) were
  not individually driven
- The API < 29 software-capture fallback (no device that old was used)
- The API 24/25 `Region.Op.DIFFERENCE` path for the inverse reveal
- Device rotation _during_ a transition
- Multi-window / foldable / picture-in-picture on Android
- Any measured GPU or memory profile on a low-end device

## 10. Known limitations

- **System windows are never captured** on either platform: alerts, share sheets,
  autofill, the keyboard. They are drawn above the app's window by the OS.
- **Android `Modal` is best-effort.** Capture walks `ReactModalHostView` dialogs
  and hosts overlays on the topmost decor; verify after RN upgrades. On iOS a
  presentation lives in the app window and the composed capture includes it
  (see §4).
- **Content under the overlay is frozen** for the duration. The app is _not_
  blocked — the live app runs underneath and touches pass straight through — but
  the still-covered region shows pixels from capture time. Visible only if
  something underneath moves (scroll momentum, a spinner) and only at longer
  durations. Imperceptible at the default 650 ms. `pixlated` may hold a few
  extra frames while waiting for the new-theme capture to diverge.
- **Reduce Motion is the app's job**, not the library's — handled in the
  policy layer (`example/src/theme/transition.ts`).
- **Web is a no-op**: the callback runs, the change is instant.

## 11. Maintenance

### ⚠ The example must build the REPO's native code, not a copy of it

**Read this before debugging anything native through the example app.**

`example/package.json` declares the library as `file:..`. `bun install`
materialises that as a **copy** inside its store:

```
node_modules/.bun/react-native-nitro-theme-transition@root/node_modules/react-native-nitro-theme-transition
```

CocoaPods then compiles *that copy*. Editing `ios/HybridThemeTransition.swift` in
the repo changes nothing the app builds — the pod keeps compiling the snapshot
taken at install time. Rebuild all you like: the app runs the old implementation,
silently.

This cost a full debugging cycle. Three separate "fixes" for the modal capture
were written, built and tested against native code that was **never compiled**;
the symptom looked exactly like each fix having no effect, so the code was
rewritten twice more for a bug that had already been fixed the first time.

`example/react-native.config.js` is the guard:

```js
module.exports = {
  dependencies: {
    'react-native-nitro-theme-transition': { root: path.resolve(__dirname, '..') },
  },
};
```

Autolinking then points the pod at the working tree, and `Podfile.lock` says
`NitroThemeTransition (from ../..)` instead of a path under `node_modules/.bun`.
**Check that line** whenever a native change appears to do nothing:

```sh
grep NitroThemeTransition example/ios/Podfile.lock
```

The same trap applies to the JS side: Metro still resolves the package through
`node_modules`, so `lib/` there is whatever `bun install` copied. Run
`bun run build` and reinstall if a JS-side change also seems to vanish.

Two smaller variants of the same mistake, both seen in this session:

- **`expo run:ios` installs a new binary but does not always restart a running
  app** — the old process keeps its loaded code. `xcrun simctl terminate` first
  when verifying a native change.
- A quick way to confirm what actually shipped:
  `strings <app>/ThemeTransition.debug.dylib | grep <a symbol you just added>`.

### Nitro version coupling — read before upgrading

The generated bridge is **version-coupled to the runtime**. `nitrogen` must match
the consumer's `react-native-nitro-modules` — not merely "a recent version".

|                     | Version                                                |
| ------------------- | ------------------------------------------------------ |
| This repo           | generated with `nitrogen@0.36.5`                       |
| SpeedyHire (vendor) | pinned to `0.35.4`, regenerated with `nitrogen@0.35.4` |

That is the reason the package declares `react-native-nitro-modules` as a **peer**
dependency with a floor (`>=0.36.0`) rather than pinning it: an app on an older
Nitro must regenerate rather than be forced to upgrade. The 0.35 ↔ 0.36 API shape
happened to be identical, so the hand-written Swift/Kotlin needed no changes — do
not assume that holds for future bumps.

### After changing the spec

```sh
bun install          # ⚠ FIRST — see below
bun run codegen      # nitrogen — regenerates nitrogen/generated
bun run build        # bob — rebuilds lib/ from src/
bun install          # again, so the example's copy of lib/ is current
cd example && bun run prebuild
```

#### ⚠ `bun install` before codegen, or nitrogen regenerates the OLD spec

Nitrogen globs for `*.nitro.ts`, and it finds **two** copies:

```
🔍  Nitrogen found 1 spec in ./src/specs
🔍  Nitrogen found 1 spec in ./example/node_modules/react-native-nitro-theme-transition/src/specs
```

The second is bun's materialised copy of this package (§11 again, in a new
disguise). It is a real directory, not a link back to the working tree, so it
holds the spec as it was at install time — and it is parsed **last**, so its
output is what lands in `nitrogen/generated`.

The symptom is worth recognising because it looks like nothing at all: codegen
reports success, `Generated 2/2 HybridObjects`, and the generated enum simply
does not contain the case you just added. Adding two kinds and an option to the
spec produced a completely unchanged `ThemeTransitionKind.kt` the first time.

`bun install` re-materialises the copy from the working tree, after which both
parses agree and the output is correct. Check it landed:

```sh
grep -c DISSOLVE nitrogen/generated/android/kotlin/com/margelo/nitro/nitrothemetransition/ThemeTransitionKind.kt
```

`lib/` is build output and is gitignored; `prepare` runs `bob build` on publish,
so a stale `lib/` can never ship.

`nitrogen/generated/` is committed on purpose — CocoaPods needs it at
`pod install` time and Gradle at sync time. It looks like build output; it is
not optional.

### The example's own dependencies

The example is no longer a single file. It pulls in Expo Router, native tabs
(`react-native-screens`), a drawer (`react-native-gesture-handler` +
`react-native-reanimated`/`react-native-worklets`), `@expo/ui`, `expo-image`,
`expo-blur`, `expo-symbols`, `expo-haptics` and `expo-system-ui` — all of which
have a native side. After pulling, `bun install && bun run prebuild` is required,
not optional.

Two constraints that will bite otherwise:

- **Do not import `@react-navigation/*` directly.** Expo Router vendors it as of
  SDK 56 and throws a build-time error on a direct import. Use
  `expo-router/drawer` and `expo-router/react-navigation` instead.
- **`babel-preset-expo` is a declared devDependency** of the example. With bun's
  isolated `node_modules`, an explicit `babel.config.js` cannot resolve a preset
  that is only a transitive dependency.

None of this reaches the published package: the library itself still depends on
nothing but Nitro.

### Build artefacts

`android/build/`, `android/.cxx/` and `example/android|ios/` are gitignored — the
example's native projects are regenerated with `expo prebuild`. If you ever see
~185 stray CMake files in `git status`, the `.cxx` pattern has been broken.

The three demo GIFs in `assets/` are deliberately **excluded from the `files`
allowlist**, so they are not downloaded on every `npm install`. The README
references them by absolute raw URL so they still render on npmjs.com.

## 12. Future work

Roughly in priority order.

1. **Drive the example's cases automatically.** `expo run:ios` now boots the app
   on a simulator and screenshots confirm it renders, but nothing presses the
   buttons: synthetic clicks reach the screen body and not the native header. A
   real UI-test target (XCUITest, or Maestro) would close the gap — and the
   sixteen case screens exist precisely so that such a suite has something
   deterministic to drive.
2. **Reduce Motion inside the library.** Currently every consumer must remember
   to check `AccessibilityInfo`. Safer as an opt-out default in `withThemeTransition`.
3. **Handle rotation mid-transition.** The snapshot is laid out to the root's
   bounds at capture time and does not follow a configuration change. Likely
   correct behaviour: abort the transition on rotation.
4. **Test the low-API paths**, or raise `minSdk` expectations and delete them. The
   software fallback and the `Region.Op.DIFFERENCE` branch are currently
   untested code shipping to users.
5. **`Modal` support on Android.** Largely done via `ReactModalHostView` /
   dialog decor capture — re-verify after RN upgrades. iOS presentations were
   already covered by window/screen capture (§4).
6. **Stress `pixlated` under load.** Confirm the second-capture poll still
   converges when the JS thread is saturated (adjacent to the settle-frames
   story in §14). The poll budget is now six attempts over ~12 frames rather
   than 24 — the same tolerance in wall-clock terms, but worth re-checking on a
   large React tree.
7. **Measure, rather than reason about, the remaining cost.** The pixelize work
   was found by reading the code, not by profiling it. A Systrace of `begin()`
   would say how much of the residual hitch is the GPU present wait, how much is
   the dialog tree walk, and how much is the consumer's own re-render — which is
   the difference between more work here and none.

## 13. Enhancement ideas

- **Configurable easing.** The curve is hard-coded to a cubic `(0.4, 0, 0.2, 1)`
  in both implementations so the platforms agree. Exposing it per call is a small
  spec change.
- **Capture a specific view** instead of the whole root — useful to keep a header
  or tab bar live while the body transitions.
- **Expose completion.** `commit()` already returns a `Promise`;
  `withThemeTransition` currently swallows it. Surfacing an `onDone` would let
  callers chain.
- **More kinds** — diagonal wipe, iris with configurable shape, per-corner reveal
  (`pixlated` / Skia-style pixelize already shipped).
- **An origin helper in the library.** Every consumer re-implements the
  park-the-touch-point dance; it could ship as `useTransitionOrigin()`.
- **Duration per kind.** A wipe reads well slightly slower than a fade; one
  constant for all six is a compromise.
- **Automated verification.** Native screenshot tests comparing mid-animation
  frames would have caught the Android live-mirror bug immediately — and the
  stale `pixlated` second capture.

## 14. Debugging recipes

**"The animation doesn't play, the theme just snaps."**
Check `isThemeTransitionAvailable()`. It returns `false` when the native module
is missing — almost always a JS bundle running against a native binary built
before the package was added. Rebuild.

**"It plays, but nothing seems to move."**
On Android, suspect the capture. Log whether the GPU path succeeded; if the
snapshot is a live mirror again (see §5) every kind except `blur` looks like a
no-op.

**"The reveal plays but nothing changes, then the theme snaps in afterwards."**
JavaScript was blocked before the new state could paint. The animation is immune
to JS load; the *callback's effect* is not. A React-driven theme needs the JS
thread free for the settle window (~50 ms) after the callback returns — block it
in the same tick and the copy peels away over a screen that has not changed yet,
so the change appears only when the thread frees up. Verified by recording the
simulator: blocking 3 s immediately produced a single changing frame, while
blocking 3 s starting 150 ms later left the full reveal visible across 14 frames.
A synchronous native applier (Unistyles) does not have this problem.

**"`pixlated` only pixels, then the theme snaps at the end."**
The second capture still matched the first (stale new theme). Confirm:

1. JS double-`rAF` before `commit` for `pixlated` is still in `src/index.ts`.
2. Native poll-until-mean-differs is still in `animatePixlated` on both
   platforms.
3. Never assign `layer.contents` on an iOS `_UIReplicantView`.
4. Raise `settleFrames` for large React trees (3–4), same as other kinds.
5. Both means still come from grid-sized buffers. Comparing a mean taken at one
   rasterisation scale against one taken at another compares two sampling
   biases as well as the colours, and the difference can sit near the delta
   threshold.

If old≈new persists past the poll budget (6 attempts, ~12 frames), the live tree
is not repainting under the overlay — dig into the consumer's theme apply path,
not the mosaic.

**"`pixlated` is the only kind that stutters."**
Something in it has gone back to working at screen resolution. Check, in order:
the outgoing capture goes through `mosaicCapture` / `downscaledCopy` at the grid
size; `captureNewTheme` is being passed a target size; the ladder is built once
off the main thread and the per-frame closure only assigns an image. See the
table in §4b for what each of those replaced.

**"The old colours flash back mid-animation."**
`settleFrames` is too low for the consumer's theme system. Default 2 suits a
synchronous applier like Unistyles; a React-state-driven theme needs 3–4 because
the callback only _schedules_ the re-render.

**Watching a transition frame by frame:**

```sh
adb exec-out screencap -p > f1.png   # repeat during the animation
ffmpeg -i f%1d.png -vf "scale=200:-1,tile=5x1" strip.png
```

Temporarily raising `durationMs` to ~3000 makes every stage obvious — this is how
both the live-mirror bug and the missing settle-hold were found.
