# react-native-nitro-theme-transition

Native, GPU-driven theme-change transitions for React Native — sixteen of them:
circular reveal and its inverse, iris, wipe, split, barn door, blinds, fade,
zoom, blur, Liquid Glass, pixelize, dissolve, stripes, ripple and shatter.

**No Skia. No Reanimated. No JS animation library.** The animation is Core
Animation on iOS and the platform animators on Android, both interpolated by the
OS render thread, so a busy JavaScript thread cannot drop a frame of it.

Built on [Nitro Modules](https://nitro.margelo.com). iOS and Android.

**[▶ Watch all sixteen, full resolution →](https://saleh2001k.github.io/react-native-nitro-theme-transition/)**

<p align="center">
  <img src="https://raw.githubusercontent.com/saleh2001k/react-native-nitro-theme-transition/main/assets/demo.gif" alt="The example app switching themes on Android and iOS side by side" width="700">
</p>

<p align="center">
  <em>The <a href="./example">example app</a>, running on Android and iOS at the same time.</em>
</p>

```sh
npm install react-native-nitro-theme-transition react-native-nitro-modules
```

Then rebuild — this ships native code, so an existing dev client will not have
it:

```sh
npx expo prebuild
npx expo run:ios      # or: run:android
```

Until you rebuild, `withThemeTransition` degrades to an instant theme change
rather than crashing.

## Usage

```tsx
import { withThemeTransition } from 'react-native-nitro-theme-transition';

withThemeTransition(
  () => setScheme(s => (s === 'light' ? 'dark' : 'light')), // must be synchronous
  { kind: 'circularReveal', durationMs: 650, origin: { x, y } },
);
```

That is the whole API surface. Pass the touch point as `origin` and the reveal
starts from the user's finger:

```tsx
<Pressable
  onPress={event => {
    const { pageX, pageY } = event.nativeEvent;
    withThemeTransition(toggleTheme, { origin: { x: pageX, y: pageY } });
  }}
/>
```

## It is not a theming library

It has no idea what a theme is. It snapshots the screen, runs **your** callback,
and animates the snapshot away. Anything that changes the UI synchronously works
— a theme, a locale/RTL flip, a font-size change, a density switch.

There is no dependency on Unistyles or any styling library. The
[`example/`](./example) app drives four palettes from a plain module-level store
and React Native's own `StyleSheet` to prove it — no styling runtime, no
animation library.

`applyTheme` runs **exactly once** in every path: if the native module is
missing, the capture fails, or the platform is web, the change still happens —
just without animation. The animation is never load-bearing.

## Demos

<table>
<tr>
<td width="50%" valign="top" align="center">

<img src="https://raw.githubusercontent.com/saleh2001k/react-native-nitro-theme-transition/main/assets/real-app.gif" alt="Brand and light/dark switching inside a production app" width="330">

**In a real app**

Brand, mode, font and corner-radius changes in a shipping
[Unistyles](https://www.unistyl.es) app — the transition riding on top of a
genuine whole-app restyle, not a toy screen.

</td>
<td width="50%" valign="top" align="center">

<img src="https://raw.githubusercontent.com/saleh2001k/react-native-nitro-theme-transition/main/assets/stress-js.gif" alt="The animation staying smooth while the JS thread is under load" width="330">

**JS thread under load**

Watch the `JS` counter in the perf overlay collapse while the reveal keeps
running. The animation is submitted to the OS render thread once, so JavaScript
is not in the loop and cannot stutter it.

</td>
</tr>
</table>

## Options

| Option         | Default            | Notes                                                      |
| -------------- | ------------------ | ---------------------------------------------------------- |
| `kind`         | `'circularReveal'` | see below                                                  |
| `durationMs`   | `650`              | below ~500ms most reveals read as a flicker; try longer for `pixlated` |
| `origin`       | screen centre      | where the effect starts, in dp — pass the touch's `pageX/pageY`; used by the shape reveals and `ripple` |
| `direction`    | `'bottom'`         | `slide` / `split` / `barnDoor` / `blinds` / `stripes` / swept `blur` — the edge, or the axis for the two-edged kinds |
| `angleDeg`     | `0`                | `slide` / `split` / `barnDoor` / `blinds` / swept `blur` — tilt of the boundary line, in degrees |
| `shape`        | `'hexagon'`        | `iris` — `'circle' \| 'diamond' \| 'hexagon' \| 'roundedRect'` |
| `blurStyle`    | `'uniform'`        | `blur` — `'uniform' \| 'sweep'`                             |
| `bands`        | `6`                | `blinds` — louvre count, clamped to 2…24                   |
| `svgPath`      | —                  | custom outline as SVG path data — `circularReveal`, `circularRevealInverse` and `iris` shrink / grow it instead of a circle |
| `settleFrames` | `2`                | frames to hold before revealing, so the change has painted |
| `ready`        | —                  | promise to wait for before counting `settleFrames` — see below |

`THEME_TRANSITION_KINDS` and `THEME_TRANSITION_DIRECTIONS` are exported as arrays
for building pickers. `isThemeTransitionAvailable()` reports whether the native
module is present.

### `origin` — just pass `pageX/pageY`

React Native reports a touch relative to the surface it happened in, and a
presented screen — a modal, a form sheet — is its own surface. A sheet resting at
its half detent starts ~450dp down the window, so a press inside it arrives with
a `pageY` that is short by exactly that much.

You do not have to correct for it, and in JavaScript you cannot: inside a sheet
even `measureInWindow` reports positions in that sheet's surface. The library
translates the point natively, reading the presentation's own frame at capture
time — so dragging a sheet between detents needs no handling at all.

```ts
const { pageX, pageY } = event.nativeEvent;
withThemeTransition(applyTheme, { origin: { x: pageX, y: pageY } });
```

### `settleFrames` — the one thing to check

This is the only setting whose right value depends on **your** theme system.

The snapshot is held for `settleFrames` frames before the reveal starts, so the
new state has painted underneath it. The default of `2` suits a theme system that
applies **synchronously** — Unistyles (a C++ shadow-tree commit), direct native
writes, and so on.

If you drive the theme with React state, your callback returns having only
_scheduled_ a re-render: React still has to reconcile, commit, mount and paint.
On a large tree that can exceed two frames, and revealing early means briefly
animating down to the **old** colours. Raise it:

```ts
withThemeTransition(applyTheme, { settleFrames: 4 });
```

On iOS a frame here is `1/120s` of wall-clock time, not a display-link
callback, so the hold is the same on a 60Hz iPhone as on a ProMotion one and
does not grow while the main thread is busy mounting the change.

If your app can tell when the new theme has actually rendered, pass that
instead of guessing a frame count. The snapshot holds until `ready` settles
(resolve or reject), then counts `settleFrames` as usual:

```ts
const committed = waitForThemeCommit(next, { maxMs: 500 }); // your code — cap it
withThemeTransition(() => setTheme(next), { ready: committed, settleFrames: 3 });
```

The library does not time it out, so cap the promise yourself. A newer
`withThemeTransition` call made while one is still waiting replaces its
snapshot; the older reveal is dropped.

`pixlated` also waits two animation frames before `commit` and then polls the
second (new-theme) snapshot until it differs from the first — settleFrames alone
is not enough for that kind when the theme is React-driven.

## Kinds

All sixteen, recorded on Android and iOS side by side. Full-resolution video for
every one is on the **[demo site](https://saleh2001k.github.io/react-native-nitro-theme-transition/)**.

<table>
<tr align="center">
<td><img src="https://raw.githubusercontent.com/saleh2001k/react-native-nitro-theme-transition/main/assets/demos/fade.gif" width="185" alt="fade"><br><a href="https://saleh2001k.github.io/react-native-nitro-theme-transition/effects/fade.html"><code>fade</code></a></td>
<td><img src="https://raw.githubusercontent.com/saleh2001k/react-native-nitro-theme-transition/main/assets/demos/circle-in.gif" width="185" alt="circularReveal"><br><a href="https://saleh2001k.github.io/react-native-nitro-theme-transition/effects/circularReveal.html"><code>circularReveal</code></a></td>
<td><img src="https://raw.githubusercontent.com/saleh2001k/react-native-nitro-theme-transition/main/assets/demos/circle-out.gif" width="185" alt="circularRevealInverse"><br><a href="https://saleh2001k.github.io/react-native-nitro-theme-transition/effects/circularRevealInverse.html"><code>circularRevealInverse</code></a></td>
<td><img src="https://raw.githubusercontent.com/saleh2001k/react-native-nitro-theme-transition/main/assets/demos/iris.gif" width="185" alt="iris"><br><a href="https://saleh2001k.github.io/react-native-nitro-theme-transition/effects/iris.html"><code>iris</code></a></td>
</tr>
<tr align="center">
<td><img src="https://raw.githubusercontent.com/saleh2001k/react-native-nitro-theme-transition/main/assets/demos/wipe.gif" width="185" alt="slide"><br><a href="https://saleh2001k.github.io/react-native-nitro-theme-transition/effects/slide.html"><code>slide</code></a></td>
<td><img src="https://raw.githubusercontent.com/saleh2001k/react-native-nitro-theme-transition/main/assets/demos/split.gif" width="185" alt="split"><br><a href="https://saleh2001k.github.io/react-native-nitro-theme-transition/effects/split.html"><code>split</code></a></td>
<td><img src="https://raw.githubusercontent.com/saleh2001k/react-native-nitro-theme-transition/main/assets/demos/barn-door.gif" width="185" alt="barnDoor"><br><a href="https://saleh2001k.github.io/react-native-nitro-theme-transition/effects/barnDoor.html"><code>barnDoor</code></a></td>
<td><img src="https://raw.githubusercontent.com/saleh2001k/react-native-nitro-theme-transition/main/assets/demos/blinds.gif" width="185" alt="blinds"><br><a href="https://saleh2001k.github.io/react-native-nitro-theme-transition/effects/blinds.html"><code>blinds</code></a></td>
</tr>
<tr align="center">
<td><img src="https://raw.githubusercontent.com/saleh2001k/react-native-nitro-theme-transition/main/assets/demos/blur.gif" width="185" alt="blur"><br><a href="https://saleh2001k.github.io/react-native-nitro-theme-transition/effects/blur.html"><code>blur</code></a></td>
<td><img src="https://raw.githubusercontent.com/saleh2001k/react-native-nitro-theme-transition/main/assets/demos/liquid-glass.gif" width="185" alt="liquidGlass"><br><a href="https://saleh2001k.github.io/react-native-nitro-theme-transition/effects/liquidGlass.html"><code>liquidGlass</code></a></td>
<td><img src="https://raw.githubusercontent.com/saleh2001k/react-native-nitro-theme-transition/main/assets/demos/zoom.gif" width="185" alt="zoom"><br><a href="https://saleh2001k.github.io/react-native-nitro-theme-transition/effects/zoom.html"><code>zoom</code></a></td>
<td><img src="https://raw.githubusercontent.com/saleh2001k/react-native-nitro-theme-transition/main/assets/demos/pixlated.gif" width="185" alt="pixlated"><br><a href="https://saleh2001k.github.io/react-native-nitro-theme-transition/effects/pixlated.html"><code>pixlated</code></a></td>
</tr>
<tr align="center">
<td><img src="https://raw.githubusercontent.com/saleh2001k/react-native-nitro-theme-transition/main/assets/demos/dissolve.gif" width="185" alt="dissolve"><br><a href="https://saleh2001k.github.io/react-native-nitro-theme-transition/effects/dissolve.html"><code>dissolve</code></a></td>
<td><img src="https://raw.githubusercontent.com/saleh2001k/react-native-nitro-theme-transition/main/assets/demos/stripes.gif" width="185" alt="stripes"><br><a href="https://saleh2001k.github.io/react-native-nitro-theme-transition/effects/stripes.html"><code>stripes</code></a></td>
<td><img src="https://raw.githubusercontent.com/saleh2001k/react-native-nitro-theme-transition/main/assets/demos/ripple.gif" width="185" alt="ripple"><br><a href="https://saleh2001k.github.io/react-native-nitro-theme-transition/effects/ripple.html"><code>ripple</code></a></td>
<td><img src="https://raw.githubusercontent.com/saleh2001k/react-native-nitro-theme-transition/main/assets/demos/shatter.gif" width="185" alt="shatter"><br><a href="https://saleh2001k.github.io/react-native-nitro-theme-transition/effects/shatter.html"><code>shatter</code></a></td>
</tr>
</table>

| `kind`                    | What the outgoing screen does                                      |
| ------------------------- | ------------------------------------------------------------------ |
| [`'circularReveal'`](https://saleh2001k.github.io/react-native-nitro-theme-transition/effects/circularReveal.html)        | collapses **into** a circle at `origin`                            |
| [`'circularRevealInverse'`](https://saleh2001k.github.io/react-native-nitro-theme-transition/effects/circularRevealInverse.html) | a hole opens **out** from `origin` and grows                       |
| [`'iris'`](https://saleh2001k.github.io/react-native-nitro-theme-transition/effects/iris.html)                  | collapses into a `shape` — diamond, hexagon or squircle             |
| [`'slide'`](https://saleh2001k.github.io/react-native-nitro-theme-transition/effects/slide.html)                 | a straight edge wipes across, painting the new theme               |
| [`'split'`](https://saleh2001k.github.io/react-native-nitro-theme-transition/effects/split.html)                 | two edges part from the centre, retreating to opposite sides       |
| [`'barnDoor'`](https://saleh2001k.github.io/react-native-nitro-theme-transition/effects/barnDoor.html)              | two edges close in; the old screen shrinks to a middle band        |
| [`'blinds'`](https://saleh2001k.github.io/react-native-nitro-theme-transition/effects/blinds.html)                | `bands` parallel louvres, each wiping across itself at once        |
| [`'fade'`](https://saleh2001k.github.io/react-native-nitro-theme-transition/effects/fade.html)                  | dissolves                                                          |
| [`'zoom'`](https://saleh2001k.github.io/react-native-nitro-theme-transition/effects/zoom.html)                  | scales up and fades                                                |
| [`'blur'`](https://saleh2001k.github.io/react-native-nitro-theme-transition/effects/blur.html)                  | blurs away — all at once, or swept across; see `blurStyle`          |
| [`'liquidGlass'`](https://saleh2001k.github.io/react-native-nitro-theme-transition/effects/liquidGlass.html)           | a sheet of Liquid Glass slides down, the theme swaps behind it, and it slides back up — **iOS 26+**, falls back to `blur` elsewhere |
| [`'pixlated'`](https://saleh2001k.github.io/react-native-nitro-theme-transition/effects/pixlated.html)              | breaks into pixels; the colour swap rides the mosaic mid-transition |
| [`'dissolve'`](https://saleh2001k.github.io/react-native-nitro-theme-transition/effects/dissolve.html)              | disintegrates into grain, speck by speck                           |
| [`'stripes'`](https://saleh2001k.github.io/react-native-nitro-theme-transition/effects/stripes.html)               | a grainy edge sweeps across, ordered along `direction`             |
| [`'ripple'`](https://saleh2001k.github.io/react-native-nitro-theme-transition/effects/ripple.html)                | wavefronts expand from `origin`                                    |
| [`'shatter'`](https://saleh2001k.github.io/react-native-nitro-theme-transition/effects/shatter.html)               | breaks into shards that fall away in turn                          |

They come from four families, and the family is what actually matters:

| Family | Kinds | The one idea |
| --- | --- | --- |
| Shape mask | `circularReveal`, `circularRevealInverse`, `iris` | a shrinking outline at a point |
| Straight boundaries | `slide`, `split`, `barnDoor`, `blinds` | half-planes sweeping along a normal |
| Mask ladder | `dissolve`, `stripes`, `ripple`, `shatter` | a per-cell disappearing order, pre-built |
| Whole-layer | `fade`, `zoom`, `blur`, `liquidGlass`, `pixlated` | animate the copy itself |

All sixteen share one timing curve, so the two platforms agree. Each also has a
minimum duration — 200ms for `fade`, 240ms for `zoom`, 260ms for the reveals and
the sweeps, 300ms for `blinds` and `blur`, 420ms for `dissolve` and `stripes`,
480ms for `ripple` and `shatter`, 520ms for `pixlated`, 620ms for `liquidGlass`. Below those a full-screen
copy coming apart has too few frames to read as motion. Pass `durationMs: 0` to
opt out of animating entirely; that is never clamped.

`circularReveal` and its inverse are the same shape run opposite ways, and they
are each other's natural counterpart: whichever is used for light→dark, the other
reads as "undo" for dark→light.

`slide` is a **wipe, not a translation** — nothing on screen moves. The old
pixels stay exactly where they are and stop being drawn as the boundary passes
over them, so it reads as a line painting the new colours across the screen.
Translating the snapshot instead drags the whole UI sideways, which looks like a
page transition rather than a theme change.

### `blurStyle` — all at once, or swept

`'uniform'` is the original behaviour: the whole screen blurs, recedes slightly
and fades. `'sweep'` is a wipe that brings the NEW theme in **out of focus** and
pulls it sharp as it arrives:

```ts
withThemeTransition(applyTheme, {
  kind: 'blur',
  blurStyle: 'sweep',
  direction: 'bottom',
});
```

The blur is on the **incoming** side, not the outgoing one. The old screen is
never blurred: it stays crisp right up to the edge and is simply taken away by
the mask, while the theme arriving behind it starts heavily out of focus and
sharpens as the wipe crosses. Blurring the outgoing copy instead reads as the
screen you are leaving being smeared off, which is the opposite of the intent.

The swept variant takes `direction` and `angleDeg` exactly as `slide` does.

### `angleDeg` — tilting the wipe

`slide` and `split` sweep a boundary along a normal rather than clipping a
rectangle, so the line can be raked over without changing where it travels:

```ts
withThemeTransition(applyTheme, { kind: 'slide', direction: 'top', angleDeg: 40 });
```

That still leaves through the top; the edge doing the leaving is 40° off level.
Positive is clockwise on screen, and the sweep always ends fully uncovered
whatever the angle, because it measures its own travel along the tilted normal.

`split` uses both edges at once, so `direction` picks the axis for it:
`'top'`/`'bottom'` part the screen horizontally, `'left'`/`'right'` vertically.

### The mask ladder — `dissolve`, `stripes`, `ripple`, `shatter`

The reference for this effect is a Skia fragment shader that discards a pixel
when its cell's noise falls below a rising threshold. There is no shader here,
and there does not need to be one: the noise is **static**, so a cell simply has
a fixed time at which it disappears, and every frame the effect can ever draw is
known in advance.

So it is a pre-built stack of alpha masks, computed once and shared by every
transition that matches. On iOS the whole sequence is handed to the render server
as discrete keyframes, which puts it in the same class as the reveals — nothing
runs per frame at all.

Nothing in that argument depends on the value being *noise*, which is why four
kinds share the implementation. Any per-cell number in 0…1 is a valid
disappearing order: `dissolve` uses the hash, `stripes` uses position along
`direction` roughened with a little hash, `ripple` uses distance from `origin`
with a sine riding on it, and `shatter` uses the hash of the nearest of 48 seeds
so whole Voronoi shards leave together.

### `pixlated` — dual snapshot

Unlike the other kinds, pixelize needs **both** themes on screen at once: the
outgoing frame and a second capture of the already-painted incoming theme. They
share one triangle `blockSize` curve (chunkiest at the midpoint); the old mosaic
fades out over the full duration so the colour change is obvious mid-transition,
behind the pixels — the same look as Skia's `pixelize`, without Skia.

For React-driven themes the library also yields two animation frames before
`commit` and, on the native side, polls the second capture until it differs from
the first (or hits a short frame budget). Capturing too early samples the old
colours twice, which makes the mid crossfade a no-op and the real swap appear
only when the overlay is removed.

### How each one is done

| `kind`                    | iOS                                      | Android                                   |
| ------------------------- | ---------------------------------------- | ----------------------------------------- |
| `'fade'`                  | `UIViewPropertyAnimator`, opacity        | `ViewPropertyAnimator` → `alpha`          |
| `'circularReveal'`        | `CAShapeLayer` mask + `CABasicAnimation` | `ViewAnimationUtils.createCircularReveal` |
| `'circularRevealInverse'` | the same mask, even-odd fill rule        | `Canvas.clipOutPath` in `onDraw`          |
| `'iris'`                  | the same mask, a fixed-vertex polygon    | `Canvas.clipPath` on the same polygon     |
| `'slide'`                 | animated mask half-plane                 | `Canvas.clipRect`, or `clipPath` if tilted |
| `'split'` `'barnDoor'` `'blinds'` | animated mask half-planes / slabs | `Canvas.clipPath` over all of them        |
| `'blur'`                  | `UIVisualEffectView` + property animator | `RenderEffect.createBlurEffect` (API 31+) |
| `'zoom'`                  | `UIViewPropertyAnimator`, scale + alpha  | `ViewPropertyAnimator`, scale + alpha     |
| `'liquidGlass'`           | a sliding `UIGlassEffect` sheet, swap held behind it | falls back to `blur`            |
| `'pixlated'`              | dual mosaic + alpha crossfade            | dual mosaic + alpha crossfade             |
| `'dissolve'` `'stripes'` `'ripple'` `'shatter'` | discrete `CAKeyframeAnimation` on a mask | `ALPHA_8` mask composited `DST_IN` |

Below API 31 there is no `RenderEffect`, and the fallback is the same motion
without the blur rather than a CPU blur that would drop frames.

## How it works

A theme change is typically a whole-app style re-evaluation plus a tree commit,
synchronous on the JS thread. It cannot be animated frame by frame. So this
package does not animate the theme at all. It:

1. takes a **GPU-side copy** of the screen and pins it on top;
2. lets you change the theme underneath it, invisibly;
3. animates the copy away with the platform's own animator.

|             | The copy                                                                          | Animated by                            |
| ----------- | --------------------------------------------------------------------------------- | -------------------------------------- |
| **iOS**     | `UIView.snapshotView(afterScreenUpdates:false)`                                    | Core Animation, on the render server   |
| **Android** | a `RenderNode` recording rasterized by `HardwareRenderer` into a hardware `Bitmap` | `ValueAnimator` / `ViewAnimationUtils` |

No pixels are ever read back to the CPU, encoded or decoded.

### The Android capture must be rasterized

Worth knowing if you read the source, because it is a trap that compiles, runs,
and looks like a broken animation rather than a broken capture.

Recording the view into a `RenderNode` and drawing _that_ does not work.
`View.draw(Canvas)` → `dispatchDraw` → `drawChild` emits each child on a hardware
canvas as `drawRenderNode(child.renderNode)` — a **reference** to the child's
live RenderNode, not a copy of its pixels. The "snapshot" is therefore a live
mirror: the instant the theme changes, it changes too. Every mask, clip and
opacity animation then plays over content identical to what is underneath, so
nothing appears to happen — except `blur`, where the effect itself is visible
even though it is blurring the wrong frame.

So the recording is only step one. Step two renders it into an offscreen surface
with `HardwareRenderer`, which resolves every referenced RenderNode into actual
pixels. Below API 29 there is no public `HardwareRenderer`, so it falls back to a
software `Canvas` — which rasterizes for the same reason.

## Concurrent transitions

Switching again before a reveal finishes does **not** cancel anything. Each
change gets its own snapshot and its own animation, and they play at the same
time:

```
iOS: overlay window                  Android: android.R.id.content
  ├─ snapshot A  ← oldest, TOP-most      ├─ [2] snapshot A  ← oldest, TOP-most
  └─ snapshot B  ← next                  ├─ [1] snapshot B  ← next
     app window                          └─ [0] React Native root
       ↑ live app, newest theme               ↑ live app, newest theme
```

On iOS the copies are hosted in a window of their own, one level above the app.
That is what lets the capture be a snapshot of the **whole window** — the only
way to be sure a presented modal is in it — without copying the copies.

Every snapshot reveals whatever sits directly beneath it, which is exactly the
state the app was in one step later — so newer snapshots go **below** older ones.
The stack stays visually consistent however fast you tap, and no animation is
ever cut short or restarted.

At most six run at once. Each is a full-screen layer the GPU composites every
frame — and on Android a full-screen buffer, roughly 10 MB at 1080×2400 — so the
stack is bounded; past the limit the **oldest** is dropped, which is the least
visible choice because by then it is furthest through its animation. Every
snapshot is released as soon as its animation ends, including an explicit
`recycle()` so the GPU buffer is not left to the garbage collector.

## Not handled

- **Reduce Motion.** Deliberately the app's call, not the library's — check
  `AccessibilityInfo.isReduceMotionEnabled()` and skip the animation yourself.
- **`Modal` on Android.** Best-effort via dialog-host capture; confirm on your
  RN version. On **iOS** the capture is a snapshot of the scene's windows, so
  everything presented (RN `Modal`, a router modal, a form sheet, an alert) is
  included along with its dimming.
- **System windows.** Alerts, share sheets, autofill and the keyboard are drawn
  by the OS above the app's window and are never part of the copy.
- **Web.** No native side; the callback runs and the change is instant.

## Example

An Expo Router app with a drawer, native bottom tabs, modals, a form sheet and
**sixteen case screens** — one per situation a real app runs into: reveal
origins, rapid switching, a blocked JS thread, settle-frame tuning, RN `Modal`
vs router modals, keyboards, long lists, native SwiftUI/Compose surfaces,
Reduce Motion, missing-module fallbacks and rotation.

```sh
cd example
bun install          # or npm install
bun run prebuild
bun run ios          # or: bun run android
```

Its map is in [`example/README.md`](./example/README.md); the integration
patterns worth copying live in `example/src/theme/transition.ts`.

## Contributing

`src/specs/ThemeTransition.nitro.ts` is the source of truth. After changing it:

```sh
bun run codegen      # nitrogen
bun run build        # bob
```

`nitrogen/generated/` is committed on purpose — CocoaPods needs it at
`pod install` time and Gradle needs it at sync time.

## License

MIT © [Saleh Almashni](https://salehos.com)
