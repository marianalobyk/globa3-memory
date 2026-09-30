import 'server-only';
import type { ContactResearchRecord, ProposalItemRecord } from '@g3/core';
import { toZonedDate } from '@g3/shared';
import { displayLabel } from '@/lib/labels';

/**
 * "Here is what I understood": a capture proposal as one human summary.
 *
 * The mobile review (and the web review's default view) ask one question: did
 * the app understand what I meant, and what next? Records, findings, links and
 * dependencies are implementation details; this turns them into a contact, a
 * line of context, what is still missing, and exactly what "Save contact" would
 * keep -- with the ids it saves, dependency-complete, decided here once so no
 * client has to understand the proposal structure.
 *
 * Nothing is invented: every sentence is built from the proposal's own items.
 * A place or event named in the note is context ("at Cannes"); it is never
 * saved as an event record from this flow.
 */

export type ConfirmationStatus = 'ready' | 'researching' | 'choose_identity' | 'needs_context' | 'saved' | 'closed';

/** What a document review shows: four groups, in the order a person decides. */
export interface DocumentView {
  title: string;
  /** "A daily radar brief with four signals and four watch dates." */
  readAs: string;
  summary: string;
  /** "We found 4 signals, 2 research suggestions and 4 watch dates." */
  headline: string;
  groups: {
    key: 'save' | 'research' | 'source_only' | 'unclear';
    label: string;
    /** One sentence: why this group matters and what happens to it. */
    why: string;
    lines: DocumentLine[];
  }[];
}

export interface DocumentLine {
  text: string;
  detail: string | null;
  /** The record behind the line, when there is one. */
  itemId: string | null;
  /**
   * Present when this line is a choice: it is NOT saved unless the person
   * turns it on. `itemIds` is what turning it on adds, dependencies included.
   */
  optional: { toggleLabel: string; itemIds: string[] } | null;
}

export interface ConfirmationView {
  /** What this capture is: someone you were in contact with, or material you captured. */
  kind: 'contact' | 'document';
  document: DocumentView | null;
  status: ConfirmationStatus;
  /** "Ready to review", "Research in progress", "Needs more context", "Saved". */
  statusLabel: string;
  contact: {
    key: string;
    /** "New contact", "Existing contact", "Possible match", "Existing Globa 3 member". */
    label: string;
    name: string;
    /** "Head of Drama at Horizon Studios", when known. */
    line: string | null;
    /** For a possible match: the similar names already in memory. */
    similarTo: string[];
  } | null;
  /** Other people the note names as contacts. */
  others: string[];
  /** "You met Anna at Cannes today." */
  context: string | null;
  /** "Contact details and a follow-up." */
  missing: string | null;
  followUps: string[];
  researchFound: ResearchFoundView | null;
  /** "Save contact", "Save interaction", "Save". */
  primaryActionLabel: string;
  /** False for a colleague: public research on your own people is never offered. */
  canResearch: boolean;
  save: {
    /** What "Confirm and save" keeps, in words. */
    lines: string[];
    /** Follow-ups, project links and research findings, only when they exist. */
    optional: string[];
    /** The note itself is kept with the saved records. */
    keepsNote: boolean;
    /** Dependency-complete ids for approval. Empty when nothing is left to save. */
    itemIds: string[];
  };
  /** One line for the inbox. */
  summary: string;
}

/**
 * Counts a person can see. Stale numbers in model prose ("three current
 * signals" when the review kept four) are removed rather than shown: every
 * count in the review comes from what the review actually holds.
 */
export function withoutStaleCounts(text: string): string {
  const NUMBER = '(?:\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)';
  const THING =
    '(?:current\\s+|fresh\\s+|forward[- ]watch\\s+|new\\s+)?(?:signals?|watch\\s+(?:items?|dates?)|forward[- ]watch\\s+items?|opportunity\\s+hypothes[ei]s|hypothes[ei]s|opportunities|gaps?|risks?|research\\s+(?:items?|opportunities|suggestions|recommendations)|entities|records?)';
  const counted = new RegExp(`\\b${NUMBER}\\s+${THING}\\b`, 'gi');
  const connectorOnly = /^(?:and|with|including|plus|covering)?$/i;

  return text
    .split(/(?<=\.)\s+/)
    .map((sentence) => {
      const clauses = sentence
        .replace(/\.$/, '')
        .split(/,\s*/)
        // Only the count goes; whatever else the clause said stays.
        .map((clause) =>
          clause
            .replace(counted, '')
            .replace(/\s{2,}/g, ' ')
            .trim()
            .replace(/^(?:and|plus|with)\s+/i, '')
            .replace(/\s+(?:with|and|including|covering)$/i, '')
            .trim(),
        )
        .filter((clause) => clause.length > 0 && !connectorOnly.test(clause));
      if (clauses.length === 0) return '';
      const joined = clauses.length > 1 ? `${clauses.slice(0, -1).join(', ')} and ${clauses.at(-1)}` : clauses[0]!;
      return `${joined}.`;
    })
    .filter((sentence) => sentence.trim().length > 0)
    .join(' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export interface ResearchFoundView {
  confirmedAs: string | null;
  profiles: { label: string; url: string }[];
  facts: { text: string; sources: string[] }[];
  /** Inferences, suggestions and open questions, each clearly labelled. */
  readings: { label: 'Inference' | 'Suggestion' | 'Still unknown'; text: string; basis: string | null; sources: string[] }[];
}

export interface ConfirmationCard {
  key: string;
  name: string;
  match: 'new' | 'existing' | 'ambiguous' | 'member';
  coreItemId: string | null;
  entityId: string | null;
  memberId: string | null;
  candidates: { name: string }[];
  missing: { label: string }[];
  basicChangeIds: string[];
}

export interface DocumentContext {
  /** From the classify stage: what kind of material this was read as. */
  readAs: string | null;
  /** Kept in the document, never saved as records. */
  sourceOnly: { label: string; why: string }[];
  /** Subjects where research would help. Suggestions only: nothing is started. */
  researchRecommendations: { subject: string; why: string }[];
}

export interface ConfirmationInput {
  title: string;
  proposalSummary: string | null;
  capturedAt: string | null;
  timeZone: string;
  items: ProposalItemRecord[];
  cards: ConfirmationCard[];
  /** Places and events the note names ("Cannes"). */
  places: string[];
  researchRows: ContactResearchRecord[];
  nameOf: Map<string, string>;
  /** Current role line for stored contacts, from memory. */
  storedLines: Map<string, string>;
  needsAttention: (item: ProposalItemRecord) => boolean;
  /** An item plus everything it depends on, so a choice can be applied alone. */
  withDependencies: (itemId: string) => string[];
  /** Present when the capture was read as a document. */
  documentContext?: DocumentContext | null;
}

const VERB: Record<string, string> = {
  encounter: 'met',
  meeting: 'met',
  introduction: 'were introduced to',
  call: 'spoke with',
  conversation: 'talked with',
  email: 'emailed',
  message: 'messaged',
  event: 'saw',
};

const MISSING_WORDS: Record<string, string> = {
  Organisation: 'organisation',
  Role: 'role',
  'Contact details': 'contact details',
  'Why this relationship matters': 'why they matter',
  'Follow-up': 'a follow-up',
};

const values = (item: ProposalItemRecord): Record<string, unknown> => ({ ...(item.old_values ?? {}), ...item.new_values, ...(item.edited_values ?? {}) });
const refSeq = (value: unknown): number | null =>
  typeof value === 'object' && value !== null && '$ref' in value ? ((value as { $ref: { seq: number } }).$ref.seq ?? null) : null;
const fromResearch = (item: ProposalItemRecord) => Boolean((item.provenance as { from_research?: boolean } | null)?.from_research);
const sourcesOf = (item: ProposalItemRecord) =>
  (((item.provenance as { source_urls?: unknown } | null)?.source_urls as unknown[]) ?? []).filter(
    (u): u is string => typeof u === 'string' && /^https?:\/\//.test(u),
  );
const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

function sentence(parts: string[]): string | null {
  if (parts.length === 0) return null;
  const joined = parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
  return `${joined.charAt(0).toUpperCase()}${joined.slice(1)}.`;
}

/**
 * The one-line summary of a document, used by the review and by the capture
 * status screen. Counts decisions, never rows.
 */
export function documentHeadline(counts: { signals: number; watch: number; risks: number; recommendations: number }): string {
  const parts = [
    counts.signals > 0 ? `${counts.signals} signal${counts.signals === 1 ? '' : 's'} worth keeping` : null,
    counts.recommendations > 0 ? `${counts.recommendations} research suggestion${counts.recommendations === 1 ? '' : 's'}` : null,
    counts.watch > 0 ? `${counts.watch} date${counts.watch === 1 ? '' : 's'} to watch` : null,
    counts.risks > 0 ? `${counts.risks} thing${counts.risks === 1 ? '' : 's'} to be careful about` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? `We found ${parts.join(', ')}.` : 'Nothing in this document needs a decision.';
}

/** Plain words for what each proposed record is, in a document review. */
const KIND_WORD: Record<string, string> = {
  person: 'person',
  organization: 'organisation',
  institution: 'organisation',
  project: 'project',
  event: 'event',
  other: 'record',
};

const DOCUMENT_LINE: Record<string, (values: Record<string, unknown>, label: string) => string> = {
  evidence: () => 'Your document, kept privately as the source',
  research_artifacts: (_v, label) => `“${label}” as a research document, with its cited sources`,
  entities: (v, label) => {
    const word = KIND_WORD[String(v.entity_type ?? 'other')] ?? 'record';
    return `${label} — ${/^[aeiou]/i.test(word) ? 'an' : 'a'} ${word} this material is about`;
  },
  signals: (_v, label) => label,
  signal_entities: (_v, label) => label,
  actions: (v, label) => `${label.replace(/^Watch:\s+Watch\s+/i, 'Watch ')}${v.due_at ? ` — ${String(v.due_at).slice(0, 10)}` : ''}`,
  research_findings: (_v, label) => label,
  opportunities: (_v, label) => label,
  entity_mentions: (_v, label) => `${label} — a name close to one you already have`,
};

function documentViewOf(
  input: ConfirmationInput,
  chosen: ProposalItemRecord[],
  openItems: ProposalItemRecord[],
): DocumentView | null {
  const artifactItem = input.items.find((i) => i.target_table === 'research_artifacts');
  if (!artifactItem) return null;
  const context = input.documentContext ?? { readAs: null, sourceOnly: [], researchRecommendations: [] };
  const artifactValues = values(artifactItem);
  const title = displayLabel(String(artifactValues.title ?? artifactItem.label));
  const optionalToggle = (item: ProposalItemRecord): { toggleLabel: string; itemIds: string[] } | null => {
    if (item.target_table === 'opportunities') {
      return { toggleLabel: 'Keep this as an unvalidated opportunity hypothesis', itemIds: input.withDependencies(item.id) };
    }
    if (item.target_table === 'entity_mentions') {
      return { toggleLabel: 'Keep this as a possible match to confirm later', itemIds: input.withDependencies(item.id) };
    }
    if (item.target_table === 'research_topics') {
      // Choosing this records the question. It starts no search: that needs the
      // separate confirmation, which names the question and says that public
      // sources will be consulted.
      return { toggleLabel: 'Research this question', itemIds: input.withDependencies(item.id) };
    }
    return null;
  };
  const line = (item: ProposalItemRecord, asChoice = false): DocumentLine => {
    const v = values(item);
    const text = (DOCUMENT_LINE[item.target_table] ?? ((_x: Record<string, unknown>, l: string) => l))(v, displayLabel(item.label));
    // The line explains itself for a subject or the document; a signal, a watch
    // date or an unknown carries the document's own reason with it.
    const why =
      item.target_table === 'entities' || item.target_table === 'evidence' || item.target_table === 'research_artifacts'
        ? null
        : typeof v.why_it_matters === 'string' && v.why_it_matters
          ? v.why_it_matters
          : typeof v.description === 'string' && v.description
            ? v.description
            : typeof v.content === 'string' && v.content
              ? v.content
              : item.reason;
    return {
      text,
      detail: why ? String(why).split('\n\n')[0]!.split('\n')[0]!.slice(0, 200) : null,
      itemId: item.id,
      optional: asChoice ? optionalToggle(item) : null,
    };
  };

  const saveTables = ['evidence', 'research_artifacts', 'entities', 'signals', 'signal_entities', 'actions', 'research_findings'];
  // Signals and dates first: those are decisions. The records that support
  // them, and the document itself, come after.
  const ORDER = ['signals', 'actions', 'research_findings', 'entities', 'research_artifacts', 'evidence'];
  const saveLines = chosen
    .filter((i) => saveTables.includes(i.target_table) && i.target_table !== 'signal_entities')
    .sort((a, b) => ORDER.indexOf(a.target_table) - ORDER.indexOf(b.target_table))
    .map((item) => line(item));
  // Off by default, and never part of "records to save": a research question is
  // a request, not memory.
  const researchLines = openItems
    .filter((i) => i.target_table === 'research_topics')
    .map((item) => line(item, true));
  const unclear = openItems
    .filter((i) => i.target_table === 'opportunities' || i.target_table === 'entity_mentions' || input.needsAttention(i))
    .map((item) => line(item, true));

  const counts = {
    signals: input.items.filter((i) => i.target_table === 'signals').length,
    watch: input.items.filter((i) => i.target_table === 'actions').length,
    risks: input.items.filter((i) => i.target_table === 'research_findings' && values(i).finding_type === 'risk').length,
  };
  const headline = documentHeadline({ ...counts, recommendations: context.researchRecommendations.length });

  return {
    title,
    readAs: withoutStaleCounts(context.readAs ?? 'A document you captured.'),
    summary: withoutStaleCounts(typeof artifactValues.summary === 'string' ? artifactValues.summary : input.proposalSummary ?? ''),
    headline,
    groups: [
      {
        key: 'save' as const,
        label: 'Save to memory',
        why: 'What this document changes about what you know. Saved only when you confirm.',
        lines: saveLines,
      },
      {
        key: 'research' as const,
        label: 'Research recommended',
        why: 'Worth looking into before a decision. Choosing one records the question; nothing is searched until you confirm it separately.',
        // Real items, so ticking one changes what the save call actually sends.
        // Anything the extractor suggested but that did not become an item is
        // still listed underneath, without a control, so nothing is hidden.
        lines: [
          ...researchLines,
          ...context.researchRecommendations
            .filter((r) => !researchLines.some((l) => l.text.toLowerCase().includes(r.subject.toLowerCase())))
            .map((r) => ({ text: r.subject, detail: r.why, itemId: null, optional: null })),
        ],
      },
      {
        key: 'source_only' as const,
        label: 'Keep as source only',
        // A note is budgeted too now, so this group is no longer document-only.
        why: 'Routine or excluded material. It stays in what you captured and creates no records.',
        lines: context.sourceOnly.map((s) => ({ text: s.label, detail: s.why, itemId: null, optional: null })),
      },
      {
        key: 'unclear' as const,
        label: 'Still unclear',
        why: 'Needs your judgement. Nothing here is saved unless you choose it.',
        lines: unclear,
      },
    ].filter((group) => group.lines.length > 0),
  };
}

export function buildConfirmation(input: ConfirmationInput): ConfirmationView {
  const { items, cards, nameOf } = input;
  const bySeq = new Map(items.map((i) => [i.seq, i]));
  const primary = cards.find((c) => c.match !== 'ambiguous') ?? cards[0] ?? null;
  const primaryCore = primary?.coreItemId ? items.find((i) => i.id === primary.coreItemId) ?? null : null;

  const pointsAtPrimary = (field: unknown) =>
    Boolean(primary) &&
    ((primary!.entityId !== null && field === primary!.entityId) || (primaryCore !== null && refSeq(field) === primaryCore.seq));
  const nameFor = (field: unknown): string | null => {
    if (typeof field === 'string') return nameOf.get(field) ?? null;
    const seq = refSeq(field);
    const target = seq !== null ? bySeq.get(seq) : undefined;
    return target ? displayLabel(String(values(target).display_name ?? target.label)) : null;
  };

  // -- When -----------------------------------------------------------------
  const today = toZonedDate(new Date(), input.timeZone);
  const yesterday = toZonedDate(new Date(Date.now() - 86_400_000), input.timeZone);
  const whenOf = (raw: unknown): string => {
    const at = typeof raw === 'string' && raw ? new Date(raw) : input.capturedAt ? new Date(input.capturedAt) : null;
    if (!at || Number.isNaN(at.getTime())) return 'today';
    const day = toZonedDate(at, input.timeZone);
    if (day === today) return 'today';
    if (day === yesterday) return 'yesterday';
    return `on ${new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: input.timeZone }).format(at)}`;
  };

  // -- The contact line, context and follow-ups ------------------------------
  const noteAffiliation = items.find(
    (i) => i.target_table === 'entity_affiliations' && !fromResearch(i) && pointsAtPrimary(values(i).person_entity_id),
  );
  const roleLine = (item: ProposalItemRecord | undefined) => {
    if (!item) return null;
    const v = values(item);
    const org = nameFor(v.organization_entity_id);
    const role = typeof v.role_title === 'string' && v.role_title.trim() ? v.role_title.trim() : null;
    return role && org ? `${role} at ${org}` : org ? `Works at ${org}` : role;
  };
  const storedFor = primary?.entityId ?? primary?.memberId ?? null;
  const line = roleLine(noteAffiliation) ?? (storedFor ? input.storedLines.get(storedFor) ?? null : null);

  const interaction =
    items.find(
      (i) =>
        i.target_table === 'interactions' &&
        !fromResearch(i) &&
        (pointsAtPrimary(values(i).external_entity_id) || (primary?.memberId != null && values(i).internal_owner_member_id === primary.memberId)),
    ) ??
    items.find((i) => i.target_table === 'interactions' && !fromResearch(i));
  let context: string | null = null;
  if (primary && interaction) {
    const v = values(interaction);
    const verb = VERB[String(v.interaction_type ?? '')] ?? 'were in touch with';
    const place = input.places.find((p) => p.toLowerCase() !== primary.name.toLowerCase());
    context = `You ${verb} ${firstName(primary.name)}${place ? ` at ${place}` : ''} ${whenOf(v.occurred_at)}.`;
  } else if (interaction) {
    context = typeof values(interaction).summary === 'string' ? String(values(interaction).summary) : null;
  }
  const followUps = items
    .filter((i) => i.target_table === 'actions' && !i.applied_at && i.decision !== 'rejected')
    .map((i) => displayLabel(String(values(i).title ?? i.label)));

  // -- Research -------------------------------------------------------------
  const row = primary ? input.researchRows.find((r) => r.contact_key === primary.key) ?? null : null;
  const researched = items.filter((i) => fromResearch(i) && i.decision !== 'rejected');
  let researchFound: ResearchFoundView | null = null;
  if (researched.length > 0) {
    const confirmed = row?.confirmed_candidate;
    const researchedAffiliation = researched.find((i) => i.target_table === 'entity_affiliations');
    researchFound = {
      confirmedAs:
        roleLine(researchedAffiliation) ??
        (confirmed ? [confirmed.role, confirmed.organization].filter(Boolean).join(' at ') || null : null),
      profiles: researched
        .filter((i) => i.target_table === 'entity_aliases' && /^https?:\/\//.test(String(values(i).alias ?? '')))
        .map((i) => ({ label: String(values(i).alias_type) === 'linkedin' ? 'LinkedIn profile' : 'Public profile', url: String(values(i).alias) })),
      facts: researched
        .filter((i) => i.target_table === 'research_findings' && values(i).finding_type === 'fact')
        .map((i) => ({ text: String(values(i).content ?? i.label).split('\n\n')[0]!, sources: sourcesOf(i) })),
      readings: researched
        .filter((i) => i.target_table === 'research_findings' && values(i).finding_type !== 'fact')
        .map((i) => {
          const [text, rest] = String(values(i).content ?? i.label).split('\n\n');
          const type = String(values(i).finding_type);
          return {
            label: type === 'inference' ? ('Inference' as const) : type === 'gap' ? ('Still unknown' as const) : ('Suggestion' as const),
            text: text ?? i.label,
            basis: rest ? rest.replace(/^(Based on|Why|Why it matters): /, '') : null,
            sources: sourcesOf(i),
          };
        }),
    };
  }

  // -- What "Save contact" keeps -------------------------------------------
  const open = (i: ProposalItemRecord) => !i.applied_at && i.decision !== 'rejected';
  const wanted = new Set<string>();
  for (const card of cards) for (const id of card.basicChangeIds) wanted.add(id);
  const documentTables = ['evidence', 'research_artifacts', 'entities', 'signals', 'signal_entities', 'research_findings'];
  const isDocument = items.some((i) => i.target_table === 'research_artifacts');
  for (const item of items.filter(open)) {
    const v = values(item);
    if (item.target_table === 'interactions' || item.target_table === 'actions' || fromResearch(item)) wanted.add(item.id);
    if (item.target_table === 'entities' && v.entity_type === 'project') wanted.add(item.id);
    // A document's own records: everything except an unvalidated idea and an
    // unconfirmed name, which are decisions, not defaults.
    if (isDocument && documentTables.includes(item.target_table)) wanted.add(item.id);
  }
  // Add what the selection depends on; drop anything that cannot be saved yet.
  const byId = new Map(items.map((i) => [i.id, i]));
  const blocked = new Set(items.filter((i) => open(i) && input.needsAttention(i)).map((i) => i.id));
  const selected = new Set<string>();
  const addWithNeeds = (id: string, trail = new Set<string>()): boolean => {
    const item = byId.get(id);
    if (!item || blocked.has(id)) return false;
    if (item.applied_at || selected.has(id) || trail.has(id)) return true;
    trail.add(id);
    for (const seq of item.depends_on_seq ?? []) {
      const needed = bySeq.get(seq);
      if (needed && !addWithNeeds(needed.id, trail)) return false;
    }
    if (open(item)) selected.add(id);
    return true;
  };
  for (const id of wanted) {
    const trial = new Set(selected);
    if (!addWithNeeds(id)) {
      selected.clear();
      for (const kept of trial) selected.add(kept);
    }
  }
  const chosen = items.filter((i) => selected.has(i.id));

  const lines: string[] = [];
  for (const card of cards) {
    if (!card.coreItemId || !selected.has(card.coreItemId)) continue;
    lines.push(
      card.match === 'new'
        ? `${card.name} as a new external contact`
        : card.match === 'existing'
          ? `${card.name}, updated as an existing contact`
          : `${card.name} as a possible match, not merged${card.candidates.length ? ` with ${card.candidates.map((c) => c.name).join(', ')}` : ''}`,
    );
  }
  for (const item of chosen.filter((i) => !fromResearch(i))) {
    const v = values(item);
    // A colleague is linked as an internal member, so their name comes from the card.
    const isPrimaryMemberItem = primary?.memberId != null && v.internal_owner_member_id === primary.memberId;
    const who = nameFor(v.person_entity_id ?? v.entity_id ?? v.external_entity_id) ?? (isPrimaryMemberItem ? primary!.name : null);
    const first = who ? firstName(who) : null;
    if (item.target_table === 'entity_affiliations') {
      const org = nameFor(v.organization_entity_id);
      if (org) lines.push(`${org} as ${first ? `${first}’s` : 'their'} organisation`);
    } else if (item.target_table === 'entity_aliases' && ['email', 'phone', 'linkedin'].includes(String(v.alias_type))) {
      const kind = String(v.alias_type) === 'email' ? 'Email address' : String(v.alias_type) === 'phone' ? 'Phone number' : 'LinkedIn';
      lines.push(`${kind}: ${String(v.alias)}`);
    } else if (item.target_table === 'interactions') {
      lines.push(`Your interaction${first ? ` with ${first}` : ''} from ${whenOf(v.occurred_at).replace(/^on /, '')}`);
    }
  }
  const optional: string[] = [];
  for (const item of chosen.filter((i) => !fromResearch(i))) {
    const v = values(item);
    if (item.target_table === 'actions') optional.push(`Follow-up: ${displayLabel(String(v.title ?? item.label))}`);
    if (item.target_table === 'entities' && v.entity_type === 'project') optional.push(`Link to ${displayLabel(String(v.display_name ?? item.label))}`);
  }
  const researchFindings = chosen.filter((i) => fromResearch(i) && i.target_table === 'research_findings').length;
  if (researchFindings > 0) optional.push(`${researchFindings} research finding${researchFindings === 1 ? '' : 's'}, with sources`);
  if (chosen.some((i) => fromResearch(i) && i.target_table === 'entity_aliases')) optional.push('Public profile link from research');

  // -- Status ---------------------------------------------------------------
  const anyOpen = items.some(open);
  const status: ConfirmationStatus = !anyOpen
    ? items.some((i) => i.applied_at)
      ? 'saved'
      : 'closed'
    : row && ['identifying', 'researching'].includes(row.status)
      ? 'researching'
      : row?.status === 'awaiting_confirmation'
        ? 'choose_identity'
        : row?.status === 'needs_context'
          ? 'needs_context'
          : 'ready';
  const statusLabel = {
    ready: 'Ready to review',
    researching: 'Research in progress',
    choose_identity: 'Needs your answer',
    needs_context: 'Needs more context',
    saved: 'Saved',
    closed: 'Nothing to save',
  }[status];

  const isMember = primary?.match === 'member';
  const missingParts = primary && primary.match !== 'ambiguous' && !isMember
    ? primary.missing.map((m) => MISSING_WORDS[m.label]).filter((m): m is string => Boolean(m))
    : [];

  const documentView = documentViewOf(input, chosen, items.filter(open));

  // A document saves material, not a relationship: its confirmation counts what
  // it keeps rather than listing a contact, an organisation and a meeting.
  if (documentView) {
    const count = (table: string, test: (v: Record<string, unknown>) => boolean = () => true) =>
      chosen.filter((i) => i.target_table === table && test(values(i))).length;
    const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
    const documentLines = [
      `“${documentView.title}” as a research document, with its cited sources`,
      count('signals') > 0 ? `${plural(count('signals'), 'signal', 'signals')} worth keeping` : null,
      count('actions') > 0 ? `${plural(count('actions'), 'date', 'dates')} to watch` : null,
      count('research_findings', (v) => v.finding_type === 'gap') > 0
        ? count('research_findings', (v) => v.finding_type === 'gap') === 1
          ? '1 thing the document says is not yet known'
          : `${count('research_findings', (v) => v.finding_type === 'gap')} things the document says are not yet known`
        : null,
      count('research_findings', (v) => v.finding_type === 'risk') > 0
        ? `${plural(count('research_findings', (v) => v.finding_type === 'risk'), 'thing', 'things')} to be careful about`
        : null,
      count('entities') > 0 ? `${plural(count('entities'), 'record', 'records')} the signals are about` : null,
    ].filter((l): l is string => l !== null);
    return {
      kind: 'document',
      document: documentView,
      status,
      statusLabel,
      contact: null,
      others: [],
      context: documentView.readAs,
      missing: null,
      followUps: [],
      researchFound: null,
      primaryActionLabel: 'Save to memory',
      canResearch: false,
      save: {
        lines: documentLines,
        optional: [],
        keepsNote: chosen.some((i) => i.target_table === 'evidence'),
        itemIds: chosen.map((i) => i.id),
      },
      summary: documentView.headline,
    };
  }

  return {
    kind: 'contact' as const,
    document: null,
    status,
    statusLabel,
    contact: primary
      ? {
          key: primary.key,
          label:
            primary.match === 'new'
              ? 'New contact'
              : primary.match === 'existing'
                ? 'Existing contact'
                : primary.match === 'member'
                  ? 'Existing Globa 3 member'
                  : 'Possible match',
          name: primary.name,
          line,
          similarTo: primary.match === 'ambiguous' ? primary.candidates.map((c) => c.name) : [],
        }
      : null,
    others: cards.filter((c) => c !== primary).map((c) => c.name),
    context,
    missing: sentence(missingParts),
    followUps,
    researchFound,
    // A colleague's card is about what happened, not about building a profile.
    primaryActionLabel: isMember ? 'Save interaction' : primary ? 'Save contact' : 'Save',
    canResearch: Boolean(primary) && !isMember,
    save: {
      lines,
      optional,
      keepsNote: chosen.some((i) => i.target_table === 'evidence' && !fromResearch(i)),
      itemIds: chosen.map((i) => i.id),
    },
    summary: context ?? input.proposalSummary ?? input.title,
  };
}
