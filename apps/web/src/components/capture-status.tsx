'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertTriangle, ArrowRight, CheckCircle2, Loader2, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api, RequestFailed } from '@/lib/client';
import type { CaptureView } from '@/lib/capture-view';
import { cn } from '@/lib/utils';

/**
 * What happened to one capture: received, analysing, matching existing memory,
 * proposal ready -- or stopped. The steps and words come from the server, the
 * same ones the mobile app shows. Polls only while the analysis is running.
 */
export function CaptureStatus({ captureId, initial }: { captureId: string; initial: CaptureView }) {
  const router = useRouter();
  const [view, setView] = useState<CaptureView>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setView(await api<CaptureView>(`/api/captures/${captureId}`));
    } catch {
      // A failed poll is not worth surfacing; the next one may succeed.
    }
  }, [captureId]);

  const active = view.phase === 'received' || view.phase === 'analysing' || view.phase === 'matching';
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void load(), 1500);
    return () => clearInterval(timer);
  }, [active, load]);

  useEffect(() => {
    if (view.phase === 'ready') router.refresh();
  }, [view.phase, router]);

  const retry = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/captures/${captureId}/retry`, { method: 'POST' });
      await load();
    } catch (failure) {
      setError(failure instanceof RequestFailed ? failure.payload.error : 'The analysis could not be retried.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <ol className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
        {view.steps.map((step, index) => (
          <li key={step.label} className="flex items-center gap-2">
            <span
              className={cn(
                'flex size-5 items-center justify-center rounded-full border text-[0.6875rem]',
                step.state === 'done' && 'border-success bg-success/10 text-success',
                step.state === 'failed' && 'border-destructive bg-destructive/10 text-destructive',
                step.state === 'current' && 'border-primary bg-primary/10 text-primary',
              )}
            >
              {step.state === 'done' ? (
                <CheckCircle2 className="size-3.5" aria-hidden />
              ) : step.state === 'failed' ? (
                <AlertTriangle className="size-3.5" aria-hidden />
              ) : step.state === 'current' ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
              ) : (
                index + 1
              )}
            </span>
            <span className={cn(step.state === 'todo' ? 'text-muted-foreground' : 'font-medium')}>{step.label}</span>
            {index < view.steps.length - 1 ? <span className="text-muted-foreground">→</span> : null}
          </li>
        ))}
      </ol>

      {view.phase === 'ready' && view.proposal ? (
        <div className="space-y-3 rounded-lg border border-success/40 bg-success/5 p-4">
          <p className="text-sm">
            <span className="font-medium">
              {view.proposal.changes} change{view.proposal.changes === 1 ? '' : 's'} proposed
            </span>{' '}
            from this capture. Nothing is saved until you approve it.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button asChild>
              <Link href={`/review/${view.proposal.id}`}>
                Review proposed changes
                <ArrowRight />
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link href={`/capture?edit=${captureId}`}>Edit the capture</Link>
            </Button>
          </div>
        </div>
      ) : null}

      {active ? (
        <p className="text-sm text-muted-foreground">
          {view.phaseLabel} — you can close this page. It also shows under Being analysed on Today.
        </p>
      ) : null}

      {view.phase === 'failed' ? (
        <div className="space-y-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4">
          <p className="text-sm font-medium">The analysis stopped.</p>
          <p className="text-sm text-muted-foreground">{view.failure}</p>
          <p className="text-sm text-muted-foreground">The source itself is stored and unchanged.</p>
          <div className="flex flex-wrap gap-2">
            {view.canRetry ? (
              <Button onClick={retry} loading={busy}>
                <RotateCcw />
                Retry analysis
              </Button>
            ) : null}
            <Button asChild variant="outline">
              <Link href={`/capture?edit=${captureId}`}>Edit the capture</Link>
            </Button>
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
