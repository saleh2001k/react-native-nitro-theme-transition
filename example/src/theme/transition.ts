/**
 * The policy layer.
 *
 * The library is deliberately unopinionated: it snapshots the screen, runs a
 * callback, and animates the snapshot away. It knows nothing about themes. So
 * every app grows a thin module like this one, which decides:
 *
 *   - which effect, how long, how many settle frames  → from the settings store
 *   - where the reveal starts                          → the parked touch point
 *   - when NOT to animate                              → Reduce Motion, first paint
 *
 * Copy this file into your own app and delete what you do not need.
 */
import { AccessibilityInfo, Dimensions, type GestureResponderEvent } from 'react-native';
import * as Haptics from 'expo-haptics';
import {
  isThemeTransitionAvailable,
  withThemeTransition,
  type ThemeTransitionConfig,
} from 'react-native-nitro-theme-transition';

import { CUSTOM_SHAPES } from '../kinds';
import { themeStore } from './store';
import { nextThemeName, oppositeThemeName, type ThemeName } from './themes';

/* -------------------------------------------------------------------------- */
/* Origin parking                                                             */
/* -------------------------------------------------------------------------- */

/**
 * A theme change travels UI → store → styling runtime, and the press event that
 * started it is long gone by the time the theme is applied. So the coordinate is
 * PARKED in a module variable and consumed once.
 *
 * The TTL matters: without it, a theme change triggered by something unrelated
 * (a deep link, a system appearance change, a timer) would inherit a stale touch
 * point and appear to explode out of a place the user never touched.
 */
const ORIGIN_TTL_MS = 250;

type Point = { x: number; y: number };

let parked: (Point & { at: number }) | null = null;

/** Remembers where the user touched. Call from `onTouchStart`, not `onPress`. */
export function parkOrigin(point: Point) {
  parked = { ...point, at: Date.now() };
}

/**
 * Parks the point a touch happened at.
 *
 * `pageX/pageY` is the touch in the coordinate space of the SURFACE it happened
 * in — the screen, or the modal, or the sheet. That is exactly what the library
 * wants: it knows where each presented surface sits in the window and translates
 * the point itself, which is the only place the sheet's own offset is knowable.
 *
 * Nothing else is needed here. Measuring the touched view was an attempt to
 * convert to window space in JavaScript, and it cannot work: inside a sheet even
 * `measureInWindow` reports positions in that sheet's surface.
 */
export function parkOriginFromEvent(event: GestureResponderEvent) {
  const { pageX, pageY } = event.nativeEvent;
  parkOrigin({ x: pageX, y: pageY });
}

/** Reads and clears the parked point, if it is still fresh. */
export function consumeOrigin(): Point | undefined {
  if (!parked) return undefined;

  const point = parked;
  parked = null;

  if (Date.now() - point.at > ORIGIN_TTL_MS) return undefined;

  return { x: point.x, y: point.y };
}

/** For the debug readout on the origin case screen. */
export function peekOrigin(): (Point & { at: number }) | null {
  return parked;
}

/* -------------------------------------------------------------------------- */
/* Reduce Motion                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Read once at startup and kept current by a listener, because the check has to
 * be SYNCHRONOUS at the moment of the theme change — `isReduceMotionEnabled()`
 * returns a Promise, and awaiting it would put the theme swap after the capture.
 */
let reduceMotion = false;

AccessibilityInfo.isReduceMotionEnabled()
  .then(value => {
    reduceMotion = value;
  })
  .catch(() => {
    reduceMotion = false;
  });

AccessibilityInfo.addEventListener('reduceMotionChanged', value => {
  reduceMotion = value;
});

export function isReduceMotionEnabled(): boolean {
  return reduceMotion;
}

/* -------------------------------------------------------------------------- */
/* The entry points                                                           */
/* -------------------------------------------------------------------------- */

export type ChangeOptions = Partial<ThemeTransitionConfig> & {
  /** Overrides the custom SVG outline from settings; `none` forces the plain shape. */
  customShape?: keyof typeof CUSTOM_SHAPES | 'none';
  /** Force the animation off for this one change (rehydration, tests, "instant" buttons). */
  instant?: boolean;
  /** Use this point instead of whatever is parked. */
  origin?: Point;
};

function resolveOrigin(options: ChangeOptions): Point | undefined {
  if (options.origin) return options.origin;

  const { originMode } = themeStore.getState().settings;

  // The non-touch modes exist to show that the origin is a plain coordinate:
  // nothing about the gesture is magic.
  switch (originMode) {
    case 'touch':
      return consumeOrigin();
    case 'center':
      // `undefined` means "centre of the screen" to the library.
      consumeOrigin();
      return undefined;
    case 'topLeft':
      consumeOrigin();
      return { x: 0, y: 0 };
    case 'bottomRight': {
      consumeOrigin();
      // Measured here rather than passed as a huge number: the native side sizes
      // the circle from the origin to the furthest corner, so an off-screen
      // origin would produce a much larger radius than intended.
      const { width, height } = Dimensions.get('window');
      return { x: width, y: height };
    }
  }
}

/**
 * Runs any synchronous mutation underneath a snapshot.
 *
 * Everything in the app funnels through here — including the screens that change
 * more than the theme — because the rule is "wrap the WHOLE swap": if a screen
 * also flips React state, that belongs inside the same callback so the reveal
 * uncovers a settled screen rather than one that is still reconciling.
 */
export function runThemed(apply: () => void, options: ChangeOptions = {}) {
  const { settings, hydrated } = themeStore.getState();

  const skip =
    options.instant === true ||
    !settings.animate ||
    !hydrated ||
    (settings.respectReduceMotion && reduceMotion);

  if (settings.haptics) {
    // Fire and forget: haptics must never delay the capture.
    void Haptics.selectionAsync().catch(() => {});
  }

  if (skip) {
    apply();
    return;
  }

  const custom = options.customShape ?? settings.customShape;

  withThemeTransition(apply, {
    kind: options.kind ?? settings.kind,
    direction: options.direction ?? settings.direction,
    angleDeg: options.angleDeg ?? settings.angleDeg,
    shape: options.shape ?? settings.shape,
    svgPath: custom === 'none' ? undefined : CUSTOM_SHAPES[custom].path,
    blurStyle: options.blurStyle ?? settings.blurStyle,
    bands: options.bands ?? settings.bands,
    durationMs: options.durationMs ?? settings.durationMs,
    settleFrames: options.settleFrames ?? settings.settleFrames,
    origin: resolveOrigin(options),
  });
}

/** Switches to a specific theme, animated. */
export function setTheme(name: ThemeName, options: ChangeOptions = {}) {
  runThemed(() => themeStore.setTheme(name), options);
}

/** Steps to the next palette in the four-theme cycle. */
export function cycleTheme(options: ChangeOptions = {}) {
  setTheme(nextThemeName(themeStore.getState().themeName), options);
}

/** The plain two-state light ⇄ dark flip. */
export function toggleTheme(options: ChangeOptions = {}) {
  setTheme(oppositeThemeName(themeStore.getState().themeName), options);
}

export { isThemeTransitionAvailable };
