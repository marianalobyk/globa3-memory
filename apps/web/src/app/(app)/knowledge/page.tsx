import Link from 'next/link';
import { BookOpen, HelpCircle } from 'lucide-react';
import { withUser } from '@g3/core';
import { requirePageSession } from '@/lib/session';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState } from '@/components/states';
import { ClaimTypeBadge, ConfidenceBadge } from '@/components/status';
import { AskKnowledge } from '@/components/ask-knowledge';
import { formatDateTime, titleCase, truncate } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export default async function KnowledgePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const session = await requirePageSession();
  const workspaceId = session.activeWorkspace.workspaceId;
  const { q } = await searchParams;
  const search = (q ?? '').trim();
  const pattern = search.length > 0 ? `%${search}%` : null;

  const data = await withUser(session.user.id, async (db) => ({
    counts: await db.oneOrFail<{
      entities: number;
      findings: number;
      signals: number;
      interactions: number;
      actions: number;
      evidence: number;
      mentions: number;
      affiliations: number;
      business_units: number;
    }>(
      `select
         (select count(*)::int from public.entities) as entities,
         (select count(*)::int from public.research_findings) as findings,
         (select count(*)::int from public.signals) as signals,
         (select count(*)::int from public.interactions) as interactions,
         (select count(*)::int from public.actions) as actions,
         (select count(*)::int from public.evidence) as evidence,
         (select count(*)::int from public.entity_mentions where resolution_status = 'pending') as mentions,
         (select count(*)::int from public.entity_affiliations) as affiliations,
         (select count(*)::int from public.business_units) as business_units`,
    ),
    entities: await db.rows<{
      id: string;
      display_name: string;
      entity_type: string;
      description: string | null;
      research_status: string | null;
      relationship_status: string | null;
      updated_at: string;
      affiliation_count: number;
      finding_count: number;
    }>(
      `select e.id, e.display_name, e.entity_type, e.description, e.research_status,
              e.relationship_status, e.updated_at,
              (select count(*)::int from public.entity_affiliations a
                where a.person_entity_id = e.id or a.organization_entity_id = e.id) as affiliation_count,
              (select count(*)::int from public.research_findings f where f.related_entity_id = e.id) as finding_count
         from public.entities e
        where ($1::text is null or e.display_name ilike $1 or coalesce(e.description,'') ilike $1)
        order by e.updated_at desc limit 60`,
      [pattern],
    ),
    findings: await db.rows<{
      id: string;
      title: string;
      content: string;
      finding_type: string;
      confidence: string | null;
      created_at: string;
      entity_name: string | null;
      url: string | null;
      business_unit: string | null;
    }>(
      `select f.id, f.title, f.content, f.finding_type, f.confidence, f.created_at,
              e.display_name as entity_name, ev.url, bu.name as business_unit
         from public.research_findings f
         left join public.entities e on e.id = f.related_entity_id
         left join public.evidence ev on ev.id = f.evidence_id
         left join public.business_units bu on bu.id = f.business_unit_id
        where ($1::text is null or f.title ilike $1 or f.content ilike $1
               or coalesce(e.display_name,'') ilike $1)
        order by f.created_at desc limit 60`,
      [pattern],
    ),
    signals: await db.rows<{
      id: string;
      title: string;
      why_it_matters: string | null;
      decision_question: string | null;
      status: string;
      signal_date: string | null;
      entity_name: string | null;
      business_unit: string | null;
    }>(
      `select s.id, s.title, s.why_it_matters, s.decision_question, s.status, s.signal_date,
              e.display_name as entity_name, bu.name as business_unit
         from public.signals s
         left join public.entities e on e.id = s.related_entity_id
         left join public.business_units bu on bu.id = s.business_unit_id
        where ($1::text is null or s.title ilike $1 or coalesce(s.why_it_matters,'') ilike $1)
        order by s.created_at desc limit 40`,
      [pattern],
    ),
    mentions: await db.rows<{
      id: string;
      mention_text: string;
      proposed_entity_type: string | null;
      resolution_status: string;
      rationale: string | null;
      created_from: string | null;
      candidate_name: string | null;
    }>(
      `select m.id, m.mention_text, m.proposed_entity_type, m.resolution_status, m.rationale,
              m.created_from, e.display_name as candidate_name
         from public.entity_mentions m
         left join public.entities e on e.id = m.candidate_entity_id
        where m.resolution_status = 'pending'
          and ($1::text is null or m.mention_text ilike $1)
        order by m.created_at desc limit 60`,
      [pattern],
    ),
    units: await db.rows<{
      id: string;
      name: string;
      type: string | null;
      summary: string | null;
      finding_count: number;
      signal_count: number;
    }>(
      `select b.id, b.name, b.type, b.summary,
              (select count(*)::int from public.research_findings f where f.business_unit_id = b.id) as finding_count,
              (select count(*)::int from public.signals s where s.business_unit_id = b.id) as signal_count
         from public.business_units b
        order by b.name`,
    ),
  }));

  const { counts, entities, findings, signals, mentions, units } = data;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Knowledge</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Everything approved into this workspace. Ask Knowledge answers only from these records and
          cites them; Research &amp; Update is where new information comes from.
        </p>
      </div>

      <AskKnowledge />

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5 [&>*]:min-w-0">
        {[
          { label: 'Entities', value: counts.entities },
          { label: 'Findings', value: counts.findings },
          { label: 'Signals', value: counts.signals },
          { label: 'Affiliations', value: counts.affiliations },
          { label: 'Evidence', value: counts.evidence },
          { label: 'Interactions', value: counts.interactions },
          { label: 'Actions', value: counts.actions },
          { label: 'Business units', value: counts.business_units },
          { label: 'Unresolved mentions', value: counts.mentions },
        ].map((stat) => (
          <div key={stat.label} className="rounded-lg border p-3">
            <p className="text-lg font-semibold tabular-nums">{stat.value}</p>
            <p className="text-xs text-muted-foreground">{stat.label}</p>
          </div>
        ))}
      </div>

      <form method="get" className="flex gap-2">
        <input
          type="search"
          name="q"
          defaultValue={search}
          placeholder="Search entities, findings, signals and mentions"
          className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <button
          type="submit"
          className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
        >
          Search
        </button>
      </form>

      <Tabs defaultValue="entities">
        <TabsList className="flex-wrap">
          <TabsTrigger value="entities">Entities ({entities.length})</TabsTrigger>
          <TabsTrigger value="findings">Findings ({findings.length})</TabsTrigger>
          <TabsTrigger value="signals">Signals ({signals.length})</TabsTrigger>
          <TabsTrigger value="mentions">Unresolved ({mentions.length})</TabsTrigger>
          <TabsTrigger value="units">Business units ({units.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="entities">
          {entities.length === 0 ? (
            <EmptyState
              icon={<BookOpen className="size-5" />}
              title="No entities yet"
              description="People, companies, projects and events appear here once you approve them from a proposal. A person can be stored long before any contact exists."
            />
          ) : (
            <Card>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Linked</TableHead>
                    <TableHead>Updated</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {entities.map((entity) => (
                    <TableRow key={entity.id}>
                      <TableCell className="max-w-sm">
                        <p className="font-medium">{entity.display_name}</p>
                        {entity.description ? (
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {truncate(entity.description, 160)}
                          </p>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{titleCase(entity.entity_type)}</Badge>
                      </TableCell>
                      <TableCell className="space-x-1 whitespace-nowrap">
                        {entity.research_status ? (
                          <Badge variant="secondary">{titleCase(entity.research_status)}</Badge>
                        ) : null}
                        {entity.relationship_status && entity.relationship_status !== 'none' ? (
                          <Badge variant="default">{titleCase(entity.relationship_status)}</Badge>
                        ) : (
                          <Badge variant="muted">No relationship</Badge>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {entity.affiliation_count} affiliation(s)
                        <br />
                        {entity.finding_count} finding(s)
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {formatDateTime(entity.updated_at)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="findings">
          {findings.length === 0 ? (
            <EmptyState
              title="No findings yet"
              description="Facts, inferences, recommendations, risks and gaps appear here after approval, each keeping its type, confidence and source."
            />
          ) : (
            <ul className="space-y-2">
              {findings.map((finding) => (
                <li key={finding.id} className="rounded-lg border p-3">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <ClaimTypeBadge type={finding.finding_type} />
                    <ConfidenceBadge confidence={finding.confidence} />
                    {finding.entity_name ? (
                      <Badge variant="secondary">{finding.entity_name}</Badge>
                    ) : null}
                    {finding.business_unit ? (
                      <Badge variant="outline">{finding.business_unit}</Badge>
                    ) : null}
                    <span className="ml-auto text-xs text-muted-foreground">
                      {formatDateTime(finding.created_at)}
                    </span>
                  </div>
                  <p className="mt-1.5 text-sm font-medium">{finding.title}</p>
                  <p className="mt-1 text-sm text-muted-foreground">{finding.content}</p>
                  {finding.url ? (
                    <a
                      href={finding.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="mt-1 inline-block break-all text-xs underline underline-offset-2"
                    >
                      {finding.url}
                    </a>
                  ) : (
                    <p className="mt-1 text-xs text-muted-foreground">No source recorded.</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </TabsContent>

        <TabsContent value="signals">
          {signals.length === 0 ? (
            <EmptyState
              title="No signals yet"
              description="A signal records why a person, company, project or topic entered the system, and what would promote it from watch to action."
            />
          ) : (
            <ul className="space-y-2">
              {signals.map((signal) => (
                <li key={signal.id} className="rounded-lg border p-3">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant={signal.status === 'watch' ? 'outline' : 'default'}>
                      {titleCase(signal.status)}
                    </Badge>
                    {signal.entity_name ? (
                      <Badge variant="secondary">{signal.entity_name}</Badge>
                    ) : null}
                    {signal.business_unit ? (
                      <Badge variant="outline">{signal.business_unit}</Badge>
                    ) : null}
                    {signal.signal_date ? (
                      <span className="text-xs text-muted-foreground">{signal.signal_date}</span>
                    ) : null}
                  </div>
                  <p className="mt-1.5 text-sm font-medium">{signal.title}</p>
                  {signal.why_it_matters ? (
                    <p className="mt-1 text-sm text-muted-foreground">
                      <span className="font-medium">Why it matters: </span>
                      {signal.why_it_matters}
                    </p>
                  ) : null}
                  {signal.decision_question ? (
                    <p className="mt-1 text-sm text-muted-foreground">
                      <span className="font-medium">Decision: </span>
                      {signal.decision_question}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </TabsContent>

        <TabsContent value="mentions">
          {mentions.length === 0 ? (
            <EmptyState
              icon={<HelpCircle className="size-5" />}
              title="No unresolved mentions"
              description="Names that appear in material but cannot be matched with confidence are staged here instead of being created or merged silently."
            />
          ) : (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Names awaiting a human decision</CardTitle>
                <CardDescription>
                  Each of these appeared in a brief or in research without resolving to a stored
                  record. They are kept visible rather than dropped, and nothing was merged.
                </CardDescription>
              </CardHeader>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Mention</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Closest match</TableHead>
                    <TableHead>Why unresolved</TableHead>
                    <TableHead>From</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {mentions.map((mention) => (
                    <TableRow key={mention.id}>
                      <TableCell className="font-medium">{mention.mention_text}</TableCell>
                      <TableCell>
                        <Badge variant="outline">
                          {titleCase(mention.proposed_entity_type ?? 'unknown')}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm">{mention.candidate_name ?? '—'}</TableCell>
                      <TableCell className="max-w-md text-xs text-muted-foreground">
                        {mention.rationale ?? '—'}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {mention.created_from ?? '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="units">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Business units</CardTitle>
              <CardDescription>
                The existing internal structure. Proposed records link to these rather than creating
                a parallel hierarchy.
              </CardDescription>
            </CardHeader>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Unit</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Linked knowledge</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {units.map((unit) => (
                  <TableRow key={unit.id}>
                    <TableCell className="max-w-md">
                      <p className="font-medium">{unit.name}</p>
                      {unit.summary ? (
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {truncate(unit.summary, 200)}
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      {unit.type ? <Badge variant="outline">{titleCase(unit.type)}</Badge> : '—'}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {unit.finding_count} finding(s), {unit.signal_count} signal(s)
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>
      </Tabs>

      <p className="text-xs text-muted-foreground">
        Looking for something that is not here?{' '}
        <Link href="/briefs" className="underline underline-offset-2">
          Research &amp; Update
        </Link>{' '}
        searches for new information and prepares changes for approval.
      </p>
    </div>
  );
}
