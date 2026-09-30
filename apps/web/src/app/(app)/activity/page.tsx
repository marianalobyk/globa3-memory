import Link from 'next/link';
import { Activity as ActivityIcon, Download } from 'lucide-react';
import { requirePageSession } from '@/lib/session';
import { CLAIM_MEANING, opVerb, recordKind } from '@/lib/labels';
import { loadActivityData } from '@/lib/page-data';
import { getLayoutData } from '@/lib/cached-data';
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

  const [{ runs, changes, activity, reports, usageByStage }, cost] = await Promise.all([
    loadActivityData(session),
    getLayoutData(session),
  ]);

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
              description="Changes appear here once they are approved and saved. Nothing reaches knowledge any other way."
            />
          ) : (
            <Card>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Record</TableHead>
                    <TableHead>Kind</TableHead>
                    <TableHead>Approved by</TableHead>
                    <TableHead>Saved by</TableHead>
                    <TableHead>Stored as approved</TableHead>
                    <TableHead>From proposal</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {changes.map((change) => (
                    <TableRow key={change.id}>
                      <TableCell className="max-w-xs">
                        <p className="font-medium">{change.label}</p>
                        <p className="text-xs text-muted-foreground">
                          {opVerb(change.op)}
                          {change.claim_type ? ` · ${CLAIM_MEANING[change.claim_type]?.label ?? change.claim_type}` : ''} ·{' '}
                          {formatRelative(change.applied_at)}
                        </p>
                      </TableCell>
                      <TableCell className="text-xs">
                        {recordKind(change.table_name, { entity_type: change.entity_type })}
                      </TableCell>
                      <TableCell className="text-xs">{change.approved_by ?? '—'}</TableCell>
                      <TableCell className="text-xs">{change.applied_by ?? '—'}</TableCell>
                      <TableCell>
                        <Badge variant={change.readback_ok ? 'success' : 'destructive'}>
                          {change.readback_ok ? 'Yes' : 'Check'}
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
            <EmptyState title="Nothing analysed yet" description="Capture a note and its analysis appears here." />
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
