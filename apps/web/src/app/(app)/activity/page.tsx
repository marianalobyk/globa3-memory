import Link from 'next/link';
import { Activity as ActivityIcon, Download } from 'lucide-react';
import { budgetStates, listActivity, withService, withUser, workspaceCostSummary } from '@g3/core';
import { requirePageSession } from '@/lib/session';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState } from '@/components/states';
import { RunStatusBadge } from '@/components/status';
import { ReportPanel } from '@/components/report-panel';
import { formatCost, formatDateTime, formatRelative, formatTokens, titleCase } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export default async function ActivityPage() {
  const session = await requirePageSession();
  const workspaceId = session.activeWorkspace.workspaceId;

  const { runs, changes, activity, reports, spend, budgets, usageByStage } = await withUser(
    session.user.id,
    async (db) => ({
      runs: await db.rows<{
        id: string;
        kind: string;
        status: string;
        progress: number;
        current_stage: string | null;
        run_date: string | null;
        attempt: number;
        max_attempts: number;
        is_mock: boolean;
        error: string | null;
        created_at: string;
        finished_at: string | null;
        format_name: string | null;
        cost: string | null;
        cost_is_estimate: boolean | null;
      }>(
        `select r.id, r.kind, r.status, r.progress, r.current_stage, r.run_date, r.attempt,
                r.max_attempts, r.is_mock, r.error, r.created_at, r.finished_at,
                f.name as format_name,
                (select sum(u.cost_usd)::text from public.usage_events u where u.run_id = r.id) as cost,
                (select bool_or(u.is_estimate) from public.usage_events u where u.run_id = r.id) as cost_is_estimate
           from public.runs r
           left join public.brief_formats f on f.id = r.format_id
          where r.workspace_id = $1
          order by r.created_at desc limit 50`,
        [workspaceId],
      ),
      changes: await db.rows<{
        id: string;
        table_name: string;
        row_id: string;
        op: string;
        applied_at: string;
        readback_ok: boolean | null;
        label: string;
        claim_type: string | null;
        applied_by: string | null;
        approved_by: string | null;
        proposal_id: string;
        proposal_title: string;
        is_mock: boolean;
      }>(
        `select c.id, c.table_name, c.row_id, c.op, c.applied_at, c.readback_ok,
                i.label, i.claim_type, au.email as applied_by, apu.email as approved_by,
                p.id as proposal_id, p.title as proposal_title, p.is_mock
           from public.applied_changes c
           join public.proposal_items i on i.id = c.proposal_item_id
           join public.proposals p on p.id = c.proposal_id
           left join public.app_users au on au.id = c.applied_by
           left join public.proposal_approvals ap on ap.id = c.approval_id
           left join public.app_users apu on apu.id = ap.approved_by
          where c.workspace_id = $1
          order by c.applied_at desc limit 80`,
        [workspaceId],
      ),
      activity: await listActivity(db, workspaceId, 80),
      reports: await db.rows<{
        report_date: string;
        change_count: number;
        generated_at: string;
        storage_path: string | null;
      }>(
        `select report_date, change_count, generated_at, storage_path
           from public.daily_reports where workspace_id = $1
          order by report_date desc limit 30`,
        [workspaceId],
      ),
      usageByStage: await db.rows<{
        stage: string | null;
        model: string | null;
        calls: number;
        tokens_in: number;
        tokens_out: number;
        searches: number;
        cost: string;
        is_estimate: boolean;
      }>(
        `select stage, model, count(*)::int as calls,
                sum(tokens_in)::int as tokens_in, sum(tokens_out)::int as tokens_out,
                sum(web_searches)::int as searches, sum(cost_usd)::text as cost,
                bool_or(is_estimate) as is_estimate
           from public.usage_events
          where workspace_id = $1 and created_at >= now() - interval '30 days'
          group by stage, model order by sum(cost_usd) desc nulls last, stage`,
        [workspaceId],
      ),
      spend: { totalUsd: 0, hasEstimates: false, byStage: [], byModel: [], periodDays: 30 },
      budgets: [] as never[],
    }),
  );

  const cost = await withService(async (db) => ({
    spend: await workspaceCostSummary(db, workspaceId, 30),
    budgets: await budgetStates(db, workspaceId),
  }));

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Activity</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every run, every change actually written, who approved it, and what it cost.
        </p>
      </div>

      <Tabs defaultValue="changes">
        <TabsList className="flex-wrap">
          <TabsTrigger value="changes">Changes ({changes.length})</TabsTrigger>
          <TabsTrigger value="runs">Runs ({runs.length})</TabsTrigger>
          <TabsTrigger value="costs">Costs</TabsTrigger>
          <TabsTrigger value="reports">Reports</TabsTrigger>
          <TabsTrigger value="log">Audit log</TabsTrigger>
        </TabsList>

        <TabsContent value="changes">
          {changes.length === 0 ? (
            <EmptyState
              icon={<ActivityIcon className="size-5" />}
              title="No records changed yet"
              description="Changes appear here once you approve a proposal. Nothing reaches the knowledge base any other way."
            />
          ) : (
            <Card>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Record</TableHead>
                    <TableHead>Table</TableHead>
                    <TableHead>Approved by</TableHead>
                    <TableHead>Applied by</TableHead>
                    <TableHead>Readback</TableHead>
                    <TableHead>Origin</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {changes.map((change) => (
                    <TableRow key={change.id}>
                      <TableCell className="max-w-xs">
                        <p className="font-medium">{change.label}</p>
                        <p className="text-xs text-muted-foreground">
                          {titleCase(change.op)}
                          {change.claim_type ? ` · ${change.claim_type}` : ''} ·{' '}
                          {formatRelative(change.applied_at)}
                        </p>
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {change.table_name}
                        <br />
                        <span className="text-muted-foreground">{change.row_id.slice(0, 8)}</span>
                      </TableCell>
                      <TableCell className="text-xs">{change.approved_by ?? '—'}</TableCell>
                      <TableCell className="text-xs">{change.applied_by ?? '—'}</TableCell>
                      <TableCell>
                        <Badge variant={change.readback_ok ? 'success' : 'destructive'}>
                          {change.readback_ok ? 'ok' : 'check'}
                        </Badge>
                      </TableCell>
                      <TableCell className="max-w-[12rem]">
                        <Link
                          href={`/review/${change.proposal_id}`}
                          className="text-xs underline underline-offset-2"
                        >
                          {change.proposal_title}
                        </Link>
                        {change.is_mock ? (
                          <Badge variant="warning" className="ml-1">
                            Mock
                          </Badge>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="runs">
          {runs.length === 0 ? (
            <EmptyState title="No runs yet" description="Start a brief from the Briefs section." />
          ) : (
            <Card>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Run</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Attempts</TableHead>
                    <TableHead>Cost</TableHead>
                    <TableHead>Started</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {runs.map((run) => (
                    <TableRow key={run.id}>
                      <TableCell className="max-w-xs">
                        <p className="font-medium">
                          {titleCase(run.kind)}
                          {run.format_name ? ` · ${run.format_name}` : ''}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {run.run_date ?? ''}
                          {run.status === 'running' ? ` · ${run.progress}% ${run.current_stage ?? ''}` : ''}
                        </p>
                        {run.error ? (
                          <p className="mt-0.5 text-xs text-destructive">{run.error}</p>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <RunStatusBadge status={run.status} isMock={run.is_mock} />
                      </TableCell>
                      <TableCell className="text-xs tabular-nums text-muted-foreground">
                        {run.attempt}/{run.max_attempts}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs tabular-nums">
                        {formatCost(Number(run.cost ?? 0), run.cost_is_estimate !== false)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {formatDateTime(run.created_at)}
                      </TableCell>
                      <TableCell>
                        <Button asChild size="sm" variant="ghost">
                          <Link href={`/activity/runs/${run.id}`}>Open</Link>
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="costs" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Last 30 days</CardTitle>
              <CardDescription>
                {cost.spend.hasEstimates
                  ? 'Some figures are estimates: either the provider did not report token counts, or no price is configured for the model. Configure prices in config/model-prices.json to report real spend.'
                  : 'Actual reported spend.'}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-2xl font-semibold tabular-nums">
                {formatCost(cost.spend.totalUsd, cost.spend.hasEstimates)}
              </p>
              {cost.budgets.length > 0 ? (
                <div className="space-y-1.5">
                  {cost.budgets.map((budget) => (
                    <div key={budget.period} className="text-sm">
                      <div className="flex items-center justify-between">
                        <span>
                          {titleCase(budget.period)} budget{budget.hardStop ? ' (hard stop)' : ' (warn only)'}
                        </span>
                        <span className="tabular-nums">
                          {formatCost(budget.spentUsd, budget.spendIsEstimate)} / $
                          {budget.limitUsd.toFixed(2)}
                        </span>
                      </div>
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                        <div
                          className={budget.exceeded ? 'h-full bg-destructive' : 'h-full bg-primary'}
                          style={{
                            width: `${Math.min(100, (budget.spentUsd / Math.max(budget.limitUsd, 0.01)) * 100)}%`,
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No budget configured.</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">By stage and model</CardTitle>
              <CardDescription>Time and API usage are recorded per pipeline stage.</CardDescription>
            </CardHeader>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Stage</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead>Calls</TableHead>
                  <TableHead>Tokens in / out</TableHead>
                  <TableHead>Searches</TableHead>
                  <TableHead>Cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {usageByStage.map((row, index) => (
                  <TableRow key={index}>
                    <TableCell className="text-sm">{row.stage ?? '—'}</TableCell>
                    <TableCell className="font-mono text-xs">{row.model ?? '—'}</TableCell>
                    <TableCell className="tabular-nums">{row.calls}</TableCell>
                    <TableCell className="tabular-nums text-xs">
                      {formatTokens(row.tokens_in)} / {formatTokens(row.tokens_out)}
                    </TableCell>
                    <TableCell className="tabular-nums">{row.searches}</TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums text-xs">
                      {formatCost(Number(row.cost ?? 0), row.is_estimate)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>

        <TabsContent value="reports" className="space-y-4">
          <ReportPanel timeZone={session.activeWorkspace.timezone} />
          {reports.length > 0 ? (
            <Card>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Changes</TableHead>
                    <TableHead>Generated</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {reports.map((report) => (
                    <TableRow key={report.report_date}>
                      <TableCell className="font-medium">{report.report_date}</TableCell>
                      <TableCell className="tabular-nums">{report.change_count}</TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {formatDateTime(report.generated_at)}
                      </TableCell>
                      <TableCell>
                        {report.storage_path ? (
                          <Button asChild size="sm" variant="ghost">
                            <a
                              href={`/api/files/${report.storage_path.split('/').slice(1).join('/')}`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              <Download />
                              Markdown
                            </a>
                          </Button>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          ) : null}
        </TabsContent>

        <TabsContent value="log">
          <Card>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Action</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Summary</TableHead>
                  <TableHead>When</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {activity.map((entry) => (
                  <TableRow key={entry.id}>
                    <TableCell className="font-mono text-xs">{entry.action}</TableCell>
                    <TableCell className="text-xs">
                      {entry.actor_email ?? titleCase(entry.actor_kind)}
                    </TableCell>
                    <TableCell className="max-w-lg text-sm text-muted-foreground">
                      {entry.summary ?? '—'}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {formatRelative(entry.created_at)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
