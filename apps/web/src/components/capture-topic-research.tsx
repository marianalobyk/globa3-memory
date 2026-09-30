'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Search, ShieldCheck } from 'lucide-react';
import { api, RequestFailed } from '@/lib/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/input';

export interface CaptureResearchQuestion {
  id: string;
  label: string;
  question: string;
  whyItMatters: string | null;
  priority: 'high' | 'medium' | 'low' | 'skip';
  targetType: string;
  subject: string | null;
  status: string;
}

interface Preflight {
  questions: CaptureResearchQuestion[];
  disclosure: string;
  affects: string[];
}

/**
 * The second, separate decision for capture questions. Their original approval
 * only saved the request; this surface is the sole public path that can queue
 * a web search.
 */
export function CaptureTopicResearch({
  proposalId,
  questions,
  canApprove,
}: {
  proposalId: string;
  questions: CaptureResearchQuestion[];
  canApprove: boolean;
}) {
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [cost, setCost] = useState(false);
  const [externalSources, setExternalSources] = useState(false);
  const [busy, setBusy] = useState<'preflight' | 'start' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState<{ runId: string; count: number } | null>(null);

  const available = questions.filter((question) => ['proposed', 'selected'].includes(question.status));
  if (questions.length === 0) return null;

  const toggle = (id: string) => {
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const fail = (failure: unknown) => {
    setError(failure instanceof RequestFailed ? failure.payload.error : 'Research could not be prepared. Try again.');
  };

  const openPreflight = async () => {
    if (chosen.size === 0) return;
    setBusy('preflight');
    setError(null);
    try {
      const result = await api<Preflight>(`/api/proposals/${proposalId}/topic-research/preflight`, {
        method: 'POST',
        json: { topicIds: [...chosen] },
      });
      setPreflight(result);
      setCost(false);
      setExternalSources(false);
    } catch (failure) {
      fail(failure);
    } finally {
      setBusy(null);
    }
  };

  const start = async () => {
    if (!preflight) return;
    setBusy('start');
    setError(null);
    try {
      const result = await api<{ runId: string; questions: CaptureResearchQuestion[] }>(
        `/api/proposals/${proposalId}/topic-research/start`,
        {
          method: 'POST',
          json: {
            topicIds: preflight.questions.map((question) => question.id),
            acknowledgeCost: true,
            acknowledgeExternalSources: true,
          },
        },
      );
      setStarted({ runId: result.runId, count: result.questions.length });
      setPreflight(null);
      setChosen(new Set());
    } catch (failure) {
      fail(failure);
    } finally {
      setBusy(null);
    }
  };

  if (started) {
    return (
      <section className="space-y-3 rounded-lg border border-success/40 bg-success/5 p-5" aria-labelledby="research-started">
        <h2 id="research-started" className="flex items-center gap-2 text-lg font-semibold">
          <ShieldCheck className="size-5 text-success" />
          Research started
        </h2>
        <p className="text-sm text-muted-foreground">
          {started.count === 1 ? 'Your question is' : `${started.count} questions are`} being researched. The results will
          return as a separate review, and nothing from them is saved automatically.
        </p>
        <Button asChild size="sm" variant="outline">
          <Link href={`/activity/runs/${started.runId}`}>
            See progress <ArrowRight />
          </Link>
        </Button>
      </section>
    );
  }

  if (preflight) {
    return (
      <section className="space-y-4 rounded-lg border p-5" aria-labelledby="confirm-topic-research">
        <div>
          <h2 id="confirm-topic-research" className="text-lg font-semibold">Start this research?</h2>
          <p className="mt-1 text-sm text-muted-foreground">Nothing has been searched yet.</p>
        </div>
        <ul className="space-y-2 rounded-md border p-3 text-sm">
          {preflight.questions.map((question) => (
            <li key={question.id}>
              <p className="font-medium">{question.question}</p>
              {question.whyItMatters ? <p className="text-muted-foreground">Why it matters: {question.whyItMatters}</p> : null}
            </li>
          ))}
        </ul>
        {preflight.affects.length > 0 ? (
          <p className="text-sm text-muted-foreground">About: {preflight.affects.join(', ')}</p>
        ) : null}
        <p className="rounded-md border border-warning/40 bg-warning/5 p-3 text-sm">{preflight.disclosure}</p>
        <label className="flex items-start gap-2 text-sm">
          <Checkbox checked={cost} onCheckedChange={(checked) => setCost(checked === true)} />
          <span>I understand this uses AI budget.</span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <Checkbox checked={externalSources} onCheckedChange={(checked) => setExternalSources(checked === true)} />
          <span>I allow Globa 3 to consult public sources for these questions.</span>
        </label>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <div className="flex flex-wrap gap-2">
          <Button disabled={!cost || !externalSources || busy !== null} loading={busy === 'start'} onClick={start}>
            <Search /> Start research
          </Button>
          <Button variant="ghost" disabled={busy !== null} onClick={() => setPreflight(null)}>Cancel</Button>
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-4 rounded-lg border p-5" aria-labelledby="topic-research">
      <div>
        <h2 id="topic-research" className="flex items-center gap-2 text-lg font-semibold">
          <Search className="size-5" /> Research questions
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          These questions were saved from this capture. Selecting one still starts nothing; you will see the exact search
          and confirm it separately.
        </p>
      </div>
      <div className="space-y-2">
        {questions.map((question) => {
          const canStart = available.some((availableQuestion) => availableQuestion.id === question.id);
          const active = ['researching', 'researched', 'captured'].includes(question.status);
          return (
            <div key={question.id} className="flex gap-3 rounded-md border p-3">
              {canStart ? (
                <Checkbox
                  id={`topic-${question.id}`}
                  checked={chosen.has(question.id)}
                  onCheckedChange={() => toggle(question.id)}
                  disabled={!canApprove || busy !== null}
                />
              ) : null}
              <div className="min-w-0 flex-1">
                <Label htmlFor={canStart ? `topic-${question.id}` : undefined} className={canStart ? 'cursor-pointer' : undefined}>
                  {question.question}
                </Label>
                {question.whyItMatters ? <p className="mt-1 text-sm text-muted-foreground">Why it matters: {question.whyItMatters}</p> : null}
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Badge variant="outline">{question.priority} priority</Badge>
                  {active ? <Badge variant={question.status === 'researching' ? 'warning' : 'success'}>{question.status === 'researching' ? 'Research in progress' : 'Already researched'}</Badge> : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      {canApprove && available.length > 0 ? (
        <Button disabled={chosen.size === 0 || busy !== null} loading={busy === 'preflight'} onClick={openPreflight}>
          <Search /> Review research request
        </Button>
      ) : null}
      {!canApprove ? <p className="text-sm text-muted-foreground">Your role can view these questions but cannot start research.</p> : null}
    </section>
  );
}
