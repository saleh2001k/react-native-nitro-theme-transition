# Changelog

## Unreleased

- **`svgPath` option.** Pass SVG path data and `circularReveal`,
  `circularRevealInverse` and `iris` shrink / grow that outline instead of a
  circle. `ThemeTransitionOptions` gained `customShape`, so the generated bridge
  changed — rebuild native.

## 1.0.0

The API is stable. `withThemeTransition` has had the same call signature since
0.1.0 and is now committed to under semver — new effects and options will keep
arriving in minor releases, and the signature will not change without a major.

Eleven new effects — five to sixteen — a large performance rewrite, and four new
options. Existing 0.1.x calls keep working untouched.

> 0.2.0 was never published; everything it carried is in this release.

### ⚠ Upgrading

**Regenerate the bridge if you vendor this package.** `ThemeTransitionKind`
gained eleven cases and `ThemeTransitionOptions` gained four fields, so the
generated C++/Swift/Kotlin in `nitrogen/generated` is not interchangeable with
0.1.x. Consumers installing from npm get the regenerated bridge in the tarball
and need nothing beyond a rebuild; anyone who regenerated against their own
`nitrogen` version must run `bun run codegen` again.

`react-native-nitro-modules` floor is unchanged (`>=0.36.0`).

### Added

- **`iris`** — the circular reveal with a shape: `'circle'`, `'diamond'`,
  `'hexagon'` or `'roundedRect'`, via the new `shape` option.
- **`split`** — two edges part from the centre and retreat to opposite sides.
- **`barnDoor`** — `split` run the other way: two edges close in on the centre
  and the old screen survives as a shrinking band.
- **`blinds`** — parallel louvres, each wiping across itself in unison. Count
  set by the new `bands` option (default 6, clamped to 2…24).
- **`pixlated`** — the screen breaks into a coarse mosaic and the colour swap
  rides it mid-transition, so neither theme is ever seen sharp mid-flight.
- **`dissolve`** — the screen disintegrates into grain, speck by speck.
- **`stripes`** — the dissolve grain, ordered along `direction`: a grainy edge
  sweeping across rather than a uniform disintegration.
- **`ripple`** — concentric wavefronts expanding from `origin`.
- **`shatter`** — the screen breaks into Voronoi shards that fall away in
  random order.
- **`zoom`** — the old screen scales up and fades.
- **`liquidGlass`** — a sheet of Liquid Glass slides down over the screen, holds
  while the theme changes behind it, then slides back up. The swap happens
  entirely out of sight, so the sheet reads as a physical pane rather than a
  reveal boundary. **iOS 26+**; every other platform and version falls back to
  `blur`, which is the closest material they have.
- **`blurStyle`** — `blur` gains a `'sweep'` mode alongside the default
  `'uniform'`. It is a wipe that brings the NEW theme in out of focus and pulls
  it sharp as it arrives; the outgoing screen is never blurred, it is simply
  taken away. Takes `direction` and `angleDeg` exactly as `slide` does.
  `'uniform'` is unchanged and remains the default.
- **`angleDeg`** — tilts the boundary line for `slide`, `split`, `barnDoor` and
  `blinds` without changing where the sweep travels. `0` is the previous
  axis-aligned behaviour.
- **`THEME_TRANSITION_SHAPES`** and **`THEME_TRANSITION_BLUR_STYLES`** exports,
  alongside the existing kind and direction arrays.
- **Per-kind minimum durations.** A request below the floor for its kind is
  clamped up, because a full-screen copy coming apart in a handful of frames
  reads as a flicker rather than as motion. `durationMs: 0` still means "no
  animation" and is never clamped.

### Performance

The `pixlated` kind could drop the UI to zero under rapid switching. Every cause
was the same cause — it worked at the screen's real resolution — and the fix
applies to the whole mask/mosaic family:

- Outgoing frames are now captured straight into the mosaic grid (~200×440
  rather than ~1200×2600) on iOS, and GPU-downscaled before readback on Android.
  A hardware Bitmap cannot be read by the CPU at all, and that readback was a
  stall.
- The new-theme poll no longer forces a layout of the whole React tree on every
  attempt, no longer captures at full resolution, and runs six times over ~12
  frames instead of 24 times over 24.
- Mosaic and mask frames are pre-built into a ladder once, off the main thread,
  and cached. Playing an effect is now an image assignment per frame — nothing
  is sampled, allocated or rasterised while the animation runs.
- Android pools the `ImageReader`/`HardwareRenderer` behind captures instead of
  allocating a ~10 MB graphics buffer per theme change.
- `fade` moved to `ViewPropertyAnimator` on Android, so the UI thread does no
  per-frame work; `blur` only reassigns its `RenderEffect` on whole-pixel steps.
- iOS drops the cached mask ladders on a memory warning.

### Fixed

- **iOS: `blinds` came out as slanted wedges instead of level louvres**, and
  `barnDoor` was quietly wrong in the same way. Both end with their bands fully
  collapsed, and a zero-area subpath has nothing to draw — so Core Graphics is
  free to drop it, which changes the path's structure between the two ends of
  the animation and leaves Core Animation interpolating points against the wrong
  subpath. The bands now keep a hundredth of a point of thickness, far below one
  device pixel. It is the same trap the circular reveal already avoided by
  clamping its radius to `0.01` rather than `0`; Android was unaffected because
  it rebuilds the clip path per frame and never interpolates one.
- **Android: a stranded overlay after a slow capture.** `onMainSync` reports
  failure after 250 ms but does not cancel the posted work, so a capture that
  landed late attached a snapshot nobody would ever commit or abort — leaving a
  frozen copy of the screen pinned over the live app until the next theme
  change. `begin()` now races the waiter against the capture and the loser
  cleans up. Only reachable when the main thread is badly behind, which is
  exactly the rapid-switching case.
- Debug logging removed from the Android capture path.
- Assorted documentation corrections: `origin`, `direction` and `angleDeg` now
  list the kinds that actually use them.

### Docs

- A [demo site](https://saleh2001k.github.io/react-native-nitro-theme-transition/)
  with full-resolution video of every effect, deployed from `docs/` by GitHub
  Actions.
- The README carries a clip of all sixteen. Neither the clips nor the site are
  in the published tarball — `files` ships source only, so `npm install` is
  unchanged at ~109 kB.
- `scripts/encode-demos.sh` rebuilds both sets from raw screen recordings,
  finding each theme change by its jump in average luminance.

## 0.1.0

Initial release. Five effects — circular reveal, its inverse, wipe, fade and
blur — animated on the OS render thread from a GPU-side copy of the screen, with
no Skia, Reanimated or JS animation library.
