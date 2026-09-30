'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  CheckCircle2,
  CircleDashed,
  Clock,
  Loader2,
  RotateCcw,
  SkipForward,
  XCircle,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorState, LoadingRows, MockBanner } from '@/components/states';
import { RunStatusBadge } from '@/components/status';
import { api, RequestFailed } from '@/lib/client';
import { cn, formatCost, formatDateTime, formatTokens, titleCase } from '@/lib/utils';
import { runKindLabel, UPLOAD_REFERENCE_NOTE } from '@/lib/labels';

interface Stage {
  seq: number;
  stage: string;
  label: string | null;
  status: string;
  progress: number;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  web_searches: number | null;
  duration_ms: number | null;
  cost_usd: string | null;
  cost_is_estimate: boolean;
  has_background_response: boolean;
}

interface RunEvent {
  id: string;
  level: string;
  stage: string | null;
  message: string;
  created_at: string;
}

interface RunPayload {
  run: {
    id: string;
    kind: string;
    status: string;
    progress: number;
    current_stage: string | null;
    attempt: number;
    max_attempts: number;
    error: string | null;
    is_mock: boolean;
    run_date: string | null;
    created_at: string;
    started_at: string | null;
    finished_at: string | null;
    lease_owner: string | null;
    heartbeat_at: string | null;
  };
  stages: Stage[];
  events: RunEvent[];
  briefDocumentId: string | null;
  proposalId: string | null;
  cost: { totalUsd: number; hasEstimates: boolean };
}

const STAGE_ICON: Record<string, React.ReactNode> = {
  pending: <CircleDashed className="size-4 text-muted-foreground" />,
  running: <Loader2 className="size-4 animate-spin text-primary" />,
  succeeded: <CheckCircle2 className="size-4 text-success" />,
  failed: <XCircle className="size-4 text-destructive" />,
  skipped: <SkipForward className="size-4 text-muted-foreground" />,
};

/**
 * Live run progress.
 *
 * Polls while the run is active and stops once it settles. The run is a durable
 * record, so closing this page does not affect it — which is the point of doing
 * the work in the worker rather than in a request.
 */
export function RunProgress({ runId }: { runId: string }) {
  const [data, setData] = useState<RunPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api<RunPayload>(`/api/runs/${runId}`));
      setError(null);
    } catch (failure) {
      setError(
        failure instanceof RequestFailed ? failure.payload.error : 'Could not load the run.',
      );
    }
  }, [runId]);

  useEffect(() => {
    void load();
  }, [load]);

  const active = data?.run.status === 'queued' || data?.run.status === 'running';

  // When a run settles, refresh the server-rendered shell so the menu counts
  // (targets ready, changes awaiting review) reflect what the run produced.
  const router = useRouter();
  const [wasActive, setWasActive] = useState(false);
  useEffect(() => {
    if (active) setWasActive(true);
    else if (wasActive && data) {
      setWasActive(false);
      router.refresh();
    }
  }, [active, wasActive, data, router]);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, [active, load]);

  if (error && !data) {
    return <ErrorState description={error} onRetry={() => void load()} />;
  }
  if (!data) return <LoadingRows rows={3} />;

  const { run, stages, events, briefDocumentId, proposalId, cost } = data;
  const headline = runHeadline(run.kind, run.status, Boolean(proposalId));

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="text-base">
                {runKindLabel(run.kind)}
                {run.run_date ? ` · ${run.run_date}` : ''}
              </CardTitle>
              <CardDescription>
                Started {formatDateTime(run.created_at)}
                {run.finished_at ? ` · finished ${formatDateTime(run.finished_at)}` : ''}
              </CardDescription>
            </div>
            <RunStatusBadge status={run.status} isMock={run.is_mock} />
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{headline}</span>
              <span className="tabular-nums">{run.progress}%</span>
            </div>
            <div className="mt-1 h-2 overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  'h-full transition-all duration-500',
                  run.status === 'failed' ? 'bg-destructive' : run.status === 'succeeded' ? 'bg-success' : 'bg-primary',
                )}
                style={{ width: `${run.progress}%` }}
              />
            </div>
          </div>

          {active ? (
            <p className="text-xs text-muted-foreground">
              Running in the background. You can close this page — it also shows under Running now on
              Today.
            </p>
          ) : null}
          {run.kind === 'ingest' && run.status === 'succeeded' ? (
            <p className="text-sm text-muted-foreground">{UPLOAD_REFERENCE_NOTE}</p>
          ) : null}

          {run.error ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
              <p className="font-medium text-destructive">
                {run.status === 'queued' ? 'Last attempt failed; it will be retried' : 'Run failed'}
              </p>
              <p className="mt-1 text-muted-foreground">{run.error}</p>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            {proposalId ? (
              <Button asChild size="sm">
                <Link href={`/review/${proposalId}`}>Review proposed changes</Link>
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" onClick={() => void load()}>
              <RotateCcw />
              Refresh
            </Button>
          </div>
        </CardContent>
      </Card>

      {run.is_mock ? <MockBanner scope="this run" /> : null}

      <details className="rounded-lg border px-4 py-3 [&[open]]:pb-4">
        <summary className="cursor-pointer text-sm font-medium text-muted-foreground">
          Technical details — stages, attempts, cost and log
        </summary>
        <div className="mt-3 space-y-4">
          <p className="text-xs text-muted-foreground">
            Attempt {run.attempt} of {run.max_attempts} · {formatCost(cost.totalUsd, cost.hasEstimates)}
            {run.lease_owner ? ` · worker ${run.lease_owner}` : ''}. Each stage stores its result, so a
            resumed run skips the stages already finished.
          </p>
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Stages</CardTitle>
          <CardDescription>
            Each stage stores its result, so a resumed run skips the ones already finished instead of
            repeating them.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-1.5">
          {stages.map((stage) => (
            <div key={stage.seq} className="flex flex-wrap items-start gap-2.5 rounded-md border p-2.5">
              <span className="mt-0.5">{STAGE_ICON[stage.status] ?? STAGE_ICON.pending}</span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">
                  {titleCase(stage.stage)}
                  {stage.has_background_response ? (
                    <Badge variant="secondary" className="ml-2">
                      Background research
                    </Badge>
                  ) : null}
                </p>
                {stage.label ? (
                  <p className="text-xs text-muted-foreground">{stage.label}</p>
                ) : null}
                {stage.error ? <p className="mt-1 text-xs text-destructive">{stage.error}</p> : null}
              </div>
              <div className="text-right text-xs tabular-nums text-muted-foreground">
                {stage.duration_ms ? <p>{(stage.duration_ms / 1000).toFixed(1)}s</p> : null}
                {stage.tokens_in || stage.tokens_out ? (
                  <p>
                    {formatTokens(stage.tokens_in)} / {formatTokens(stage.tokens_out)} tok
                  </p>
                ) : null}
                {stage.web_searches ? <p>{stage.web_searches} search(es)</p> : null}
                {stage.cost_usd ? (
                  <p>{formatCost(Number(stage.cost_usd), stage.cost_is_estimate)}</p>
                ) : null}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Run log</CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="space-y-1.5">
            {events.map((event) => (
              <li key={event.id} className="flex gap-2 text-xs">
                <span className="shrink-0 text-muted-foreground">
                  <Clock className="mt-0.5 size-3" />
                </span>
                <span
                  className={cn(
                    'min-w-0',
                    event.level === 'error' && 'text-destructive',
                    event.level === 'warn' && 'text-warning',
                  )}
                >
                  {event.stage ? <span className="font-mono">[{event.stage}] </span> : null}
                  {event.message}
                </span>
                <span className="ml-auto shrink-0 whitespace-nowrap text-muted-foreground">
                  {formatDateTime(event.created_at)}
                </span>
              </li>
            ))}
            {events.length === 0 ? (
              <li className="text-xs text-muted-foreground">No events recorded yet.</li>
            ) : null}
          </ol>
        </CardContent>
      </Card>
        </div>
      </details>
    </div>
  );
}

function runHeadline(kind: string, status: string, hasProposal: boolean): string {
  if (status === 'queued') return 'Waiting for the worker';
  if (status === 'running') return 'Working';
  if (status === 'failed') return 'Stopped — see the error below';
  if (status === 'canceled') return 'Canceled';
  if (kind === 'brief') return 'Brief ready — next, choose what to research';
  if (kind === 'research') return hasProposal ? 'Research finished — changes are awaiting your review' : 'Research finished';
  if (kind === 'ingest') return 'Upload processed';
  return 'Finished';
}
