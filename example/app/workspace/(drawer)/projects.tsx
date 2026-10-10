/**
 * Projects — cards with progress bars.
 *
 * The bars are the useful part: a solid fill over a track means two theme
 * colours meeting at a hard edge, and any tearing during the reveal shows up
 * there before it shows up anywhere else.
 */
import { StyleSheet, Text, View } from 'react-native';

import { Body, Card, Hint, Row, Screen, SectionTitle, Title, useStyles } from '@/components/ui';
import type { Theme } from '@/theme/themes';

type Project = {
  name: string;
  owner: string;
  progress: number;
  status: 'On track' | 'At risk' | 'Shipped';
};

const PROJECTS: Project[] = [
  { name: 'Palette system', owner: 'Dana Okoro', progress: 0.82, status: 'On track' },
  { name: 'Native tab migration', owner: 'Marco Vidal', progress: 0.55, status: 'At risk' },
  { name: 'Onboarding rewrite', owner: 'Sasha Lindqvist', progress: 0.31, status: 'On track' },
  { name: 'Offline sync', owner: 'Priya Raman', progress: 0.94, status: 'On track' },
  { name: 'Search reindex', owner: 'Tom Njeri', progress: 1, status: 'Shipped' },
];

export default function Projects() {
  const styles = useStyles(makeStyles);

  return (
    <Screen>
      <Title>Projects</Title>
      <Body style={{ marginTop: 8 }}>
        Five fake projects. Every colour here — track, fill, status pill — is a theme token, so the
        whole card repaints in the same commit.
      </Body>

      <SectionTitle>Active</SectionTitle>

      {PROJECTS.map(project => (
        <Card key={project.name} title={project.name} subtitle={`Owner · ${project.owner}`} icon="albums-outline">
          <Row gap={10}>
            <View style={styles.track}>
              <View style={[styles.fill, { width: `${Math.round(project.progress * 100)}%` }]} />
            </View>
            <Text style={styles.percent}>{Math.round(project.progress * 100)}%</Text>
          </Row>

          <View style={[styles.pill, styles[statusKey(project.status)]]}>
            <Text style={styles.pillText}>{project.status}</Text>
          </View>
        </Card>
      ))}

      <Hint>Nothing here talks to a server — it is layout, so there is something to reveal.</Hint>
    </Screen>
  );
}

function statusKey(status: Project['status']): 'onTrack' | 'atRisk' | 'shipped' {
  if (status === 'At risk') return 'atRisk';
  if (status === 'Shipped') return 'shipped';
  return 'onTrack';
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    atRisk: { backgroundColor: theme.danger },
    fill: { backgroundColor: theme.tint, borderRadius: 999, height: '100%' },
    onTrack: { backgroundColor: theme.success },
    percent: { color: theme.muted, fontSize: 12, fontVariant: ['tabular-nums'], width: 38 },
    pill: {
      alignSelf: 'flex-start',
      borderRadius: 999,
      paddingHorizontal: 10,
      paddingVertical: 4,
    },
    pillText: { color: '#FFFFFF', fontSize: 11, fontWeight: '700' },
    shipped: { backgroundColor: theme.muted },
    track: {
      backgroundColor: theme.surfaceAlt,
      borderRadius: 999,
      flex: 1,
      height: 8,
      overflow: 'hidden',
    },
  });
