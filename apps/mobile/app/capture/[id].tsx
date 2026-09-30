import { useState } from 'react';
import { Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import * as api from '@/api';
import type { CaptureView } from '@/types';
import { useLoad } from '@/use-load';
import { Body, Button, Card, ErrorNote, Heading, Loading, Pill, Screen, Small, usePalette } from '@/ui';

const ACTIVE = new Set(['received', 'analysing', 'matching']);

/** Processing: where a capture is, in plain words, until its proposal is ready. */
export default function ProcessingScreen() {
  const p = usePalette();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data, error, reload } = useLoad<CaptureView>(() => api.getCapture(String(id)), {
    pollWhile: (capture) => ACTIVE.has(capture.phase),
  });
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  if (!data) return error ? <Screen><ErrorNote message={error} /></Screen> : <Loading label="Opening capture" />;

  const retry = async () => {
    setRetrying(true);
    setRetryError(null);
    try {
      await api.retryCapture(data.id);
      await reload();
    } catch (failure) {
      setRetryError(failure instanceof api.ApiError ? failure.message : 'Could not retry.');
    } finally {
      setRetrying(false);
    }
  };

  return (
    <Screen>
      {data.isMock ? <Pill label="Mock AI — synthetic analysis" tone="warn" /> : null}

      <Card>
        {data.steps.map((step) => (
          <View key={step.label} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 32 }}>
            <Text
              style={{
                width: 22,
                textAlign: 'center',
                fontSize: 16,
                color: step.state === 'done' ? p.goodInk : step.state === 'failed' ? p.badInk : step.state === 'current' ? p.accent : p.muted,
              }}
            >
              {step.state === 'done' ? '✓' : step.state === 'failed' ? '!' : step.state === 'current' ? '●' : '○'}
            </Text>
            <Body muted={step.state === 'todo'} style={step.state === 'current' ? { fontWeight: '600' } : undefined}>
              {step.label}
            </Body>
          </View>
        ))}
      </Card>

      {ACTIVE.has(data.phase) ? (
        <Small>You can leave this screen. The capture keeps being analysed and shows on Today.</Small>
      ) : null}

      {data.phase === 'ready' && data.proposal ? (
        <Card tone="good">
          <Heading>{data.proposal.summary}</Heading>
          <Small style={{ color: p.goodInk }}>Nothing is saved until you approve it.</Small>
          <Button label="Review" onPress={() => router.replace(`/proposal/${data.proposal!.id}`)} />
        </Card>
      ) : null}

      {data.phase === 'failed' ? (
        <Card tone="bad">
          <Heading>The analysis stopped</Heading>
          <Body>{data.failure}</Body>
          {data.canRetry ? <Button label="Retry analysis" onPress={retry} busy={retrying} /> : null}
          <Button
            label="Edit the capture"
            variant="secondary"
            onPress={() => router.push({ pathname: '/capture', params: { edit: data.id } })}
          />
          <ErrorNote message={retryError} />
        </Card>
      ) : null}

      {data.phase === 'withdrawn' ? <Body muted>This capture was replaced by an edited version.</Body> : null}

      <View style={{ gap: 6 }}>
        <Heading>Your note</Heading>
        {data.source.text ? <Body selectable>{data.source.text}</Body> : null}
        {data.source.filename ? <Body>📎 {data.source.filename} — private to this workspace</Body> : null}
        {data.source.url ? <Small>Link kept as a reference; it is not opened or searched automatically.</Small> : null}
      </View>
    </Screen>
  );
}
