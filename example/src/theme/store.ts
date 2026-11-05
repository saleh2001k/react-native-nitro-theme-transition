/**
 * The app's theme state, in a plain external store rather than React context.
 *
 * Why not `useState`: the library's callback must be SYNCHRONOUS. A module-level
 * store lets `setTheme()` mutate and notify inside that callback with no `await`
 * anywhere, which is exactly the shape a real styling runtime (Unistyles, a
 * Zustand slice, MobX) has. React subscribers still re-render asynchronously —
 * see `settleFrames` in `transition.ts` — but the SOURCE of truth is already
 * correct the moment the callback returns.
 *
 * Everything here is deliberately dependency-free: `useSyncExternalStore` is
 * built into React.
 */
import { useSyncExternalStore } from 'react';
import type {
  ThemeTransitionBlurStyle,
  ThemeTransitionDirection,
  ThemeTransitionKind,
  ThemeTransitionShape,
} from 'react-native-nitro-theme-transition';

import type { CustomShapeKey } from '../kinds';
import { THEMES, type Theme, type ThemeName } from './themes';

/** Where the reveal circle is centred. */
export type OriginMode = 'touch' | 'center' | 'topLeft' | 'bottomRight';

export type Settings = {
  kind: ThemeTransitionKind;
  direction: ThemeTransitionDirection;
  /** Tilt of the boundary line for `slide` / `split`, in degrees. */
  angleDeg: number;
  /** Outline `iris` collapses into. */
  shape: ThemeTransitionShape;
  /** SVG outline for the shape reveals; `none` keeps the circle / `shape`. */
  customShape: CustomShapeKey | 'none';
  /** How `blur` applies itself. */
  blurStyle: ThemeTransitionBlurStyle;
  /** How many louvres `blinds` cuts the screen into. */
  bands: number;
  durationMs: number;
  settleFrames: number;
  originMode: OriginMode;
  /** Master switch — off means the theme still changes, just instantly. */
  animate: boolean;
  /** Skip the animation when the OS "Reduce Motion" setting is on. */
  respectReduceMotion: boolean;
  /** Fire a selection tick on every theme change. */
  haptics: boolean;
};

type State = {
  themeName: ThemeName;
  settings: Settings;
  /**
   * False until the persisted theme has been restored. The first apply is NOT
   * animated: there is no previous screen to reveal, and snapshotting a
   * half-mounted app flashes over the first paint.
   */
  hydrated: boolean;
  /** Every theme change ever made this session, newest last. Used by the log screens. */
  changes: number;
};

const DEFAULT_SETTINGS: Settings = {
  kind: 'circularReveal',
  direction: 'bottom',
  angleDeg: 0,
  shape: 'hexagon',
  customShape: 'none',
  blurStyle: 'uniform',
  bands: 6,
  // Longer than a production app would use (300–450ms) so each effect is
  // actually watchable.
  durationMs: 650,
  // 3, not the library default of 2: React only *schedules* the re-render when
  // the callback returns, so the new colours need an extra frame to paint.
  settleFrames: 3,
  originMode: 'touch',
  animate: true,
  respectReduceMotion: true,
  haptics: true,
};

let state: State = {
  themeName: 'light',
  settings: DEFAULT_SETTINGS,
  hydrated: false,
  changes: 0,
};

const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getState(): State {
  return state;
}

/** Replaces the whole state object so `useSyncExternalStore` sees a new snapshot. */
function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  emit();
}

export const themeStore = {
  subscribe,
  getState,

  /** Synchronous by design — safe to call inside `withThemeTransition`. */
  setTheme(name: ThemeName) {
    if (name === state.themeName) return;
    set({ themeName: name, changes: state.changes + 1 });
  },

  setSettings(patch: Partial<Settings>) {
    set({ settings: { ...state.settings, ...patch } });
  },

  resetSettings() {
    set({ settings: DEFAULT_SETTINGS });
  },

  markHydrated(name: ThemeName) {
    set({ themeName: name, hydrated: true });
  },
};

export function useThemeName(): ThemeName {
  return useSyncExternalStore(subscribe, () => state.themeName);
}

export function useTheme(): Theme {
  return THEMES[useThemeName()];
}

export function useSettings(): Settings {
  return useSyncExternalStore(subscribe, () => state.settings);
}

export function useHydrated(): boolean {
  return useSyncExternalStore(subscribe, () => state.hydrated);
}

export function useChangeCount(): number {
  return useSyncExternalStore(subscribe, () => state.changes);
}

export { DEFAULT_SETTINGS };
