/**
 * Inbox — the workspace drawer's first screen.
 *
 * Fake data on purpose. What matters is that it is a dense, ordinary list of
 * themed rows: enough surface area that a mistimed reveal shows up as a band of
 * the wrong colour crossing the rows, rather than being hidden by a mostly empty
 * screen.
 */
import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Body, Hint, Row, Screen, SectionTitle, Stat, Title, useStyles } from '@/components/ui';
import type { Theme } from '@/theme/themes';
import { parkOriginFromEvent } from '@/theme/transition';

type Message = {
  id: string;
  from: string;
  subject: string;
  preview: string;
  time: string;
  unread: boolean;
};

const MESSAGES: Message[] = [
  {
    id: 'm1',
    from: 'Dana Okoro',
    subject: 'Q3 rollout — final sign-off',
    preview: 'The staging build is green. I need one more pass on the migration notes before we…',
    time: '09:41',
    unread: true,
  },
  {
    id: 'm2',
    from: 'Build bot',
    subject: 'main → release/1.4 passed',
    preview: '412 tests, 0 failures, 2 skipped. Artifacts retained for 30 days.',
    time: '09:12',
    unread: true,
  },
  {
    id: 'm3',
    from: 'Priya Raman',
    subject: 'Design review moved to Thursday',
    preview: 'Rescheduled so the accessibility audit lands first. Same room, same length.',
    time: 'Yesterday',
    unread: true,
  },
  {
    id: 'm4',
    from: 'Marco Vidal',
    subject: 're: contrast ratios on the dark palette',
    preview: 'Muted text against surfaceAlt is 4.2:1. Bumping it clears AA without touching…',
    time: 'Yesterday',
    unread: true,
  },
  {
    id: 'm5',
    from: 'Ops digest',
    subject: 'Weekly reliability summary',
    preview: 'p99 down 40ms week over week. One incident, resolved in 11 minutes.',
    time: 'Mon',
    unread: false,
  },
  {
    id: 'm6',
    from: 'Sasha Lindqvist',
    subject: 'Onboarding copy, second draft',
    preview: 'Cut it from nine screens to four. The palette picker moved into settings.',
    time: 'Mon',
    unread: false,
  },
  {
    id: 'm7',
    from: 'Finance',
    subject: 'Expense report approved',
    preview: 'Reimbursement scheduled for the next cycle. No action needed.',
    time: 'Fri',
    unread: false,
  },
];

export default function Inbox() {
  const router = useRouter();
  const styles = useStyles(makeStyles);
  const unread = MESSAGES.filter(message => message.unread).length;

  return (
    <Screen>
      <Title>Inbox</Title>
      <Body style={{ marginTop: 8 }}>
        Tap the sun in the top-left — of the header or of the drawer — and the reveal starts from
        the icon and crosses every row below it.
      </Body>

      <Row gap={10} wrap style={{ marginTop: 16 }}>
        <Stat label="unread" value={String(unread)} />
        <Stat label="total" value={String(MESSAGES.length)} />
        <Stat label="drafts" value="2" />
      </Row>

      <SectionTitle>Today</SectionTitle>

      <View style={styles.list}>
        {MESSAGES.map(message => (
          <Pressable
            key={message.id}
            accessibilityRole="button"
            onTouchStart={parkOriginFromEvent}
            onPress={() =>
              router.push({
                pathname: '/workspace/thread',
                params: { from: message.from, subject: message.subject },
              })
            }
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
          >
            <View style={[styles.dot, !message.unread && styles.dotRead]} />

            <View style={styles.rowBody}>
              <View style={styles.rowHead}>
                <Text style={styles.from} numberOfLines={1}>
                  {message.from}
                </Text>
                <Text style={styles.time}>{message.time}</Text>
              </View>

              <Text style={[styles.subject, message.unread && styles.subjectUnread]} numberOfLines={1}>
                {message.subject}
              </Text>
              <Text style={styles.preview} numberOfLines={2}>
                {message.preview}
              </Text>
            </View>
          </Pressable>
        ))}
      </View>

      <Hint>Opening a message pushes it onto the workspace stack, over the drawer.</Hint>
    </Screen>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    dot: {
      backgroundColor: theme.tint,
      borderRadius: 4,
      height: 8,
      marginTop: 6,
      width: 8,
    },
    dotRead: { backgroundColor: 'transparent' },
    from: { color: theme.text, flex: 1, fontSize: 14.5, fontWeight: '700' },
    list: {
      backgroundColor: theme.surface,
      borderColor: theme.border,
      borderRadius: 16,
      borderWidth: 1,
      marginTop: 12,
      overflow: 'hidden',
    },
    preview: { color: theme.muted, fontSize: 12.5, lineHeight: 17, marginTop: 3 },
    pressed: { backgroundColor: theme.surfaceAlt },
    row: {
      borderBottomColor: theme.border,
      borderBottomWidth: StyleSheet.hairlineWidth,
      flexDirection: 'row',
      gap: 10,
      padding: 14,
    },
    rowBody: { flex: 1 },
    rowHead: { alignItems: 'center', flexDirection: 'row', gap: 8 },
    subject: { color: theme.text, fontSize: 13.5, marginTop: 2 },
    subjectUnread: { fontWeight: '600' },
    time: { color: theme.muted, fontSize: 11.5 },
  });
