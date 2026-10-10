/**
 * Navigation chrome shared by every tab's stack.
 *
 * The headers here are NATIVE (react-native-screens), so they are part of the
 * captured view and animate with the rest of the screen — unlike the OS status
 * bar, which is not. Worth knowing when a transition looks "almost" right.
 */
import Ionicons from "@expo/vector-icons/Ionicons";
import { useNavigation } from "expo-router";
import { DrawerActions } from "expo-router/react-navigation";
import { Pressable } from "react-native";

import { useTheme } from "@/theme/store";
import { THEMES, nextThemeName, type ThemeName } from "@/theme/themes";
import { cycleTheme, parkOriginFromEvent } from "@/theme/transition";

/** The drawer's own navigation object, addressed by route rather than by bubbling. */
type DrawerNavigation = {
  openDrawer?: () => void;
  dispatch: (action: unknown) => void;
};

/**
 * Opens the drawer that wraps the tabs.
 *
 * `useNavigation('/(drawer)')` asks for the DRAWER's navigation object directly.
 * The alternative — dispatching `DrawerActions.openDrawer()` from the screen's
 * own navigation — depends on the action bubbling up through the native tab
 * navigator, which is not something to rely on. The dispatch is kept as a
 * fallback for navigator versions that do not expose the helper.
 *
 * The workspace drawer does NOT use this: its header is rendered by the drawer
 * itself, so it already has the right navigation object and needs no lookup.
 */
export function DrawerMenuButton() {
  const theme = useTheme();
  const navigation = useNavigation("/(drawer)") as unknown as DrawerNavigation;

  return (
    <Pressable
      accessibilityLabel="Open navigation drawer"
      accessibilityRole="button"
      hitSlop={10}
      onPress={() => {
        if (typeof navigation.openDrawer === "function") {
          navigation.openDrawer();
          return;
        }

        navigation.dispatch(DrawerActions.openDrawer());
      }}
    >
      <Ionicons name="menu" size={22} color={theme.tint} />
    </Pressable>
  );
}

/**
 * A single icon that steps the palette forward.
 *
 * Two details make it work as a HEADER button rather than an ordinary one:
 *
 *   - `onTouchStart` parks the coordinate before `onPress` runs, so the reveal
 *     starts from the icon itself. A native header hosts a real React Native
 *     view, so the touch reports usable `pageX/pageY` like anywhere else;
 *   - the icon is derived from the theme it is currently showing, so it repaints
 *     inside the same commit as the rest of the header — it is part of the
 *     snapshot, not something that flips a frame later.
 */
export function ThemeIconButton({ size = 22 }: { size?: number }) {
  const theme = useTheme();
  const next = THEMES[nextThemeName(theme.name)];

  return (
    <Pressable
      accessibilityLabel={`Switch theme to ${next.label}`}
      accessibilityRole="button"
      hitSlop={12}
      onTouchStart={parkOriginFromEvent}
      onPress={() => cycleTheme()}
      style={({ pressed }) => (pressed ? { opacity: 0.6 } : undefined)}
    >
      <Ionicons
        name={theme.isDark ? "moon" : "sunny"}
        size={size}
        color={theme.tint}
      />
    </Pressable>
  );
}

/**
 * Native header + content colours.
 *
 * Cached per theme rather than rebuilt per render, for the same reason as
 * `useStyles`: these go to a NATIVE navigator, which compares them to decide
 * whether to re-apply the header. A fresh object every render means every screen
 * in every stack re-sends its header options on every theme change, and there
 * are only four possible answers.
 */
const stackOptions = new Map<ThemeName, StackOptions>();

type StackOptions = {
  readonly headerStyle: { readonly backgroundColor: string };
  readonly headerTintColor: string;
  readonly headerTitleStyle: { readonly color: string };
  readonly headerShadowVisible: false;
  readonly contentStyle: { readonly backgroundColor: string };
};

export function useStackOptions(): StackOptions {
  const theme = useTheme();

  let options = stackOptions.get(theme.name);

  if (!options) {
    options = {
      headerStyle: { backgroundColor: theme.surface },
      headerTintColor: theme.tint,
      headerTitleStyle: { color: theme.text },
      headerShadowVisible: false,
      contentStyle: { backgroundColor: theme.background },
    } as const;
    stackOptions.set(theme.name, options);
  }

  return options;
}
