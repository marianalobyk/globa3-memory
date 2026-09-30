import { Pressable, RefreshControl, Text, View } from 'react-native';
import { router } from 'expo-router';
import * as api from '@/api';
import type { ReviewList } from '@/types';
import { useLoad } from '@/use-load';
import { Body, ErrorNote, Pill, relativeTime, Screen, Small, usePalette, type Tone } from '@/ui';

const STATUS_TONE: Record<string, Tone> = {
  ready: 'good',
  researching: 'plain',
  choose_identity: 'warn',
  needs_context: 'warn',
};

/** Captures waiting for confirmation, newest first: who, one line, where it stands. */
export default function ReviewListScreen() {
  const { data, error, refreshing, refresh } = useLoad(api.getReviewList);
  return (
    <Screen onRefresh={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}>
      <ErrorNote message={error} />
      {data && data.proposals.length === 0 ? (
        <Body muted>Nothing is waiting for you. Capture a note and it appears here for a quick confirmation.</Body>
      ) : null}
      {data?.proposals.map((item) => <InboxRow key={item.proposalId} item={item} />)}
    </Screen>
  );
}

function InboxRow({ item }: { item: ReviewList['proposals'][number] }) {
  const p = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${item.name}. ${item.statusLabel}.`}
      onPress={() => router.push(`/proposal/${item.proposalId}`)}
      style={({ pressed }) => ({ paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: p.line, opacity: pressed ? 0.7 : 1, gap: 4 })}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={{ flex: 1, fontSize: 17, fontWeight: '600', color: p.ink }} numberOfLines={1}>
          {item.name}
        </Text>
        <Small>{relativeTime(item.createdAt)}</Small>
      </View>
      {item.summary ? (
        <Text style={{ fontSize: 15, color: p.muted }} numberOfLines={1}>
          {item.summary}
        </Text>
      ) : null}
      <View style={{ flexDirection: 'row' }}>
        <Pill label={item.statusLabel} tone={STATUS_TONE[item.status] ?? 'plain'} />
      </View>
    </Pressable>
  );
}
