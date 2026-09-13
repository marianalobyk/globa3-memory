'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Telescope } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { EmptyState } from '@/components/states';
import { MatchStatusBadge, PriorityBadge } from '@/components/status';
import { api, RequestFailed } from '@/lib/client';
import { titleCase } from '@/lib/utils';

export interface TopicRow {
  id: string;
  label: string;
  target_type: string;
  resolution_status: string;
  priority: string;
  research_question: string | null;
  why_useful: string | null;
  status: string;
  selected: boolean;
  candidate_matches: { rationale?: string; candidates?: { displayName: string; similarity: number }[] };
  business_unit_name: string | null;
}

/**
 * Choose which topics get deep research.
 *
 * Nothing is researched automatically: people, companies and projects are
 * explicit targets, and each one shows whether it already exists in the
 * knowledge base, is an ambiguous match, or is new. An ambiguous match is shown
 * with its closest candidates and the reason, so the operator decides rather
 * than the resolver.
 */
export function TopicSelector({
  briefDocumentId,
  topics,
}: {
  briefDocumentId: string;
  topics: TopicRow[];
}) {
  const router = useRouter();
  const researchable = useMemo(
    () => topics.filter((t) => t.priority !== 'skip' && t.status !== 'captured'),
    [topics],
  );
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(researchable.filter((t) => t.priority === 'high').map((t) => t.id)),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ runId: string; created: boolean; budgetWarnings: string[] }>(
        '/api/runs',
        {
          method: 'POST',
          json: { kind: 'research', briefDocumentId, topicIds: [...selected] },
        },
      );
      router.push(`/activity/runs/${result.runId}`);
    } catch (failure) {
      setError(
        failure instanceof RequestFailed ? failure.payload.error : 'Could not start the research run.',
      );
    } finally {
      setBusy(false);
    }
  };

  if (topics.length === 0) {
    return (
      <EmptyState
        icon={<Telescope className="size-5" />}
        title="No research topics proposed"
        description="This brief did not surface targets worth researching, or it has not finished its extraction stage yet."
      />
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Choose what to research</CardTitle>
          <CardDescription>
            Deep research runs only on the targets you pick. Each one shows how it resolved against
            the knowledge base — a similar name is never treated as the same record.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {researchable.map((topic) => {
            const candidates = topic.candidate_matches?.candidates ?? [];
            const isSelected = selected.has(topic.id);
            const done = topic.status === 'researched' || topic.status === 'captured';
            return (
              <div
                key={topic.id}
                className="flex gap-3 rounded-lg border p-3 transition-colors has-[:checked]:border-primary/50 has-[:checked]:bg-accent/30"
              >
                <Checkbox
                  id={`topic-${topic.id}`}
                  checked={isSelected}
                  onCheckedChange={() => toggle(topic.id)}
                  className="mt-0.5"
                  aria-label={`Research ${topic.label}`}
                />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <label htmlFor={`topic-${topic.id}`} className="cursor-pointer text-sm font-medium">
                      {topic.label}
                    </label>
                    <Badge variant="outline">{titleCase(topic.target_type)}</Badge>
                    <PriorityBadge priority={topic.priority} />
                    <MatchStatusBadge
                      status={
                        topic.resolution_status === 'existing'
                          ? 'existing'
                          : topic.resolution_status === 'ambiguous'
                            ? 'ambiguous'
                            : 'new'
                      }
                    />
                    {done ? <Badge variant="success">{titleCase(topic.status)}</Badge> : null}
                    {topic.business_unit_name ? (
                      <Badge variant="secondary">{topic.business_unit_name}</Badge>
                    ) : null}
                  </div>
                  {topic.research_question ? (
                    <p className="text-sm">{topic.research_question}</p>
                  ) : null}
                  {topic.why_useful ? (
                    <p className="text-xs text-muted-foreground">{topic.why_useful}</p>
                  ) : null}
                  {topic.resolution_status === 'ambiguous' && candidates.length > 0 ? (
                    <div className="rounded-md border border-warning/40 bg-warning/5 p-2 text-xs">
                      <p className="font-medium">Possible existing matches</p>
                      <ul className="mt-1 space-y-0.5">
                        {candidates.slice(0, 3).map((candidate) => (
                          <li key={candidate.displayName} className="text-muted-foreground">
                            {candidate.displayName} — similarity {candidate.similarity.toFixed(2)}
                          </li>
                        ))}
                      </ul>
                      {topic.candidate_matches?.rationale ? (
                        <p className="mt-1 text-muted-foreground">{topic.candidate_matches.rationale}</p>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}

          {topics.some((t) => t.priority === 'skip') ? (
            <details className="rounded-md border p-3 text-sm">
              <summary className="cursor-pointer text-muted-foreground">
                {topics.filter((t) => t.priority === 'skip').length} target(s) marked skip
              </summary>
              <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                {topics
                  .filter((t) => t.priority === 'skip')
                  .map((topic) => (
                    <li key={topic.id}>
                      {topic.label} — {topic.why_useful ?? 'no reason recorded'}
                    </li>
                  ))}
              </ul>
            </details>
          ) : null}

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-3 pt-1">
            <Button onClick={start} loading={busy} disabled={selected.size === 0}>
              <Telescope />
              Research {selected.size} target{selected.size === 1 ? '' : 's'}
            </Button>
            <p className="text-xs text-muted-foreground">
              Research runs in the background. You can close this page.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
