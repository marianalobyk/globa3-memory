import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, CheckCircle2, CircleSlash, ExternalLink, HelpCircle, XCircle } from 'lucide-react';
import { withUser } from '@g3/core';
import { requirePageSession } from '@/lib/session';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Markdown } from '@/components/markdown';
import { MockBanner } from '@/components/states';
import { QaStatusBadge } from '@/components/status';
import { TopicSelector } from '@/components/topic-selector';
import { formatDateTime, titleCase } from '@/lib/utils';

export const dynamic = 'force-dynamic';

interface QaCheck {
  key: string;
  passed: boolean;
  severity: string;
  note: string;
  decidedBy?: string;
}

export default async function BriefPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePageSession();
  const workspaceId = session.activeWorkspace.workspaceId;
  const { id } = await params;

  const data = await withUser(session.user.id, async (db) => {
    const brief = await db.one<{
      id: string;
      title: string;
      run_date: string | null;
      coverage_start: string | null;
      coverage_end: string | null;
      body_md: string;
      output_mode: string | null;
      qa_status: string | null;
      qa_checks: QaCheck[];
      qa_notes: string | null;
      gaps: { question: string; why_it_matters: string }[];
      structured: Record<string, unknown>;
      origin: string;
      is_mock: boolean;
      created_at: string;
      format_name: string;
      format_key: string;
      prompt_version: number | null;
      run_id: string | null;
    }>(
      `select b.id, b.title, b.run_date, b.coverage_start, b.coverage_end, b.body_md,
              b.output_mode, b.qa_status, b.qa_checks, b.qa_notes, b.gaps, b.structured,
              b.origin, b.is_mock, b.created_at, b.run_id,
              f.name as format_name, f.key as format_key, pv.version as prompt_version
         from public.brief_documents b
         join public.brief_formats f on f.id = b.format_id
         left join public.prompt_versions pv on pv.id = b.prompt_version_id
        where b.workspace_id = $1 and b.id = $2`,
      [workspaceId, id],
    );
    if (!brief) return null;

    const sources = await db.rows<{
      id: string;
      url: string | null;
      title: string | null;
      publisher: string | null;
      source_tier: string | null;
      published_at: string | null;
      is_press_release: boolean;
      verification_state: string;
      verification_note: string | null;
    }>(
      `select id, url, title, publisher, source_tier, published_at, is_press_release,
              verification_state, verification_note
         from public.brief_sources where workspace_id = $1 and brief_document_id = $2
         order by source_tier, title`,
      [workspaceId, id],
    );

    const topics = await db.rows<{
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
    }>(
      `select t.id, t.label, t.target_type, t.resolution_status, t.priority,
              t.research_question, t.why_useful, t.status, t.selected, t.candidate_matches,
              bu.name as business_unit_name
         from public.research_topics t
         left join public.business_units bu on bu.id = t.business_unit_id
        where t.workspace_id = $1 and t.brief_document_id = $2
        order by case t.priority when 'high' then 0 when 'medium' then 1 when 'low' then 2 else 3 end,
                 t.label`,
      [workspaceId, id],
    );

    const proposals = await db.rows<{ id: string; title: string; status: string; version: number }>(
      `select id, title, status, version from public.proposals
        where workspace_id = $1 and brief_document_id = $2 order by created_at desc`,
      [workspaceId, id],
    );

    return { brief, sources, topics, proposals };
  });

  if (!data) notFound();
  const { brief, sources, topics, proposals } = data;

  const failedChecks = brief.qa_checks.filter((c) => !c.passed);
  const candidates = (brief.structured.candidates as { headline: string; tier: string; classification: string; freshness_label: string; confidence: string; recommended_action: string }[] | undefined) ?? [];
  const laneOutcomes = (brief.structured.lane_outcomes as { lane: string; searched: boolean; found_count: number; note: string }[] | undefined) ?? [];
  const limitations = (brief.structured.limitations as string[] | undefined) ?? [];

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="space-y-3">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href="/briefs">
            <ArrowLeft />
            All briefs
          </Link>
        </Button>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight">{brief.title}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {brief.format_name}
              {brief.run_date ? ` · ${brief.run_date}` : ''}
              {brief.prompt_version ? ` · prompt v${brief.prompt_version}` : ''} ·{' '}
              {formatDateTime(brief.created_at)}
            </p>
            {brief.coverage_start && brief.coverage_end ? (
              <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                Coverage {brief.coverage_start} → {brief.coverage_end}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {brief.is_mock ? <Badge variant="warning">Mock</Badge> : null}
            {brief.origin === 'uploaded' ? <Badge variant="secondary">Uploaded</Badge> : null}
            {brief.output_mode ? <Badge variant="outline">{titleCase(brief.output_mode)}</Badge> : null}
            <QaStatusBadge status={brief.qa_status} />
          </div>
        </div>
      </div>

      {brief.is_mock ? <MockBanner scope="this brief" /> : null}

      {brief.qa_status && brief.qa_status !== 'pass_internal_only' && brief.qa_status !== 'not_run' ? (
        <Card className="border-warning/40 bg-warning/5 shadow-none">
          <CardHeader>
            <CardTitle className="text-sm">QA gate: {titleCase(brief.qa_status)}</CardTitle>
            <CardDescription>
              {brief.qa_notes ?? 'The format’s release gate did not return a clean pass.'} This is the
              format’s own gate, not your approval of any record.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      {proposals.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 p-3 text-sm">
          <span className="font-medium">Proposed changes from this brief:</span>
          {proposals.map((proposal) => (
            <Button key={proposal.id} asChild size="sm" variant="outline">
              <Link href={`/review/${proposal.id}`}>
                {titleCase(proposal.status)} · v{proposal.version}
              </Link>
            </Button>
          ))}
        </div>
      ) : null}

      <Tabs defaultValue="brief">
        <TabsList className="flex-wrap">
          <TabsTrigger value="brief">Brief</TabsTrigger>
          <TabsTrigger value="sources">Sources ({sources.length})</TabsTrigger>
          <TabsTrigger value="gaps">Gaps ({brief.gaps.length})</TabsTrigger>
          <TabsTrigger value="research">Research ({topics.length})</TabsTrigger>
          <TabsTrigger value="qa">QA ({failedChecks.length > 0 ? `${failedChecks.length} failed` : 'clean'})</TabsTrigger>
        </TabsList>

        <TabsContent value="brief">
          <Card>
            <CardContent className="pt-5">
              <Markdown>{brief.body_md}</Markdown>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="sources" className="space-y-4">
          {sources.length === 0 ? (
            <p className="text-sm text-muted-foreground">This brief records no sources.</p>
          ) : (
            <Card>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Source</TableHead>
                    <TableHead>Tier</TableHead>
                    <TableHead>Published</TableHead>
                    <TableHead>Checks</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sources.map((source) => (
                    <TableRow key={source.id}>
                      <TableCell className="max-w-sm">
                        <p className="font-medium">{source.title ?? 'Untitled'}</p>
                        {source.url ? (
                          <a
                            href={source.url}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="mt-0.5 inline-flex items-center gap-1 break-all text-xs text-muted-foreground underline underline-offset-2"
                          >
                            {source.url}
                            <ExternalLink className="size-3 shrink-0" />
                          </a>
                        ) : null}
                        {source.publisher ? (
                          <p className="mt-0.5 text-xs text-muted-foreground">{source.publisher}</p>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">
                          {source.source_tier ? titleCase(source.source_tier.replace(/^tier\d_/, '')) : 'Unknown'}
                        </Badge>
                        {source.is_press_release ? (
                          <Badge variant="secondary" className="ml-1">
                            Press release
                          </Badge>
                        ) : null}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                        {source.published_at ?? '—'}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            source.verification_state === 'url_valid' || source.verification_state === 'corroborated'
                              ? 'secondary'
                              : source.verification_state === 'url_invalid'
                                ? 'destructive'
                                : 'outline'
                          }
                        >
                          {titleCase(source.verification_state)}
                        </Badge>
                        {source.verification_note ? (
                          <p className="mt-1 max-w-xs text-xs text-muted-foreground">
                            {source.verification_note}
                          </p>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}

          {laneOutcomes.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Research lane coverage</CardTitle>
                <CardDescription>
                  What each mandatory lane returned. A lane that was not scanned is a reason the
                  brief cannot claim full coverage.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-1.5 text-sm">
                {laneOutcomes.map((lane) => (
                  <div key={lane.lane} className="flex flex-wrap items-baseline gap-2">
                    {lane.searched ? (
                      <CheckCircle2 className="size-3.5 shrink-0 text-success" />
                    ) : (
                      <CircleSlash className="size-3.5 shrink-0 text-warning" />
                    )}
                    <span className="font-medium">Lane {lane.lane}</span>
                    <span className="text-muted-foreground">
                      {lane.found_count} found — {lane.note}
                    </span>
                  </div>
                ))}
              </CardContent>
            </Card>
          ) : null}

          {limitations.length > 0 ? (
            <Card className="border-warning/40 bg-warning/5 shadow-none">
              <CardHeader>
                <CardTitle className="text-sm">Stated limitations</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="list-disc space-y-1 pl-5 text-sm">
                  {limitations.map((limitation, index) => (
                    <li key={index}>{limitation}</li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ) : null}
        </TabsContent>

        <TabsContent value="gaps">
          {brief.gaps.length === 0 ? (
            <p className="text-sm text-muted-foreground">No gaps were recorded for this brief.</p>
          ) : (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">What this brief does not know</CardTitle>
                <CardDescription>
                  Gaps are recorded rather than glossed over. Each one is a candidate for deep
                  research.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {brief.gaps.map((gap, index) => (
                  <div key={index} className="rounded-md border p-3">
                    <p className="flex items-start gap-2 text-sm font-medium">
                      <HelpCircle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                      {gap.question}
                    </p>
                    <p className="mt-1 pl-6 text-sm text-muted-foreground">{gap.why_it_matters}</p>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="research">
          <TopicSelector briefDocumentId={brief.id} topics={topics} />
        </TabsContent>

        <TabsContent value="qa" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">QA and release gate</CardTitle>
              <CardDescription>
                Checks marked <span className="font-medium">code</span> are decided
                deterministically over the draft and its sources. The rest come from an adversarial
                review pass.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-1.5">
              {brief.qa_checks.length === 0 ? (
                <p className="text-sm text-muted-foreground">No QA checks were recorded.</p>
              ) : (
                brief.qa_checks.map((check) => (
                  <div
                    key={check.key}
                    className="flex flex-wrap items-start gap-2 rounded-md border p-2.5 text-sm"
                  >
                    {check.passed ? (
                      <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
                    ) : (
                      <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="font-mono text-xs font-medium">{check.key}</p>
                      <p className="mt-0.5 text-muted-foreground">{check.note}</p>
                    </div>
                    <div className="flex gap-1">
                      <Badge variant={check.severity === 'critical' ? 'destructive' : check.severity === 'major' ? 'warning' : 'muted'}>
                        {check.severity}
                      </Badge>
                      {check.decidedBy ? <Badge variant="outline">{check.decidedBy}</Badge> : null}
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          {candidates.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Candidate ledger</CardTitle>
                <CardDescription>
                  What the research stage considered, with the tier it reached. Numerical scores are
                  kept out of the reader-facing brief.
                </CardDescription>
              </CardHeader>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Candidate</TableHead>
                    <TableHead>Tier</TableHead>
                    <TableHead>Freshness</TableHead>
                    <TableHead>Confidence</TableHead>
                    <TableHead>Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {candidates.map((candidate, index) => (
                    <TableRow key={index}>
                      <TableCell className="max-w-sm">
                        <p className="font-medium">{candidate.headline}</p>
                        <p className="text-xs text-muted-foreground">{candidate.classification}</p>
                      </TableCell>
                      <TableCell>
                        <Badge variant={/p1|priority/i.test(candidate.tier) ? 'default' : 'outline'}>
                          {candidate.tier}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {titleCase(candidate.freshness_label ?? '')}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {titleCase(candidate.confidence ?? '')}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {candidate.recommended_action}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          ) : null}
        </TabsContent>
      </Tabs>
    </div>
  );
}
