/**
 * Reports — stats and a bar chart drawn out of plain views.
 *
 * A grid of large flat colour blocks is the opposite stress case to the inbox:
 * few edges, lots of area. Banding and gamma mismatches during a cross-fade show
 * up here rather than in dense text.
 */
import { StyleSheet, Text, View } from 'react-native';

import { Body, Card, Hint, Row, Screen, SectionTitle, Stat, Title, useStyles } from '@/components/ui';
import { useChangeCount } from '@/theme/store';
import type { Theme } from '@/theme/themes';

const BARS = [
  { label: 'Mon', value: 0.42 },
  { label: 'Tue', value: 0.68 },
  { label: 'Wed', value: 0.55 },
  { label: 'Thu', value: 0.91 },
  { label: 'Fri', value: 0.73 },
  { label: 'Sat', value: 0.21 },
  { label: 'Sun', value: 0.16 },
];

export default function Reports() {
  const styles = useStyles(makeStyles);
  const changes = useChangeCount();

  return (
    <Screen>
      <Title>Reports</Title>
      <Body style={{ marginTop: 8 }}>
        Large flat blocks instead of text. Few edges, lots of area — the case where a cross-fade
        goes wrong quietly.
      </Body>

      <Row gap={10} wrap style={{ marginTop: 16 }}>
        <Stat label="sessions" value="12.4k" />
        <Stat label="p99" value="184ms" />
        <Stat label="errors" value="0.02%" />
        <Stat label="theme swaps" value={String(changes)} />
      </Row>

      <SectionTitle>This week</SectionTitle>

      <Card title="Active sessions" subtitle="Seven days, normalised" icon="stats-chart-outline">
        <View style={styles.chart}>
          {BARS.map(bar => (
            <View key={bar.label} style={styles.column}>
              <View style={styles.barTrack}>
                <View style={[styles.bar, { height: `${Math.round(bar.value * 100)}%` }]} />
              </View>
              <Text style={styles.barLabel}>{bar.label}</Text>
            </View>
          ))}
        </View>
      </Card>

      <SectionTitle>Breakdown</SectionTitle>

      <View style={styles.blocks}>
        <View style={[styles.block, styles.blockTint]}>
          <Text style={styles.blockValue}>61%</Text>
          <Text style={styles.blockLabel}>iOS</Text>
        </View>
        <View style={[styles.block, styles.blockAccent]}>
          <Text style={styles.blockValue}>37%</Text>
          <Text style={styles.blockLabel}>Android</Text>
        </View>
        <View style={[styles.block, styles.blockMuted]}>
          <Text style={styles.blockValue}>2%</Text>
          <Text style={styles.blockLabel}>Other</Text>
        </View>
      </View>

      <Hint>The only real number on this screen is the theme swap count.</Hint>
    </Screen>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    bar: { backgroundColor: theme.tint, borderRadius: 6, width: '100%' },
    barLabel: { color: theme.muted, fontSize: 11 },
    barTrack: {
      backgroundColor: theme.surfaceAlt,
      borderRadius: 6,
      flex: 1,
      justifyContent: 'flex-end',
      overflow: 'hidden',
      width: '100%',
    },
    block: { borderRadius: 16, flexGrow: 1, minWidth: 96, padding: 16 },
    blockAccent: { backgroundColor: theme.accent },
    blockLabel: { color: theme.onPrimary, fontSize: 12, marginTop: 2, opacity: 0.85 },
    blockMuted: { backgroundColor: theme.muted },
    blockTint: { backgroundColor: theme.tint },
    blockValue: { color: theme.onPrimary, fontSize: 24, fontWeight: '800' },
    blocks: { flexDirection: 'row', gap: 10, marginTop: 12 },
    chart: { alignItems: 'flex-end', flexDirection: 'row', gap: 8, height: 148 },
    column: { alignItems: 'center', flex: 1, gap: 6, height: '100%' },
  });
