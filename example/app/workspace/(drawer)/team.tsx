/**
 * Team — avatars, which are the one thing in the app with a hard circular edge.
 *
 * Circles are worth having in a demo of a CIRCULAR reveal: two curves crossing
 * each other is where an off-by-a-frame origin is easiest to see.
 */
import { StyleSheet, Text, View } from 'react-native';

import { Body, Hint, Screen, SectionTitle, Title, useStyles } from '@/components/ui';
import type { Theme } from '@/theme/themes';

type Member = { name: string; role: string; initials: string; online: boolean };

const TEAM: Member[] = [
  { name: 'Dana Okoro', role: 'Engineering lead', initials: 'DO', online: true },
  { name: 'Priya Raman', role: 'Design', initials: 'PR', online: true },
  { name: 'Marco Vidal', role: 'iOS', initials: 'MV', online: false },
  { name: 'Sasha Lindqvist', role: 'Content', initials: 'SL', online: true },
  { name: 'Tom Njeri', role: 'Infrastructure', initials: 'TN', online: false },
  { name: 'Hana Aoki', role: 'QA', initials: 'HA', online: false },
];

export default function Team() {
  const styles = useStyles(makeStyles);
  const online = TEAM.filter(member => member.online).length;

  return (
    <Screen>
      <Title>Team</Title>
      <Body style={{ marginTop: 8 }}>
        {online} of {TEAM.length} online. The avatars are circles — useful, because the default
        effect is a circular reveal and two curves crossing make a bad origin obvious.
      </Body>

      <SectionTitle>Members</SectionTitle>

      <View style={styles.list}>
        {TEAM.map(member => (
          <View key={member.name} style={styles.row}>
            <View style={styles.avatar}>
              <Text style={styles.initials}>{member.initials}</Text>
              {member.online && <View style={styles.presence} />}
            </View>

            <View style={styles.rowBody}>
              <Text style={styles.name}>{member.name}</Text>
              <Text style={styles.role}>{member.role}</Text>
            </View>
          </View>
        ))}
      </View>

      <Hint>Six invented people. No network call, no avatar images to decode.</Hint>
    </Screen>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    avatar: {
      alignItems: 'center',
      backgroundColor: theme.surfaceAlt,
      borderRadius: 999,
      height: 42,
      justifyContent: 'center',
      width: 42,
    },
    initials: { color: theme.tint, fontSize: 14, fontWeight: '700' },
    list: {
      backgroundColor: theme.surface,
      borderColor: theme.border,
      borderRadius: 16,
      borderWidth: 1,
      gap: 4,
      marginTop: 12,
      padding: 12,
    },
    name: { color: theme.text, fontSize: 14.5, fontWeight: '600' },
    presence: {
      backgroundColor: theme.success,
      borderColor: theme.surface,
      borderRadius: 999,
      borderWidth: 2,
      bottom: 0,
      height: 13,
      position: 'absolute',
      right: 0,
      width: 13,
    },
    role: { color: theme.muted, fontSize: 12, marginTop: 2 },
    row: { alignItems: 'center', flexDirection: 'row', gap: 12, paddingVertical: 8 },
    rowBody: { flex: 1 },
  });
