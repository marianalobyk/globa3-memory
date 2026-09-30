/**
 * "Why does X matter to us?" answered as a short briefing.
 *
 * Built only from approved records, in the order a person reads them:
 *
 *   What we know          what the sources actually state
 *   Why it matters        the reading we drew from it, never stated as fact
 *   What to watch next    the dates and the condition for taking it further
 *   Still unconfirmed     gaps, and concerns that need care
 *
 * No model writes this, so it cannot drift from memory or invent a detail. The
 * records behind it -- their titles, kinds and dates -- stay available for
 * "See source details" and never clutter the answer. Both clients render this
 * same structure, so the phone and the web cannot say different things.
 */
import { slugify } from '@g3/shared';
import { assertScope, type Queryable } from './db.js';

export type BriefingSectionKey = 'known' | 'why' | 'watch' | 'unconfirmed';

export interface BriefingLine {
  text: string;
  /** A short qualifier: "Needs care", "Our reading", a date. Never a table name. */
  note: string | null;
}

export interface SubjectBriefing {
  name: string;
  /** "Head of Drama at Horizon Studios", or what kind of record this is. */
  subtitle: string | null;
  /** The most concrete thing the sources say, as one short paragraph. */
  lead: string | null;
  sections: { key: BriefingSectionKey; heading: string; lines: BriefingLine[] }[];
  /** For "See source details": the records this rests on. */
  sources: { label: string; kind: string; date: string | null }[];
}

const RELATIONSHIP_WORDS: Record<string, string> = {
  contact: 'A contact you have met',
  internal: 'Inside Globa 3',
  partner: 'A partner',
  client: 'A client',
};

/** "26 September 2026" -- never an ISO timestamp. */
function readableDate(value: string | Date | null, timeZone: string): string | null {
  if (!value) return null;
  const at = typeof value === 'string' ? new Date(value.length === 10 ? `${value}T12:00:00Z` : value) : value;
  if (Number.isNaN(at.getTime())) return null;
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone }).format(at);
}

/** The first sentence, so a briefing line stays a line. */
function firstSentence(text: string, limit = 220): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  const stop = clean.search(/\.\s|\.$/);
  const sentence = stop > 40 ? clean.slice(0, stop + 1) : clean;
  return sentence.length > limit ? `${sentence.slice(0, limit - 1).trimEnd()}…` : sentence;
}

/** Keeps each point to one place: the first section that needs it wins. */
function once() {
  const seen = new Set<string>();
  return (text: string): boolean => {
    const key = text.toLowerCase().replace(/[^a-z0-9 ]/g, '').slice(0, 90);
    if (key.length === 0 || seen.has(key)) return false;
    seen.add(key);
    return true;
  };
}

export async function subjectBriefing(
  db: Queryable,
  workspaceId: string,
  query: string,
  options: { timeZone?: string } = {},
): Promise<SubjectBriefing | null> {
  assertScope(workspaceId, 'subjectBriefing');
  const timeZone = options.timeZone || 'UTC';
  const name = query.trim();
  if (name.length < 2) return null;
  const slug = slugify(name);
  if (!slug) return null;

  const subject = await db.one<{ id: string; display_name: string; entity_type: string; relationship_status: string | null }>(
    `select e.id, e.display_name, e.entity_type, e.relationship_status
       from public.entities e
      where e.workspace_id = $1
        and (e.slug = $2 or exists (
          select 1 from public.entity_aliases a
           where a.workspace_id = e.workspace_id and a.entity_id = e.id and a.alias_slug = $2))
      limit 1`,
    [workspaceId, slug],
  );
  if (!subject) return null;

  const [roles, interactions, signals, actions, findings, ideas, details, sources] = await Promise.all([
    db.rows<{ role_title: string | null; organization: string }>(
      `select a.role_title, o.display_name as organization
         from public.entity_affiliations a
         join public.entities o on o.id = a.organization_entity_id
        where a.workspace_id = $1 and a.person_entity_id = $2 and a.is_current
        order by a.updated_at desc limit 2`,
      [workspaceId, subject.id],
    ),
    db.rows<{ subject: string; summary: string | null; occurred_at: string | null }>(
      `select subject, summary, occurred_at from public.interactions
        where workspace_id = $1 and external_entity_id = $2
        order by occurred_at desc nulls last limit 3`,
      [workspaceId, subject.id],
    ),
    // A signal reaches a subject directly or through the entities it names.
    db.rows<{
      title: string;
      description: string | null;
      why_it_matters: string | null;
      decision_question: string | null;
      recommended_next_step: string | null;
      promotion_trigger: string | null;
      original_claim: string | null;
      status: string | null;
      signal_date: string | null;
    }>(
      `select distinct s.title, s.description, s.why_it_matters, s.decision_question, s.recommended_next_step,
              s.promotion_trigger, s.original_claim, s.status, s.signal_date
         from public.signals s
         left join public.signal_entities se on se.signal_id = s.id
        where s.workspace_id = $1 and (s.related_entity_id = $2 or se.entity_id = $2)
        order by s.signal_date desc nulls last limit 4`,
      [workspaceId, subject.id],
    ),
    db.rows<{ title: string; description: string | null; due_at: string | null; action_type: string | null }>(
      `select title, description, due_at, action_type from public.actions
        where workspace_id = $1 and related_entity_id = $2 and status not in ('done', 'cancelled')
        order by due_at nulls last limit 4`,
      [workspaceId, subject.id],
    ),
    db.rows<{ finding_type: string; title: string; content: string | null }>(
      `select finding_type, title, content from public.research_findings
        where workspace_id = $1 and related_entity_id = $2
          and finding_type in ('fact', 'inference', 'gap', 'risk', 'recommendation')
        order by case finding_type when 'fact' then 0 when 'inference' then 1 when 'risk' then 2 when 'gap' then 3 else 4 end,
                 created_at desc
        limit 12`,
      [workspaceId, subject.id],
    ),
    db.rows<{ title: string; stage: string | null; opportunity_type: string | null }>(
      `select title, stage, opportunity_type from public.opportunities
        where workspace_id = $1 and related_entity_id = $2 order by created_at desc limit 2`,
      [workspaceId, subject.id],
    ),
    db.rows<{ alias_type: string }>(
      `select alias_type from public.entity_aliases
        where workspace_id = $1 and entity_id = $2 and alias_type in ('email', 'phone', 'linkedin')`,
      [workspaceId, subject.id],
    ),
    db.rows<{ label: string; kind: string; date: string | null }>(
      `select e.title as label, 'Source' as kind, e.source_date::text as date
         from public.evidence e
        where e.workspace_id = $1
          and (exists (select 1 from public.research_findings f where f.evidence_id = e.id and f.related_entity_id = $2)
            -- Every source a finding cites, not only the one it was written
            -- from. Research routinely rests a single statement on several
            -- sources, and a briefing that named one of them would be quietly
            -- under-citing its own evidence.
            or exists (select 1 from public.research_finding_evidence fe
                         join public.research_findings f2 on f2.id = fe.finding_id
                        where fe.evidence_id = e.id and f2.related_entity_id = $2)
            or exists (select 1 from public.interactions i where i.evidence_id = e.id and i.external_entity_id = $2)
            or exists (select 1 from public.signals s left join public.signal_entities se on se.signal_id = s.id
                        where s.evidence_id = e.id and (s.related_entity_id = $2 or se.entity_id = $2)))
       union all
       select a.title, 'Research document', a.created_at::date::text
         from public.research_artifacts a
        where a.workspace_id = $1
          and exists (select 1 from public.research_findings f where f.artifact_id = a.id and f.related_entity_id = $2)
        limit 8`,
      [workspaceId, subject.id],
    ),
  ]);

  const used = once();
  const facts = findings.filter((f) => f.finding_type === 'fact');
  const readings = findings.filter((f) => f.finding_type === 'inference');
  const gaps = findings.filter((f) => f.finding_type === 'gap');
  const risks = findings.filter((f) => f.finding_type === 'risk');
  const body = (finding: { title: string; content: string | null }) =>
    firstSentence((finding.content ?? finding.title).split('\n\n')[0] ?? finding.title);

  // -- The lead: the most concrete thing a source states -------------------
  const leadCandidates = [
    ...facts.map((f) => body(f)),
    ...signals.map((s) => (s.description ? firstSentence(s.description) : null)),
    ...signals.map((s) => (s.original_claim ? firstSentence(s.original_claim) : null)),
    ...interactions.map((i) => (i.summary ? firstSentence(i.summary) : null)),
  ].filter((line): line is string => Boolean(line));
  const lead = leadCandidates[0] ?? null;
  if (lead) used(lead);

  // -- What we know --------------------------------------------------------
  const known: BriefingLine[] = [];
  for (const finding of facts) {
    const text = body(finding);
    if (used(text)) known.push({ text, note: null });
  }
  for (const signal of signals) {
    for (const candidate of [signal.description, signal.original_claim]) {
      if (!candidate) continue;
      const text = firstSentence(candidate);
      if (used(text)) known.push({ text, note: null });
    }
  }
  for (const interaction of interactions) {
    const text = interaction.summary ? firstSentence(interaction.summary) : interaction.subject;
    if (used(text)) known.push({ text, note: readableDate(interaction.occurred_at, timeZone) });
  }

  // -- Why it matters ------------------------------------------------------
  const why: BriefingLine[] = [];
  for (const signal of signals) {
    if (signal.why_it_matters) {
      const text = firstSentence(signal.why_it_matters);
      if (used(text)) why.push({ text, note: 'Our reading' });
    }
  }
  for (const reading of readings) {
    const text = body(reading);
    if (used(text)) why.push({ text, note: 'Our reading' });
  }
  // A possibility must never read as a plan. Said once, plainly.
  const possibility = ideas.find((i) => i.opportunity_type === 'hypothesis' || i.stage === 'idea');
  const watching = signals.some((s) => (s.status ?? '') === 'watch');
  if (possibility) {
    why.push({ text: `A possible direction, not a confirmed initiative: ${firstSentence(possibility.title)}`, note: 'Unvalidated' });
  } else if (watching && (gaps.length > 0 || risks.length > 0)) {
    why.push({ text: 'This is a possibility we are watching, not a confirmed or launched initiative.', note: 'Unvalidated' });
  }
  for (const signal of signals) {
    if (signal.decision_question) {
      const text = firstSentence(signal.decision_question);
      if (used(text)) why.push({ text, note: 'The question to answer' });
    }
  }

  // -- What to watch next --------------------------------------------------
  const watch: BriefingLine[] = [];
  for (const action of actions) {
    const when = readableDate(action.due_at, timeZone);
    const title = action.title.replace(/^Watch:\s*/i, '');
    if (used(title)) watch.push({ text: title, note: when ? (action.action_type === 'watch' ? `Watch ${when}` : `By ${when}`) : null });
    // The document's own condition, kept in its words under a plain label.
    const condition = (action.description ?? '').split('\n\n').find((part) => /^promote only if:/i.test(part.trim()));
    if (condition) {
      const text = firstSentence(condition.trim().replace(/^promote only if:\s*/i, ''));
      if (used(text)) watch.push({ text, note: 'Condition to take it further' });
    }
  }
  for (const signal of signals) {
    for (const candidate of [signal.recommended_next_step, signal.promotion_trigger]) {
      if (!candidate) continue;
      const text = firstSentence(candidate);
      if (used(text)) watch.push({ text, note: null });
    }
  }

  // -- Still unconfirmed ---------------------------------------------------
  const unconfirmed: BriefingLine[] = [];
  for (const risk of risks) {
    const text = body(risk);
    if (used(text)) unconfirmed.push({ text, note: 'Needs care' });
  }
  for (const gap of gaps) {
    const text = body(gap);
    if (used(text)) unconfirmed.push({ text, note: null });
  }
  if (subject.entity_type === 'person' && details.length === 0 && interactions.length > 0) {
    unconfirmed.push({ text: 'How to reach them directly.', note: null });
  }

  const role = roles.find((r) => r.role_title) ?? roles[0] ?? null;
  const subtitle =
    (role ? (role.role_title ? `${role.role_title} at ${role.organization}` : `Works at ${role.organization}`) : null) ??
    RELATIONSHIP_WORDS[subject.relationship_status ?? ''] ??
    (signals.length > 0 ? 'From your research documents' : null);

  // The audience is named only when the material itself names it.
  const mentionsAmv = [...signals.map((s) => `${s.why_it_matters ?? ''} ${s.description ?? ''}`), ...sources.map((s) => s.label)]
    .join(' ')
    .includes('AMV');

  const sections = [
    { key: 'known' as const, heading: 'What we know', lines: known },
    { key: 'why' as const, heading: mentionsAmv ? 'Why it matters to AMV' : 'Why it matters', lines: why },
    { key: 'watch' as const, heading: 'What to watch next', lines: watch },
    { key: 'unconfirmed' as const, heading: 'Still unconfirmed', lines: unconfirmed },
  ].filter((section) => section.lines.length > 0);

  if (!lead && sections.length === 0) return null;

  return {
    name: subject.display_name,
    subtitle,
    lead,
    sections,
    sources: sources.map((source) => ({ label: source.label, kind: source.kind, date: readableDate(source.date, timeZone) })),
  };
}
