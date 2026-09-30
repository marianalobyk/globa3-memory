import { useState } from 'react';
import { Pressable, RefreshControl, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import * as api from '@/api';
import { useAuth } from '@/auth';
import { useLoad } from '@/use-load';
import {
  Body,
  Button,
  Card,
  ErrorNote,
  Heading,
  Pill,
  relativeTime,
  Row,
  Screen,
  Small,
  styles,
  Title,
  usePalette,
} from '@/ui';

/**
 * Today: one dominant action. Everything else is a short, quiet list below it.
 */
export default function TodayScreen() {
  const p = usePalette();
  const { session, signOut } = useAuth();
  const { data, error, refreshing, refresh } = useLoad(api.getToday, {
    pollWhile: (today) => today.analysing.some((a) => !a.failed),
    intervalMs: 3000,
  });
  const [question, setQuestion] = useState('');

  return (
    <Screen topInset onRefresh={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}>
      <View style={{ gap: 4 }}>
        <Title>Today</Title>
        {session ? <Small>{session.workspace.name}</Small> : null}
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Add anything"
        accessibilityHint="Opens capture to write, paste or dictate a note"
        onPress={() => router.push('/capture')}
        style={({ pressed }) => [
          styles.card,
          {
            minHeight: 120,
            justifyContent: 'center',
            backgroundColor: p.card,
            borderColor: p.accent,
            borderWidth: 1.5,
            opacity: pressed ? 0.85 : 1,
          },
        ]}
      >
        <Text style={{ fontSize: 22, fontWeight: '600', color: p.ink }}>Add anything…</Text>
        <Small>A note from a meeting, a name, a link. Nothing is saved until you approve it.</Small>
      </Pressable>

      {session?.aiMode === 'mock' ? (
        <Card tone="warn">
          <Small style={{ color: p.warnInk }}>
            Mock AI: this server has no model configured, so analysis is synthetic and labelled Mock.
          </Small>
        </Card>
      ) : null}

      <ErrorNote message={error} />

      <Pressable accessibilityRole="button" onPress={() => router.push('/review')}>
        <Card tone={data && data.awaiting.proposals > 0 ? 'warn' : undefined}>
          <Heading right={<Text style={{ color: p.muted, fontSize: 20 }}>›</Text>}>
            {data
              ? data.awaiting.proposals > 0
                ? `${data.awaiting.proposals} capture${data.awaiting.proposals === 1 ? '' : 's'} to confirm`
                : 'Nothing to confirm'
              : 'To confirm'}
          </Heading>
        </Card>
      </Pressable>

      {/* A note that stopped needs you; one still running does not. */}
      {data && data.analysing.some((item) => item.failed) ? (
        <View>
          <Heading>Needs your attention</Heading>
          {data.analysing
            .filter((item) => item.failed)
            .map((item, index) => (
              <Row
                key={`failed-${item.captureId ?? 'run'}-${index}`}
                title={item.title}
                meta={`Stopped ${relativeTime(item.createdAt)} · tap to try again`}
                right={<Pill label="Stopped" tone="bad" />}
                onPress={item.captureId ? () => router.push(`/capture/${item.captureId}`) : undefined}
              />
            ))}
        </View>
      ) : null}

      {data && data.analysing.some((item) => !item.failed) ? (
        <View>
          <Heading>Being analysed</Heading>
          {data.analysing
            .filter((item) => !item.failed)
            .map((item, index) => (
              <Row
                key={`${item.captureId ?? 'run'}-${index}`}
                title={item.title}
                meta={`${item.phaseLabel} · ${relativeTime(item.createdAt)}`}
                onPress={item.captureId ? () => router.push(`/capture/${item.captureId}`) : undefined}
              />
            ))}
        </View>
      ) : null}

      <View style={{ gap: 8 }}>
        <Heading>Ask memory</Heading>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <TextInput
            accessibilityLabel="Ask a question about saved memory"
            placeholder="What do we know about…"
            placeholderTextColor={p.muted}
            value={question}
            onChangeText={setQuestion}
            returnKeyType="search"
            onSubmitEditing={() =>
              question.trim().length > 2 && router.push({ pathname: '/knowledge', params: { q: question.trim() } })
            }
            style={[
              styles.body,
              { flex: 1, borderWidth: 1, borderColor: p.line, borderRadius: 12, paddingHorizontal: 12, minHeight: 48, color: p.ink, backgroundColor: p.card },
            ]}
          />
          <View style={{ width: 80 }}>
            <Button
              label="Ask"
              variant="secondary"
              disabled={question.trim().length < 3}
              onPress={() => router.push({ pathname: '/knowledge', params: { q: question.trim() } })}
            />
          </View>
        </View>
      </View>

      <View>
        <Heading>{data?.savedTitle ?? 'Saved'}</Heading>
        {data && data.saved.length === 0 ? (
          <Body muted>Nothing saved yet. What you approve appears here.</Body>
        ) : null}
        {data?.saved.map((item, index) => (
          <Row
            key={`${item.proposalId}-${index}`}
            title={item.label}
            meta={`${item.kind} · ${item.verb.toLowerCase()} ${relativeTime(item.savedAt)}`}
            onPress={() => router.push(`/saved/${item.proposalId}`)}
          />
        ))}
      </View>

      <Button label="Sign out" variant="quiet" onPress={() => void signOut()} />
    </Screen>
  );
}
