import Link from 'next/link';
import { FileText, Upload } from 'lucide-react';
import { hasOpenAi } from '@g3/core';
import type { FormatConfig } from '@g3/shared';
import { computeRunWindows, toZonedDate } from '@g3/shared';
import { requirePageSession } from '@/lib/session';
import { loadBriefsData } from '@/lib/page-data';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { EmptyState, MockBanner } from '@/components/states';
import { QaStatusBadge, RunStatusBadge } from '@/components/status';
import { GenerateBriefPanel } from '@/components/generate-brief-panel';
import { UploadPanel } from '@/components/upload-panel';
import { formatDateTime, formatRelative } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export default async function BriefsPage() {
  const session = await requirePageSession();
  const workspaceId = session.activeWorkspace.workspaceId;
  const isMock = !hasOpenAi();

  const { formats, briefs, activeRuns } = await loadBriefsData(session);

  // Default run date: yesterday in the workspace timezone, because a daily brief
  // covers the window that has actually closed.
  const timeZone = session.activeWorkspace.timezone;
  const today = toZonedDate(new Date(), timeZone);
  const formatOptions = formats.map((f) => {
    const config = f.config as FormatConfig;
    const windows = computeRunWindows(today, config.windowShape);
    return {
      id: f.id,
      key: f.key,
      name: f.name,
      productLine: f.product_line ?? '',
      coverageHours: config.windowShape.coverageHours,
      laneCount: config.researchLanes.length,
      timeZone: config.windowShape.timeZone,
      previewCoverage: `${windows.coverageStartIso} → ${windows.coverageEndIso}`,
    };
  });

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-xl font-semibold tracking-tight">Sources</h1>
          <Link href="/research" className="text-sm underline underline-offset-2">
            Research runs and targets
          </Link>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Briefs and uploaded files. A brief proposes research targets; research proposes changes; nothing
          is saved to knowledge until you approve it in Review.
        </p>
      </div>

      {isMock ? <MockBanner scope="any brief you generate now" /> : null}

      <div className="grid gap-4 lg:grid-cols-2 [&>*]:min-w-0">
        <div id="generate" className="scroll-mt-4">
          <GenerateBriefPanel formats={formatOptions} today={today} timeZone={timeZone} />
        </div>
        <div id="upload" className="scroll-mt-4">
          <UploadPanel />
        </div>
      </div>

      {activeRuns.length > 0 ? (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">In progress</h2>
          <div className="space-y-2">
            {activeRuns.map((run) => (
              <Link
                key={run.id}
                href={`/activity/runs/${run.id}`}
                className="flex flex-wrap items-center gap-3 rounded-lg border p-3 text-sm transition-colors hover:bg-accent/50"
              >
                <RunStatusBadge status={run.status} isMock={run.is_mock} />
                <span className="font-medium">{run.format_name ?? 'Brief'}</span>
                {run.run_date ? <span className="text-muted-foreground">{run.run_date}</span> : null}
                <span className="text-muted-foreground">
                  {run.status === 'running'
                    ? `${run.progress}% done`
                    : run.status === 'failed'
                      ? (run.error ?? 'Failed')
                      : 'Queued'}
                </span>
                <span className="ml-auto text-xs text-muted-foreground">
                  {formatRelative(run.created_at)}
                </span>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      <Separator />

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">All briefs</h2>
        {briefs.length === 0 ? (
          <EmptyState
            icon={<FileText className="size-5" />}
            title="No briefs yet"
            description="Generate one with a format above. Uploaded files are stored for reference and listed in the upload panel; capture into knowledge is coming next."
          />
        ) : (
          <ul className="space-y-2">
            {briefs.map((brief) => (
              <li key={brief.id}>
                <Link
                  href={`/briefs/${brief.id}`}
                  className="block rounded-lg border p-4 transition-colors hover:bg-accent/40"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{brief.title}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {brief.format_name}
                        {brief.run_date ? ` · ${brief.run_date}` : ''} · {brief.source_count} source
                        {brief.source_count === 1 ? '' : 's'} · {formatDateTime(brief.created_at)}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {brief.is_mock ? <Badge variant="warning">Mock</Badge> : null}
                      {brief.origin === 'uploaded' ? <Badge variant="secondary">Uploaded</Badge> : null}
                      <QaStatusBadge status={brief.qa_status} />
                      {brief.pending_topics > 0 ? (
                        <Badge variant="warning">
                          {brief.pending_topics} research target{brief.pending_topics === 1 ? '' : 's'} ready
                        </Badge>
                      ) : null}
                    </div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Card className="border-dashed shadow-none">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Upload className="size-4" />
            How a brief becomes knowledge
          </CardTitle>
          <CardDescription>
            Generate a brief, choose what to research, then review the proposed changes and approve the
            ones you want saved. Nothing reaches knowledge until you approve it. Uploaded files are
            stored for reference only for now.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-xs text-muted-foreground">
          A brief&rsquo;s quality check is about the brief itself. It is not an approval of any record.
        </CardContent>
      </Card>
    </div>
  );
}
