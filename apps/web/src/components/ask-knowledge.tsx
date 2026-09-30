'use client';

import { useState } from 'react';
import Link from 'next/link';
import { MessageSquareQuote, Search } from 'lucide-react';
import { usableBriefing, type Briefing } from '@/lib/briefing-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Textarea } from '@/components/ui/input';
import { Markdown } from '@/components/markdown';
import { api, RequestFailed } from '@/lib/client';
import { recordKind } from '@/lib/labels';

interface Citation {
  table_name: string;
  row_id: string;
  label: string;
  quote: string | null;
}

interface Answer {
  briefing: unknown;
  answerMd: string;
  citations: Citation[];
  unanswered: string[];
  retrievedCount: number;
  isMock: boolean;
  threadId: string;
}

/**
 * Ask Knowledge.
 *
 * Deliberately closed-book: the answer comes only from stored records, and the
 * records it used are listed underneath. When nothing matches, it says so rather
 * than producing a plausible-sounding answer.
 */
export function AskKnowledge({ variant = 'full' }: { variant?: 'full' | 'compact' }) {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ask = async (event: React.FormEvent) => {
    event.preventDefault();
    if (question.trim().length < 3) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api<Answer>('/api/ask', {
        method: 'POST',
        json: { question: question.trim(), threadId: answer?.threadId },
      });
      setAnswer(result);
    } catch (failure) {
      setError(
        failure instanceof RequestFailed ? failure.payload.error : 'Could not answer the question.',
      );
    } finally {
      setBusy(false);
    }
  };

  const result = answer ? <AnswerView answer={answer} /> : null;

  if (variant === 'compact') {
    return (
      <div className="space-y-3">
        <form onSubmit={ask} className="flex flex-wrap items-center gap-2" role="search" aria-label="Ask knowledge">
          <MessageSquareQuote className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <Input
            id="today-ask"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="Ask knowledge — e.g. What do we know about Unseen Arabia?"
            className="h-9 min-w-0 flex-1"
            aria-label="Question for the knowledge base"
          />
          <Button type="submit" size="sm" loading={busy} disabled={question.trim().length < 3}>
            <Search />
            Ask
          </Button>
        </form>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {result}
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MessageSquareQuote className="size-4" />
          Ask Knowledge
        </CardTitle>
        <CardDescription>
          Answers from saved records only, and lists every record it used. No web search.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <form onSubmit={ask} className="space-y-2">
          <Textarea
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="What do we know about Sports One? Which people are connected to AMV? What is still unverified?"
            className="min-h-[72px]"
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void ask(event);
            }}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" loading={busy} disabled={question.trim().length < 3}>
              <Search />
              Ask
            </Button>
            <span className="text-xs text-muted-foreground">⌘/Ctrl + Enter</span>
          </div>
        </form>

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        {result}
      </CardContent>
    </Card>
  );
}

/**
 * The same briefing the phone shows, from the same server data: a short
 * paragraph, then what we know, why it matters, what to watch, what is still
 * unconfirmed. Sources live under "See source details".
 */
function BriefingView({ briefing, answer }: { briefing: Briefing; answer: Answer }) {
  return (
    <div className="space-y-4">
      <div>
        <p className="text-lg font-semibold">{briefing.name}</p>
        {briefing.subtitle ? <p className="text-sm text-muted-foreground">{briefing.subtitle}</p> : null}
      </div>
      {briefing.lead ? <p>{briefing.lead}</p> : null}
      {(briefing.sections ?? []).map((section) => (
        <div key={section.key} className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{section.heading}</p>
          <ul className="list-disc space-y-1 pl-5">
            {(section.lines ?? []).map((line, index) => (
              <li key={`${line.text}-${index}`}>
                {line.text}
                {line.note ? <span className="text-muted-foreground"> — {line.note}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ))}
      <details className="text-sm">
        <summary className="cursor-pointer font-medium text-primary">See source details</summary>
        <ul className="mt-2 space-y-1 text-muted-foreground">
          {(briefing.sources ?? []).map((source, index) => (
            <li key={`${source.label}-${index}`}>
              {source.label} — {source.kind}
              {source.date ? ` (${source.date})` : ''}
            </li>
          ))}
          {(answer.citations ?? []).map((citation) => (
            <li key={`${citation.table_name}-${citation.row_id}`}>
              {citation.label} — {recordKind(citation.table_name)}
            </li>
          ))}
          <li>{answer.retrievedCount} saved record(s) were searched.</li>
        </ul>
      </details>
    </div>
  );
}

function AnswerView({ answer }: { answer: Answer }) {
  // An older server, or a half-formed briefing, falls back to the plain answer.
  const briefing = usableBriefing(answer);
  return (
    <div className="space-y-3 rounded-lg border bg-muted/30 p-4">
      <div className="flex flex-wrap items-center gap-1.5">
        {briefing ? null : <Badge variant="outline">{answer.retrievedCount} record(s) retrieved</Badge>}
        {answer.isMock ? <Badge variant="warning">Mock answer text</Badge> : null}
      </div>

      {briefing ? <BriefingView briefing={briefing} answer={answer} /> : <Markdown>{answer.answerMd ?? ''}</Markdown>}

      {(answer.citations ?? []).length > 0 && !briefing ? (
        <details className="text-xs">
          <summary className="cursor-pointer font-medium text-primary">See source details</summary>
          <p className="mt-2 text-xs font-medium">Records used</p>
          <ul className="mt-1 space-y-1">
            {(answer.citations ?? []).map((citation) => (
              <li key={`${citation.table_name}-${citation.row_id}`} className="text-xs">
                {citation.table_name !== 'entities' ? (
                  <span className="text-muted-foreground">{recordKind(citation.table_name)} · </span>
                ) : null}
                <Link
                  href={`/knowledge?q=${encodeURIComponent(citation.label)}`}
                  className="font-medium underline underline-offset-2"
                >
                  {citation.label}
                </Link>
                {citation.quote ? (
                  <span className="text-muted-foreground"> — &ldquo;{citation.quote}&rdquo;</span>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {(answer.unanswered ?? []).length > 0 && !briefing ? (
        <div>
          <p className="text-xs font-medium">Not covered by the stored data</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
            {(answer.unanswered ?? []).map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
