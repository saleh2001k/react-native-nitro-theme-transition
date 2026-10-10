/**
 * The workspace drawer.
 *
 * The icon in the top-left corner — both in the native header and at the top of
 * the drawer panel itself — steps the palette forward. That placement is
 * deliberate rather than decorative: the top-left is where a drawer normally
 * puts its hamburger, so the two controls swap places here and the theme button
 * gets the position the user's thumb already knows.
 *
 * Everything visible while the drawer is open — the panel, the dimmed backdrop,
 * the screen behind it and the native header — is one captured image, so the
 * reveal crosses all of it at once, starting from the icon that was pressed.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
// Expo Router vendors react-navigation as of SDK 56 — importing
// `@react-navigation/drawer` directly is a hard error, not a style preference.
import { Drawer, DrawerContentScrollView } from 'expo-router/drawer';
import { useNavigation, usePathname, useRouter } from 'expo-router';
import { DrawerActions } from 'expo-router/react-navigation';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { ThemeIconButton } from '@/components/nav';
import { useStyles, type IoniconName } from '@/components/ui';
import { useTheme, useThemeName } from '@/theme/store';
import { THEMES, nextThemeName, type Theme } from '@/theme/themes';

type WorkspaceLink = {
  href: string;
  label: string;
  icon: IoniconName;
  badge?: string;
};

const LINKS: WorkspaceLink[] = [
  { href: '/workspace', label: 'Inbox', icon: 'mail-outline', badge: '4' },
  { href: '/workspace/projects', label: 'Projects', icon: 'albums-outline' },
  { href: '/workspace/calendar', label: 'Calendar', icon: 'calendar-outline' },
  { href: '/workspace/reports', label: 'Reports', icon: 'stats-chart-outline' },
  { href: '/workspace/team', label: 'Team', icon: 'people-outline' },
];

function WorkspaceDrawerContent() {
  const theme = useTheme();
  const themeName = useThemeName();
  const styles = useStyles(makeStyles);
  const router = useRouter();
  const pathname = usePathname();

  return (
    <DrawerContentScrollView contentContainerStyle={styles.drawer}>
      {/* The icon sits first in a row, so it is the top-left element of the
          panel — the same control as the one in the header, same behaviour. */}
      <View style={styles.header}>
        <View style={styles.headerIcon}>
          <ThemeIconButton size={20} />
        </View>

        <View style={styles.headerText}>
          <Text style={styles.brand}>Northwind</Text>
          <Text style={styles.brandHint}>
            {THEMES[themeName].label} · tap the icon for{' '}
            {THEMES[nextThemeName(themeName)].label}
          </Text>
        </View>
      </View>

      <View style={styles.links}>
        {LINKS.map(link => {
          const active = pathname === link.href;

          return (
            <Pressable
              key={link.href}
              accessibilityRole="link"
              accessibilityState={{ selected: active }}
              onPress={() => router.navigate(link.href as never)}
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
              {link.badge && (
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{link.badge}</Text>
                </View>
              )}
            </Pressable>
          );
        })}
      </View>

      <View style={styles.footer}>
        <Pressable
          accessibilityRole="button"
          onPress={() => router.dismissTo('/')}
          style={({ pressed }) => [styles.exit, pressed && styles.pressed]}
        >
          <Ionicons name="exit-outline" size={16} color={theme.muted} />
          <Text style={styles.exitText}>Leave workspace</Text>
        </Pressable>
      </View>
    </DrawerContentScrollView>
  );
}

/** Hoisted so a theme change does not hand the navigator a new prop identity. */
const renderDrawerContent = () => <WorkspaceDrawerContent />;

/**
 * Opens THIS drawer.
 *
 * Unlike the root `DrawerMenuButton`, no route lookup is needed: a header
 * rendered from the drawer's own `screenOptions` already sits inside that
 * navigator, so `useNavigation()` returns the drawer itself.
 */
function WorkspaceMenuButton() {
  const theme = useTheme();
  const navigation = useNavigation() as unknown as {
    openDrawer?: () => void;
    dispatch: (action: unknown) => void;
  };

  return (
    <Pressable
      accessibilityLabel="Open navigation drawer"
      accessibilityRole="button"
      hitSlop={10}
      onPress={() => {
        if (typeof navigation.openDrawer === 'function') {
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
 * Header buttons, hoisted so a theme change does not hand the navigator new
 * prop identities. The theme icon takes the LEFT slot and the hamburger moves
 * to the right — the whole point of this stack.
 */
const renderHeaderLeft = () => <ThemeIconButton />;
const renderHeaderRight = () => <WorkspaceMenuButton />;

export default function WorkspaceDrawerLayout() {
  const theme = useTheme();

  return (
    <Drawer
      drawerContent={renderDrawerContent}
      screenOptions={{
        drawerType: 'front',
        drawerStyle: {
          backgroundColor: theme.surface,
          width: 296,
          paddingTop: 90,
        },
        overlayColor: theme.isDark ? 'rgba(0,0,0,0.6)' : 'rgba(20,18,16,0.35)',
        headerStyle: { backgroundColor: theme.surface },
        headerTintColor: theme.tint,
        headerTitleStyle: { color: theme.text },
        headerShadowVisible: false,
        sceneStyle: { backgroundColor: theme.background },
        headerLeft: renderHeaderLeft,
        headerRight: renderHeaderRight,
      }}
    >
      <Drawer.Screen name="index" options={{ title: 'Inbox' }} />
      <Drawer.Screen name="projects" options={{ title: 'Projects' }} />
      <Drawer.Screen name="calendar" options={{ title: 'Calendar' }} />
      <Drawer.Screen name="reports" options={{ title: 'Reports' }} />
      <Drawer.Screen name="team" options={{ title: 'Team' }} />
    </Drawer>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    badge: {
      backgroundColor: theme.accent,
      borderRadius: 999,
      minWidth: 22,
      paddingHorizontal: 7,
      paddingVertical: 2,
    },
    badgeText: {
      color: theme.onPrimary,
      fontSize: 11,
      fontWeight: '700',
      textAlign: 'center',
    },
    brand: { color: theme.text, fontSize: 19, fontWeight: '800' },
    brandHint: { color: theme.muted, fontSize: 12, marginTop: 3 },
    drawer: { paddingTop: 12 },
    exit: {
      alignItems: 'center',
      borderColor: theme.border,
      borderRadius: 12,
      borderWidth: 1,
      flexDirection: 'row',
      gap: 8,
      justifyContent: 'center',
      paddingVertical: 12,
    },
    exitText: { color: theme.muted, fontSize: 13, fontWeight: '600' },
    footer: {
      borderTopColor: theme.border,
      borderTopWidth: 1,
      marginTop: 24,
      paddingHorizontal: 16,
      paddingTop: 16,
    },
    header: { alignItems: 'center', flexDirection: 'row', gap: 12, paddingHorizontal: 16 },
    headerIcon: {
      alignItems: 'center',
      backgroundColor: theme.surfaceAlt,
      borderRadius: 10,
      height: 36,
      justifyContent: 'center',
      width: 36,
    },
    headerText: { flex: 1 },
    link: {
      alignItems: 'center',
      borderRadius: 10,
      flexDirection: 'row',
      gap: 12,
      paddingHorizontal: 12,
      paddingVertical: 12,
    },
    linkActive: { backgroundColor: theme.surfaceAlt },
    linkText: { color: theme.text, flex: 1, fontSize: 15, fontWeight: '500' },
    links: { marginTop: 18, paddingHorizontal: 8 },
    pressed: { opacity: 0.65 },
  });
