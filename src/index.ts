import { Platform } from 'react-native';
import { NitroModules } from 'react-native-nitro-modules';
import { svgPathToPolygon } from './svgPath';
import type {
  ThemeTransition,
  ThemeTransitionBlurStyle,
  ThemeTransitionDirection,
  ThemeTransitionKind,
  ThemeTransitionShape,
} from './specs/ThemeTransition.nitro';

export type {
  ThemeTransition,
  ThemeTransitionBlurStyle,
  ThemeTransitionDirection,
  ThemeTransitionKind,
  ThemeTransitionShape,
};

/** Everything is optional at the call site; these fill the gaps. */
export type ThemeTransitionConfig = {
  kind?: ThemeTransitionKind;
  /**
   * Animation length in milliseconds. Defaults to 650.
   *
   * There is a floor, applied natively so both platforms agree:
   *
   * | Floor | Kinds |
   * | ----- | ----- |
   * | 200ms | `fade` |
   * | 240ms | `zoom` |
   * | 260ms | the shape reveals, `slide`, `split`, `barnDoor` |
   * | 300ms | `blinds`, `blur` |
   * | 420ms | `dissolve`, `stripes` |
   * | 480ms | `ripple`, `shatter` |
   * | 520ms | `pixlated` |
   * | 620ms | `liquidGlass` |
   *
   * Below those a full-screen copy coming apart does not have enough frames to
   * read as motion — the eye gets the start and the end and nothing between
   * them, which looks like a flicker with a hard edge in it rather than a fast
   * transition. `pixlated` is the highest because it has to grow a mosaic, swap
   * the colours behind it and take the mosaic back down again.
   *
   * Pass `0` to opt out entirely: that still means "no animation" and is not
   * clamped.
   */
  durationMs?: number;
  /**
   * Where the effect starts, in dp. Omit for the centre of the screen.
   *
   * Used by the shape reveals — `circularReveal`, `circularRevealInverse`,
   * `iris` — and by `ripple` and `liquidGlass`. Every other kind ignores it.
   *
   * Pass a touch event's `pageX/pageY` as-is. React Native reports those relative
   * to the surface the touch happened in, and a presented screen — a modal, a
   * form sheet — is its own surface, so inside one they are offset from the
   * window. The snapshot covers the window, but the correction is applied
   * natively: only UIKit knows where a sheet currently sits, and it re-reads that
   * on every capture, so any detent works with no help from the caller.
   *
   * ```ts
   * const { pageX, pageY } = event.nativeEvent;
   * withThemeTransition(applyTheme, { origin: { x: pageX, y: pageY } });
   * ```
   */
  origin?: { x: number; y: number };
  /**
   * Edge the outgoing screen leaves through — `slide`, `split`, `barnDoor`,
   * `blinds`, `stripes`, and `blur` with `blurStyle: 'sweep'`. `'bottom'` drops
   * the old screen off the bottom edge.
   *
   * Every kind but `slide` uses both edges at once, so for those this picks the
   * axis instead: `'top'`/`'bottom'` work horizontally, `'left'`/`'right'`
   * vertically.
   */
  direction?: ThemeTransitionDirection;
  /**
   * Tilt of the boundary line in degrees — `slide`, `split`, `barnDoor`,
   * `blinds`, and `blur` with `blurStyle: 'sweep'`. Defaults to 0, the
   * axis-aligned edge.
   *
   * The sweep still travels along `direction`; the line doing the sweeping is
   * raked over. `{ direction: 'top', angleDeg: 40 }` leaves through the top with
   * a 40° diagonal edge rather than a level one. Positive is clockwise on
   * screen, and the sweep always ends fully uncovered whatever the angle.
   */
  angleDeg?: number;
  /**
   * Outline the old screen collapses into — `iris` only. Defaults to
   * `'hexagon'`.
   *
   * `'circle'` makes `iris` identical to `circularReveal`, which is why that
   * kind is still the one to reach for when a circle is what you want.
   */
  shape?: ThemeTransitionShape;
  /**
   * How `blur` applies itself — `blur` only. Defaults to `'uniform'`.
   *
   * `'uniform'` blurs the whole screen at once and lets it recede, which is the
   * original behaviour. `'sweep'` deepens the blur behind a straight edge
   * travelling across, so the old screen blurs away in one direction rather than
   * all over — and it takes `direction` and `angleDeg` exactly as `slide` does.
   */
  blurStyle?: ThemeTransitionBlurStyle;
  /**
   * How many parallel slabs the screen is cut into — `blinds` only. Defaults to
   * 6, and is clamped natively to 2…24.
   *
   * Each slab wipes across itself at the same time, so a higher count reads as
   * finer louvres.
   */
  bands?: number;
  /**
   * A custom outline as SVG path data (the `d` attribute), e.g. a star, a heart
   * or a logo. `circularReveal`, `circularRevealInverse` and `iris` use it in
   * place of the circle / `shape`: it shrinks (or, for the inverse, grows) from
   * `origin` exactly as the circle would.
   *
   * ```ts
   * withThemeTransition(applyTheme, {
   *   kind: 'circularRevealInverse',
   *   svgPath: 'M12 2l3 7h7l-5.5 4.5L18 21l-6-4-6 4 1.5-7.5L2 9h7z',
   * });
   * ```
   *
   * Any viewBox and any size: the outline is recentred on its centroid and
   * scaled natively. Only the first subpath is used, and the shape should
   * contain its own centre. Invalid data falls back to the default outline.
   */
  svgPath?: string;
  /**
   * Display frames to hold the snapshot before revealing, so the theme swap has
   * painted underneath. Two is enough in practice: Unistyles commits on the JS
   * thread and mounts on the next main-thread pass.
   *
   * On iOS a frame is 1/120s of wall-clock time, so the hold does not depend on
   * the panel's refresh rate or on how busy the main thread is.
   */
  settleFrames?: number;
  /**
   * Hold the snapshot until this settles, THEN count `settleFrames` and reveal.
   * For an app that knows when its new theme has actually painted — views
   * coloured through React props repaint a render after the native styles, and
   * a fixed hold uncovers them in the old colours. Resolve or reject, both
   * release the hold; cap it on your side.
   *
   * A newer `withThemeTransition` call made while this one is still waiting
   * replaces its snapshot: this call's reveal is then dropped, not run late.
   */
  ready?: PromiseLike<unknown>;
};

/**
 * Bumped by every `begin()`.
 *
 * Native holds ONE pending snapshot and evicts it on the next `begin()`. A
 * commit deferred past a newer call — by `ready`, or `pixlated`'s frame wait —
 * would otherwise adopt that call's snapshot and animate it with the stale
 * options, ahead of the newer call's own hold.
 */
let generation = 0;

const DEFAULTS = {
  kind: 'circularReveal' as ThemeTransitionKind,
  direction: 'bottom' as ThemeTransitionDirection,
  /**
   * 650ms, not the 300–400ms a UI animation usually wants.
   *
   * This is not a fade between two frames of the same screen — it is a copy of
   * the whole app being taken apart to reveal a different one, and the eye needs
   * time to read that. Below ~500ms the reveal stops being a transition between
   * two states and starts reading as a flicker, however even the easing curve is.
   * Shorten it deliberately if you want that, but it is not a good default.
   *
   * The native side will not go below a per-kind floor — see `durationMs` on
   * {@link ThemeTransitionConfig}.
   */
  durationMs: 650,
  settleFrames: 2,
  angleDeg: 0,
  shape: 'hexagon' as ThemeTransitionShape,
  blurStyle: 'uniform' as ThemeTransitionBlurStyle,
  bands: 6,
};

/** Every kind the native side implements, for building pickers. */
export const THEME_TRANSITION_KINDS = [
  'fade',
  'circularReveal',
  'circularRevealInverse',
  'iris',
  'slide',
  'split',
  'barnDoor',
  'blinds',
  'blur',
  'liquidGlass',
  'zoom',
  'pixlated',
  'dissolve',
  'stripes',
  'ripple',
  'shatter',
] as const satisfies readonly ThemeTransitionKind[];

/** Every `blur` style, for building pickers. */
export const THEME_TRANSITION_BLUR_STYLES = [
  'uniform',
  'sweep',
] as const satisfies readonly ThemeTransitionBlurStyle[];

/** Every `iris` outline, for building pickers. */
export const THEME_TRANSITION_SHAPES = [
  'circle',
  'diamond',
  'hexagon',
  'roundedRect',
] as const satisfies readonly ThemeTransitionShape[];

export const THEME_TRANSITION_DIRECTIONS = [
  'top',
  'bottom',
  'left',
  'right',
] as const satisfies readonly ThemeTransitionDirection[];

/**
 * The native hybrid object, or `null` where it cannot exist.
 *
 * Resolved lazily and defensively: a JS bundle can run against a native binary
 * that predates this package (any dev client built before it was added), and a
 * missing native module must degrade to "no animation", never to a crash.
 */
let cached: ThemeTransition | null | undefined;

function getNative(): ThemeTransition | null {
  if (cached !== undefined) return cached;

  // iOS and Android both have an implementation; web has no native side at all.
  if (Platform.OS === 'web') {
    cached = null;
    return cached;
  }

  try {
    cached = NitroModules.createHybridObject<ThemeTransition>('ThemeTransition');
  } catch {
    cached = null;
  }

  return cached;
}

/** Whether an animated switch is actually available on this build. */
export function isThemeTransitionAvailable(): boolean {
  return getNative() !== null;
}

/**
 * Runs `applyTheme` underneath a snapshot of the current screen, then animates
 * the snapshot away.
 *
 * `applyTheme` MUST be synchronous. It is invoked while the screen is covered,
 * and the reveal is scheduled from native frame callbacks — an async mutation
 * would land after the reveal had already started.
 *
 * Safe by construction: if the native module is unavailable, or the capture
 * fails, `applyTheme` still runs exactly once, just without animation. It is
 * never skipped and never run twice.
 */
export function withThemeTransition(applyTheme: () => void, config: ThemeTransitionConfig = {}) {
  const native = getNative();

  if (!native) {
    applyTheme();
    return;
  }

  const token = ++generation;
  let captured = false;

  try {
    captured = native.begin();
  } catch {
    captured = false;
  }

  // The theme change happens either way — the snapshot only decides whether it
  // is visible while it happens.
  try {
    applyTheme();
  } catch (error) {
    // Never strand the overlay on top of the app if the caller threw.
    if (captured) {
      try {
        native.abort();
      } catch {
        // nothing further we can do
      }
    }
    throw error;
  }

  if (!captured) return;

  const origin = config.origin;
  const kind = config.kind ?? DEFAULTS.kind;
  const durationMs = config.durationMs ?? DEFAULTS.durationMs;
  const settleFrames = config.settleFrames ?? DEFAULTS.settleFrames;

  const customShape = (config.svgPath && svgPathToPolygon(config.svgPath)) || [];
  if (config.svgPath && !customShape.length && __DEV__) {
    console.warn('[theme-transition] `svgPath` is not a valid closed path; ignoring it.');
  }

  const doCommit = () => {
    // A newer call's `begin()` already evicted this snapshot natively; what is
    // pending now is that call's, and it commits it itself.
    if (token !== generation) return;

    void native
      .commit({
        kind,
        durationMs,
        // Negative means "centre of the screen" on the native side.
        originX: origin?.x ?? -1,
        originY: origin?.y ?? -1,
        settleFrames,
        direction: config.direction ?? DEFAULTS.direction,
        angleDeg: config.angleDeg ?? DEFAULTS.angleDeg,
        shape: config.shape ?? DEFAULTS.shape,
        blurStyle: config.blurStyle ?? DEFAULTS.blurStyle,
        bands: config.bands ?? DEFAULTS.bands,
        customShape,
      })
      .catch(() => {
        try {
          native.abort();
        } catch {
          // nothing further we can do
        }
      });
  };

  // Pixelize needs a second snapshot of the *already painted* new theme.
  // Yield two animation frames so React (useSyncExternalStore / context)
  // can commit before native settle + capture starts — otherwise old≈new.
  const start =
    kind === 'pixlated'
      ? () => {
          requestAnimationFrame(() => {
            requestAnimationFrame(doCommit);
          });
        }
      : doCommit;

  // The caller knows when its new theme has painted: hold the snapshot until
  // then. Either outcome releases it — the reveal must never be stranded.
  if (config.ready) {
    Promise.resolve(config.ready).then(start, start);
  } else {
    start();
  }
}
