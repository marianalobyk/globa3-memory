/**
 * Ask Knowledge.
 *
 * Answers only from records already saved in this workspace, and cites the exact
 * rows it used. No web search, no model-supplied facts: retrieval happens in SQL,
 * and the model's job is to compose an answer over the retrieved rows and to say
 * what the stored data does not cover.
 *
 * This is the counterpart to Research & Update, which is the path that looks for
 * new information and prepares changes for approval.
 */
import { AskAnswer, normalizeName } from '@g3/shared';
import { getAiProvider, models, type AiProvider } from '../ai/index.js';
import { recordUsage } from '../costs.js';
import { assertScope, withService, type Queryable } from './../db.js';
import { baseSystemPrompt } from '../prompt.js';

export interface RetrievedRecord {
  table: string;
  rowId: string;
  label: string;
  body: string;
  extra: Record<string, unknown>;
}

/** Turns a question into tokens worth matching, dropping stopwords. */
const STOPWORDS = new Set([
  'what', 'who', 'when', 'where', 'which', 'why', 'how', 'do', 'does', 'did', 'is', 'are', 'was',
  'were', 'the', 'a', 'an', 'of', 'for', 'to', 'in', 'on', 'about', 'with', 'and', 'or', 'we',
  'our', 'know', 'have', 'has', 'any', 'tell', 'me', 'show', 'from', 'that', 'this', 'there',
  'their', 'it', 'its', 'be', 'been', 'can', 'could', 'should', 'would', 'you', 'your',
]);

export function questionTerms(question: string): string[] {
  return [
    ...new Set(
      normalizeName(question)
        .split(' ')
        .filter((t) => t.length > 2 && !STOPWORDS.has(t)),
    ),
  ].slice(0, 12);
}

/**
 * How many distinct question terms a record must match to be retrieved.
 *
 * SQL fetches candidates with an OR across terms, which on its own is far too
 * loose: one shared common word ("holdings") would drag in an unrelated record
 * and make the answer look informed about something the knowledge base has
 * nothing on. So candidates are then scored by how many distinct terms they
 * match, and thin matches are dropped rather than answered over.
 */
function requiredTermMatches(termCount: number): number {
  if (termCount <= 1) return 1;
  if (termCount === 2) return 2;
  // For longer questions, demand a real overlap but not every word.
  return Math.max(2, Math.ceil(termCount * 0.4));
}

function countMatchedTerms(record: RetrievedRecord, terms: string[]): number {
  const haystack = normalizeName(`${record.label} ${record.body}`);
  let matched = 0;
  for (const term of terms) if (haystack.includes(term)) matched += 1;
  return matched;
}

/**
 * Retrieval across the knowledge tables, workspace-scoped.
 *
 * Uses ILIKE over the terms rather than a vector index: the corpus is small, the
 * behaviour is identical on Supabase and on a local test database, and the
 * matched rows can be cited exactly.
 *
 * Returns results ranked by term overlap, with weak matches removed, so an
 * answer is either grounded in genuinely relevant records or empty.
 */
export async function retrieveRecords(
  db: Queryable,
  workspaceId: string,
  question: string,
  limitPerTable = 8,
): Promise<RetrievedRecord[]> {
  assertScope(workspaceId, 'retrieveRecords');
  const terms = questionTerms(question);
  if (terms.length === 0) return [];
  const patterns = terms.map((t) => `%${t}%`);

  const records: RetrievedRecord[] = [];

  const entities = await db.rows<{
    id: string;
    display_name: string;
    entity_type: string;
    description: string | null;
    research_status: string | null;
    relationship_status: string | null;
  }>(
    `select id, display_name, entity_type, description, research_status, relationship_status
       from public.entities
      where workspace_id = $1
        and (display_name ilike any($2) or coalesce(description,'') ilike any($2))
      order by updated_at desc limit $3`,
    [workspaceId, patterns, limitPerTable],
  );
  for (const e of entities) {
    records.push({
      table: 'entities',
      rowId: e.id,
      label: e.display_name,
      body: [
        `Type: ${e.entity_type}`,
        e.description ? `Description: ${e.description}` : null,
        `Research status: ${e.research_status ?? 'unknown'}`,
        `Relationship status: ${e.relationship_status ?? 'unknown'}`,
      ]
        .filter(Boolean)
        .join('\n'),
      extra: { entityType: e.entity_type },
    });
  }

  const findings = await db.rows<{
    id: string;
    title: string;
    content: string;
    finding_type: string;
    confidence: string | null;
    entity_name: string | null;
    url: string | null;
    source_date: string | null;
  }>(
    `select f.id, f.title, f.content, f.finding_type, f.confidence,
            e.display_name as entity_name, ev.url, ev.source_date
       from public.research_findings f
       left join public.entities e on e.id = f.related_entity_id
       left join public.evidence ev on ev.id = f.evidence_id
      where f.workspace_id = $1
        and (f.title ilike any($2) or f.content ilike any($2) or coalesce(e.display_name,'') ilike any($2))
      order by f.created_at desc limit $3`,
    [workspaceId, patterns, limitPerTable * 2],
  );
  for (const f of findings) {
    records.push({
      table: 'research_findings',
      rowId: f.id,
      label: f.title,
      body: [
        `Type: ${f.finding_type}`,
        f.confidence ? `Confidence: ${f.confidence}` : null,
        f.entity_name ? `About: ${f.entity_name}` : null,
        f.url ? `Source: ${f.url}${f.source_date ? ` (${f.source_date})` : ''}` : 'Source: not recorded',
        '',
        f.content,
      ]
        .filter((l) => l !== null)
        .join('\n'),
      extra: { findingType: f.finding_type, confidence: f.confidence },
    });
  }

  const signals = await db.rows<{
    id: string;
    title: string;
    why_it_matters: string | null;
    decision_question: string | null;
    status: string;
    signal_date: string | null;
    entity_name: string | null;
  }>(
    `select s.id, s.title, s.why_it_matters, s.decision_question, s.status, s.signal_date,
            e.display_name as entity_name
       from public.signals s
       left join public.entities e on e.id = s.related_entity_id
      where s.workspace_id = $1
        and (s.title ilike any($2) or coalesce(s.why_it_matters,'') ilike any($2)
             or coalesce(e.display_name,'') ilike any($2))
      order by s.created_at desc limit $3`,
    [workspaceId, patterns, limitPerTable],
  );
  for (const s of signals) {
    records.push({
      table: 'signals',
      rowId: s.id,
      label: s.title,
      body: [
        `Status: ${s.status}`,
        s.signal_date ? `Signal date: ${s.signal_date}` : null,
        s.entity_name ? `About: ${s.entity_name}` : null,
        s.why_it_matters ? `Why it matters: ${s.why_it_matters}` : null,
        s.decision_question ? `Decision question: ${s.decision_question}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
      extra: {},
    });
  }

  const interactions = await db.rows<{
    id: string;
    subject: string;
    summary: string | null;
    interaction_type: string;
    occurred_at: string | null;
    entity_name: string | null;
  }>(
    `select i.id, i.subject, i.summary, i.interaction_type, i.occurred_at,
            e.display_name as entity_name
       from public.interactions i
       left join public.entities e on e.id = i.external_entity_id
      where i.workspace_id = $1
        and (i.subject ilike any($2) or coalesce(i.summary,'') ilike any($2)
             or coalesce(e.display_name,'') ilike any($2))
      order by coalesce(i.occurred_at, i.created_at) desc limit $3`,
    [workspaceId, patterns, limitPerTable],
  );
  for (const i of interactions) {
    records.push({
      table: 'interactions',
      rowId: i.id,
      label: i.subject,
      body: [
        `Type: ${i.interaction_type}`,
        i.occurred_at ? `Occurred: ${i.occurred_at}` : 'Occurred: date not recorded',
        i.entity_name ? `With: ${i.entity_name}` : null,
        i.summary,
      ]
        .filter(Boolean)
        .join('\n'),
      extra: {},
    });
  }

  const actions = await db.rows<{
    id: string;
    title: string;
    description: string | null;
    status: string;
    due_at: string | null;
    entity_name: string | null;
  }>(
    `select a.id, a.title, a.description, a.status, a.due_at, e.display_name as entity_name
       from public.actions a
       left join public.entities e on e.id = a.related_entity_id
      where a.workspace_id = $1
        and (a.title ilike any($2) or coalesce(a.description,'') ilike any($2)
             or coalesce(e.display_name,'') ilike any($2))
      order by a.created_at desc limit $3`,
    [workspaceId, patterns, limitPerTable],
  );
  for (const a of actions) {
    records.push({
      table: 'actions',
      rowId: a.id,
      label: a.title,
      body: [
        `Status: ${a.status}`,
        a.due_at ? `Due: ${a.due_at}` : null,
        a.entity_name ? `About: ${a.entity_name}` : null,
        a.description,
      ]
        .filter(Boolean)
        .join('\n'),
      extra: {},
    });
  }

  const affiliations = await db.rows<{
    id: string;
    role_title: string | null;
    context: string | null;
    is_current: boolean;
    person: string;
    organization: string;
  }>(
    `select af.id, af.role_title, af.context, af.is_current,
            p.display_name as person, o.display_name as organization
       from public.entity_affiliations af
       join public.entities p on p.id = af.person_entity_id
       join public.entities o on o.id = af.organization_entity_id
      where af.workspace_id = $1
        and (p.display_name ilike any($2) or o.display_name ilike any($2)
             or coalesce(af.role_title,'') ilike any($2))
      order by af.is_current desc, af.updated_at desc limit $3`,
    [workspaceId, patterns, limitPerTable],
  );
  for (const af of affiliations) {
    records.push({
      table: 'entity_affiliations',
      rowId: af.id,
      label: `${af.person} at ${af.organization}`,
      body: [
        af.role_title ? `Role: ${af.role_title}` : null,
        af.context ? `Context: ${af.context}` : null,
        `Current: ${af.is_current ? 'yes' : 'no'}`,
      ]
        .filter(Boolean)
        .join('\n'),
      extra: {},
    });
  }

  const knowledge = await db.rows<{ id: string; title: string; content: string | null; type: string | null }>(
    `select id, title, content, type from public.knowledge
      where workspace_id = $1 and (title ilike any($2) or coalesce(content,'') ilike any($2))
      order by updated_at desc limit $3`,
    [workspaceId, patterns, limitPerTable],
  );
  for (const k of knowledge) {
    records.push({
      table: 'knowledge',
      rowId: k.id,
      label: k.title,
      body: [k.type ? `Type: ${k.type}` : null, k.content].filter(Boolean).join('\n'),
      extra: {},
    });
  }

  const businessUnits = await db.rows<{ id: string; name: string; summary: string | null; type: string | null }>(
    `select id, name, summary, type from public.business_units
      where workspace_id = $1 and (name ilike any($2) or coalesce(summary,'') ilike any($2))
      order by name limit $3`,
    [workspaceId, patterns, limitPerTable],
  );
  for (const b of businessUnits) {
    records.push({
      table: 'business_units',
      rowId: b.id,
      label: b.name,
      body: [b.type ? `Type: ${b.type}` : null, b.summary].filter(Boolean).join('\n'),
      extra: {},
    });
  }

  const mentions = await db.rows<{
    id: string;
    mention_text: string;
    resolution_status: string;
    rationale: string | null;
  }>(
    `select id, mention_text, resolution_status, rationale from public.entity_mentions
      where workspace_id = $1 and mention_text ilike any($2)
      order by created_at desc limit $3`,
    [workspaceId, patterns, limitPerTable],
  );
  for (const m of mentions) {
    records.push({
      table: 'entity_mentions',
      rowId: m.id,
      label: `Unresolved mention: ${m.mention_text}`,
      body: [`Resolution status: ${m.resolution_status}`, m.rationale].filter(Boolean).join('\n'),
      extra: {},
    });
  }

  // Rank by term overlap and drop the thin matches.
  const threshold = requiredTermMatches(terms.length);
  const scored = records
    .map((record) => ({ record, matched: countMatchedTerms(record, terms) }))
    .filter((entry) => entry.matched >= threshold)
    .sort((a, b) => b.matched - a.matched);

  return scored.map((entry) => entry.record);
}

export interface AskResult {
  answerMd: string;
  citations: { table_name: string; row_id: string; label: string; quote: string | null }[];
  unanswered: string[];
  retrievedCount: number;
  isMock: boolean;
  costUsd: number;
  costIsEstimate: boolean;
}

export async function askKnowledge(
  workspaceId: string,
  question: string,
  options?: { provider?: AiProvider; threadId?: string; userId?: string },
): Promise<AskResult> {
  assertScope(workspaceId, 'askKnowledge');
  const provider = options?.provider ?? getAiProvider();

  const records = await withService((db) => retrieveRecords(db, workspaceId, question));

  if (records.length === 0) {
    return {
      answerMd:
        'Nothing in the saved records matches that question.\n\nThis answer is limited to what has been approved into this workspace, so an empty result means the knowledge base does not hold it yet -- not that the answer does not exist. Use **Research & Update** to look for new information and prepare changes for approval.',
      citations: [],
      unanswered: [question],
      retrievedCount: 0,
      isMock: provider.isMock,
      costUsd: 0,
      costIsEstimate: false,
    };
  }

  const numbered = records.map((r, i) => ({ ...r, ref: i + 1 }));
  const result = await provider.generateStructured({
    model: models().draft,
    schema: AskAnswer,
    schemaName: 'ask_answer',
    label: `ask:${workspaceId}`,
    reasoningEffort: 'low',
    system: baseSystemPrompt(
      [
        '',
        'Answer strictly from the stored records supplied below. This is a closed-book',
        'question: you have no web access and you must not use background knowledge.',
        '',
        '- If the records do not answer part of the question, put that part in `unanswered`.',
        '- Cite the exact records you used, by table_name and row_id, copied verbatim from',
        '  the list. Never invent an id.',
        '- Preserve the distinction the records themselves make between fact, inference and',
        '  recommendation, and carry through confidence and dates where they are recorded.',
        '- Where a record notes an unresolved or ambiguous entity, say so rather than',
        '  presenting it as settled.',
      ].join('\n'),
    ),
    input: [
      `## Question`,
      question,
      '',
      '## Stored records',
      ...numbered.map((r) =>
        [
          `### [${r.ref}] ${r.label}`,
          `table_name: ${r.table}`,
          `row_id: ${r.rowId}`,
          '',
          r.body,
          '',
        ].join('\n'),
      ),
    ].join('\n'),
  });

  // Keep only citations that point at rows actually retrieved.
  const valid = new Set(records.map((r) => `${r.table}:${r.rowId}`));
  const citations = result.value.citations.filter((c) => valid.has(`${c.table_name}:${c.row_id}`));

  const cost = await withService((db) =>
    recordUsage(db, {
      workspaceId,
      operation: 'ask_knowledge',
      stage: 'answer',
      usage: result.usage,
      isMock: provider.isMock,
    }),
  );

  // With no model configured, still return the retrieved records rather than
  // nothing, so the feature is usable and honest about what it is doing.
  const answerMd = provider.isMock
    ? [
        result.value.answer_md,
        '',
        `### Retrieved records (${records.length})`,
        '',
        ...numbered.map((r) => `- **${r.label}** — \`${r.table}\` \`${r.rowId}\``),
      ].join('\n')
    : result.value.answer_md;

  return {
    answerMd,
    citations: provider.isMock
      ? numbered.map((r) => ({ table_name: r.table, row_id: r.rowId, label: r.label, quote: null }))
      : citations,
    unanswered: result.value.unanswered,
    retrievedCount: records.length,
    isMock: provider.isMock,
    costUsd: cost.costUsd,
    costIsEstimate: cost.isEstimate,
  };
}
