/**
 * A message thread, pushed onto the workspace stack from the inbox.
 *
 * It sits ABOVE the drawer in the same stack, so switching the theme here proves
 * the reveal is not scoped to whatever navigator started it: the snapshot is the
 * whole root view, and the drawer parked off-screen behind this screen is inside
 * it too.
 */
import { useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { CycleButton, ThemeSwatches } from '@/components/ThemeControls';
import { Body, Callout, Card, Hint, Screen, SectionTitle, Title, useStyles } from '@/components/ui';
import type { Theme } from '@/theme/themes';

const REPLIES = [
  {
    author: 'Dana Okoro',
    time: '09:41',
    body: 'The staging build is green. I need one more pass on the migration notes before we cut, mostly around the fallback path for older devices.',
  },
  {
    author: 'You',
    time: '09:47',
    body: 'Notes are updated. I split the fallback into its own section so it can be read on its own.',
  },
  {
    author: 'Marco Vidal',
    time: '10:02',
    body: 'Checked it on a physical device this morning — no flicker on the first paint, which was the thing I was worried about.',
  },
];

export default function Thread() {
  const { from, subject } = useLocalSearchParams<{ from?: string; subject?: string }>();
  const styles = useStyles(makeStyles);

  return (
    <Screen>
      <Title>{subject ?? 'Thread'}</Title>
      <Hint>{from ?? 'Unknown sender'} · 3 messages</Hint>

      <SectionTitle>Conversation</SectionTitle>

      {REPLIES.map(reply => (
        <View key={reply.time} style={[styles.bubble, reply.author === 'You' && styles.bubbleOwn]}>
          <View style={styles.bubbleHead}>
            <Text style={styles.author}>{reply.author}</Text>
            <Text style={styles.time}>{reply.time}</Text>
          </View>
          <Text style={styles.body}>{reply.body}</Text>
        </View>
      ))}

      <Callout title="One screen up the stack">
        The drawer is still mounted, parked off-screen behind this screen. It is captured with
        everything else, so the reveal here looks identical to the reveal one level down.
      </Callout>

      <Card title="Switch from here" subtitle="Same controls, different navigator depth." icon="color-palette-outline">
        <Body>The icon in the header works too — it is on the right in this stack, so the reveal starts from the opposite corner.</Body>
        <View style={{ marginTop: 8 }}>
          <ThemeSwatches />
        </View>
        <View style={{ marginTop: 12 }}>
          <CycleButton />
        </View>
      </Card>
    </Screen>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    author: { color: theme.text, flex: 1, fontSize: 13.5, fontWeight: '700' },
    body: { color: theme.text, fontSize: 14, lineHeight: 21, marginTop: 6 },
    bubble: {
      backgroundColor: theme.surface,
      borderColor: theme.border,
      borderRadius: 14,
      borderWidth: 1,
      marginTop: 12,
      padding: 14,
    },
    bubbleHead: { alignItems: 'center', flexDirection: 'row', gap: 8 },
    bubbleOwn: { backgroundColor: theme.surfaceAlt, borderColor: theme.surfaceAlt },
    time: { color: theme.muted, fontSize: 11.5 },
  });
