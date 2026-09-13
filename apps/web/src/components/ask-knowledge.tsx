'use client';

import { useState } from 'react';
import { MessageSquareQuote, Search } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/input';
import { Markdown } from '@/components/markdown';
import { api, RequestFailed } from '@/lib/client';

interface Citation {
  table_name: string;
  row_id: string;
  label: string;
  quote: string | null;
}

interface Answer {
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
export function AskKnowledge() {
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

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MessageSquareQuote className="size-4" />
          Ask Knowledge
        </CardTitle>
        <CardDescription>
          Answers from saved records only, with a link to each record used. No web search.
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

        {answer ? (
          <div className="space-y-3 rounded-lg border bg-muted/30 p-4">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="outline">{answer.retrievedCount} record(s) retrieved</Badge>
              {answer.isMock ? <Badge variant="warning">Mock answer text</Badge> : null}
            </div>

            <Markdown>{answer.answerMd}</Markdown>

            {answer.citations.length > 0 ? (
              <div>
                <p className="text-xs font-medium">Records used</p>
                <ul className="mt-1 space-y-1">
                  {answer.citations.map((citation) => (
                    <li key={`${citation.table_name}-${citation.row_id}`} className="text-xs">
                      <span className="font-medium">{citation.label}</span>{' '}
                      <code className="font-mono text-muted-foreground">
                        {citation.table_name}/{citation.row_id.slice(0, 8)}
                      </code>
                      {citation.quote ? (
                        <span className="text-muted-foreground"> — &ldquo;{citation.quote}&rdquo;</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {answer.unanswered.length > 0 ? (
              <div>
                <p className="text-xs font-medium">Not covered by the stored data</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
                  {answer.unanswered.map((item, index) => (
                    <li key={index}>{item}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
