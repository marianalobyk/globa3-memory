/**
 * The app's small component kit: calm, legible, thumb-sized.
 *
 * Plain React Native primitives and one palette per colour scheme. Touch targets
 * are at least 44 points, text follows the system's Dynamic Type scaling, and
 * nothing depends on a web font or a remote asset.
 */
import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useColorScheme,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export interface Palette {
  ground: string;
  card: string;
  ink: string;
  muted: string;
  line: string;
  accent: string;
  accentInk: string;
  warnBg: string;
  warnInk: string;
  goodBg: string;
  goodInk: string;
  badBg: string;
  badInk: string;
}

const LIGHT: Palette = {
  ground: '#F7F6F3',
  card: '#FFFFFF',
  ink: '#1C1B19',
  muted: '#6B6860',
  line: '#E4E1DA',
  accent: '#2F5D50',
  accentInk: '#FFFFFF',
  warnBg: '#FBF1DC',
  warnInk: '#7A5200',
  goodBg: '#E3F1E8',
  goodInk: '#1F6B40',
  badBg: '#F8E4E0',
  badInk: '#9B2F20',
};

const DARK: Palette = {
  ground: '#141412',
  card: '#1E1D1B',
  ink: '#F2F0EB',
  muted: '#A5A197',
  line: '#34322E',
  accent: '#7DB8A4',
  accentInk: '#0F1D18',
  warnBg: '#3A2E14',
  warnInk: '#F1C979',
  goodBg: '#16301F',
  goodInk: '#8FD3A8',
  badBg: '#3A1B16',
  badInk: '#F0A596',
};

export function usePalette(): Palette {
  return useColorScheme() === 'dark' ? DARK : LIGHT;
}

export function Screen({
  children,
  scroll = true,
  onRefresh,
  topInset = false,
}: {
  children: ReactNode;
  scroll?: boolean;
  onRefresh?: ReactNode;
  /** For screens without a navigation header, which must clear the status bar themselves. */
  topInset?: boolean;
}) {
  const p = usePalette();
  return (
    <SafeAreaView edges={topInset ? ['top', 'left', 'right'] : ['left', 'right']} style={{ flex: 1, backgroundColor: p.ground }}>
      {scroll ? (
        <ScrollView
          contentContainerStyle={styles.screen}
          keyboardShouldPersistTaps="handled"
          refreshControl={onRefresh as never}
        >
          {children}
        </ScrollView>
      ) : (
        <View style={[styles.screen, { flex: 1 }]}>{children}</View>
      )}
    </SafeAreaView>
  );
}

export function Title({ children }: { children: ReactNode }) {
  const p = usePalette();
  return (
    <Text accessibilityRole="header" style={[styles.title, { color: p.ink }]}>
      {children}
    </Text>
  );
}

export function Heading({ children, right }: { children: ReactNode; right?: ReactNode }) {
  const p = usePalette();
  return (
    <View style={styles.headingRow}>
      <Text accessibilityRole="header" style={[styles.heading, { color: p.ink }]}>
        {children}
      </Text>
      {right}
    </View>
  );
}

export function Body({
  children,
  muted,
  style,
  selectable,
}: {
  children: ReactNode;
  muted?: boolean;
  style?: StyleProp<TextStyle>;
  selectable?: boolean;
}) {
  const p = usePalette();
  return (
    <Text selectable={selectable} style={[styles.body, { color: muted ? p.muted : p.ink }, style]}>
      {children}
    </Text>
  );
}

export function Small({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  const p = usePalette();
  return <Text style={[styles.small, { color: p.muted }, style]}>{children}</Text>;
}

export function Card({ children, style, tone }: { children: ReactNode; style?: StyleProp<ViewStyle>; tone?: Tone }) {
  const p = usePalette();
  const bg = tone === 'warn' ? p.warnBg : tone === 'good' ? p.goodBg : tone === 'bad' ? p.badBg : p.card;
  return (
    <View style={[styles.card, { backgroundColor: bg, borderColor: tone ? bg : p.line }, style]}>{children}</View>
  );
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  busy,
  disabled,
  accessibilityHint,
}: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'quiet' | 'danger';
  busy?: boolean;
  disabled?: boolean;
  accessibilityHint?: string;
}) {
  const p = usePalette();
  const off = disabled || busy;
  const bg = variant === 'primary' ? p.accent : variant === 'danger' ? p.badBg : variant === 'secondary' ? p.card : 'transparent';
  const fg = variant === 'primary' ? p.accentInk : variant === 'danger' ? p.badInk : p.accent;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: Boolean(off), busy: Boolean(busy) }}
      onPress={off ? undefined : onPress}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: bg,
          borderColor: variant === 'secondary' ? p.line : bg,
          opacity: off ? 0.5 : pressed ? 0.8 : 1,
        },
      ]}
    >
      {busy ? <ActivityIndicator color={fg} /> : <Text style={[styles.buttonText, { color: fg }]}>{label}</Text>}
    </Pressable>
  );
}

export type Tone = 'warn' | 'good' | 'bad' | 'plain';

export function Pill({ label, tone = 'plain' }: { label: string; tone?: Tone }) {
  const p = usePalette();
  const bg = tone === 'warn' ? p.warnBg : tone === 'good' ? p.goodBg : tone === 'bad' ? p.badBg : p.ground;
  const fg = tone === 'warn' ? p.warnInk : tone === 'good' ? p.goodInk : tone === 'bad' ? p.badInk : p.muted;
  return (
    <View style={[styles.pill, { backgroundColor: bg, borderColor: tone === 'plain' ? p.line : bg }]}>
      <Text style={[styles.pillText, { color: fg }]}>{label}</Text>
    </View>
  );
}

export function Row({
  title,
  meta,
  right,
  onPress,
}: {
  title: string;
  meta?: string | null;
  right?: ReactNode;
  onPress?: () => void;
}) {
  const p = usePalette();
  return (
    <Pressable
      accessibilityRole={onPress ? 'button' : undefined}
      onPress={onPress}
      style={({ pressed }) => [styles.row, { borderColor: p.line, opacity: pressed && onPress ? 0.7 : 1 }]}
    >
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={2} style={[styles.rowTitle, { color: p.ink }]}>
          {title}
        </Text>
        {meta ? (
          <Text numberOfLines={1} style={[styles.small, { color: p.muted }]}>
            {meta}
          </Text>
        ) : null}
      </View>
      {right}
      {onPress ? <Text style={{ color: p.muted, fontSize: 20 }}>›</Text> : null}
    </Pressable>
  );
}

export function Loading({ label }: { label?: string }) {
  const p = usePalette();
  return (
    <View style={styles.center}>
      <ActivityIndicator color={p.accent} />
      {label ? <Small style={{ marginTop: 8 }}>{label}</Small> : null}
    </View>
  );
}

export function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <Card tone="bad">
      <Body>{message}</Body>
    </Card>
  );
}

export function relativeTime(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

export const styles = StyleSheet.create({
  screen: { padding: 16, gap: 16, paddingBottom: 48 },
  title: { fontSize: 28, fontWeight: '700', letterSpacing: -0.3 },
  headingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  heading: { fontSize: 17, fontWeight: '600' },
  body: { fontSize: 16, lineHeight: 22 },
  small: { fontSize: 13, lineHeight: 18 },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, padding: 14, gap: 8 },
  button: {
    minHeight: 48,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: { fontSize: 16, fontWeight: '600' },
  pill: {
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 8,
    paddingVertical: 2,
    alignSelf: 'flex-start',
  },
  pillText: { fontSize: 12, fontWeight: '600' },
  row: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowTitle: { fontSize: 16, fontWeight: '500' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
});
