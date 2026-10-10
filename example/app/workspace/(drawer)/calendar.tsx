/**
 * Calendar — an agenda with coloured accent rails.
 */
import { StyleSheet, Text, View } from 'react-native';

import { Body, Hint, Screen, SectionTitle, Title, useStyles } from '@/components/ui';
import type { Theme } from '@/theme/themes';

type Slot = { time: string; title: string; where: string; tone: 'tint' | 'accent' | 'success' | 'muted' };

const AGENDA: { day: string; slots: Slot[] }[] = [
  {
    day: 'Today',
    slots: [
      { time: '09:30', title: 'Standup', where: 'Huddle room', tone: 'tint' },
      { time: '11:00', title: 'Palette review', where: 'Design lab', tone: 'accent' },
      { time: '14:15', title: 'Accessibility audit', where: 'Remote', tone: 'success' },
      { time: '16:00', title: 'Focus block', where: 'No meetings', tone: 'muted' },
    ],
  },
  {
    day: 'Tomorrow',
    slots: [
      { time: '10:00', title: 'Release cut 1.4', where: 'Remote', tone: 'tint' },
      { time: '13:00', title: 'Onboarding walkthrough', where: 'Room 2', tone: 'accent' },
      { time: '15:30', title: 'Retro', where: 'Huddle room', tone: 'success' },
    ],
  },
];

export default function Calendar() {
  const styles = useStyles(makeStyles);

  return (
    <Screen>
      <Title>Calendar</Title>
      <Body style={{ marginTop: 8 }}>
        Thin coloured rails against a surface — the narrowest elements in the app, and the first
        place a half-painted frame would be visible.
      </Body>

      {AGENDA.map(section => (
        <View key={section.day}>
          <SectionTitle>{section.day}</SectionTitle>

          <View style={styles.list}>
            {section.slots.map(slot => (
              <View key={`${section.day}-${slot.time}`} style={styles.slot}>
                <Text style={styles.time}>{slot.time}</Text>
                <View style={[styles.rail, styles[slot.tone]]} />

                <View style={styles.slotBody}>
                  <Text style={styles.slotTitle}>{slot.title}</Text>
                  <Text style={styles.slotWhere}>{slot.where}</Text>
                </View>
              </View>
            ))}
          </View>
        </View>
      ))}

      <Hint>Times are hard-coded. This screen exists to be looked at, not used.</Hint>
    </Screen>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    accent: { backgroundColor: theme.accent },
    list: {
      backgroundColor: theme.surface,
      borderColor: theme.border,
      borderRadius: 16,
      borderWidth: 1,
      gap: 2,
      marginTop: 12,
      padding: 12,
    },
    muted: { backgroundColor: theme.muted },
    rail: { borderRadius: 999, width: 3 },
    slot: { alignItems: 'stretch', flexDirection: 'row', gap: 12, paddingVertical: 10 },
    slotBody: { flex: 1, justifyContent: 'center' },
    slotTitle: { color: theme.text, fontSize: 14.5, fontWeight: '600' },
    slotWhere: { color: theme.muted, fontSize: 12, marginTop: 2 },
    success: { backgroundColor: theme.success },
    time: { color: theme.muted, fontSize: 12, fontVariant: ['tabular-nums'], paddingTop: 2, width: 46 },
    tint: { backgroundColor: theme.tint },
  });
