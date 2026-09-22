package com.margelo.nitro.nitrothemetransition

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.ValueAnimator
import android.graphics.RenderEffect
import android.graphics.Shader
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.Choreographer
import android.view.View
import android.view.ViewAnimationUtils
import android.view.ViewGroup
import android.view.animation.PathInterpolator
import android.widget.FrameLayout
import androidx.annotation.Keep
import androidx.annotation.RequiresApi
import com.facebook.proguard.annotations.DoNotStrip
import com.facebook.react.views.modal.ReactModalHostView
import com.margelo.nitro.NitroModules
import com.margelo.nitro.core.Promise
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Native theme-change transition for Android — the counterpart of
 * `ios/HybridThemeTransition.swift`, with the same behaviour and the same
 * guarantees.
 *
 * ── Why it is built this way ──
 * A Unistyles theme change is a whole-app style re-evaluation plus a shadow-tree
 * commit, synchronous on the JS thread. It cannot be animated frame by frame. So
 * the theme swap stays exactly as it is, and the ANIMATION is applied to a copy
 * of the screen instead (see [SnapshotView]).
 *
 * Every animation here is either driven by the platform's RenderThread
 * ([ViewAnimationUtils.createCircularReveal], property animations on the view) or
 * is a single clipped draw op per frame. Nothing round-trips through JavaScript,
 * so a busy JS thread cannot stutter them.
 *
 * ── What is captured, and where the copy lives ──
 * Every window the app is showing is recorded into ONE frame: the activity, then
 * each `Dialog` above it, each drawn at its own position on screen.
 *
 * That second part is what makes React Native's `Modal` work. A `Modal` is a
 * `Dialog` — a separate window, outside `android.R.id.content` — so drawing the
 * activity's view tree produces a copy with the modal missing, and a snapshot
 * added to that tree can never cover one either, because a dialog window always
 * draws above the activity's. Both halves have to change together: capture every
 * window, and host the copy in the TOP-most one.
 *
 * The iOS side reaches the same place by snapshotting the screen and hosting the
 * copies in a window of its own — see the header of `HybridThemeTransition.swift`.
 *
 * ── Concurrent transitions ──
 * Switching again before a reveal finishes does NOT cancel anything. Each change
 * gets its own snapshot and its own animation, and they play at the same time:
 *
 *     host window (activity content, or the top-most dialog's decor)
 *       ├─ live content    ← the app, already on the newest theme
 *       ├─ snapshot B      ← newest change, animating away to reveal it
 *       └─ snapshot A      ← oldest change, TOP-most, revealing B
 *
 * Each snapshot reveals whatever sits directly beneath it, which is exactly the
 * state the app was in one step later. Newer snapshots therefore go BELOW older
 * ones, and the stack stays visually consistent no matter how fast the user taps.
 *
 * In a `FrameLayout` with equal elevation, child index IS z-order — later children
 * draw on top — so a new snapshot is inserted just below the lowest existing one.
 * The index is computed from the snapshots themselves rather than hard-coded,
 * because in a dialog's decor view the other children belong to the system.
 *
 * A snapshot must contain the live app *without* the other snapshots, or each
 * capture would bake in a frozen copy of the animations still running above it —
 * which is why the capture walks windows and skips [SnapshotView]s.
 */
@Keep
@DoNotStrip
class HybridThemeTransition : HybridThemeTransitionSpec() {

  /** One in-flight transition: the snapshot and whatever is animating it. */
  private class Transition(val view: SnapshotView, val originOffset: IntArray) {
    /**
     * Retained so it is not collected mid-flight, and so it can be cancelled if
     * this snapshot is torn down early.
     */
    var animator: Animator? = null

    /**
     * Optional pixlated underlay (new-theme mosaic), sitting just below [view].
     * Cleared with the outgoing snapshot on [stop].
     */
    var underlay: SnapshotView? = null

    /**
     * The pre-built mosaic ladders `pixlated` draws from, owned here because the
     * views only ever point at a frame — the same one on many consecutive
     * frames, and every one of them again on the way back down the triangle.
     */
    var mosaics: List<List<android.graphics.Bitmap>> = emptyList()

    /** Teardown for effects that are not an [Animator] — currently the fade. */
    var cancelEffect: (() -> Unit)? = null

    /**
     * The LIVE React root, when a swept `blur` has put a `RenderEffect` on it.
     *
     * Borrowed, not owned — so [stop] hands it back clean whatever happens, and
     * that is the only thing standing between a cancelled transition and an app
     * left permanently blurred.
     */
    var blurredRoot: View? = null

    fun stop() {
      // A no-op if it already ran to completion, so this cannot double-fire the
      // completion listener — `onAnimationCancel` is only reached from a genuine
      // early teardown.
      animator?.cancel()
      animator = null

      cancelEffect?.invoke()
      cancelEffect = null

      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        view.setRenderEffect(null)
        blurredRoot?.setRenderEffect(null)
      }
      blurredRoot = null

      // Detach BEFORE releasing. Removing the view is what stops it being asked
      // to re-record a display list, so by the time the frame is recycled below
      // nothing can try to draw it again.
      underlay?.let { under ->
        (under.parent as? ViewGroup)?.removeView(under)
        under.release()
      }
      underlay = null

      (view.parent as? ViewGroup)?.removeView(view)
      view.release()

      // After both views are detached, so nothing can be asked to draw a frame
      // that has just been recycled.
      mosaics.forEach(PixelizeMosaic::releaseLadder)
      mosaics = emptyList()
    }
  }

  /**
   * Live snapshots, oldest first.
   *
   * Oldest is the top-most view and finishes first; newest is the bottom-most,
   * sitting directly above the live app.
   */
  private val transitions = mutableListOf<Transition>()

  /**
   * Captured by [begin], waiting for its [commit]. Never more than one: callers
   * always pair the two within a single synchronous block.
   */
  private var pending: Transition? = null

  private val mainHandler = Handler(Looper.getMainLooper())

  /**
   * Builds `pixlated`'s mosaic ladders off the main thread.
   *
   * One thread on purpose: concurrent transitions then queue behind each other
   * instead of competing for cores with the RenderThread, and the work is a few
   * milliseconds each.
   */
  private val mosaicWorker: ExecutorService = Executors.newSingleThreadExecutor { runnable ->
    Thread(runnable, "ThemeTransitionMosaic").apply { isDaemon = true }
  }

  // MARK: - Spec

  /**
   * The View system is main-thread only, and this must be SYNCHRONOUS: when
   * `begin()` returns, the screen has to already be covered, so no frame can
   * render between the capture and the caller's theme change.
   *
   * ── Why this does not use [onMainSync] ──
   * It cannot, because the capture has a SIDE EFFECT. `onMainSync` gives up
   * after [SYNC_TIMEOUT_MS] and reports failure, but the work it posted still
   * runs — so a capture that landed late attached a snapshot to the window and
   * set [pending], while JavaScript had already been told there was none. No
   * `commit()` or `abort()` would ever come for it, and a frozen copy of the
   * screen stayed pinned over the live app until the next theme change happened
   * to clear it.
   *
   * Only reachable when the main thread is more than a quarter of a second
   * behind, which is exactly the rapid-switching case this is supposed to
   * survive. So the two sides race for the right to decide, and whichever loses
   * cleans up: the capture undoes itself if JavaScript has already given up, and
   * the waiter takes the real answer if the capture beat it to the line.
   */
  override fun begin(): Boolean {
    if (Looper.myLooper() == Looper.getMainLooper()) return capture()

    val settled = AtomicBoolean(false)
    val latch = CountDownLatch(1)
    var captured = false

    mainHandler.post {
      val ok = capture()

      if (settled.compareAndSet(false, true)) {
        captured = ok
      } else if (ok) {
        // JavaScript gave up while this was queued. Nothing will ever commit or
        // abort this snapshot, so it must not be left on screen.
        pending?.let {
          pending = null
          remove(it)
        }
      }

      latch.countDown()
    }

    if (latch.await(SYNC_TIMEOUT_MS, TimeUnit.MILLISECONDS)) return captured

    // Timed out — claim the outcome, so the late capture knows to undo itself.
    if (settled.compareAndSet(false, true)) return false

    // It finished in the gap between the timeout and the claim, and has already
    // recorded a real answer. The latch is counting down as we speak.
    latch.await()
    return captured
  }

  override fun commit(options: ThemeTransitionOptions): Promise<Unit> {
    val promise = Promise<Unit>()

    mainHandler.post {
      val transition = pending
      if (transition == null) {
        // `begin()` never succeeded, or `abort()` already ran. The theme change
        // still happened — there is simply nothing to animate.
        promise.resolve(Unit)
        return@post
      }

      pending = null

      // Hold for a few frames so the theme swap — committed on the JS thread and
      // mounted a frame or two later — has actually painted underneath.
      // Revealing early would animate down to the OLD colours.
      waitFrames(options.settleFrames.toInt()) {
        if (!transitions.contains(transition)) {
          // Dropped by the overlay cap or by `dispose()` while we waited.
          promise.resolve(Unit)
          return@waitFrames
        }

        animate(transition, options) { promise.resolve(Unit) }
      }
    }

    return promise
  }

  override fun abort() {
    onMainSync(Unit) {
      val transition = pending ?: return@onMainSync
      pending = null
      remove(transition)
    }
  }

  /** Called if JS disposes the object mid-transition — never strand an overlay. */
  override fun dispose() {
    onMainSync(Unit) {
      pending = null
      transitions.forEach { it.stop() }
      transitions.clear()
    }
    // Queued ladder builds still run; they check `transitions` before touching
    // anything, and their bitmaps are dropped on the floor.
    runCatching { mosaicWorker.shutdown() }
    super.dispose()
  }

  // MARK: - Capture

  /** Must run on the main thread. */
  private fun capture(): Boolean {
    // A previous `begin()` never reached its `commit()`. Don't leak it.
    pending?.let {
      pending = null
      remove(it)
    }

    val activity = NitroModules.applicationContext?.currentActivity ?: return false
    val content = activity.findViewById<ViewGroup>(android.R.id.content) ?: return false
    // The React Native root — the live app, never one of our own overlays. It is
    // index 0 in practice (overlays are inserted at 1 or above), but skipping
    // SnapshotViews explicitly means a capture can never nest a snapshot inside a
    // snapshot if anything else ever inserts a view below them.
    val root =
      (0 until content.childCount).map(content::getChildAt).firstOrNull { it !is SnapshotView }
        ?: return false

    /*
     * The frame everything is measured against: the activity's content area.
     *
     * Not the decor view. Hosting a copy sized to the decor inside
     * `android.R.id.content` needs negative margins to line up on a
     * non-edge-to-edge app, and `content` clips its children — the copy would
     * lose its top edge. Anchoring here keeps every offset positive in the
     * common case, at the cost of not covering a dialog's status-bar strip.
     */
    val anchor = locationOnScreen(content)
    val width = content.width
    val height = content.height

    // Every window the app is currently showing, activity first. Anything after
    // it is a dialog, drawn above it on screen and therefore later in the list.
    val dialogs = showingDialogs(content)
    val layers =
      buildList {
        add(layerFor(root, anchor))
        dialogs.forEach { add(layerFor(it.decor, anchor)) }
      }

    val snapshot = SnapshotView(activity)
    if (!snapshot.capture(layers, width, height)) return false

    /*
     * Host the copy in the TOP-most window.
     *
     * A dialog is a separate window and always draws above the activity's, so a
     * snapshot added to `android.R.id.content` can never cover one — which is
     * exactly why RN `Modal` used to snap while everything else animated. Adding
     * it to the dialog's own decor view puts it above both, because RN modals use
     * a full-screen dialog theme.
     */
    val host = dialogs.lastOrNull()?.decor as? ViewGroup ?: content
    val hostAnchor = locationOnScreen(host)

    // Positioned in screen space rather than "fill the parent", so the copy lands
    // exactly over the pixels it was taken from whichever window hosts it.
    val params = FrameLayout.LayoutParams(width, height)
    params.leftMargin = anchor[0] - hostAnchor[0]
    params.topMargin = anchor[1] - hostAnchor[1]
    snapshot.layoutParams = params

    // Equal elevation is what makes child index decide z-order — see the class
    // comment. Without it a raised sibling would draw over the snapshot.
    snapshot.elevation =
      (0 until host.childCount).maxOfOrNull { host.getChildAt(it).elevation } ?: 0f

    // Newest goes BELOW every existing snapshot in this host, and above the live
    // content. Computing the index from the snapshots themselves keeps that true
    // in a dialog's decor view, whose other children are the system's, not ours.
    val lowestOverlay =
      transitions
        .map { it.view }
        .filter { it.parent === host }
        .minOfOrNull { host.indexOfChild(it) }
    host.addView(snapshot, lowestOverlay ?: host.childCount)

    val transition = Transition(snapshot, originOffset = surfaceOffset(dialogs, anchor))
    transitions.add(transition)
    pending = transition

    enforceOverlayCap()

    return true
  }

  /** A dialog that is currently on screen, and the view its touches are measured against. */
  private class DialogWindow(val decor: View, val surface: View?)

  /**
   * Every React Native `Modal` currently showing, in the order they were opened.
   *
   * `ReactModalHostView` is a view in the app's tree that hosts a `Dialog`; the
   * dialog's content is NOT in that tree, which is why it has to be reached
   * through the host rather than found by walking children. If React Native ever
   * moves the class, this stops compiling — which is the intended failure mode,
   * since silently losing modal support is exactly the bug this fixes.
   */
  private fun showingDialogs(content: ViewGroup): List<DialogWindow> {
    val found = mutableListOf<DialogWindow>()

    fun walk(view: View) {
      if (view is SnapshotView) return

      if (view is ReactModalHostView) {
        val dialog = view.dialog
        val decor = dialog?.window?.decorView
        if (dialog != null && dialog.isShowing && decor != null && decor.width > 0) {
          found.add(DialogWindow(decor, reactSurfaceIn(decor)))
        }
      }

      if (view is ViewGroup) {
        for (index in 0 until view.childCount) walk(view.getChildAt(index))
      }
    }

    walk(content)
    return found
  }

  /**
   * The view a dialog's touches are reported against — React Native's own root
   * inside it, which sits below whatever inset wrapper the modal added.
   */
  private fun reactSurfaceIn(decor: View): View? {
    val dialogContent = decor.findViewById<ViewGroup>(android.R.id.content) ?: return null
    val wrapper = dialogContent.getChildAt(0) as? ViewGroup ?: return dialogContent.getChildAt(0)
    return wrapper.getChildAt(0) ?: wrapper
  }

  private fun layerFor(view: View, anchor: IntArray): SnapshotView.Layer {
    val location = locationOnScreen(view)
    return SnapshotView.Layer(view, location[0] - anchor[0], location[1] - anchor[1])
  }

  private fun locationOnScreen(view: View): IntArray {
    val location = IntArray(2)
    view.getLocationOnScreen(location)
    return location
  }

  /**
   * Where the surface a touch came from sits inside the captured frame, in px.
   *
   * React Native reports touches relative to the surface they happened in, and a
   * `Modal` is its own surface: a press inside one arrives measured from the
   * dialog's own root, not from the window. The copy covers the whole window, so
   * a reveal centred on the raw value opens in the wrong place — the same bug the
   * iOS side fixes in `surfaceOffset(in:)`, and for the same reason.
   *
   * Zero when no modal is showing, which is why every other screen was unaffected.
   */
  private fun surfaceOffset(dialogs: List<DialogWindow>, anchor: IntArray): IntArray {
    val surface = dialogs.lastOrNull()?.surface ?: return intArrayOf(0, 0)
    val location = locationOnScreen(surface)
    return intArrayOf(location[0] - anchor[0], location[1] - anchor[1])
  }

  /**
   * Ceiling on simultaneous snapshots — see [MAX_OVERLAYS].
   *
   * Beyond it the OLDEST is dropped, which is the least visible choice: by then
   * it is the furthest through its animation.
   */
  private fun enforceOverlayCap() {
    while (transitions.size > MAX_OVERLAYS) {
      remove(transitions.first())
    }
  }

  /** Drops a transition from the stack and the view hierarchy. */
  private fun remove(transition: Transition) {
    transitions.remove(transition)
    transition.stop()
  }

  // MARK: - Animation

  private fun animate(
    transition: Transition,
    options: ThemeTransitionOptions,
    completion: () -> Unit,
  ) {
    // Zero still means "no animation". Anything else is clamped up to the
    // shortest length this kind can read as motion rather than as a cut.
    val duration = floorDuration(options.kind, options.durationMs)

    val finish = {
      remove(transition)
      completion()
    }

    if (duration == 0L) {
      finish()
      return
    }

    when (options.kind) {
      ThemeTransitionKind.FADE -> animateFade(transition, duration, finish)
      ThemeTransitionKind.CIRCULARREVEAL ->
        animateCircularReveal(transition, options, inverse = false, duration = duration, finish = finish)
      ThemeTransitionKind.CIRCULARREVEALINVERSE ->
        animateCircularReveal(transition, options, inverse = true, duration = duration, finish = finish)
      ThemeTransitionKind.IRIS -> animateIris(transition, options, duration, finish)
      ThemeTransitionKind.SLIDE ->
        animateSweep(transition, options, SnapshotView.SweepMode.WIPE, duration, finish)
      ThemeTransitionKind.SPLIT ->
        animateSweep(transition, options, SnapshotView.SweepMode.SPLIT, duration, finish)
      ThemeTransitionKind.BARNDOOR ->
        animateSweep(transition, options, SnapshotView.SweepMode.BARN_DOOR, duration, finish)
      ThemeTransitionKind.BLINDS ->
        animateSweep(transition, options, SnapshotView.SweepMode.BLINDS, duration, finish)
      ThemeTransitionKind.BLUR -> animateBlur(transition, options, duration, finish)
      // Liquid Glass is an iOS 26 material. There is no Android equivalent, and
      // a hand-rolled imitation would be a full-screen shader per frame — the
      // exact cost this library exists to avoid. A blur is the honest fallback.
      ThemeTransitionKind.LIQUIDGLASS -> animateBlur(transition, options, duration, finish)
      ThemeTransitionKind.ZOOM -> animateZoom(transition, duration, finish)
      ThemeTransitionKind.PIXLATED -> animatePixlated(transition, duration, finish)
      ThemeTransitionKind.DISSOLVE ->
        animateGrain(transition, options, DissolveGrain.Pattern.DISSOLVE, duration, finish)
      ThemeTransitionKind.STRIPES ->
        animateGrain(transition, options, DissolveGrain.Pattern.STRIPES, duration, finish)
      ThemeTransitionKind.RIPPLE ->
        animateGrain(transition, options, DissolveGrain.Pattern.RIPPLE, duration, finish)
      ThemeTransitionKind.SHATTER ->
        animateGrain(transition, options, DissolveGrain.Pattern.SHATTER, duration, finish)
    }
  }

  /**
   * The shortest each kind is allowed to run, in milliseconds — mirrored in
   * `Timing` on the iOS side, so the two platforms stay identical.
   *
   * ── Why the library clamps at all ──
   * The curve fix (see [curve]) made short transitions read as motion rather
   * than as a cut, but there is a floor below which no curve helps: a
   * full-screen copy being taken apart needs enough frames for the eye to
   * register the shape of the motion, not just its start and end. At 120ms a
   * reveal is seven frames — the circle is already half-way in frame two, and
   * what the user sees is a flicker with a hard edge in it.
   *
   * The floors differ because the kinds do not carry the same amount of
   * information. A fade has one moving quantity; a wipe has a moving boundary
   * the eye tracks across the whole screen; `pixlated` has to grow a mosaic,
   * swap the colours behind it and take the mosaic back down, so it needs
   * roughly three times a fade to complete that arc.
   *
   * A caller asking for `0` still means "no animation", so an app can always
   * opt out.
   */
  private fun floorDuration(kind: ThemeTransitionKind, requestedMs: Double): Long {
    if (requestedMs <= 0.0) return 0L

    val floor =
      when (kind) {
        ThemeTransitionKind.FADE -> 200.0
        ThemeTransitionKind.CIRCULARREVEAL,
        ThemeTransitionKind.CIRCULARREVEALINVERSE -> 260.0
        ThemeTransitionKind.IRIS -> 260.0
        ThemeTransitionKind.SLIDE,
        ThemeTransitionKind.SPLIT,
        ThemeTransitionKind.BARNDOOR -> 260.0
        ThemeTransitionKind.ZOOM -> 240.0
        // More boundaries to follow than a plain wipe has.
        ThemeTransitionKind.BLINDS -> 300.0
        ThemeTransitionKind.BLUR -> 300.0
        ThemeTransitionKind.LIQUIDGLASS -> 620.0
        // Grain has no shape to follow, so the eye reads it as texture rather
        // than motion until it has had time to thin out.
        ThemeTransitionKind.DISSOLVE,
        ThemeTransitionKind.STRIPES -> 420.0
        ThemeTransitionKind.RIPPLE,
        ThemeTransitionKind.SHATTER -> 480.0
        ThemeTransitionKind.PIXLATED -> 520.0
      }

    return maxOf(requestedMs, floor).toLong()
  }

  /**
   * Straight opacity dissolve.
   *
   * Driven by [android.view.ViewPropertyAnimator] rather than a [ValueAnimator]
   * with an update listener: alpha is a RenderNode property, so handing the
   * whole animation to the platform lets the RenderThread interpolate it and
   * the UI thread does no per-frame work at all. With
   * `hasOverlappingRendering() == false` on the snapshot it is also a colour
   * filter on one draw op rather than an offscreen layer.
   *
   * This is also the fallback for every `pixlated` path that cannot complete,
   * which is a second reason for it to be the cheapest thing here.
   */
  private fun animateFade(transition: Transition, duration: Long, finish: () -> Unit) {
    val view = transition.view

    view
      .animate()
      .alpha(0f)
      .setDuration(duration)
      .setInterpolator(curve())
      .withEndAction {
        transition.cancelEffect = null
        finish()
      }
      .start()

    // `withEndAction` does not run on cancel, which is what we want — a
    // cancellation comes from a teardown that has already removed the view.
    transition.cancelEffect = { view.animate().cancel() }
  }

  /**
   * Sweeps a straight boundary across the screen, uncovering the new theme.
   *
   * `split == false` is the wipe: one line crossing the whole screen, leaving
   * through `direction`. `split == true` is two lines, starting together at the
   * middle and parting until they reach opposite edges — so `direction` names
   * the axis rather than an edge, and `TOP` and `BOTTOM` mean the same thing (as
   * do `LEFT` and `RIGHT`).
   *
   * Nothing translates in either case: the clip does all the work. An
   * un-tilted wipe keeps the plain `clipRect` path, which is cheaper than a
   * path clip and is by far the common case; anything else goes through
   * [SweepGeometry]. See [SnapshotView.Clip].
   */
  private fun animateSweep(
    transition: Transition,
    options: ThemeTransitionOptions,
    mode: SnapshotView.SweepMode,
    duration: Long,
    finish: () -> Unit,
  ) {
    val view = transition.view
    view.direction = options.direction

    if (mode == SnapshotView.SweepMode.WIPE && options.angleDeg == 0.0) {
      view.clip = SnapshotView.Clip.WIPE
    } else {
      view.prepareSweep(options.angleDeg, mode, options.bands.toInt())
      view.clip = SnapshotView.Clip.SWEEP
    }

    start(transition, duration, finish) { snapshot, t -> snapshot.progress = t }
  }

  /**
   * `circularReveal` with a shape other than a circle.
   *
   * Identical in every other respect — same origin handling, same clip, same
   * one draw op per frame. Only the outline differs, and [IrisShape] explains
   * why every one it produces is a fixed-vertex polygon.
   */
  private fun animateIris(
    transition: Transition,
    options: ThemeTransitionOptions,
    duration: Long,
    finish: () -> Unit,
  ) {
    val view = transition.view
    val origin = revealOrigin(transition, options)

    view.prepareIris(options.shape, origin[0], origin[1])
    view.clip = SnapshotView.Clip.IRIS

    start(transition, duration, finish) { snapshot, t -> snapshot.progress = t }
  }

  /**
   * The old screen scales up and fades out.
   *
   * The cheapest kind here by a distance — two RenderNode properties, both
   * interpolated on the RenderThread, so the UI thread does nothing per frame.
   * It is also the one that reads least like a theme change: growth plus a fade
   * is the vocabulary of a navigation push, which is why the rest of the library
   * animates masks instead of moving the copy about.
   */
  private fun animateZoom(transition: Transition, duration: Long, finish: () -> Unit) {
    val view = transition.view

    view
      .animate()
      .alpha(0f)
      .scaleX(1.12f)
      .scaleY(1.12f)
      .setDuration(duration)
      .setInterpolator(curve())
      .withEndAction {
        transition.cancelEffect = null
        finish()
      }
      .start()

    transition.cancelEffect = { view.animate().cancel() }
  }

  /**
   * Where a shape-based reveal is centred, in the snapshot's own px space.
   *
   * JS measures in dp and the View system in px; the surface offset is already
   * px, since it came from `getLocationOnScreen`, so it is added after the
   * conversion.
   */
  private fun revealOrigin(
    transition: Transition,
    options: ThemeTransitionOptions,
  ): FloatArray {
    val view = transition.view
    val density = view.resources.displayMetrics.density
    val hasOrigin = options.originX >= 0 && options.originY >= 0

    return floatArrayOf(
      if (hasOrigin) (options.originX * density).toFloat() + transition.originOffset[0]
      else view.capturedWidth / 2f,
      if (hasOrigin) (options.originY * density).toFloat() + transition.originOffset[1]
      else view.capturedHeight / 2f,
    )
  }

  /**
   * The four mask-ladder effects: `dissolve`, `stripes`, `ripple` and `shatter`.
   *
   * They differ only in the order their cells disappear in — see
   * [DissolveGrain]. Everything from here on is shared, because once the ladder
   * exists there is nothing pattern-specific left to do.
   *
   * Playback is picking a rung per frame, which is the same per-frame cost as
   * the inverse reveal's clip. (The iOS side can go one better and hand the
   * whole sequence to the render server as discrete keyframes; there is no
   * equivalent for an arbitrary alpha mask here.)
   */
  private fun animateGrain(
    transition: Transition,
    options: ThemeTransitionOptions,
    pattern: DissolveGrain.Pattern,
    duration: Long,
    finish: () -> Unit,
  ) {
    val view = transition.view
    val density = view.resources.displayMetrics.density
    val cols = DissolveGrain.columns(view.capturedWidth, density)
    val rows = DissolveGrain.rows(view.capturedHeight, density)

    // `ripple` is the only one that needs the touch point, and it needs it in
    // MASK CELLS rather than px.
    val cell = (DissolveGrain.CELL_DP * density).coerceAtLeast(1f)
    val origin = revealOrigin(transition, options)

    val key =
      DissolveGrain.Key.make(
        pattern = pattern,
        cols = cols,
        rows = rows,
        direction = options.direction,
        originCol = Math.round(origin[0] / cell),
        originRow = Math.round(origin[1] / cell),
      )

    DissolveGrain.cachedLadder(key)?.let {
      runGrain(transition, it, duration, finish)
      return
    }

    // A key this has not seen before: the ladder is kept for every one after.
    val submitted =
      runCatching {
          mosaicWorker.execute {
            val ladder = DissolveGrain.build(key)

            mainHandler.post {
              if (!transitions.contains(transition)) {
                finish()
                return@post
              }

              if (ladder == null) {
                // An effect that cannot mask is a fade.
                animateFade(transition, duration, finish)
                return@post
              }

              DissolveGrain.store(key, ladder)
              runGrain(transition, ladder, duration, finish)
            }
          }
        }
        .isSuccess

    if (!submitted) animateFade(transition, duration, finish)
  }

  private fun runGrain(
    transition: Transition,
    ladder: List<android.graphics.Bitmap>,
    duration: Long,
    finish: () -> Unit,
  ) {
    if (ladder.isEmpty()) {
      animateFade(transition, duration, finish)
      return
    }

    val last = ladder.size - 1
    var currentStep = -1

    transition.view.dissolveMask = ladder[0]

    start(transition, duration, finish) { view, t ->
      // `t` arrives already eased by the animator's interpolator, and the
      // ladder's thresholds are linear — so this is where the curve gets
      // applied, exactly once.
      val step = Math.round(t * last).coerceIn(0, last)
      if (step != currentStep) {
        currentStep = step
        view.dissolveMask = ladder[step]
      }
    }
  }

  /**
   * The circle at the origin, uncovering whatever sits beneath this snapshot.
   *
   *   inverse == false  the OLD screen shrinks INTO the circle — the new theme
   *                     arrives from the edges and closes in on the touch point.
   *   inverse == true   a HOLE opens at the circle and grows — the new theme
   *                     spreads outward from the touch point.
   *
   * Same shape, run the other way round, and they are each other's natural
   * counterpart: whichever one is used for light→dark, the other reads as "undo"
   * for dark→light.
   *
   * The forward case uses [ViewAnimationUtils.createCircularReveal], which sets a
   * reveal clip on the view's RenderNode and is interpolated entirely on the
   * RenderThread. There is no platform API for the inverse, so that one animates
   * [SnapshotView.progress] and clips the hole out in `onDraw` — one draw op per
   * frame against an already-recorded display list.
   */
  private fun animateCircularReveal(
    transition: Transition,
    options: ThemeTransitionOptions,
    inverse: Boolean,
    duration: Long,
    finish: () -> Unit,
  ) {
    val view = transition.view
    val origin = revealOrigin(transition, options)
    val x = origin[0]
    val y = origin[1]

    view.prepareHole(x, y)

    if (inverse) {
      view.clip = SnapshotView.Clip.HOLE
      start(transition, duration, finish) { snapshot, t -> snapshot.progress = t }
      return
    }

    val animator =
      ViewAnimationUtils.createCircularReveal(view, x.toInt(), y.toInt(), view.holeMaxRadius, 0f)
    animator.duration = duration
    animator.interpolator = curve()
    onEnd(animator, finish)

    transition.animator = animator
    animator.start()
  }

  /**
   * Blurs the outgoing screen as it dissolves.
   *
   * [RenderEffect] is a GPU shader attached to the view's RenderNode, so the blur
   * costs nothing on the CPU — but unlike alpha it is not an animatable property,
   * so the radius has to be reassigned each frame.
   *
   * The slight scale-up stops it reading as a flat cross-fade; the old screen
   * feels like it is receding rather than just vanishing.
   *
   * Below API 31 there is no RenderEffect, and the honest fallback is the same
   * motion without the blur rather than a CPU blur that would drop frames.
   */
  private fun animateBlur(
    transition: Transition,
    options: ThemeTransitionOptions,
    duration: Long,
    finish: () -> Unit,
  ) {
    val view = transition.view

    // `RenderEffect` radii are in px, so a fixed constant would be a heavy blur on
    // a 1x screen and a faint one on a 3x screen.
    val radius = BLUR_RADIUS_DP * view.resources.displayMetrics.density

    if (options.blurStyle != ThemeTransitionBlurStyle.SWEEP) {
      // A RenderEffect cannot be interpolated, so it is reassigned as the radius
      // moves — but only when it moves by a whole pixel. Sub-pixel steps are
      // invisible in a blur and each one allocates a native effect object and
      // dirties the render node for nothing.
      var lastRadius = -1

      start(transition, duration, finish) { snapshot, t ->
        snapshot.alpha = 1f - t
        snapshot.scaleX = 1f + 0.04f * t
        snapshot.scaleY = 1f + 0.04f * t

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
          val stepped = (radius * t).toInt()
          if (stepped != lastRadius) {
            lastRadius = stepped
            applyBlur(snapshot, stepped.toFloat())
          }
        }
      }
      return
    }

    /*
     * `.sweep`: a wipe that brings the NEW theme in out of focus, and pulls it
     * sharp as it arrives.
     *
     * ── The blur is on the incoming side ──
     * The outgoing copy is never blurred: it stays crisp right up to the edge
     * and is simply taken away by the clip. What is out of focus is the theme
     * arriving behind it. Blurring the outgoing copy instead reads as the screen
     * you are leaving being smeared off, which is the opposite of the intent.
     *
     * ── Which means blurring the LIVE view ──
     * iOS can put a backdrop-blurring view underneath the snapshot and be done.
     * Android has no equivalent for a sibling — `RenderEffect` only ever applies
     * to a view's OWN content — so the effect goes on the live React root
     * itself, and comes off again as the wipe finishes.
     *
     * ⚠ That is someone else's view, so it must always be handed back clean.
     * Two things guarantee it: `Transition.stop()` clears whatever it was given
     * (and stop() runs on completion, on the overlay cap, on abort and on
     * dispose), and the delayed sweep below is a backstop in case a transition
     * is ever dropped without either.
     */
    view.direction = options.direction

    if (options.angleDeg == 0.0) {
      view.clip = SnapshotView.Clip.WIPE
    } else {
      view.prepareSweep(options.angleDeg, SnapshotView.SweepMode.WIPE)
      view.clip = SnapshotView.Clip.SWEEP
    }

    val live =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) liveRoot() else null

    var lastRadius = -1

    fun sharpen(t: Float) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || live == null) return

      // Reaches zero before the wipe does, so the last sliver to be uncovered is
      // already sharp and the transition does not end on a soft frame.
      val remaining = (1f - t / 0.85f).coerceIn(0f, 1f)
      val stepped = (radius * remaining).toInt()
      if (stepped == lastRadius) return
      lastRadius = stepped
      applyBlur(live, stepped.toFloat())
    }

    if (live != null) {
      transition.blurredRoot = live
      sharpen(0f)

      // Backstop. Cheap, and the alternative failure is an app left blurred.
      mainHandler.postDelayed(
        { if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) live.setRenderEffect(null) },
        duration + 500L,
      )
    }

    start(transition, duration, finish) { snapshot, t ->
      snapshot.progress = t
      sharpen(t)
    }
  }

  /** The live React root — the app itself, already wearing the new theme. */
  private fun liveRoot(): View? {
    val activity = NitroModules.applicationContext?.currentActivity ?: return null
    val content = activity.findViewById<ViewGroup>(android.R.id.content) ?: return null
    return (0 until content.childCount)
      .map(content::getChildAt)
      .firstOrNull { it !is SnapshotView }
  }

  @RequiresApi(Build.VERSION_CODES.S)
  private fun applyBlur(view: View, radius: Float) {
    // `createBlurEffect` rejects a zero radius, and zero blur is just no effect.
    view.setRenderEffect(
      if (radius <= 0f) null
      else RenderEffect.createBlurEffect(radius, radius, Shader.TileMode.CLAMP)
    )
  }

  /**
   * Pixelize — matches the Skia package's `pixelize` and the iOS side.
   *
   * Two mosaiced layers (new underneath, old on top). Shared `blockSize`
   * triangle peaks at the midpoint; the OLD layer's alpha is `1 - progress`,
   * so the colour swap is a fade *behind* the pixels across the whole
   * duration (obviously half-swapped at mid). A short last-15% container
   * fade only unwraps onto the live app once both themes already match.
   *
   * The incoming theme is captured only after React Native has painted it:
   * we poll until the new capture's mean colour differs from the outgoing
   * snapshot (or hit a short frame budget). Capturing once after the default
   * settle often still sampled the OLD colours — which made the mid
   * crossfade a no-op and the real swap appear only on the final fade.
   */
  private fun animatePixlated(transition: Transition, duration: Long, finish: () -> Unit) {
    val view = transition.view
    val host = view.parent as? ViewGroup
    val density = view.resources.displayMetrics.density
    val activity = NitroModules.applicationContext?.currentActivity

    if (host == null || activity == null) {
      animateFade(transition, duration, finish)
      return
    }

    // The finest grid the mosaic can ever show — and therefore the resolution
    // everything below is captured at. See [PixelizeMosaic].
    val gridWidth = PixelizeMosaic.gridWidth(view.capturedWidth, density)
    val gridHeight = PixelizeMosaic.gridHeight(view.capturedHeight, density)

    val oldPixels = view.downscaledCopy(gridWidth, gridHeight)
    val oldBuf = oldPixels?.let(PixelizeMosaic.Buffer::from)
    oldPixels?.recycle()

    if (oldBuf == null) {
      animateFade(transition, duration, finish)
      return
    }

    // Both sides of the comparison are grid-sized buffers sampled the same way,
    // so the only thing the delta can reflect is the colours themselves.
    val (oldR, oldG, oldB) = oldBuf.meanRGB()

    /*
     * The windows to capture, resolved once.
     *
     * `showingDialogs` walks the entire view tree looking for ReactModalHostViews,
     * which for a real app is thousands of instanceof checks. Doing that on every
     * poll attempt was pure waste: a dialog cannot appear and settle inside the
     * dozen frames this loop lives for, and if one somehow did, the worst case is
     * that the incoming mosaic misses it for the length of one transition.
     */
    val captureLayers = newThemeLayers(activity)

    fun diverged(buffer: PixelizeMosaic.Buffer): Boolean {
      val (r, g, b) = buffer.meanRGB()
      val delta =
        kotlin.math.abs(oldR - r) + kotlin.math.abs(oldG - g) + kotlin.math.abs(oldB - b)
      return delta >= PIXELIZE_MIN_DELTA
    }

    fun startCrossfade(oldLadder: List<android.graphics.Bitmap>, newLadder: List<android.graphics.Bitmap>) {
      val underlay = SnapshotView(activity)
      underlay.prepareMosaicSurface(view.capturedWidth, view.capturedHeight)
      underlay.layoutParams = view.layoutParams
      underlay.elevation = view.elevation
      val index = host.indexOfChild(view).coerceAtLeast(0)
      host.addView(underlay, index)
      transition.underlay = underlay
      transition.mosaics = listOf(oldLadder, newLadder)

      var currentLevel = -1

      fun frame(t: Float) {
        val tri =
          if (t < 0.5f) {
            t / 0.5f
          } else {
            val u = 1f - (t - 0.5f) / 0.5f
            u * u * u
          }

        val level = PixelizeMosaic.level(tri)
        if (level != currentLevel) {
          currentLevel = level
          underlay.setMosaic(newLadder[level])
          view.setMosaic(oldLadder[level])
        }

        val endFade = if (t <= 0.85f) 1f else 1f - (t - 0.85f) / 0.15f
        view.alpha = (1f - t) * endFade
        underlay.alpha = endFade
      }

      frame(0f)
      start(transition, duration, finish) { _, t -> frame(t) }
    }

    /**
     * Build both ladders off the main thread — ~230k pixel copies and 48 small
     * bitmaps, which is a few milliseconds the UI thread should not spend while
     * a frozen overlay is sitting over the app.
     */
    fun buildLadders(newBuf: PixelizeMosaic.Buffer) {
      val submitted =
        runCatching {
            mosaicWorker.execute {
              val oldLadder = PixelizeMosaic.ladder(oldBuf)
              val newLadder = PixelizeMosaic.ladder(newBuf)

              mainHandler.post {
                if (!transitions.contains(transition)) {
                  // Torn down while building. `stop()` has already removed the
                  // views; resolving is all that is left, and the ladders are
                  // ours to drop.
                  PixelizeMosaic.releaseLadder(oldLadder)
                  PixelizeMosaic.releaseLadder(newLadder)
                  finish()
                  return@post
                }

                if (oldLadder == null || newLadder == null) {
                  PixelizeMosaic.releaseLadder(oldLadder)
                  PixelizeMosaic.releaseLadder(newLadder)
                  animateFade(transition, duration, finish)
                  return@post
                }

                startCrossfade(oldLadder, newLadder)
              }
            }
          }
          .isSuccess

      // The worker only refuses work after `dispose()`, and then there is
      // nothing left to animate over.
      if (!submitted) animateFade(transition, duration, finish)
    }

    /*
     * Wait for the incoming theme to actually paint underneath.
     *
     * Capturing once after `settleFrames` often still samples the OLD colours
     * when the theme is React-driven, which makes the crossfade a no-op — so
     * this polls until the mean colour moves.
     *
     * The polling is what used to cost everything: it ran every frame for 24
     * frames, and each attempt called `requestLayout()` on the React root — a
     * full measure and layout of the whole app — then captured the screen at
     * full resolution and dragged ~10 MB back from the GPU to average it. Each
     * attempt now rasterizes into the mosaic grid — ~180x400 rather than
     * 1080x2400 — every other frame, with a budget of six: the same ~12 frames
     * of tolerance for a slow theme, for a fraction of a percent of the work.
     *
     * The attempt captures at the size the mosaic actually needs rather than
     * probing smaller first, so the frame that finally diverges is the frame
     * that produces the buffer. There is no second capture, and nothing has to
     * reconcile two different sampling scales.
     */
    fun attempt(probes: Int) {
      if (!transitions.contains(transition)) {
        finish()
        return
      }

      val exhausted = probes >= PIXELIZE_MAX_PROBES
      val newBuf =
        captureNewTheme(activity, captureLayers, gridWidth, gridHeight)?.let { bitmap ->
          val buffer = PixelizeMosaic.Buffer.from(bitmap)
          bitmap.recycle()
          buffer
        }

      if (newBuf != null && (diverged(newBuf) || exhausted)) {
        buildLadders(newBuf)
        return
      }

      if (exhausted) {
        animateFade(transition, duration, finish)
        return
      }

      waitFrames(PIXELIZE_PROBE_INTERVAL) { attempt(probes + 1) }
    }

    attempt(0)
  }

  /** The windows `captureNewTheme` composes, resolved against the content anchor. */
  private class NewThemeLayers(
    val layers: List<SnapshotView.Layer>,
    val decors: List<View>,
    val width: Int,
    val height: Int,
  )

  private fun newThemeLayers(activity: android.app.Activity): NewThemeLayers? {
    val content = activity.findViewById<ViewGroup>(android.R.id.content) ?: return null
    val root =
      (0 until content.childCount).map(content::getChildAt).firstOrNull { it !is SnapshotView }
        ?: return null

    val width = content.width
    val height = content.height
    if (width <= 0 || height <= 0) return null

    val anchor = locationOnScreen(content)
    val dialogs = showingDialogs(content)

    return NewThemeLayers(
      layers =
        buildList {
          add(layerFor(root, anchor))
          dialogs.forEach { add(layerFor(it.decor, anchor)) }
        },
      decors = buildList { add(root); dialogs.forEach { add(it.decor) } },
      width = width,
      height = height,
    )
  }

  /**
   * The live app in its NEW theme, rasterized at [targetWidth] x [targetHeight].
   *
   * The size is the caller's choice, and it is what makes polling affordable:
   * the mosaic is never finer than one cell per two dp, so this never asks for
   * the screen's real resolution — roughly 1/36 of its pixels, both to draw and
   * to read back.
   *
   * Snapshot overlays (and their underlays) are hidden for the capture, so a
   * dialog-host draw cannot bake a frozen copy into the "new" frame. Live trees
   * are invalidated first so a just-committed theme makes it into the recorded
   * display list — Android's nearest equivalent of `afterScreenUpdates: true`.
   */
  private fun captureNewTheme(
    activity: android.app.Activity,
    layers: NewThemeLayers?,
    targetWidth: Int,
    targetHeight: Int,
  ): android.graphics.Bitmap? {
    if (layers == null) return null

    layers.decors.forEach { it.invalidate() }

    val hidden =
      transitions.flatMap { t ->
        listOfNotNull(t.view to t.view.visibility, t.underlay?.let { it to it.visibility })
      }
    transitions.forEach {
      it.view.visibility = View.INVISIBLE
      it.underlay?.visibility = View.INVISIBLE
    }

    return try {
      val snapshot = SnapshotView(activity)
      val captured =
        snapshot.capture(layers.layers, layers.width, layers.height, targetWidth, targetHeight)
      if (!captured) {
        snapshot.release()
        null
      } else {
        val pixels = snapshot.readPixels()
        snapshot.release()
        pixels
      }
    } finally {
      hidden.forEach { (view, visibility) -> view.visibility = visibility }
    }
  }

  /**
   * Runs a 0→1 animation with the shared curve, retaining the animator on the
   * transition so it survives and can be cancelled.
   *
   * `t` is already eased, so [onFrame] can interpolate linearly.
   */
  private fun start(
    transition: Transition,
    duration: Long,
    finish: () -> Unit,
    onFrame: (SnapshotView, Float) -> Unit,
  ) {
    val view = transition.view
    val animator = ValueAnimator.ofFloat(0f, 1f)
    animator.duration = duration
    animator.interpolator = curve()
    animator.addUpdateListener { onFrame(view, it.animatedValue as Float) }
    onEnd(animator, finish)

    transition.animator = animator
    animator.start()
  }

  /**
   * Calls [finish] when the animation runs to completion, but NOT when it is
   * cancelled — a cancellation comes from a teardown that has already removed the
   * view, and finishing again would double-resolve the promise.
   */
  private fun onEnd(animator: Animator, finish: () -> Unit) {
    animator.addListener(
      object : AnimatorListenerAdapter() {
        private var cancelled = false

        override fun onAnimationCancel(animation: Animator) {
          cancelled = true
        }

        override fun onAnimationEnd(animation: Animator) {
          if (!cancelled) finish()
        }
      }
    )
  }

  /**
   * The same four numbers as the iOS side, so both platforms look identical.
   *
   * Was `(0.2, 0, 0, 1)`, which front-loads the motion hard: half the reveal is
   * over by 20% of the duration and 94% by 62%. At the 200–300ms a production
   * app wants, the visible part collapses into two or three frames and the
   * change reads as a cut. `(0.4, 0, 0.2, 1)` spreads it out — 50% done at 35%
   * of the duration — so short transitions still read as movement.
   */
  private fun curve() = PathInterpolator(0.4f, 0f, 0.2f, 1f)

  // MARK: - Frame waiting

  /**
   * Runs [work] after [frames] display frames. Must be called on the main thread.
   *
   * Several can be in flight at once, one per concurrent transition, and each
   * [work] re-checks that its overlay is still in the stack before touching it.
   */
  private fun waitFrames(frames: Int, work: () -> Unit) {
    if (frames <= 0) {
      work()
      return
    }

    var remaining = frames
    val choreographer = Choreographer.getInstance()

    lateinit var callback: Choreographer.FrameCallback
    callback =
      Choreographer.FrameCallback {
        remaining -= 1
        if (remaining <= 0) work() else choreographer.postFrameCallback(callback)
      }

    choreographer.postFrameCallback(callback)
  }

  // MARK: - Threading

  /**
   * Runs [block] on the main thread synchronously, without deadlocking when the
   * caller is already on it.
   *
   * The timeout is a safety valve, not an expectation: the JS thread blocking
   * here is only ever waiting on a view teardown. If the main thread is so busy
   * that it cannot service the post in time, the [fallback] means the theme still
   * changes — just instantly, with no animation.
   *
   * Only safe for blocks whose side effect is REMOVAL. A late teardown still
   * tears down, which is the outcome the caller wanted; a late capture would
   * attach a snapshot nobody is going to commit, which is why [begin] rolls its
   * own instead of using this.
   */
  private fun <T> onMainSync(fallback: T, block: () -> T): T {
    if (Looper.myLooper() == Looper.getMainLooper()) return block()

    var result = fallback
    val latch = CountDownLatch(1)

    mainHandler.post {
      try {
        result = block()
      } finally {
        latch.countDown()
      }
    }

    return if (latch.await(SYNC_TIMEOUT_MS, TimeUnit.MILLISECONDS)) result else fallback
  }

  private companion object {
    /**
     * Ceiling on simultaneous snapshots.
     *
     * Each one is a full-screen layer the GPU composites every frame, ON TOP of
     * the live app still drawing underneath — so the stack is straight overdraw.
     *
     * Six was tried at three, and three was the wrong trade: the overdraw is GPU
     * work, it was never what a fast tapper felt, and dropping a copy early is a
     * visible pop. The cost that actually hurt under rapid switching was on the
     * CPU and is fixed elsewhere.
     */
    const val MAX_OVERLAYS = 6

    const val SYNC_TIMEOUT_MS = 250L

    /** Matches the visual weight of iOS's `.systemThinMaterial`. */
    const val BLUR_RADIUS_DP = 12f

    /**
     * How far the mean colour has to move before the incoming theme counts as
     * painted. Low enough to catch a subtle palette change, high enough not to
     * fire on a blinking cursor.
     */
    const val PIXELIZE_MIN_DELTA = 12.0

    /** Display frames between new-theme probes, and how many to take. */
    const val PIXELIZE_PROBE_INTERVAL = 2
    const val PIXELIZE_MAX_PROBES = 6
  }
}
