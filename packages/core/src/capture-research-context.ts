/**
 * What a research run is allowed to know about the capture that asked it.
 *
 * A research question from a capture needs context, or the search is just the
 * question shorn of everything that made it worth asking: which person, which
 * document, what the material already said. The easy version of this is to hand
 * the model the workspace's memory and let it sort things out. That is the
 * wrong shape twice over -- it sends private material that has nothing to do
 * with the question, and it buries the little that matters.
 *
 * So the context is built from ONE place: the capture proposal's own items,
 * plus the records that capture actually saved. Nothing else in the workspace
 * can reach it, not by filtering but because it is never read. Within that, the
 * lists are ranked by how much they overlap the question and its subject, and
 * every list is capped.
 *
 * The same structure goes into the worker's prompt, the run's metadata and the
 * test fixtures, so what a test asserts is what the model was given.
 */
import type { Queryable } from './db.js';

/** Hard ceilings. A research brief a person could read in a minute. */
export const CONTEXT_BUDGET = {
  excerptChars: 1_500,
  subjects: 8,
  signals: 4,
  findings: 6,
  actions: 4,
  evidence: 6,
  savedRecords: 8,
} as const;

export interface CaptureResearchQuestion {
  id: string;
  question: string;
  whyItMatters: string | null;
  subject: string | null;
}

export interface CaptureResearchContext {
  proposalId: string;
  /** The capture's own title and one-line summary, as the person saw them. */
  title: string;
  summary: string | null;
  /** What the capture actually said, truncated to the budget. */
  excerpt: string | null;
  /** The attached document, when the capture had one. */
  source: { title: string; kind: string; url: string | null } | null;
  questions: CaptureResearchQuestion[];
  subjects: { name: string; kind: string; resolved: boolean }[];
  signals: { title: string; whyItMatters: string | null }[];
  findings: { kind: string; title: string }[];
  actions: { title: string; dueOn: string | null }[];
  evidence: { title: string; url: string | null }[];
  /** Records this capture already saved, so research enriches instead of repeating. */
  savedRecords: { kind: string; label: string }[];
  /** Every list is capped; this says what was left out. */
  omitted: string[];
}

type ItemRow = {
  target_table: string;
  label: string;
  new_values: Record<string, unknown> | null;
  applied_at: string | null;
};

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

/** Words worth matching on: everything except the ones every sentence has. */
const STOP = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'by',
  'with', 'at', 'from', 'this', 'that', 'it', 'its', 'as', 'be', 'has', 'have', 'who', 'what',
  'which', 'why', 'how', 'does', 'do', 'any', 'their', 'there',
]);
const terms = (value: string): Set<string> =>
  new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2 && !STOP.has(word)),
  );

/**
 * How much a line has to do with the questions being researched.
 *
 * Deliberately crude: shared significant words. It does not need to be clever,
 * only to put the relevant half first so the cap keeps the right things. A tie
 * keeps the capture's own order, because the material was written in the order
 * its author thought mattered.
 */
function rankByRelevance<T>(items: T[], describe: (item: T) => string, wanted: Set<string>): T[] {
  return items
    .map((item, index) => {
      const own = terms(describe(item));
      let overlap = 0;
      for (const word of own) if (wanted.has(word)) overlap += 1;
      return { item, index, overlap };
    })
    .sort((a, b) => (b.overlap - a.overlap) || (a.index - b.index))
    .map((entry) => entry.item);
}

/**
 * Builds the bounded context for a capture-originated research run.
 *
 * Reads only: the capture proposal, its items, and the rows it saved.
 */
export async function buildCaptureResearchContext(
  db: Queryable,
  workspaceId: string,
  proposalId: string,
  questions: CaptureResearchQuestion[],
): Promise<CaptureResearchContext> {
  const proposal = await db.oneOrFail<{ title: string; summary: string | null }>(
    `select title, summary from public.proposals where workspace_id = $1 and id = $2`,
    [workspaceId, proposalId],
  );
  const items = await db.rows<ItemRow>(
    `select target_table, label, new_values, applied_at
       from public.proposal_items
      where workspace_id = $1 and proposal_id = $2 and coalesce(decision, '') <> 'rejected'
      order by seq`,
    [workspaceId, proposalId],
  );

  // What the questions are about, for ranking everything else.
  const wanted = terms(
    questions.map((q) => `${q.question} ${q.whyItMatters ?? ''} ${q.subject ?? ''}`).join(' '),
  );
  const omitted: string[] = [];
  const cap = <T>(list: T[], limit: number, what: string): T[] => {
    if (list.length > limit) omitted.push(`${list.length - limit} more ${what}`);
    return list.slice(0, limit);
  };
  const valuesOf = (item: ItemRow) => item.new_values ?? {};
  const forTable = (table: string) => items.filter((i) => i.target_table === table);

  // The capture's own words, from the private source record it proposed.
  const sourceItem = forTable('evidence')[0];
  const excerptRaw = sourceItem
    ? text(valuesOf(sourceItem).excerpt) ?? text(valuesOf(sourceItem).notes)
    : null;
  const excerpt = excerptRaw ? excerptRaw.slice(0, CONTEXT_BUDGET.excerptChars) : null;
  if (excerptRaw && excerptRaw.length > CONTEXT_BUDGET.excerptChars) {
    omitted.push(`${excerptRaw.length - CONTEXT_BUDGET.excerptChars} more characters of the capture`);
  }

  const artifact = forTable('research_artifacts')[0];
  const source = artifact
    ? {
        title: text(valuesOf(artifact).title) ?? artifact.label,
        kind: text(valuesOf(artifact).artifact_type) ?? 'document',
        url: text(valuesOf(artifact).source_file),
      }
    : sourceItem
      ? {
          title: text(valuesOf(sourceItem).title) ?? sourceItem.label,
          kind: text(valuesOf(sourceItem).source_type) ?? 'note',
          url: text(valuesOf(sourceItem).url),
        }
      : null;

  // Subjects: canonical entities the capture named, plus names it could not place.
  const entityItems = forTable('entities').map((item) => ({
    name: text(valuesOf(item).display_name) ?? item.label,
    kind: text(valuesOf(item).entity_type) ?? 'record',
    resolved: true,
  }));
  const mentionItems = forTable('entity_mentions').map((item) => ({
    name: text(valuesOf(item).mention_text) ?? item.label,
    kind: text(valuesOf(item).proposed_entity_type) ?? 'unknown',
    resolved: false,
  }));
  const subjects = cap(
    rankByRelevance([...entityItems, ...mentionItems], (s) => s.name, wanted),
    CONTEXT_BUDGET.subjects,
    'names from this capture',
  );

  const signals = cap(
    rankByRelevance(
      forTable('signals').map((item) => ({
        title: text(valuesOf(item).title) ?? item.label,
        whyItMatters: text(valuesOf(item).why_it_matters),
      })),
      (s) => `${s.title} ${s.whyItMatters ?? ''}`,
      wanted,
    ),
    CONTEXT_BUDGET.signals,
    'signals',
  );

  const findings = cap(
    rankByRelevance(
      forTable('research_findings').map((item) => ({
        kind: text(valuesOf(item).finding_type) ?? 'fact',
        title: text(valuesOf(item).title) ?? item.label,
      })),
      (f) => f.title,
      wanted,
    ),
    CONTEXT_BUDGET.findings,
    'findings, gaps and risks',
  );

  const actions = cap(
    rankByRelevance(
      forTable('actions').map((item) => ({
        title: text(valuesOf(item).title) ?? item.label,
        dueOn: text(valuesOf(item).due_at)?.slice(0, 10) ?? null,
      })),
      (a) => a.title,
      wanted,
    ),
    CONTEXT_BUDGET.actions,
    'dates to watch',
  );

  // Sources the capture already cites. Private note bodies are NOT included:
  // the excerpt above is the one place the capture's own words appear, and a
  // research query has no use for the same text twice.
  const evidence = cap(
    rankByRelevance(
      forTable('evidence')
        .filter((item) => item !== sourceItem)
        .map((item) => ({ title: text(valuesOf(item).title) ?? item.label, url: text(valuesOf(item).url) })),
      (e) => e.title,
      wanted,
    ),
    CONTEXT_BUDGET.evidence,
    'sources',
  );

  // What this capture already saved, so research adds rather than repeats.
  const saved = await db.rows<{ table_name: string; label: string }>(
    `select ac.table_name, coalesce(pi.label, ac.table_name) as label
       from public.applied_changes ac
       left join public.proposal_items pi on pi.id = ac.proposal_item_id
      where ac.workspace_id = $1 and ac.proposal_id = $2
        and ac.table_name not in ('research_topics')
      order by ac.applied_at`,
    [workspaceId, proposalId],
  );
  const savedRecords = cap(
    rankByRelevance(
      saved.map((row) => ({ kind: row.table_name, label: row.label })),
      (r) => r.label,
      wanted,
    ),
    CONTEXT_BUDGET.savedRecords,
    'records already saved from this capture',
  );

  return {
    proposalId,
    title: proposal.title,
    summary: proposal.summary,
    excerpt,
    source,
    questions,
    subjects,
    signals,
    findings,
    actions,
    evidence,
    savedRecords,
    omitted,
  };
}

/** The context as the worker puts it in front of the model. No table names, no ids. */
export function renderCaptureResearchContext(context: CaptureResearchContext): string {
  const lines: string[] = [];
  const list = (heading: string, entries: string[]) => {
    if (entries.length === 0) return;
    lines.push('', heading);
    for (const entry of entries) lines.push(`- ${entry}`);
  };

  lines.push(`This research was asked for from a capture: ${context.title}`);
  if (context.summary) lines.push(context.summary);
  if (context.source) lines.push(`Attached: ${context.source.title} (${context.source.kind})`);

  list(
    'Questions to answer:',
    context.questions.map((q) => `${q.question}${q.whyItMatters ? ` — why it matters: ${q.whyItMatters}` : ''}`),
  );
  list('Who and what this capture is about:', context.subjects.map((s) => `${s.name} (${s.kind}${s.resolved ? '' : ', not yet identified'})`));
  list('What the material said was worth watching:', context.signals.map((s) => `${s.title}${s.whyItMatters ? ` — ${s.whyItMatters}` : ''}`));
  list('What it established or left open:', context.findings.map((f) => `${f.kind}: ${f.title}`));
  list('Dates it flagged:', context.actions.map((a) => `${a.title}${a.dueOn ? ` — ${a.dueOn}` : ''}`));
  list('Sources it already cites:', context.evidence.map((e) => `${e.title}${e.url ? ` (${e.url})` : ''}`));
  list('Already saved from this capture, so do not repeat it:', context.savedRecords.map((r) => r.label));

  if (context.excerpt) {
    lines.push('', 'The capture itself:', '<capture>', context.excerpt, '</capture>');
  }
  if (context.omitted.length > 0) {
    lines.push('', `Not included, to keep this short: ${context.omitted.join(', ')}.`);
  }
  return lines.join('\n');
}
