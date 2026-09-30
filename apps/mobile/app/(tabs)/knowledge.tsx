import { useEffect, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import * as api from '@/api';
import type { AskAnswer, SubjectBriefing } from '@/types';
import { usableBriefing } from '@/briefing-view';
import { Body, Button, Card, ErrorNote, Heading, Pill, Screen, Small, styles, usePalette } from '@/ui';

/** "22 Sep", or "today"/"yesterday": never a raw stored date. */
function readableDate(iso: string | null): string | null {
  if (!iso) return null;
  const at = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  if (Number.isNaN(at.getTime())) return null;
  const days = Math.round((Date.now() - at.getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** Plain text from the server's Markdown answer, without its markup. */
function plain(markdown: string): string {
  return markdown
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/^#+\s*/gm, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[(\d+)\]/g, '[$1]')
    .trim();
}

/**
 * Knowledge: ask a question about saved memory.
 *
 * Answers are drawn only from approved records, and the supporting records are
 * listed with each answer. An answer without supporting records is shown as
 * exactly that, never as an established fact.
 */
export default function KnowledgeScreen() {
  const p = usePalette();
  const params = useLocalSearchParams<{ q?: string }>();
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<AskAnswer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ask = async (text: string) => {
    if (text.trim().length < 3) return;
    setBusy(true);
    setError(null);
    try {
      setAnswer(await api.askKnowledge(text.trim()));
    } catch (failure) {
      setError(failure instanceof api.ApiError ? failure.message : 'Could not search memory.');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (typeof params.q === 'string' && params.q.length > 2) {
      setQuestion(params.q);
      void ask(params.q);
    }
  }, [params.q]);

  const briefing = usableBriefing(answer);

  return (
    <Screen>
      <TextInput
        accessibilityLabel="Question about saved memory"
        placeholder="What do we know about…"
        placeholderTextColor={p.muted}
        value={question}
        onChangeText={setQuestion}
        returnKeyType="search"
        onSubmitEditing={() => void ask(question)}
        style={[
          styles.body,
          { borderWidth: 1, borderColor: p.line, borderRadius: 12, padding: 14, color: p.ink, backgroundColor: p.card },
        ]}
      />
      <Button label="Ask memory" onPress={() => void ask(question)} busy={busy} disabled={question.trim().length < 3} />
      <Small>Answers come only from records you approved. Nothing is searched outside Globa 3.</Small>
      <ErrorNote message={error} />

      {!answer && !busy ? (
        <Small>Try a name you saved, a company, or a project — for example “What do we know about Anna Smith?”</Small>
      ) : null}

      {briefing ? <Briefing briefing={briefing} answer={answer!} /> : null}

      {answer && !briefing ? (
        <View style={{ gap: 12 }}>
          {answer.isMock ? <Pill label="Mock AI — synthetic wording" tone="warn" /> : null}
          <Card tone={(answer.citations ?? []).length === 0 ? 'warn' : undefined}>
            {(answer.citations ?? []).length === 0 ? (
              <Small style={{ color: p.warnInk }}>
                Nothing you have saved answers this yet. Capture a note about it, and it will be here next time.
              </Small>
            ) : null}
            <Body selectable>{plain(answer.answerMd ?? '')}</Body>
          </Card>

          {(answer.citations ?? []).length > 0 ? (
            <Details label="See details">
              <Small>How we know this — the saved records behind the answer.</Small>
              {(answer.citations ?? []).map((citation, index) => (
                <Card key={`${citation.row_id}-${index}`}>
                  <Small>{citation.kind}</Small>
                  <Body style={{ fontWeight: '600' }}>
                    [{index + 1}] {citation.label}
                  </Body>
                  {citation.quote ? <Small>“{citation.quote}”</Small> : null}
                </Card>
              ))}
            </Details>
          ) : null}

          {(answer.unanswered ?? []).length > 0 ? (
            <View style={{ gap: 4 }}>
              <Heading>Not in memory</Heading>
              {(answer.unanswered ?? []).map((gap, index) => (
                <Small key={index}>• {gap}</Small>
              ))}
            </View>
          ) : null}
        </View>
      ) : null}
    </Screen>
  );
}

/**
 * The briefing: a short paragraph, then what we know, why it matters, what to
 * watch and what is still unconfirmed. Sources stay under "See source details".
 */
function Briefing({ briefing, answer }: { briefing: SubjectBriefing; answer: AskAnswer }) {
  const p = usePalette();
  return (
    <Card style={{ gap: 14, paddingVertical: 18 }}>
      <View style={{ gap: 2 }}>
        <Text style={{ fontSize: 22, fontWeight: '700', color: p.ink }}>{briefing.name}</Text>
        {briefing.subtitle ? <Small>{briefing.subtitle}</Small> : null}
      </View>
      {briefing.lead ? <Body>{briefing.lead}</Body> : null}
      {(briefing.sections ?? []).map((section) => (
        <View key={section.key} style={{ gap: 6 }}>
          <Text style={{ fontSize: 12, fontWeight: '700', letterSpacing: 0.5, color: p.muted, textTransform: 'uppercase' }}>
            {section.heading}
          </Text>
          {(section.lines ?? []).map((line, index) => (
            <View key={`${line.text}-${index}`} style={{ flexDirection: 'row', gap: 8 }}>
              <Body>•</Body>
              <View style={{ flex: 1 }}>
                <Body>{line.text}</Body>
                {line.note ? <Small>{line.note}</Small> : null}
              </View>
            </View>
          ))}
        </View>
      ))}
      <Details label="See source details">
        <Small style={{ fontWeight: '600' }}>What this rests on</Small>
        {(briefing.sources ?? []).map((source, index) => (
          <Small key={`${source.label}-${index}`}>
            • {source.label} — {source.kind}
            {source.date ? ` (${source.date})` : ''}
          </Small>
        ))}
        {(answer.citations ?? []).length > 0 ? <Small style={{ fontWeight: '600' }}>Records searched</Small> : null}
        {(answer.citations ?? []).map((citation, index) => (
          <Small key={`${citation.row_id}-${index}`}>
            • {citation.label} — {citation.kind}
          </Small>
        ))}
        {answer.isMock ? <Small>Written without a live AI model (mock).</Small> : null}
      </Details>
    </Card>
  );
}

function Details({ label, children }: { label: string; children: React.ReactNode }) {
  const p = usePalette();
  const [open, setOpen] = useState(false);
  return (
    <View style={{ gap: 8 }}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)} style={{ paddingVertical: 4 }}>
        <Text style={{ color: p.accent, fontSize: 15, fontWeight: '600' }}>
          {open ? '▾' : '▸'} {label}
        </Text>
      </Pressable>
      {open ? children : null}
    </View>
  );
}
