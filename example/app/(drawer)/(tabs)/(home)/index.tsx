/**
 * Playground — the one screen that exposes every option at once.
 *
 * Everything else in the app is a specific situation; this is the control panel.
 */
import { Host, Slider } from "@expo/ui";
import { Link } from "expo-router";
import { View } from "react-native";
import {
  THEME_TRANSITION_DIRECTIONS,
  THEME_TRANSITION_KINDS,
  THEME_TRANSITION_BLUR_STYLES,
  THEME_TRANSITION_SHAPES,
  isThemeTransitionAvailable,
} from "react-native-nitro-theme-transition";

import {
  CycleButton,
  ThemeReadout,
  ThemeSwatches,
  ThemeSwitch,
} from "@/components/ThemeControls";
import {
  Body,
  Button,
  Callout,
  Card,
  Chip,
  Code,
  Divider,
  Hint,
  Row,
  Screen,
  SectionTitle,
  Stat,
  StatusDot,
  Tile,
  TileGrid,
} from "@/components/ui";
import { BLUR_STYLE_META, CUSTOM_SHAPES, DIRECTION_META, KIND_META, SHAPE_META, type CustomShapeKey } from "@/kinds";
import {
  themeStore,
  useChangeCount,
  useSettings,
  useTheme,
} from "@/theme/store";
import type { OriginMode } from "@/theme/store";
import { nextThemeName } from "@/theme/themes";
import { cycleTheme, runThemed } from "@/theme/transition";

const ORIGIN_MODES: { value: OriginMode; label: string }[] = [
  { value: "touch", label: "Touch point" },
  { value: "center", label: "Screen centre" },
  { value: "topLeft", label: "Top left" },
  { value: "bottomRight", label: "Bottom right" },
];

export default function Playground() {
  const theme = useTheme();
  const settings = useSettings();
  const changes = useChangeCount();
  const available = isThemeTransitionAvailable();

  return (
    <Screen>
      <View style={{ marginTop: 12 }}>
        <StatusDot
          ok={available}
          label={
            available
              ? "Native module ready"
              : "Unavailable — switches instantly"
          }
        />
      </View>

      <Body style={{ marginTop: 14 }}>
        A theme change cannot be interpolated — there is no “40% dark”. So the
        screen is copied on the GPU, the theme changes underneath the copy, and
        the OS animates the copy away.
      </Body>

      <SectionTitle>Effect</SectionTitle>
      <Hint>Tap one to select it and play it from that exact point.</Hint>

      <TileGrid>
        {THEME_TRANSITION_KINDS.map((kind) => (
          <Tile
            key={kind}
            active={kind === settings.kind}
            icon={KIND_META[kind].icon}
            title={KIND_META[kind].label}
            hint={KIND_META[kind].hint}
            onPress={() =>
              // Both mutations go INSIDE the callback — "wrap the whole swap" —
              // so the reveal uncovers a screen where this tile is already
              // selected, rather than watching it pop afterwards.
              runThemed(
                () => {
                  themeStore.setTheme(
                    nextThemeName(themeStore.getState().themeName),
                  );
                  themeStore.setSettings({ kind });
                },
                { kind },
              )
            }
          />
        ))}
      </TileGrid>

      <Card
        title="Under the hood"
        subtitle={KIND_META[settings.kind].native}
        icon="hardware-chip-outline"
      />

      {settings.kind === "blur" && (
        <>
          <SectionTitle>Blur style</SectionTitle>
          <Hint>
            All at once blurs the whole screen and lets it recede. Swept wipes the new theme in
            out of focus and pulls it sharp as it arrives — the old screen is never blurred.
          </Hint>
          <Row gap={8} wrap style={{ marginTop: 12 }}>
            {THEME_TRANSITION_BLUR_STYLES.map((blurStyle) => (
              <Chip
                key={blurStyle}
                active={blurStyle === settings.blurStyle}
                icon={BLUR_STYLE_META[blurStyle].icon}
                label={BLUR_STYLE_META[blurStyle].label}
                onPress={() =>
                  runThemed(
                    () => {
                      themeStore.setTheme(nextThemeName(themeStore.getState().themeName));
                      themeStore.setSettings({ blurStyle });
                    },
                    { blurStyle },
                  )
                }
              />
            ))}
          </Row>
        </>
      )}

      {settings.kind === "iris" && (
        <>
          <SectionTitle>Iris shape</SectionTitle>
          <Hint>
            Every outline is a fixed-vertex polygon, which is what lets the mask
            path interpolate on iOS rather than being rebuilt each frame.
          </Hint>
          <Row gap={8} wrap style={{ marginTop: 12 }}>
            {THEME_TRANSITION_SHAPES.map((shape) => (
              <Chip
                key={shape}
                active={shape === settings.shape}
                icon={SHAPE_META[shape].icon}
                label={SHAPE_META[shape].label}
                onPress={() =>
                  runThemed(
                    () => {
                      themeStore.setTheme(
                        nextThemeName(themeStore.getState().themeName),
                      );
                      themeStore.setSettings({ shape });
                    },
                    { shape },
                  )
                }
              />
            ))}
          </Row>
        </>
      )}

      {(settings.kind === "circularReveal" ||
        settings.kind === "circularRevealInverse" ||
        settings.kind === "iris") && (
        <>
          <SectionTitle>Custom SVG shape</SectionTitle>
          <Hint>
            Pass any SVG path as svgPath and the reveal uses it instead of the
            circle. It is recentred on its centroid and resampled natively.
          </Hint>
          <Row gap={8} wrap style={{ marginTop: 12 }}>
            {(["none", ...Object.keys(CUSTOM_SHAPES)] as (CustomShapeKey | "none")[]).map(
              (customShape) => (
                <Chip
                  key={customShape}
                  active={customShape === settings.customShape}
                  icon={customShape === "none" ? "close-outline" : CUSTOM_SHAPES[customShape].icon}
                  label={customShape === "none" ? "None" : CUSTOM_SHAPES[customShape].label}
                  onPress={() =>
                    runThemed(
                      () => {
                        themeStore.setTheme(
                          nextThemeName(themeStore.getState().themeName),
                        );
                        themeStore.setSettings({ customShape });
                      },
                      { customShape },
                    )
                  }
                />
              ),
            )}
          </Row>
        </>
      )}

      {settings.kind === "blinds" && (
        <>
          <SectionTitle>Louvres</SectionTitle>
          <Hint>
            How many parallel slabs the screen is cut into. Each wipes across
            itself at once.
          </Hint>
          <Row gap={8} wrap style={{ marginTop: 12 }}>
            {[3, 6, 10, 16].map((bands) => (
              <Chip
                key={bands}
                active={bands === settings.bands}
                label={String(bands)}
                onPress={() =>
                  runThemed(
                    () => {
                      themeStore.setTheme(
                        nextThemeName(themeStore.getState().themeName),
                      );
                      themeStore.setSettings({ bands });
                    },
                    { bands },
                  )
                }
              />
            ))}
          </Row>
        </>
      )}

      {(settings.kind === "slide" ||
        settings.kind === "split" ||
        settings.kind === "barnDoor" ||
        settings.kind === "blinds" ||
        (settings.kind === "blur" && settings.blurStyle === "sweep")) && (
        <>
          <SectionTitle>
            {settings.kind === "slide" || settings.kind === "blur"
              ? "Wipe direction"
              : "Sweep axis"}
          </SectionTitle>
          <Hint>
            {settings.kind === "slide" || settings.kind === "blur"
              ? "The edge the OLD screen leaves through. Nothing translates — a mask animates."
              : "These use both edges, so this picks the axis — top/bottom work horizontally, left/right vertically."}
          </Hint>
          <Row gap={8} wrap style={{ marginTop: 12 }}>
            {THEME_TRANSITION_DIRECTIONS.map((direction) => (
              <Chip
                key={direction}
                active={direction === settings.direction}
                icon={DIRECTION_META[direction].icon}
                label={DIRECTION_META[direction].label}
                onPress={() =>
                  runThemed(
                    () => {
                      themeStore.setTheme(
                        nextThemeName(themeStore.getState().themeName),
                      );
                      themeStore.setSettings({ direction });
                    },
                    { direction },
                  )
                }
              />
            ))}
          </Row>

          <SectionTitle>Edge angle</SectionTitle>
          <Hint>
            Tilts the line without changing where it travels. The sweep still
            ends fully uncovered at any angle, because it measures its own
            travel along the tilted normal.
          </Hint>
          <Card>
            <Row gap={10} wrap>
              <Stat label="angle" value={`${settings.angleDeg}°`} />
            </Row>
            <Host
              style={{ height: 44 }}
              colorScheme={theme.isDark ? "dark" : "light"}
              seedColor={theme.tint}
            >
              <Slider
                min={-80}
                max={80}
                step={5}
                value={settings.angleDeg}
                onValueChange={(value) =>
                  themeStore.setSettings({ angleDeg: Math.round(value) })
                }
              />
            </Host>
            <Row gap={8} wrap>
              {[-40, 0, 40].map((angle) => (
                <Chip
                  key={angle}
                  active={angle === settings.angleDeg}
                  label={`${angle}°`}
                  onPress={() =>
                    runThemed(
                      () => {
                        themeStore.setTheme(
                          nextThemeName(themeStore.getState().themeName),
                        );
                        themeStore.setSettings({ angleDeg: angle });
                      },
                      { angleDeg: angle },
                    )
                  }
                />
              ))}
            </Row>
          </Card>
        </>
      )}

      <SectionTitle>Timing</SectionTitle>
      <Card>
        <Row gap={10} wrap>
          <Stat label="duration" value={`${settings.durationMs}ms`} />
          <Stat label="settle" value={`${settings.settleFrames}f`} />
          <Stat label="changes" value={String(changes)} />
        </Row>

        <Hint>Duration</Hint>
        {/* A real SwiftUI / Jetpack Compose slider — native views repaint under
            the snapshot exactly like React ones do. */}
        <Host
          style={{ height: 44 }}
          colorScheme={theme.isDark ? "dark" : "light"}
          seedColor={theme.tint}
        >
          <Slider
            min={120}
            max={2000}
            step={20}
            value={settings.durationMs}
            onValueChange={(value) =>
              themeStore.setSettings({ durationMs: Math.round(value) })
            }
          />
        </Host>

        <Divider />

        <Hint>
          Settle frames — how long the copy is held before it animates away
        </Hint>
        <Row gap={8} wrap>
          {[0, 1, 2, 3, 4, 6].map((frames) => (
            <Chip
              key={frames}
              active={frames === settings.settleFrames}
              label={`${frames}f`}
              onPress={() => themeStore.setSettings({ settleFrames: frames })}
            />
          ))}
        </Row>
        <Callout tone={settings.settleFrames < 2 ? "warn" : "info"}>
          {settings.settleFrames < 2
            ? "Below 2 the reveal starts before React has painted — expect the old colours to flash back."
            : "This app drives the theme from an external store, which React still re-renders asynchronously, so 3 is the safe floor here."}
        </Callout>
      </Card>

      <SectionTitle>Reveal origin</SectionTitle>
      <Hint>
        Used by the shape reveals — circle in, circle out and iris — and by
        ripple. Every other effect ignores it.
      </Hint>
      <Row gap={8} wrap style={{ marginTop: 12 }}>
        {ORIGIN_MODES.map((mode) => (
          <Chip
            key={mode.value}
            active={mode.value === settings.originMode}
            label={mode.label}
            onPress={() => {
              // Applied first: the mode decides where THIS reveal starts.
              themeStore.setSettings({ originMode: mode.value });
              cycleTheme();
            }}
          />
        ))}
      </Row>

      <SectionTitle>Switch the theme</SectionTitle>
      <Card>
        <ThemeSwatches />
        <ThemeReadout />
        <Divider />
        <ThemeSwitch />
        <Divider />
        <CycleButton />
      </Card>

      <SectionTitle>The call this screen makes</SectionTitle>
      <Code>{`withThemeTransition(
  () => store.setTheme(next),   // synchronous
  {
    kind: '${settings.kind}',${settings.kind === "slide" ? `\n    direction: '${settings.direction}',` : ""}
    durationMs: ${settings.durationMs},
    settleFrames: ${settings.settleFrames},
    origin: ${settings.originMode === "touch" ? "{ x: pageX, y: pageY }" : "undefined"},
  },
)`}</Code>

      <Callout tone="good" title="Try this">
        Tap four effects as fast as you can. Nothing is cancelled — each change
        gets its own snapshot and they play at the same time, newest underneath.
      </Callout>

      <Row gap={10} style={{ marginTop: 20 }}>
        <Link href="/cases" asChild>
          <Button
            label="Browse the cases"
            icon="flask-outline"
            style={{ flex: 1 }}
          />
        </Link>
      </Row>
    </Screen>
  );
}
