/**
 * Drawer layout.
 *
 * The drawer is an ordinary React Native view inside the app's root, so it is
 * part of the capture: opening it and switching the theme snapshots the drawer
 * too, and the reveal plays over the whole screen including the dimmed backdrop.
 *
 * It also proves a smaller point — the drawer is animated by Reanimated on the
 * UI thread while the theme transition is animated by the OS compositor. The two
 * never contend, because neither runs in JavaScript.
 */
import Ionicons from "@expo/vector-icons/Ionicons";
// Expo Router vendors react-navigation as of SDK 56 — importing
// `@react-navigation/drawer` directly is a hard error, not a style preference.
import { Drawer, DrawerContentScrollView } from "expo-router/drawer";
import { usePathname, useRouter } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { ThemeSwatches } from "@/components/ThemeControls";
import { useStyles, type IoniconName } from "@/components/ui";
import { useChangeCount, useTheme, useThemeName } from "@/theme/store";
import { THEMES, type Theme } from "@/theme/themes";
import { cycleTheme } from "@/theme/transition";

type DrawerLink = { href: string; label: string; icon: IoniconName };

const LINKS: DrawerLink[] = [
  { href: "/", label: "Playground", icon: "color-wand-outline" },
  { href: "/cases", label: "Cases", icon: "flask-outline" },
  { href: "/gallery", label: "Gallery", icon: "grid-outline" },
  { href: "/settings", label: "Settings", icon: "options-outline" },
  { href: "/playbook", label: "Playbook", icon: "book-outline" },
  { href: "/workspace", label: "Workspace", icon: "briefcase-outline" },
  { href: "/about", label: "About", icon: "information-circle-outline" },
];

function DrawerContent() {
  const theme = useTheme();
  const themeName = useThemeName();
  const changes = useChangeCount();
  const styles = useStyles(makeStyles);
  const router = useRouter();
  const pathname = usePathname();

  return (
    <DrawerContentScrollView contentContainerStyle={styles.drawer}>
      <Text style={styles.brand}>Theme Transition</Text>
      <Text style={styles.brandHint}>
        {THEMES[themeName].label} · {changes} change{changes === 1 ? "" : "s"}{" "}
        this session
      </Text>

      <View style={styles.links}>
        {LINKS.map((link) => {
          const active = pathname === link.href;

          return (
            <Pressable
              key={link.href}
              accessibilityRole="link"
              onPress={() => router.push(link.href as never)}
              style={({ pressed }) => [
                styles.link,
                active && styles.linkActive,
                pressed && styles.pressed,
              ]}
            >
              <Ionicons
                name={link.icon}
                size={18}
                color={active ? theme.tint : theme.muted}
              />
              <Text style={[styles.linkText, active && { color: theme.tint }]}>
                {link.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <Text style={styles.group}>Switch from in here</Text>
      <Text style={styles.groupHint}>
        The drawer is inside the snapshot, so the reveal covers it too.
      </Text>

      <View style={styles.swatches}>
        <ThemeSwatches />
      </View>

      <Pressable
        accessibilityRole="button"
        onPress={() => cycleTheme()}
        style={({ pressed }) => [styles.cycle, pressed && styles.pressed]}
      >
        <Ionicons
          name="color-palette-outline"
          size={16}
          color={theme.onPrimary}
        />
        <Text style={styles.cycleText}>Next palette</Text>
      </Pressable>
    </DrawerContentScrollView>
  );
}

/** Hoisted so a theme change does not hand the navigator a new prop identity. */
const renderDrawerContent = () => <DrawerContent />;

export default function DrawerLayout() {
  const theme = useTheme();

  return (
    <Drawer
      drawerContent={renderDrawerContent}
      screenOptions={{
        drawerType: "front",
        drawerStyle: {
          backgroundColor: theme.surface,
          width: 300,
          paddingTop: 120,
        },
        overlayColor: theme.isDark ? "rgba(0,0,0,0.6)" : "rgba(20,18,16,0.35)",
        headerStyle: { backgroundColor: theme.surface },
        headerTintColor: theme.tint,
        headerTitleStyle: { color: theme.text },
        sceneStyle: { backgroundColor: theme.background },
      }}
    >
      <Drawer.Screen
        name="(tabs)"
        options={{ headerShown: false, title: "Explorer" }}
      />
      <Drawer.Screen name="about" options={{ title: "About" }} />
      <Drawer.Screen name="playbook" options={{ title: "Playbook" }} />
    </Drawer>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    brand: {
      color: theme.text,
      fontSize: 20,
      fontWeight: "800",
      paddingHorizontal: 16,
    },
    brandHint: {
      color: theme.muted,
      fontSize: 12,
      marginTop: 4,
      paddingHorizontal: 16,
    },
    cycle: {
      alignItems: "center",
      backgroundColor: theme.primary,
      borderRadius: 12,
      flexDirection: "row",
      gap: 8,
      justifyContent: "center",
      marginHorizontal: 16,
      marginTop: 16,
      paddingVertical: 13,
    },
    cycleText: { color: theme.onPrimary, fontSize: 14, fontWeight: "700" },
    drawer: { paddingTop: 12 },
    group: {
      color: theme.text,
      fontSize: 12,
      fontWeight: "700",
      letterSpacing: 0.6,
      marginTop: 26,
      paddingHorizontal: 16,
      textTransform: "uppercase",
    },
    groupHint: {
      color: theme.muted,
      fontSize: 12,
      lineHeight: 17,
      marginTop: 4,
      paddingHorizontal: 16,
    },
    link: {
      alignItems: "center",
      borderRadius: 10,
      flexDirection: "row",
      gap: 12,
      paddingHorizontal: 12,
      paddingVertical: 12,
    },
    linkActive: { backgroundColor: theme.surfaceAlt },
    linkText: { color: theme.text, fontSize: 15, fontWeight: "500" },
    links: { marginTop: 18, paddingHorizontal: 8 },
    pressed: { opacity: 0.65 },
    swatches: { marginTop: 12, paddingHorizontal: 16 },
  });
