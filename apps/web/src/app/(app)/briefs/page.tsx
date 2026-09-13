import Link from 'next/link';
import { FileText, Upload } from 'lucide-react';
import { hasOpenAi, listFormats, withService, withUser } from '@g3/core';
import type { FormatConfig } from '@g3/shared';
import { computeRunWindows, toZonedDate } from '@g3/shared';
import { requirePageSession } from '@/lib/session';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { EmptyState, MockBanner } from '@/components/states';
import { QaStatusBadge, RunStatusBadge } from '@/components/status';
import { GenerateBriefPanel } from '@/components/generate-brief-panel';
import { UploadPanel } from '@/components/upload-panel';
import { formatDateTime, formatRelative } from '@/lib/utils';

export const dynamic = 'force-dynamic';

interface BriefRow {
  id: string;
  title: string;
  run_date: string | null;
  qa_status: string | null;
  output_mode: string | null;
  origin: string;
  is_mock: boolean;
  created_at: string;
  format_name: string;
  format_key: string;
  source_count: number;
  topic_count: number;
  pending_topics: number;
}

interface RunRow {
  id: string;
  kind: string;
  status: string;
  progress: number;
  current_stage: string | null;
  run_date: string | null;
  is_mock: boolean;
  created_at: string;
  format_name: string | null;
  error: string | null;
}

export default async function BriefsPage() {
  const session = await requirePageSession();
  const workspaceId = session.activeWorkspace.workspaceId;
  const isMock = !hasOpenAi();

  const formats = await withService((db) => listFormats(db, workspaceId));

  const { briefs, activeRuns } = await withUser(session.user.id, async (db) => ({
    briefs: await db.rows<BriefRow>(
      `select b.id, b.title, b.run_date, b.qa_status, b.output_mode, b.origin, b.is_mock,
              b.created_at, f.name as format_name, f.key as format_key,
              (select count(*)::int from public.brief_sources s where s.brief_document_id = b.id) as source_count,
              (select count(*)::int from public.research_topics t where t.brief_document_id = b.id) as topic_count,
              (select count(*)::int from public.research_topics t
                where t.brief_document_id = b.id and t.status = 'proposed') as pending_topics
         from public.brief_documents b
         join public.brief_formats f on f.id = b.format_id
        where b.workspace_id = $1
        order by coalesce(b.run_date::text, '') desc, b.created_at desc
        limit 60`,
      [workspaceId],
    ),
    activeRuns: await db.rows<RunRow>(
      `select r.id, r.kind, r.status, r.progress, r.current_stage, r.run_date, r.is_mock,
              r.created_at, r.error, f.name as format_name
         from public.runs r
         left join public.brief_formats f on f.id = r.format_id
        where r.workspace_id = $1 and r.kind = 'brief'
          and r.status in ('queued', 'running', 'failed')
        order by r.created_at desc
        limit 10`,
      [workspaceId],
    ),
  }));

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
        <h1 className="text-xl font-semibold tracking-tight">Briefs</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Generate a brief for one of the configured formats, or upload briefs and dossiers you
          already have. Generating a brief never writes to the knowledge base.
        </p>
      </div>

      {isMock ? <MockBanner scope="any brief you generate now" /> : null}

      <div className="grid gap-4 lg:grid-cols-2 [&>*]:min-w-0">
        <GenerateBriefPanel formats={formatOptions} today={today} timeZone={timeZone} />
        <UploadPanel />
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
                    ? `${run.progress}% — ${run.current_stage ?? 'starting'}`
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
            description="Generate one with a format above, or upload an existing brief or dossier. Uploaded documents go through the same review and approval path as generated ones."
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
                        <Badge variant="outline">{brief.pending_topics} topic(s) to choose</Badge>
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
            Generate or upload a brief, review its sources and gaps, choose which topics deserve deep
            research, then review the proposed changes and approve the ones you want saved. Nothing
            reaches the knowledge base until you approve it.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-xs text-muted-foreground">
          A QA verdict on a brief is that format&rsquo;s own release gate. It is not your approval of
          any record.
        </CardContent>
      </Card>
    </div>
  );
}
