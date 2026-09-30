import Link from 'next/link';
import type { ReactNode } from 'react';
import { Activity, ArrowRight, CheckCircle2, ClipboardCheck, Loader2, Search } from 'lucide-react';
import { CAPTURE_PHASES, capturePhase } from '@g3/shared';
import { hasOpenAi } from '@g3/core';
import { requirePageSession } from '@/lib/session';
import { loadTodayData, type TodayRun, type TodaySaved } from '@/lib/page-data';
import { CaptureForm } from '@/components/capture-form';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { displayLabel, recordKind } from '@/lib/labels';
import { cn, formatRelative } from '@/lib/utils';

export const dynamic = 'force-dynamic';

/**
 * Today: one dominant action, and the little that needs a person.
 *
 * Built phone-first for someone leaving a meeting: the capture box is the first
 * thing on the screen, everything else is a discreet link or a short list below
 * it -- what awaits approval, what is being analysed, what was saved. Read-only:
 * nothing on this page writes, except the capture box, which stores a private
 * source and never knowledge.
 */
export default async function TodayPage() {
  const session = await requirePageSession();
  const isMock = !hasOpenAi();
  const data = await loadTodayData(session);

  const awaiting = data.awaiting.changes;
  const savedTotal = data.saved[0]?.total ?? 0;
  const savedList: Omit<TodaySaved, 'total'>[] = savedTotal > 0 ? data.saved : data.recent;
  const dateLabel = new Intl.DateTimeFormat('en-GB', {
    timeZone: data.timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date());

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Today</h1>
        <p className="mt-1 text-sm text-muted-foreground">{dateLabel}</p>
      </div>

      <section className="space-y-2 rounded-xl border bg-card p-3 shadow-sm sm:p-4" aria-labelledby="today-capture">
        <h2 id="today-capture" className="sr-only">
          Add anything
        </h2>
        <CaptureForm variant="compact" autoFocus={false} />
      </section>

      <nav aria-label="Also on Today" className="flex flex-wrap gap-x-1 gap-y-1 text-sm">
        <Button asChild variant="ghost" size="sm">
          <Link href="/review">
            <ClipboardCheck />
            {awaiting > 0 ? `${awaiting} awaiting approval` : 'Awaiting approval'}
          </Link>
        </Button>
        <Button asChild variant="ghost" size="sm">
          <Link href="/knowledge">
            <Search />
            Search memory
          </Link>
        </Button>
        <Button asChild variant="ghost" size="sm">
          <Link href="/activity">
            <Activity />
            Recent activity
          </Link>
        </Button>
      </nav>

      {data.decisions.length > 0 ? (
        <QueueSection icon={<ClipboardCheck className="size-4" />} title="Needs your decision" count={data.awaiting.proposals}>
          {data.decisions.map((proposal) => (
            <QueueRow
              key={proposal.id}
              href={`/review/${proposal.id}`}
              title={displayLabel(proposal.title)}
              meta={[
                proposal.capture_id ? 'From a capture' : proposal.source_kind === 'research' ? 'From research you requested' : null,
                formatRelative(proposal.created_at),
              ]}
              badges={
                <>
                  {proposal.is_mock ? <Badge variant="warning">Mock</Badge> : null}
                  {proposal.awaiting > 0 ? <Badge variant="warning">{proposal.awaiting} to review</Badge> : null}
                  {proposal.approved_unsaved > 0 ? (
                    <Badge variant="secondary">{proposal.approved_unsaved} approved, not saved</Badge>
                  ) : null}
                </>
              }
              action="Review"
            />
          ))}
        </QueueSection>
      ) : null}

      {data.runs.length > 0 ? (
        <QueueSection icon={<Loader2 className="size-4" />} title="Being analysed" count={data.runs.filter((r) => r.status !== 'failed').length}>
          {data.runs.map((run) => (
            <QueueRow
              key={run.id}
              href={run.capture_id ? `/capture/${run.capture_id}` : `/activity/runs/${run.id}`}
              title={runTitle(run)}
              meta={[runMeta(run), formatRelative(run.created_at)]}
              badges={run.is_mock ? <Badge variant="warning">Mock</Badge> : null}
              action={run.status === 'failed' ? 'See why' : 'Open'}
            />
          ))}
        </QueueSection>
      ) : null}

      <QueueSection
        icon={<CheckCircle2 className="size-4" />}
        title={savedTotal > 0 ? 'Saved today' : 'Recently saved'}
        count={savedTotal}
        empty="Nothing has been saved yet. Capture a note; what you approve appears here."
      >
        {savedList.map((change) => (
          <SavedRow key={change.id} change={change} />
        ))}
      </QueueSection>

      {isMock ? (
        <p className="text-xs text-muted-foreground">
          Mock AI: no OpenAI key is configured, so analysis results are synthetic and labelled Mock. Saved memory is
          real.
        </p>
      ) : null}
    </div>
  );
}

function runTitle(run: TodayRun): string {
  if (run.kind === 'research') return `Research · ${run.target_label ?? 'requested target'}`;
  return run.capture_kind === 'file' ? 'Captured file' : run.capture_kind === 'url' ? 'Captured link' : 'Captured note';
}

function runMeta(run: TodayRun): string {
  if (run.status === 'failed') return 'Stopped — open to retry';
  if (run.kind === 'research') return run.status === 'queued' ? 'Waiting to start' : 'Researching';
  return CAPTURE_PHASES[capturePhase(run.capture_status ?? 'received', run.current_stage)];
}

function SavedRow({ change }: { change: Omit<TodaySaved, 'total'> }) {
  const kind = recordKind(change.table_name, { entity_type: change.entity_type });
  const verb = change.op === 'update' ? 'Updated' : change.op === 'link' ? 'Linked' : 'Created';
  return (
    <li>
      <Link
        href={`/knowledge?q=${encodeURIComponent(change.label)}`}
        title={`View ${change.label} in Knowledge`}
        className="group flex items-center gap-x-3 px-3 py-2.5 text-sm transition-colors hover:bg-accent/40"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{displayLabel(change.label)}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {kind} · {verb} {formatRelative(change.applied_at)}
          </span>
        </span>
        <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-primary">
          View
          <ArrowRight className="size-3 transition-transform group-hover:translate-x-0.5" />
        </span>
      </Link>
    </li>
  );
}

function QueueSection({
  icon,
  title,
  count,
  children,
  empty,
}: {
  icon: ReactNode;
  title: string;
  count: number;
  children: ReactNode[];
  empty?: string;
}) {
  const hasRows = children.length > 0;
  return (
    <section className="space-y-2" aria-labelledby={`today-${slug(title)}`}>
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground">{icon}</span>
        <h2 id={`today-${slug(title)}`} className="text-sm font-semibold">
          {title}
        </h2>
        {count > 0 ? (
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium tabular-nums">{count}</span>
        ) : null}
      </div>
      {hasRows ? (
        <ul className="divide-y rounded-lg border">{children}</ul>
      ) : (
        <p className="rounded-lg border border-dashed px-3 py-3 text-sm text-muted-foreground">{empty}</p>
      )}
    </section>
  );
}

function QueueRow({
  href,
  title,
  meta,
  badges,
  action,
}: {
  href: string;
  title: string;
  meta: (string | null)[];
  badges: ReactNode;
  action: string;
}) {
  const metaText = meta.filter(Boolean).join(' · ');
  return (
    <li>
      <Link
        href={href}
        className={cn('group flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-sm transition-colors hover:bg-accent/40')}
      >
        {/* On a phone the title takes the whole first line; badges and the
            action wrap underneath instead of squeezing it to three letters. */}
        <span className="w-full min-w-0 sm:w-auto sm:flex-1">
          <span className="block truncate font-medium">{title}</span>
          {metaText ? <span className="block truncate text-xs text-muted-foreground">{metaText}</span> : null}
        </span>
        <span className="flex flex-wrap items-center gap-1.5">{badges}</span>
        <span className="inline-flex items-center gap-1 text-xs font-medium text-primary">
          {action}
          <ArrowRight className="size-3 transition-transform group-hover:translate-x-0.5" />
        </span>
      </Link>
    </li>
  );
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}
