/**
 * Root layout.
 *
 * Owns four things the rest of the app relies on:
 *
 *   1. the gesture-handler root (the drawer needs it);
 *   2. the one-off theme "rehydration", which is deliberately NOT animated;
 *   3. the window background colour, so nothing white shows through behind the
 *      snapshot while it animates;
 *   4. the root stack, which is where every modal presentation lives, because a
 *      modal pushed from a tab still belongs to the root navigator.
 */
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { useEffect } from 'react';
import { Appearance } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { themeStore, useTheme } from '@/theme/store';
import type { ThemeName } from '@/theme/themes';

/**
 * Stands in for reading a persisted preference (AsyncStorage, MMKV, SQLite).
 * Async on purpose — that is what makes the first apply different from every
 * other one.
 */
async function loadStoredTheme(): Promise<ThemeName> {
  await new Promise(resolve => setTimeout(resolve, 60));
  return Appearance.getColorScheme() === 'dark' ? 'dark' : 'light';
}

export default function RootLayout() {
  const theme = useTheme();

  useEffect(() => {
    let cancelled = false;

    void loadStoredTheme().then(name => {
      if (cancelled) return;

      // `markHydrated` applies the theme WITHOUT a transition. There is no
      // previous screen to reveal, and snapshotting a half-mounted app flashes
      // over the first paint. Everything after this point animates.
      themeStore.markHydrated(name);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  // The window itself sits below the React Native root. If it stays the default
  // colour, a transparent moment in any effect shows the wrong background — so
  // it follows the theme like everything else.
  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(theme.background);
  }, [theme.background]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        {/*
          The status bar is drawn by the OS, OUTSIDE the captured view, so it
          flips instantly while the snapshot is still animating. See the
          "System chrome" case.
        */}
        <StatusBar style={theme.isDark ? 'light' : 'dark'} />

        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: theme.surface },
            headerTintColor: theme.tint,
            headerTitleStyle: { color: theme.text },
            contentStyle: { backgroundColor: theme.background },
          }}
        >
          <Stack.Screen name="(drawer)" options={{ headerShown: false }} />

          {/* A second navigator entirely: a stack whose first screen is its own
              drawer. Pushed on top of everything above, so a theme change fired
              from in there still snapshots the same single root view. */}
          <Stack.Screen name="workspace" options={{ headerShown: false }} />

          {/* A native modal presentation: a child view controller / dialog that
              still lives inside the app's own window, so it IS captured. */}
          <Stack.Screen
            name="modal"
            options={{ presentation: 'modal', title: 'Router modal' }}
          />

          {/* iOS form sheet — a detented card over the app. */}
          <Stack.Screen
            name="sheet"
            options={{
              presentation: 'formSheet',
              title: 'Form sheet',
              sheetAllowedDetents: [0.5, 0.9],
              sheetGrabberVisible: true,
            }}
          />

          {/* Transparent modal: the screen underneath stays visible, which makes
              it the clearest way to see what a snapshot actually contains. */}
          <Stack.Screen
            name="overlay"
            options={{ presentation: 'transparentModal', headerShown: false, animation: 'fade' }}
          />
        </Stack>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
