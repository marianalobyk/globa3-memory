import Link from 'next/link';
import { Telescope } from 'lucide-react';
import { requirePageSession } from '@/lib/session';
import { loadResearchData } from '@/lib/page-data';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { EmptyState } from '@/components/states';
import { MatchStatusBadge, PriorityBadge, RunStatusBadge } from '@/components/status';
import { formatRelative, titleCase } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export default async function ResearchPage() {
  const session = await requirePageSession();
  const workspaceId = session.activeWorkspace.workspaceId;

  const { runs, awaiting, researched } = await loadResearchData(session);

  // Group the awaiting topics by the brief they came from, since research is
  // started from a brief.
  const byBrief = new Map<string, typeof awaiting>();
  for (const topic of awaiting) {
    const key = topic.brief_document_id ?? 'none';
    const list = byBrief.get(key) ?? [];
    list.push(topic);
    byBrief.set(key, list);
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Research</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Research runs and the targets waiting for a choice. Research always starts from a brief, runs
          in the background and ends in proposed changes awaiting your review — it never saves directly.
        </p>
      </div>

      {runs.length > 0 ? (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Research runs</h2>
          <ul className="space-y-2">
            {runs.map((run) => (
              <li key={run.id} className="rounded-lg border p-3">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <RunStatusBadge status={run.status} isMock={run.is_mock} />
                  <span className="font-medium">
                    {run.topic_count} target{run.topic_count === 1 ? '' : 's'}
                  </span>
                  {run.brief_title ? (
                    <span className="truncate text-muted-foreground">from {run.brief_title}</span>
                  ) : null}
                  <span className="ml-auto text-xs text-muted-foreground">
                    {formatRelative(run.created_at)}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  {run.status === 'running' ? (
                    <span>
                      {run.progress}% — {run.current_stage ?? 'starting'}
                    </span>
                  ) : null}
                  {run.error ? <span className="text-destructive">{run.error}</span> : null}
                  <Button asChild size="sm" variant="ghost">
                    <Link href={`/activity/runs/${run.id}`}>Progress</Link>
                  </Button>
                  {run.proposal_id ? (
                    <Button asChild size="sm" variant="outline">
                      <Link href={`/review/${run.proposal_id}`}>Review proposed changes</Link>
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <Separator />

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Targets awaiting a decision</h2>
        {awaiting.length === 0 ? (
          <EmptyState
            icon={<Telescope className="size-5" />}
            title="No targets waiting"
            description="Research targets are proposed by a brief. Generate or open a brief, then choose which people, companies and projects deserve deep research."
            action={
              <Button asChild variant="outline" size="sm">
                <Link href="/briefs">Go to Sources</Link>
              </Button>
            }
          />
        ) : (
          [...byBrief.entries()].map(([briefId, topics]) => (
            <Card key={briefId}>
              <CardHeader>
                <CardTitle className="text-sm">
                  {topics[0]?.brief_title ?? 'Topics without a brief'}
                  {topics[0]?.brief_run_date ? ` · ${topics[0].brief_run_date}` : ''}
                </CardTitle>
                <CardDescription>
                  {topics.length} target{topics.length === 1 ? '' : 's'} proposed. Choose and start
                  research from the brief, so the research keeps its source context.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-1.5">
                {topics.slice(0, 8).map((topic) => (
                  <div key={topic.id} className="flex flex-wrap items-center gap-1.5 text-sm">
                    <span className="font-medium">{topic.label}</span>
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
                  </div>
                ))}
                {topics.length > 8 ? (
                  <p className="text-xs text-muted-foreground">and {topics.length - 8} more</p>
                ) : null}
                {briefId !== 'none' ? (
                  <div className="pt-2">
                    <Button asChild size="sm">
                      <Link href={`/briefs/${briefId}`}>Choose targets</Link>
                    </Button>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          ))
        )}
      </section>

      {researched.length > 0 ? (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Already researched</h2>
          <ul className="flex flex-wrap gap-1.5">
            {researched.map((topic) => (
              <li key={topic.id}>
                <Badge variant="secondary">
                  {topic.label} · {titleCase(topic.status)}
                </Badge>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
