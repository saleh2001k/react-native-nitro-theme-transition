/**
 * The workspace stack.
 *
 * A second, self-contained navigator mounted as a sibling of `(drawer)` on the
 * root stack — a stack whose first screen is its OWN drawer. It exists to show
 * two things the main demo does not:
 *
 *   1. a drawer nested inside a stack still lives in the app's root view, so it
 *      is captured and revealed like everything else, one level deeper;
 *   2. a theme change fired from a NATIVE header button behaves exactly like one
 *      fired from the screen body — the header is inside the snapshot, and the
 *      touch point comes from the icon that was pressed.
 *
 * The drawer draws its own headers, so the stack hides its header for that
 * screen and only shows one for the pushed detail screen.
 */
import { Stack } from 'expo-router';

import { ThemeIconButton, useStackOptions } from '@/components/nav';

export default function WorkspaceStackLayout() {
  const options = useStackOptions();

  return (
    <Stack screenOptions={options}>
      {/* `gestureEnabled: false` so the left edge belongs to the drawer. Left
          on, the stack's back-swipe wins the edge and the drawer never opens
          by gesture. */}
      <Stack.Screen
        name="(drawer)"
        options={{ headerShown: false, gestureEnabled: false }}
      />

      {/* Pushed on top of the drawer, so the drawer is no longer reachable by a
          swipe — which is the point: it is a stack, not a tab. */}
      <Stack.Screen
        name="thread"
        options={{
          title: 'Thread',
          headerRight: () => <ThemeIconButton />,
        }}
      />
    </Stack>
  );
}
