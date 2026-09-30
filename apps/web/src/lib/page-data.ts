/**
 * Server-side data for the six main screens.
 *
 * Kept free of Next.js imports so the same code can be timed outside the app.
 * Every loader takes the resolved session: user-facing reads run with RLS for
 * that user (withUser), and the few service-role reads are scoped by the
 * session's active workspace, which never comes from the client.
 *
 * Latency: against the Supabase pooler every statement is a ~100 ms round trip
 * and one transaction holds one connection, so N reads in one transaction cost
 * N round trips back to back. Independent reads are therefore split into a few
 * transactions that run concurrently (at most three per screen plus two for
 * the header, so one navigation stays within the connection pool). Each
 * transaction still runs with the same RLS identity, and all of them are READ
 * ONLY (withUserRead / withServiceRead): a page load cannot write, and does not
 * wait for the COMMIT round trip.
 */
import {
  budgetStates,
  listActivity,
  listFormats,
  reportDayBounds,
  todayInZone,
  withServiceRead,
  withUserRead,
  workspaceCostSummary,
} from '@g3/core';
import type { Session } from '@g3/shared';

export interface BriefRow {
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

export interface BriefRunRow {
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

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * Header data shown on every screen: 30-day spend and budget states. Two
 * independent reads, run concurrently.
 */
export async function loadLayoutData(session: Session) {
  const workspaceId = session.activeWorkspace.workspaceId;
  const [spend, budgets, counts] = await Promise.all([
    withServiceRead((db) => workspaceCostSummary(db, workspaceId, 30)),
    withServiceRead((db) => budgetStates(db, workspaceId)),
    loadNavCounts(session),
  ]);
  return { spend, budgets, counts };
}

/**
 * Counts shown next to menu items, only when something is waiting for a person:
 * proposals with changes awaiting review. Read with the user's own access rules.
 */
export async function loadNavCounts(session: Session) {
  const workspaceId = session.activeWorkspace.workspaceId;
  return withUserRead(session.user.id, (db) =>
    db.oneOrFail<{ review: number }>(
      `select count(distinct i.proposal_id)::int as review
         from public.proposal_items i
         join public.proposals p on p.id = i.proposal_id
        where p.workspace_id = $1
          and p.status in ('pending_review', 'partially_applied')
          and i.decision = 'pending' and i.applied_at is null`,
      [workspaceId],
    ),
  );
}

// ---------------------------------------------------------------------------
// Today
// ---------------------------------------------------------------------------

export interface TodayDecision {
  id: string;
  title: string;
  is_mock: boolean;
  created_at: string;
  capture_id: string | null;
  source_kind: string;
  awaiting: number;
  approved_unsaved: number;
}

export interface TodayRun {
  id: string;
  kind: string;
  status: string;
  progress: number;
  current_stage: string | null;
  is_mock: boolean;
  created_at: string;
  capture_id: string | null;
  capture_kind: string | null;
  capture_status: string | null;
  target_label: string | null;
}

export interface TodaySaved {
  id: string;
  applied_at: string;
  op: string;
  table_name: string;
  row_id: string;
  label: string;
  entity_type: string | null;
  proposal_id: string;
  proposal_title: string;
  total: number;
}

/**
 * The home screen: what is waiting for approval, what is being analysed, and
 * what was saved -- today in the workspace timezone, and most recently overall.
 * Read-only, under the user's own access rules. Shared by the web home page and
 * the mobile API, so both clients show the same queue.
 */
export async function loadTodayData(session: Session) {
  const workspaceId = session.activeWorkspace.workspaceId;
  const timeZone = session.activeWorkspace.timezone;
  const today = todayInZone(timeZone);
  const { startIso, endIso } = reportDayBounds(today, timeZone);

  const [queue, activity] = await Promise.all([
    withUserRead(session.user.id, async (db) => ({
      // One statement: the newest proposals waiting for a decision, and -- via
      // window functions computed before the limit -- how many proposals and
      // changes are waiting in total.
      decisions: await db.rows<TodayDecision & { total_proposals: number; total_changes: number }>(
        `with waiting as (
           select p.id, p.title, p.is_mock, p.created_at, p.source_kind, cap.id as capture_id,
                  count(*) filter (where i.decision = 'pending' and i.applied_at is null)::int as awaiting,
                  count(*) filter (where i.decision = 'approved' and i.applied_at is null)::int as approved_unsaved
             from public.proposals p
             join public.proposal_items i on i.proposal_id = p.id
             left join public.captures cap on cap.proposal_id = p.id
            where p.workspace_id = $1 and p.status in ('pending_review', 'partially_applied')
            group by p.id, cap.id
           having count(*) filter (where i.applied_at is null and i.decision in ('pending', 'approved')) > 0
         )
         select w.*,
                (count(*) filter (where w.awaiting > 0) over ())::int as total_proposals,
                (sum(w.awaiting) over ())::int as total_changes
           from waiting w
          order by w.created_at desc
          limit 6`,
        [workspaceId],
      ),
    })),
    withUserRead(session.user.id, async (db) => ({
      // Only work a person started from the product: captures, and research
      // they explicitly asked for. Historical brief and upload runs stay in
      // Activity but are no longer part of the home queue.
      runs: await db.rows<TodayRun>(
        `select r.id, r.kind, r.status, r.progress, r.current_stage, r.is_mock, r.created_at,
                c.id as capture_id, c.kind as capture_kind, c.status as capture_status,
                (select t.label from public.research_topics t
                  where t.workspace_id = r.workspace_id and t.run_id = r.id limit 1) as target_label
           from public.runs r
           left join public.captures c on c.workspace_id = r.workspace_id and c.run_id = r.id
          where r.workspace_id = $1 and r.kind in ('capture', 'research')
            and (r.kind = 'capture' or (r.input ->> 'requestedExplicitly') = 'true')
            and (r.status in ('queued', 'running')
                 or (r.status = 'failed' and r.created_at >= now() - interval '24 hours'))
          order by r.created_at desc
          limit 8`,
        [workspaceId],
      ),
      saved: await db.rows<TodaySaved>(
        `select c.id, c.applied_at, c.op, c.table_name, c.row_id, i.label,
                coalesce(i.edited_values ->> 'entity_type', i.new_values ->> 'entity_type',
                         i.old_values ->> 'entity_type') as entity_type,
                p.id as proposal_id, p.title as proposal_title,
                count(*) over ()::int as total
           from public.applied_changes c
           join public.proposal_items i on i.id = c.proposal_item_id
           join public.proposals p on p.id = c.proposal_id
          where c.workspace_id = $1 and c.applied_at >= $2::timestamptz and c.applied_at < $3::timestamptz
          order by c.applied_at desc
          limit 12`,
        [workspaceId, startIso, endIso],
      ),
      recent: await db.rows<Omit<TodaySaved, 'total'>>(
        `select c.id, c.applied_at, c.op, c.table_name, c.row_id, i.label,
                coalesce(i.edited_values ->> 'entity_type', i.new_values ->> 'entity_type',
                         i.old_values ->> 'entity_type') as entity_type,
                p.id as proposal_id, p.title as proposal_title
           from public.applied_changes c
           join public.proposal_items i on i.id = c.proposal_item_id
           join public.proposals p on p.id = c.proposal_id
          where c.workspace_id = $1
          order by c.applied_at desc
          limit 8`,
        [workspaceId],
      ),
    })),
  ]);

  const first = queue.decisions[0];
  const awaiting = { proposals: first?.total_proposals ?? 0, changes: first?.total_changes ?? 0 };
  return { today, timeZone, decisions: queue.decisions, awaiting, ...activity };
}

// ---------------------------------------------------------------------------
// Briefs
// ---------------------------------------------------------------------------

export async function loadBriefsData(session: Session) {
  const workspaceId = session.activeWorkspace.workspaceId;
  const [formats, { briefs, activeRuns }] = await Promise.all([
    withServiceRead((db) => listFormats(db, workspaceId)),
    withUserRead(session.user.id, async (db) => ({
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
      activeRuns: await db.rows<BriefRunRow>(
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
    })),
  ]);
  return { formats, briefs, activeRuns };
}

// ---------------------------------------------------------------------------
// Research
// ---------------------------------------------------------------------------

export async function loadResearchData(session: Session) {
  const workspaceId = session.activeWorkspace.workspaceId;
  const [first, second] = await Promise.all([
    withUserRead(session.user.id, async (db) => ({
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
    })),
    withUserRead(session.user.id, async (db) => ({
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
    })),
  ]);
  return { ...first, ...second };
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

export interface ProposalRow {
  id: string;
  title: string;
  summary: string | null;
  status: string;
  version: number;
  source_kind: string;
  is_mock: boolean;
  created_at: string;
  item_count: number;
  pending_count: number;
  approved_count: number;
  applied_count: number;
  ambiguous_count: number;
  brief_title: string | null;
  format_name: string | null;
}

export async function loadReviewData(session: Session) {
  const workspaceId = session.activeWorkspace.workspaceId;
  return withUserRead(session.user.id, (db) =>
    db.rows<ProposalRow>(
      `select p.id, p.title, p.summary, p.status, p.version, p.source_kind, p.is_mock, p.created_at,
              b.title as brief_title, f.name as format_name,
              (select count(*)::int from public.proposal_items i where i.proposal_id = p.id) as item_count,
              (select count(*)::int from public.proposal_items i
                where i.proposal_id = p.id and i.decision = 'pending' and i.applied_at is null) as pending_count,
              (select count(*)::int from public.proposal_items i
                where i.proposal_id = p.id and i.decision = 'approved' and i.applied_at is null) as approved_count,
              (select count(*)::int from public.proposal_items i
                where i.proposal_id = p.id and i.applied_at is not null) as applied_count,
              (select count(*)::int from public.proposal_items i
                where i.proposal_id = p.id and i.match_status = 'ambiguous') as ambiguous_count
         from public.proposals p
         left join public.brief_documents b on b.id = p.brief_document_id
         left join public.brief_formats f on f.id = b.format_id
        where p.workspace_id = $1
          and p.status in ('pending_review', 'partially_applied')
        order by case p.status when 'pending_review' then 0 else 1 end,
                 p.created_at desc
        limit 80`,
      [workspaceId],
    ),
  );
}

// ---------------------------------------------------------------------------
// Knowledge
// ---------------------------------------------------------------------------

export async function loadKnowledgeData(session: Session, search: string) {
  const pattern = search.length > 0 ? `%${search}%` : null;
  const [a, b, c] = await Promise.all([
    withUserRead(session.user.id, async (db) => ({
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
    })),
    withUserRead(session.user.id, async (db) => ({
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
    })),
    withUserRead(session.user.id, async (db) => ({
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
    })),
  ]);
  return { ...a, ...b, ...c };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function loadSettingsData(session: Session) {
  const workspaceId = session.activeWorkspace.workspaceId;
  return withUserRead(session.user.id, async (db) => ({
    budgets: await db.rows<{ period: string; limit_usd: string; hard_stop: boolean }>(
      `select period, limit_usd, hard_stop from public.budgets where workspace_id = $1`,
      [workspaceId],
    ),
    members: await db.rows<{
      email: string;
      display_name: string | null;
      role: string;
      can_approve: boolean;
    }>(
      `select u.email, u.display_name, m.role, m.can_approve
       from public.workspace_members m
       join public.app_users u on u.id = m.user_id
      where m.workspace_id = $1
      order by m.role, u.email`,
      [workspaceId],
    ),
  }));
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

/**
 * Spend and budgets are not loaded here: the layout already reads exactly the
 * same figures for the header, and the page reuses that result (see
 * cached-data.ts) instead of querying them a second time.
 */
export async function loadActivityData(session: Session) {
  const workspaceId = session.activeWorkspace.workspaceId;
  const [a, b] = await Promise.all([
    withUserRead(session.user.id, async (db) => ({
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
        entity_type: string | null;
      }>(
        `select c.id, c.table_name, c.row_id, c.op, c.applied_at, c.readback_ok,
                coalesce(i.edited_values ->> 'entity_type', i.new_values ->> 'entity_type',
                         i.old_values ->> 'entity_type') as entity_type,
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
    })),
    withUserRead(session.user.id, async (db) => ({
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
    })),
  ]);
  return { ...a, ...b };
}
