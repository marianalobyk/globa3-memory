import Link from 'next/link';
import { Telescope } from 'lucide-react';
import { withUser } from '@g3/core';
import { requirePageSession } from '@/lib/session';
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

  const { runs, awaiting, researched } = await withUser(session.user.id, async (db) => ({
    runs: await db.rows<{
      id: string;
      status: string;
      progress: number;
      current_stage: string | null;
      created_at: string;
      is_mock: boolean;
      error: string | null;
      topic_count: number;
      proposal_id: string | null;
      brief_title: string | null;
    }>(
      `select r.id, r.status, r.progress, r.current_stage, r.created_at, r.is_mock, r.error,
              coalesce(jsonb_array_length(r.input -> 'topicIds'), 0) as topic_count,
              (select p.id from public.proposals p where p.run_id = r.id limit 1) as proposal_id,
              (select b.title from public.brief_documents b
                where b.id = (r.input ->> 'briefDocumentId')::uuid) as brief_title
         from public.runs r
        where r.workspace_id = $1 and r.kind = 'research'
        order by r.created_at desc limit 25`,
      [workspaceId],
    ),
    awaiting: await db.rows<{
      id: string;
      label: string;
      target_type: string;
      priority: string;
      resolution_status: string;
      research_question: string | null;
      brief_document_id: string | null;
      brief_title: string | null;
      brief_run_date: string | null;
    }>(
      `select t.id, t.label, t.target_type, t.priority, t.resolution_status, t.research_question,
              t.brief_document_id, b.title as brief_title, b.run_date as brief_run_date
         from public.research_topics t
         left join public.brief_documents b on b.id = t.brief_document_id
        where t.workspace_id = $1 and t.status = 'proposed' and t.priority <> 'skip'
        order by case t.priority when 'high' then 0 when 'medium' then 1 else 2 end,
                 b.run_date desc nulls last, t.label
        limit 60`,
      [workspaceId],
    ),
    researched: await db.rows<{
      id: string;
      label: string;
      target_type: string;
      status: string;
      updated_at: string;
      brief_document_id: string | null;
    }>(
      `select id, label, target_type, status, updated_at, brief_document_id
         from public.research_topics
        where workspace_id = $1 and status in ('researched', 'captured')
        order by updated_at desc limit 25`,
      [workspaceId],
    ),
  }));

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
          Deep research on the targets you choose. It runs in the background, uses the material
          already collected, and ends in proposed changes for you to review — never a direct write.
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
                <Link href="/briefs">Go to Briefs</Link>
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
