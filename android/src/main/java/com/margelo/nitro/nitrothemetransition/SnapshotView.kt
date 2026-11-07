package com.margelo.nitro.nitrothemetransition

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.ColorSpace
import android.graphics.HardwareRenderer
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.RectF
import android.graphics.RenderNode
import android.graphics.Region
import android.hardware.HardwareBuffer
import android.media.Image
import android.media.ImageReader
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.View
import androidx.annotation.RequiresApi

/**
 * A frozen copy of the app, drawn with a clip that shrinks over the transition.
 *
 * ── Why a copy at all ──
 * A Unistyles theme change is a whole-app style re-evaluation plus a shadow-tree
 * commit, synchronous on the JS thread. It cannot be animated frame by frame. So
 * the theme swap stays exactly as it is, and the ANIMATION runs on a copy of the
 * screen laid over the live app.
 *
 * ── Why the copy has to be rasterized ──
 * The obvious capture — record the view into a [RenderNode] with
 * `view.draw(recordingCanvas)` — DOES NOT WORK, and fails in a way that looks
 * like the animation is broken rather than the capture.
 *
 * `View.draw(Canvas)` delegates to `dispatchDraw` → `drawChild`, and on a
 * hardware canvas each child is emitted as `drawRenderNode(child.renderNode)` —
 * a REFERENCE to the child's live RenderNode, not a copy of its pixels. The
 * result is a live mirror of the app: the moment the theme changes, the
 * "snapshot" changes with it. Every mask, clip and opacity animation then plays
 * over content identical to what is underneath, so nothing appears to happen at
 * all — except `blur`, where the effect itself is visible even though it is
 * blurring the wrong frame.
 *
 * So the recording is only step one. Step two renders it into an offscreen
 * surface with [HardwareRenderer], which resolves every referenced RenderNode
 * into actual pixels, and the resulting [HardwareBuffer] is wrapped as a hardware
 * [Bitmap]. That bitmap is a genuine frozen frame, it lives in GPU memory, and it
 * is never read back to the CPU — the Android counterpart of iOS's
 * `snapshotView(afterScreenUpdates:)`.
 *
 * Below API 29 there is no public `HardwareRenderer`, so it falls back to a
 * software `Canvas` — which rasterizes for the same reason, since a software
 * canvas cannot reference RenderNodes and has to draw the pixels. That costs one
 * full-screen software draw at capture time; the animation itself is GPU-side
 * either way.
 */
@SuppressLint("ViewConstructor")
internal class SnapshotView(context: Context) : View(context) {

  /** Which clip [onDraw] applies. */
  enum class Clip {
    /** Draw everything — used by `fade` and `blur`, which animate the view itself. */
    NONE,

    /** A growing hole at ([holeX], [holeY]) — `circularRevealInverse`. */
    HOLE,

    /** A shrinking rect — `slide` at [sweepAngleDeg] `== 0`, which is a wipe. */
    WIPE,

    /**
     * Any arrangement of straight boundaries — one receding half-plane (`slide`
     * at an angle), two parting from the centre (`split`), two closing on it
     * (`barnDoor`), or a row of slabs (`blinds`). See [SweepGeometry].
     */
    SWEEP,

    /** A shrinking polygon at ([holeX], [holeY]) — `iris`. */
    IRIS,
  }

  /** Which arrangement of boundaries [Clip.SWEEP] draws. */
  enum class SweepMode {
    WIPE,
    SPLIT,
    BARN_DOOR,
    BLINDS,
  }

  private var bitmap: Bitmap? = null

  /**
   * Optional mosaiced frame drawn instead of [bitmap] during `pixlated`.
   *
   * NOT owned by this view. The frames come from a pre-built ladder that the
   * transition owns and recycles once, at teardown — the animation only ever
   * points at one of them, so recycling on assignment (as this used to do) would
   * destroy a frame the next level still needs.
   */
  private var mosaic: Bitmap? = null

  private val mosaicPaint =
    android.graphics.Paint().apply {
      // Nearest-neighbour so stretched mosaic cells stay blocky.
      isFilterBitmap = false
    }

  /** Bilinear, because this one is shrinking a photo of the screen, not a mosaic. */
  private val downscalePaint =
    android.graphics.Paint().apply {
      isFilterBitmap = true
      isAntiAlias = true
    }

  /**
   * Keeps the snapshot only where the dissolve mask is still opaque. The mask is
   * ALPHA_8, so `DST_IN` reduces to "multiply the snapshot by the mask's alpha".
   */
  private val dissolvePaint =
    android.graphics.Paint().apply {
      xfermode = android.graphics.PorterDuffXfermode(android.graphics.PorterDuff.Mode.DST_IN)
      // Each grain cell must stay a hard speck, not a smudge.
      isFilterBitmap = false
      isAntiAlias = false
    }

  /** Reused by [onDraw]; allocating there is the classic way to cause a stutter. */
  private val destination = android.graphics.Rect()

  /**
   * The reader and image backing [bitmap], held for the lifetime of the snapshot.
   *
   * [Bitmap.wrapHardwareBuffer] takes its own reference to the underlying buffer,
   * but keeping the reader and image open until [release] means the frame cannot
   * be recycled out from under us on any implementation. Returned to
   * [SurfacePool] rather than destroyed, so a burst of theme changes stops
   * allocating a full-screen graphics buffer per capture.
   */
  private var lease: SurfacePool.Lease? = null

  /**
   * Size of the captured content, in px.
   *
   * Geometry is measured against THIS rather than the view's own `width`/
   * `height`: the overlay is configured the moment it is created, and a freshly
   * added view has not been laid out yet, so its own size is still zero.
   */
  private var contentWidth = 0
  private var contentHeight = 0

  /**
   * Size of [bitmap] itself, which is only different from the content size when
   * a caller asked for a downscaled rasterization — see [capture].
   */
  private var bitmapWidth = 0
  private var bitmapHeight = 0

  /** Size of the captured content, in px — valid as soon as [capture] succeeds. */
  val capturedWidth: Int
    get() = contentWidth

  val capturedHeight: Int
    get() = contentHeight

  var clip = Clip.NONE
  var direction = ThemeTransitionDirection.BOTTOM
  var holeX = 0f
  var holeY = 0f

  /**
   * The sweep, resolved once by [prepareSweep] rather than per frame — the
   * normal and the travel range depend only on the direction, the angle and the
   * size, none of which move during the animation.
   */
  private var sweepNormalX = 0f
  private var sweepNormalY = 1f
  private var sweepMin = 0f
  private var sweepMax = 0f
  private var sweepMode = SweepMode.WIPE
  private var sweepBands = 6

  /** Unit outline for [Clip.IRIS], as x/y pairs. Set by [prepareIris]. */
  private var irisPolygon: FloatArray = FloatArray(0)

  /** Radius at which the outline still covers the whole frame. */
  private var irisRadius = 0f

  /** Whether the outline is a growing hole (`circularRevealInverse`) rather than a shrinking mask. */
  private var irisInverse = false

  /**
   * The current `dissolve` mask — a small ALPHA_8 grid stretched over the
   * snapshot, punching out the cells that have already disintegrated.
   *
   * Not owned here: the frames come from a ladder shared by every dissolve in
   * the process. See [DissolveGrain].
   */
  var dissolveMask: Bitmap? = null
    set(value) {
      if (field === value) return
      field = value
      invalidate()
    }

  /**
   * How far through the clip animation, 0..1, already eased by the animator's
   * interpolator. Setting it invalidates — which for a single bitmap draw is a
   * re-issue of one draw op with a different clip, not a real redraw.
   */
  var progress = 0f
    set(value) {
      field = value
      if (clip != Clip.NONE) invalidate()
    }

  /** Longest distance from the hole centre to a corner — the radius that covers all of it. */
  var holeMaxRadius = 0f
    private set

  // Reused every frame; allocating in onDraw is the classic way to make a smooth
  // animation stutter.
  private val clipPath = Path()
  private val clipRect = RectF()

  init {
    // Touches fall through to the live app underneath, which is already on the
    // new theme and is what the user means to hit.
    isClickable = false
    isFocusable = false
    setWillNotDraw(false)
  }

  /**
   * Tells Android the content never overlaps itself, so `alpha` is applied as a
   * plain colour filter on the single draw op instead of being routed through an
   * offscreen layer. Correct here by construction: the snapshot is one bitmap.
   */
  override fun hasOverlappingRendering(): Boolean = false

  /**
   * One window's contribution to the copy.
   *
   * A `Dialog` — which is what React Native's `Modal` is — lives in a window of
   * its own, so it is not inside the activity's view tree and cannot be captured
   * by drawing that tree. Each window is recorded separately and placed at its
   * position relative to the activity's window, which is what makes the finished
   * copy look like the screen.
   */
  data class Layer(val view: View, val offsetX: Int, val offsetY: Int)

  /**
   * Copies [layers] into this view, composed into one frame of [width] x [height]
   * px. Returns false if nothing could be captured, in which case the caller must
   * fall back to an instant theme change.
   *
   * [targetWidth] / [targetHeight] rasterize the same composition at a different
   * resolution. That is not a quality knob — it is what makes `pixlated`'s
   * new-theme polling affordable: the mosaic is never finer than one cell per
   * two dp, so it asks for roughly 1/36 of the screen's pixels and the readback
   * that follows shrinks with them. The default renders 1:1, which is what a
   * real snapshot wants.
   */
  fun capture(
    layers: List<Layer>,
    width: Int,
    height: Int,
    targetWidth: Int = width,
    targetHeight: Int = height,
  ): Boolean {
    if (width <= 0 || height <= 0 || layers.isEmpty()) return false
    if (targetWidth <= 0 || targetHeight <= 0) return false

    contentWidth = width
    contentHeight = height
    bitmapWidth = targetWidth
    bitmapHeight = targetHeight

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      bitmap = captureOnGpu(layers, width, height, targetWidth, targetHeight)
      if (bitmap != null) return true
    }

    bitmap = captureOnCpu(layers, width, height, targetWidth, targetHeight)
    return bitmap != null
  }

  /**
   * Draws every layer into [canvas] at its own offset.
   *
   * Order is the order the windows stack on screen: the activity first, then each
   * dialog above it.
   */
  private fun drawLayers(canvas: Canvas, layers: List<Layer>) {
    for (layer in layers) {
      if (layer.view.width <= 0 || layer.view.height <= 0) continue

      val save = canvas.save()
      try {
        canvas.translate(layer.offsetX.toFloat(), layer.offsetY.toFloat())
        layer.view.draw(canvas)
      } finally {
        canvas.restoreToCount(save)
      }
    }
  }

  /**
   * Records [source] and rasterizes the recording into a GPU buffer — see the
   * class comment for why the rasterization is not optional.
   */
  @RequiresApi(Build.VERSION_CODES.Q)
  private fun captureOnGpu(
    layers: List<Layer>,
    width: Int,
    height: Int,
    targetWidth: Int,
    targetHeight: Int,
  ): Bitmap? =
    runCatching {
        val node = RenderNode("ThemeTransitionSnapshot")
        node.setPosition(0, 0, targetWidth, targetHeight)
        val recording = node.beginRecording()
        try {
          if (targetWidth != width || targetHeight != height) {
            recording.scale(targetWidth.toFloat() / width, targetHeight.toFloat() / height)
          }
          drawLayers(recording, layers)
        } finally {
          node.endRecording()
        }

        val lease = SurfacePool.obtain(targetWidth, targetHeight)

        val captured =
          try {
            render(lease, node, targetWidth)
          } finally {
            node.discardDisplayList()
          }

        if (captured == null) {
          SurfacePool.recycle(lease)
        } else {
          // Held for the lifetime of the snapshot, and returned to the pool by
          // `release()` — see the field comments.
          this.lease = lease
        }

        captured
      }
      .getOrNull()

  /**
   * Draws [node] into [lease]'s surface and wraps the result as a hardware
   * Bitmap, leaving the acquired [Image] on the lease for the caller to own.
   */
  @RequiresApi(Build.VERSION_CODES.Q)
  private fun render(lease: SurfacePool.Lease, node: RenderNode, lightWidth: Int): Bitmap? {
    lease.renderer.setContentRoot(node)
    applyLightSource(lease.renderer, lightWidth)

    // Blocks until the frame is presented, so the image is ready to acquire. A
    // few milliseconds of GPU wait, against a full-screen software
    // rasterization on the alternative path.
    lease.renderer.createRenderRequest().setWaitForPresent(true).syncAndDraw()

    val image = lease.reader.acquireNextImage()
    if (image == null) {
      // The frame was drawn but never handed over, so the reader's only slot may
      // still be occupied. Reusing it could block the next `syncAndDraw`
      // forever, so this one does not go back in the pool.
      lease.faulted = true
      return null
    }

    val buffer = image.hardwareBuffer

    if (buffer == null) {
      image.close()
      return null
    }

    lease.image = image
    return buffer.use { Bitmap.wrapHardwareBuffer(it, ColorSpace.get(ColorSpace.Named.SRGB)) }
  }

  /**
   * Matches `ThreadedRenderer`'s own light source, so views with elevation cast
   * the same shadows in the capture as they do on screen. Without it they render
   * flat, and the snapshot does not quite match the frame it replaces.
   */
  @RequiresApi(Build.VERSION_CODES.Q)
  private fun applyLightSource(renderer: HardwareRenderer, width: Int) {
    val density = resources.displayMetrics.density

    renderer.setLightSourceGeometry(
      width / 2f,
      -LIGHT_Y_DP * density,
      LIGHT_Z_DP * density,
      LIGHT_RADIUS_DP * density,
    )
    renderer.setLightSourceAlpha(AMBIENT_SHADOW_ALPHA, SPOT_SHADOW_ALPHA)
  }

  /** API 28 and below. A software canvas has to rasterize, which is what we want. */
  private fun captureOnCpu(
    layers: List<Layer>,
    width: Int,
    height: Int,
    targetWidth: Int,
    targetHeight: Int,
  ): Bitmap? =
    runCatching {
        val bitmap = Bitmap.createBitmap(targetWidth, targetHeight, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        if (targetWidth != width || targetHeight != height) {
          canvas.scale(targetWidth.toFloat() / width, targetHeight.toFloat() / height)
        }
        drawLayers(canvas, layers)
        bitmap
      }
      // An OOM on a full-screen bitmap is survivable: skip the animation.
      .getOrNull()

  /** Precomputes the reveal radius. Requires [capture] to have run. */
  fun prepareHole(x: Float, y: Float) {
    holeX = x
    holeY = y
    val w = contentWidth.toFloat()
    val h = contentHeight.toFloat()

    holeMaxRadius = maxOf(hypot(x, y), hypot(w - x, y), hypot(x, h - y), hypot(w - x, h - y))
  }

  private fun hypot(x: Float, y: Float) = kotlin.math.hypot(x.toDouble(), y.toDouble()).toFloat()

  /**
   * A small software copy of the frozen frame, for CPU sampling (`pixlated`).
   *
   * ── Why it is scaled on the GPU first ──
   * A hardware Bitmap cannot be read by the CPU at all, so it has to be copied
   * into ARGB_8888 — and that copy is a GPU→CPU readback, which stalls the UI
   * thread for as long as it takes to pull the pixels back across the bus. At
   * full screen that is ~10 MB, and it used to happen on every poll attempt.
   *
   * So the frame is first re-rendered at the requested size through the same
   * offscreen path the capture uses (a `drawBitmap` into a small RenderNode, on
   * the GPU where the pixels already live), and only that result is read back.
   * The mosaic never needs more than one cell per two dp, so the readback drops
   * by roughly 36x with no visible difference.
   */
  fun downscaledCopy(targetWidth: Int, targetHeight: Int): Bitmap? {
    val source = bitmap ?: return null
    if (targetWidth <= 0 || targetHeight <= 0) return null

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      gpuDownscale(source, targetWidth, targetHeight)?.let { return it }
    }

    // Software path: either an old API level, or the GPU rescale failed. A
    // hardware bitmap still has to come back through a full-size copy first.
    return runCatching {
        val readable =
          if (source.config == Bitmap.Config.HARDWARE) {
            source.copy(Bitmap.Config.ARGB_8888, false) ?: return@runCatching null
          } else {
            source
          }
        val scaled = Bitmap.createScaledBitmap(readable, targetWidth, targetHeight, true)
        if (readable !== source && readable !== scaled) readable.recycle()
        scaled
      }
      .getOrNull()
  }

  /**
   * A software copy of the captured frame, exactly as it was rasterized.
   *
   * A hardware Bitmap cannot be read by the CPU, so this is a GPU→CPU readback
   * and costs in proportion to the frame's size — which is why the only callers
   * are ones that already asked [capture] to rasterize small.
   */
  fun readPixels(): Bitmap? {
    val source = bitmap ?: return null
    return runCatching { source.copy(Bitmap.Config.ARGB_8888, false) }.getOrNull()
  }

  /** Rescales [source] through an offscreen GPU surface and reads back the result. */
  @RequiresApi(Build.VERSION_CODES.Q)
  private fun gpuDownscale(source: Bitmap, targetWidth: Int, targetHeight: Int): Bitmap? =
    runCatching {
        val node = RenderNode("ThemeTransitionMosaicSource")
        node.setPosition(0, 0, targetWidth, targetHeight)
        val recording = node.beginRecording()
        try {
          recording.drawBitmap(
            source,
            null,
            android.graphics.Rect(0, 0, targetWidth, targetHeight),
            downscalePaint,
          )
        } finally {
          node.endRecording()
        }

        val lease = SurfacePool.obtain(targetWidth, targetHeight)
        try {
          val frame = render(lease, node, targetWidth) ?: return@runCatching null
          val copy = frame.copy(Bitmap.Config.ARGB_8888, false)
          if (!frame.isRecycled) frame.recycle()
          copy
        } finally {
          node.discardDisplayList()
          SurfacePool.recycle(lease)
        }
      }
      .getOrNull()

  /**
   * Prepares this view as a mosaic-only overlay (no GPU capture). Used for the
   * underlay in `pixlated` — size matches the outgoing snapshot.
   */
  fun prepareMosaicSurface(width: Int, height: Int) {
    contentWidth = width
    contentHeight = height
  }

  /**
   * Draws [frame] instead of the captured bitmap.
   *
   * Does NOT take ownership. Frames come from a pre-built ladder the transition
   * owns for the length of the animation, so the same one is assigned on many
   * consecutive frames and every one of them is needed again on the way back
   * down the triangle.
   */
  fun setMosaic(frame: Bitmap?) {
    if (mosaic === frame) return
    mosaic = frame
    invalidate()
  }

  override fun onDraw(canvas: Canvas) {
    val mosaic = this.mosaic
    val bitmap = mosaic ?: this.bitmap ?: return

    // A hardware bitmap cannot be drawn by a software canvas. In practice the
    // window is always hardware accelerated; this keeps a screenshot, or a
    // software-layered ancestor, from throwing.
    if (!canvas.isHardwareAccelerated && bitmap.config == Bitmap.Config.HARDWARE) return

    val mask = dissolveMask
    val save = canvas.save()

    when (clip) {
      Clip.NONE -> Unit
      Clip.HOLE -> clipOutHole(canvas)
      Clip.WIPE -> clipToWipe(canvas)
      Clip.SWEEP -> clipToSweep(canvas)
      Clip.IRIS -> clipToIris(canvas)
    }

    /*
     * `dissolve` needs a per-cell alpha, which a clip cannot express, so the
     * snapshot and the mask are combined with DST_IN inside an offscreen layer.
     *
     * The layer is the cost of the effect: one full-screen render target per
     * frame. It is GPU work rather than CPU work, and there is no way to give a
     * View an arbitrary alpha mask without it — `clipPath` would need one
     * subpath per surviving cell, which is thousands of them.
     */
    val layer =
      if (mask != null) canvas.saveLayer(0f, 0f, contentWidth.toFloat(), contentHeight.toFloat(), null)
      else -1

    // A mosaic frame is cols×rows, and a downscaled capture is smaller than the
    // content it stands for; both have to stretch. Nearest-neighbour sampling is
    // what makes each mosaic texel a hard block rather than a smear.
    if (mosaic != null || bitmapWidth != contentWidth || bitmapHeight != contentHeight) {
      destination.set(0, 0, contentWidth, contentHeight)
      canvas.drawBitmap(bitmap, null, destination, mosaicPaint)
    } else {
      canvas.drawBitmap(bitmap, 0f, 0f, null)
    }

    if (mask != null) {
      destination.set(0, 0, contentWidth, contentHeight)
      canvas.drawBitmap(mask, null, destination, dissolvePaint)
      canvas.restoreToCount(layer)
    }

    canvas.restoreToCount(save)
  }

  /** Punches a growing circle out of the old screen. */
  @Suppress("DEPRECATION")
  private fun clipOutHole(canvas: Canvas) {
    val radius = holeMaxRadius * progress
    if (radius <= 0f) return

    clipPath.rewind()
    clipPath.addCircle(holeX, holeY, radius, Path.Direction.CW)

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      canvas.clipOutPath(clipPath)
    } else {
      // `clipOutPath`'s predecessor. Deprecated, but the only option on API 24/25
      // and still honoured by the hardware canvas there.
      canvas.clipPath(clipPath, Region.Op.DIFFERENCE)
    }
  }

  /**
   * Sweeps a straight edge across the screen.
   *
   * The old pixels do not move — they stop being drawn as the boundary passes
   * over them, so it reads as a line painting the new theme across the screen.
   * Translating the snapshot instead would drag the whole UI sideways, which
   * looks like a page transition rather than a theme change.
   *
   * [direction] names the edge the old screen leaves through: the surviving
   * sliver ends up against that edge.
   */
  private fun clipToWipe(canvas: Canvas) {
    val w = contentWidth.toFloat()
    val h = contentHeight.toFloat()
    val t = progress

    when (direction) {
      ThemeTransitionDirection.TOP -> clipRect.set(0f, 0f, w, h * (1f - t))
      ThemeTransitionDirection.BOTTOM -> clipRect.set(0f, h * t, w, h)
      ThemeTransitionDirection.LEFT -> clipRect.set(0f, 0f, w * (1f - t), h)
      ThemeTransitionDirection.RIGHT -> clipRect.set(w * t, 0f, w, h)
    }

    canvas.clipRect(clipRect)
  }

  /**
   * Clips to the surviving half-plane, or to the two of them a split leaves
   * against opposite edges.
   *
   * The quads come from [SweepGeometry], which is shared with the iOS side so
   * both platforms sweep identically. They deliberately overshoot the view; the
   * canvas is already clipped to its own bounds.
   */
  private fun clipToSweep(canvas: Canvas) {
    val reach = SweepGeometry.reach(contentWidth.toFloat(), contentHeight.toFloat())
    val middle = (sweepMin + sweepMax) / 2f
    clipPath.rewind()

    when (sweepMode) {
      SweepMode.WIPE -> {
        val threshold = sweepMin + progress * (sweepMax - sweepMin)
        SweepGeometry.addHalfPlane(clipPath, sweepNormalX, sweepNormalY, threshold, reach)
      }

      SweepMode.SPLIT -> {
        val parted = (sweepMax - sweepMin) / 2f * progress
        SweepGeometry.addHalfPlane(clipPath, sweepNormalX, sweepNormalY, middle + parted, reach)
        // The far side is the same half-plane read through the opposite normal.
        SweepGeometry.addHalfPlane(
          clipPath,
          -sweepNormalX,
          -sweepNormalY,
          -(middle - parted),
          reach,
        )
      }

      SweepMode.BARN_DOOR ->
        // The same two boundaries as a split, run the other way: they start at
        // the edges and close, so the old screen survives as a shrinking band.
        SweepGeometry.addSlab(
          clipPath,
          sweepNormalX,
          sweepNormalY,
          sweepMin + progress * (middle - sweepMin),
          sweepMax - progress * (sweepMax - middle),
          reach,
        )

      SweepMode.BLINDS -> {
        val width = (sweepMax - sweepMin) / sweepBands
        for (band in 0 until sweepBands) {
          val start = sweepMin + band * width
          // Each slab's own boundary sweeps from its near edge to its far one,
          // all at the same moment — which is what louvres closing look like.
          SweepGeometry.addSlab(
            clipPath,
            sweepNormalX,
            sweepNormalY,
            start + progress * width,
            start + width,
            reach,
          )
        }
      }
    }

    canvas.clipPath(clipPath)
  }

  /**
   * Resolves the sweep for this transition. Requires [capture] to have run, and
   * [direction] to already be set.
   */
  fun prepareSweep(angleDeg: Double, mode: SweepMode, bands: Int = 6) {
    sweepMode = mode
    sweepBands = bands.coerceIn(2, 24)

    val normal = SweepGeometry.normal(direction, angleDeg)
    sweepNormalX = normal[0]
    sweepNormalY = normal[1]

    val span =
      SweepGeometry.projection(
        contentWidth.toFloat(),
        contentHeight.toFloat(),
        sweepNormalX,
        sweepNormalY,
      )
    sweepMin = span[0]
    sweepMax = span[1]
  }

  /**
   * Resolves the `iris` outline. Requires [capture] to have run.
   *
   * The polygon is scaled so its EDGES clear the furthest corner — a polygon's
   * edges sit closer to the centre than its vertices do, so scaling to the
   * corner distance alone would leave the corners poking out at the start.
   *
   * [inverse] grows the outline as a hole instead of shrinking it as a mask.
   */
  fun prepareIris(polygon: FloatArray, x: Float, y: Float, inverse: Boolean = false) {
    holeX = x
    holeY = y
    irisPolygon = polygon
    irisInverse = inverse

    val w = contentWidth.toFloat()
    val h = contentHeight.toFloat()
    val corner = maxOf(hypot(x, y), hypot(w - x, y), hypot(x, h - y), hypot(w - x, h - y))
    irisRadius = corner / IrisShape.inradius(irisPolygon)
  }

  /** Clips to the shrinking outline, or punches the growing one out. */
  @Suppress("DEPRECATION")
  private fun clipToIris(canvas: Canvas) {
    if (irisPolygon.size < 6) return

    // Never exactly zero: a degenerate outline has no drawable area.
    val radius = maxOf(0.01f, irisRadius * (if (irisInverse) progress else 1f - progress))

    clipPath.rewind()
    var index = 0
    while (index < irisPolygon.size) {
      val px = holeX + irisPolygon[index] * radius
      val py = holeY + irisPolygon[index + 1] * radius
      if (index == 0) clipPath.moveTo(px, py) else clipPath.lineTo(px, py)
      index += 2
    }
    clipPath.close()

    when {
      !irisInverse -> canvas.clipPath(clipPath)
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.O -> canvas.clipOutPath(clipPath)
      else -> canvas.clipPath(clipPath, Region.Op.DIFFERENCE)
    }
  }

  /**
   * Drops the copy and its GPU buffer. Safe to call more than once.
   *
   * A full-screen frame is ~10 MB, and up to six can be alive at once, so this
   * frees all three references to the underlying [HardwareBuffer] **now** rather
   * than leaving the last one to the garbage collector:
   *
   *  - `recycle()` drops the [Bitmap]'s reference. Without it the buffer would
   *    survive until the Bitmap is collected — Android tracks it as native
   *    allocation pressure so it does come back eventually, but "eventually" is
   *    the wrong guarantee for something this size that is created on every
   *    theme change.
   *  - returning the lease closes the [Image], which hands the slot back to the
   *    reader, and either parks the reader in [SurfacePool] for the next capture
   *    or closes it outright — see the pool for which, and why.
   *
   * Recycling is safe here because the field is cleared first, so [onDraw] can no
   * longer reach the bitmap, and the view has already been detached by
   * `Transition.stop()`. A display list still being replayed by the RenderThread
   * holds its own native reference to the buffer, which refcounting handles.
   */
  fun release() {
    setMosaic(null)
    // Shared with every other dissolve in the process — drop the reference, do
    // not recycle it.
    dissolveMask = null

    bitmap?.let {
      bitmap = null
      if (!it.isRecycled) it.recycle()
    }

    val held = lease
    lease = null
    // Only ever set on the GPU path, which is API 29+; the check is for lint.
    if (held != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      SurfacePool.recycle(held)
    }
  }

  private companion object {
    // ThreadedRenderer's own defaults, in dp.
    const val LIGHT_Y_DP = 600f
    const val LIGHT_Z_DP = 600f
    const val LIGHT_RADIUS_DP = 800f
    const val AMBIENT_SHADOW_ALPHA = 0.039f
    const val SPOT_SHADOW_ALPHA = 0.19f
  }
}

/**
 * Keeps the offscreen surfaces a capture needs, instead of building them anew
 * every time.
 *
 * ── Why ──
 * Each capture used to allocate its own [ImageReader] and [HardwareRenderer].
 * The reader is the expensive half: at 1080x2400 its buffer is ~10 MB of
 * graphics memory, allocated and mapped on the UI thread inside the synchronous
 * window that `begin()` holds the JS thread open for. One theme change absorbs
 * that; a user flicking the toggle pays it over and over, which is exactly when
 * the drop is most visible.
 *
 * Since the screen size does not change between captures, a returned lease is
 * almost always the right shape for the next one.
 *
 * ── Why it does not simply grow ──
 * Idle leases are graphics memory doing nothing, so only full-screen-ish ones
 * are worth keeping ([MIN_POOLED_PIXELS] — the grid-sized ones `pixlated` uses
 * are cheap to rebuild), at most [MAX_IDLE] of them, and the lot is destroyed
 * once the app has gone [TRIM_DELAY_MS] without a theme change.
 *
 * Main thread only, like everything else here.
 */
@RequiresApi(Build.VERSION_CODES.Q)
internal object SurfacePool {

  /** One offscreen surface, and the frame most recently acquired from it. */
  class Lease(val reader: ImageReader, val renderer: HardwareRenderer, val width: Int, val height: Int) {
    var image: Image? = null

    /** Set when a drawn frame was never acquired — see `SnapshotView.render`. */
    var faulted = false
  }

  private val idle = mutableListOf<Lease>()
  private val handler = Handler(Looper.getMainLooper())
  private val trim = Runnable { drain() }

  fun obtain(width: Int, height: Int): Lease {
    handler.removeCallbacks(trim)

    val index = idle.indexOfFirst { it.width == width && it.height == height }
    if (index >= 0) return idle.removeAt(index)

    val reader =
      ImageReader.newInstance(
        width,
        height,
        PixelFormat.RGBA_8888,
        1,
        HardwareBuffer.USAGE_GPU_SAMPLED_IMAGE or HardwareBuffer.USAGE_GPU_COLOR_OUTPUT,
      )
    val renderer = HardwareRenderer()
    renderer.setSurface(reader.surface)

    return Lease(reader, renderer, width, height)
  }

  /**
   * Gives a lease back. The acquired image is closed here — that is what frees
   * the reader's only slot, so a lease is never handed out still holding one.
   */
  fun recycle(lease: Lease) {
    lease.image?.close()
    lease.image = null

    val worthKeeping =
      !lease.faulted && lease.width * lease.height >= MIN_POOLED_PIXELS && idle.size < MAX_IDLE
    if (!worthKeeping) {
      destroy(lease)
      return
    }

    idle.add(lease)
    handler.removeCallbacks(trim)
    handler.postDelayed(trim, TRIM_DELAY_MS)
  }

  private fun drain() {
    idle.forEach(::destroy)
    idle.clear()
  }

  private fun destroy(lease: Lease) {
    runCatching {
      lease.image?.close()
      lease.image = null
      lease.renderer.destroy()
      lease.reader.close()
    }
  }

  private const val MAX_IDLE = 2
  private const val TRIM_DELAY_MS = 3_000L

  /** Roughly a quarter of a 1080p screen — below this, allocation is not the cost. */
  private const val MIN_POOLED_PIXELS = 600_000
}
