import 'server-only';
import {
  getCapture,
  getProposal,
  listContactResearch,
  type ContactResearchRecord,
  hasOpenAi,
  readbackProposal,
  withUserRead,
  type ProposalItemRecord,
} from '@g3/core';
import {
  CAPTURE_PHASES,
  capturePhase,
  slugify,
  REVIEW_BAND_ORDER,
  REVIEW_BANDS,
  reviewBand,
  type CapturePhase,
  type ReviewBand,
  type Session,
} from '@g3/shared';
import {
  CLAIM_MEANING,
  displayLabel,
  fieldLabel,
  humanValue,
  isSubjectKind,
  opVerb,
  proposalSourceLabel,
  plainTitle,
  proposalStatusLabel,
  recordKind,
  SYSTEM_FIELDS,
  type RecordKind,
} from '@/lib/labels';
import { buildConfirmation, documentHeadline, type ConfirmationView } from '@/lib/capture-confirmation';

/**
 * What a client shows for a capture and its proposal, in plain words.
 *
 * The web capture screen and the mobile app read these shapes, so neither
 * client decides how a change is grouped, what it is called, or whether a name
 * matched memory: that is decided here, once, on the server, from the same
 * labels the web review uses. Nothing here exposes table names, job ids or
 * database errors, and nothing here writes.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

export interface CaptureView {
  id: string;
  kind: 'text' | 'url' | 'file';
  phase: CapturePhase;
  phaseLabel: string;
  /** The three steps a person sees, with where this capture is. */
  steps: { label: string; state: 'done' | 'current' | 'todo' | 'failed' }[];
  failure: string | null;
  canRetry: boolean;
  capturedAt: string;
  source: { text: string | null; filename: string | null; url: string | null };
  proposal: {
    id: string;
    title: string;
    /** "We found 4 signals worth keeping, 2 research suggestions, 4 dates to watch." */
    summary: string;
    /** Row counts: for "See details", never for the headline. */
    changes: number;
    awaiting: number;
    saved: number;
  } | null;
  isMock: boolean;
  /** Kept for the web capture screen, which predates `phase`. */
  status: string;
  proposalId: string | null;
}

const STEP_ORDER: CapturePhase[] = ['received', 'analysing', 'matching', 'ready'];

export async function loadCaptureView(session: Session, captureId: string): Promise<CaptureView | null> {
  const workspaceId = session.activeWorkspace.workspaceId;
  // Read under the user's own access rules: a capture from another workspace is
  // simply not found.
  return withUserRead(session.user.id, async (db) => {
    const capture = await getCapture(db, workspaceId, captureId);
    if (!capture) return null;
    const extra = await db.oneOrFail<{
      current_stage: string | null;
      run_status: string | null;
      is_mock: boolean | null;
      filename: string | null;
      title: string | null;
      changes: number;
      awaiting: number;
      saved: number;
    }>(
      `select r.current_stage, r.status as run_status, r.is_mock, u.filename, p.title,
              (select count(*)::int from public.proposal_items i where i.proposal_id = p.id) as changes,
              (select count(*)::int from public.proposal_items i
                where i.proposal_id = p.id and i.decision = 'pending' and i.applied_at is null) as awaiting,
              (select count(*)::int from public.proposal_items i
                where i.proposal_id = p.id and i.applied_at is not null) as saved
         from (select 1) one
         left join public.runs r on r.workspace_id = $1 and r.id = $2
         left join public.uploads u on u.workspace_id = $1 and u.id = $3
         left join public.proposals p on p.workspace_id = $1 and p.id = $4`,
      [workspaceId, capture.run_id, capture.upload_id, capture.proposal_id],
    );

    // What the analysis found, in decisions rather than rows. A document says
    // what it found; a note about people keeps the proposal's own summary.
    const documentCounts = capture.proposal_id
      ? await db.one<{ signals: number; watch: number; risks: number }>(
          `select count(*) filter (where target_table = 'signals')::int as signals,
                  count(*) filter (where target_table = 'actions' and new_values->>'action_type' = 'watch')::int as watch,
                  count(*) filter (where target_table = 'research_findings' and new_values->>'finding_type' = 'risk')::int as risks
             from public.proposal_items where workspace_id = $1 and proposal_id = $2`,
          [workspaceId, capture.proposal_id],
        )
      : null;
    const recommendations = capture.run_id
      ? (
          await db.one<{ n: number }>(
            `select coalesce(jsonb_array_length(output->'document'->'research_recommendations'), 0)::int as n
               from public.run_stages where workspace_id = $1 and run_id = $2 and stage = 'extract'`,
            [workspaceId, capture.run_id],
          )
        )?.n ?? 0
      : 0;
    const phase = capturePhase(capture.status, extra.run_status === 'queued' ? null : extra.current_stage);
    const at = STEP_ORDER.indexOf(phase === 'failed' ? 'analysing' : phase);
    const steps = (['received', 'analysing', 'matching', 'ready'] as const).map((key, index) => ({
      label: CAPTURE_PHASES[key],
      state:
        phase === 'ready' || index < at
          ? ('done' as const)
          : index === at
            ? phase === 'failed'
              ? ('failed' as const)
              : ('current' as const)
            : ('todo' as const),
    }));

    return {
      id: capture.id,
      kind: capture.kind,
      phase,
      phaseLabel: CAPTURE_PHASES[phase],
      steps,
      failure:
        phase === 'failed'
          ? (capture.status_detail ?? 'The analysis could not finish. The source is stored unchanged.')
          : null,
      canRetry:
        phase === 'failed' &&
        (extra.run_status === 'failed' || (!capture.run_id && !capture.proposal_id)) &&
        session.activeWorkspace.role !== 'viewer',
      capturedAt: capture.captured_at,
      source: { text: capture.body_text, filename: extra.filename, url: capture.source_url },
      proposal:
        capture.proposal_id && extra.title
          ? {
              id: capture.proposal_id,
              title: displayLabel(extra.title),
              summary:
                documentCounts && documentCounts.signals > 0
                  ? documentHeadline({ ...documentCounts, recommendations })
                  : `${extra.changes} thing${extra.changes === 1 ? '' : 's'} to confirm`,
              changes: extra.changes,
              awaiting: extra.awaiting,
              saved: extra.saved,
            }
          : null,
      isMock: extra.is_mock ?? !hasOpenAi(),
      status: capture.status,
      proposalId: capture.proposal_id,
    };
  });
}

// ---------------------------------------------------------------------------
// Proposal
// ---------------------------------------------------------------------------

export type MatchView = 'existing' | 'new' | 'ambiguous' | 'member';

export interface ProposedChangeView {
  id: string;
  number: number;
  action: string;
  kind: RecordKind;
  title: string;
  /** The main text of the change, if it has one (a finding's content, a summary). */
  text: string | null;
  /** A few readable fields, already described in words. */
  details: { label: string; value: string }[];
  claim: { label: string; meaning: string } | null;
  confidence: string | null;
  /** Only for people, companies, projects and unconfirmed names. */
  match: MatchView | null;
  matchNote: string | null;
  candidates: { name: string; similarity: number | null }[];
  decision: 'pending' | 'approved' | 'rejected';
  saved: boolean;
  needsAttention: string | null;
  /** Change numbers that must be approved together with this one. */
  needs: number[];
  /** What this change is, in plain words ("Your original note", "Email address"). */
  kindLabel: string;
  /** Shown in a contact card at the top instead of in the list. */
  inContactCard: boolean;
  /** Added by research after identity confirmation, with the sources it rests on. */
  fromResearch: boolean;
  sources: string[];
}

export interface ContactResearchView {
  status: ContactResearchRecord['status'];
  /** Plain words for where research is. */
  statusLabel: string;
  message: string | null;
  /** True while a step runs and the client should poll. */
  active: boolean;
  candidates: {
    index: number;
    name: string;
    organization: string | null;
    role: string | null;
    location: string | null;
    explanation: string;
    matches: string[];
    conflicts: string[];
    nameOnly: boolean;
    confidence: string;
    sources: { url: string; title: string | null }[];
  }[];
  confirmed: { name: string; organization: string | null; role: string | null } | null;
  itemsAdded: number;
}

export interface ContactCardView {
  /** Identifies the contact in research and "important" requests. */
  key: string;
  name: string;
  important: boolean;
  /** Why research would help, only when there is a reason. Empty means not recommended. */
  researchReasons: string[];
  research: ContactResearchView | null;
  /** What research added about this person, awaiting the same approval. */
  fromResearch: string[];
  match: MatchView;
  /** "New external contact", "Existing external contact", "Possible match, not merged". */
  matchLabel: string;
  needsMoreInfo: boolean;
  candidates: { name: string; similarity: number | null }[];
  /** What came directly from the note about this person. */
  fromNote: string[];
  /** What is still unknown, never invented. */
  missing: { label: string; value: string }[];
  /** The changes "Save the basic contact now" approves (their dependencies are added by the client). */
  basicChangeIds: string[];
  entityId: string | null;
  /** Set when this is a colleague: the workspace member they are. */
  memberId: string | null;
  /** The change that creates or marks this contact (internal; used to build the summary). */
  coreItemId: string | null;
}

export interface ProposalView {
  id: string;
  title: string;
  summary: string | null;
  statusLabel: string;
  version: number;
  isMock: boolean;
  sourceLabel: string;
  canApprove: boolean;
  capture: { id: string; text: string | null; filename: string | null; url: string | null; capturedAt: string } | null;
  counts: { total: number; awaiting: number; approved: number; saved: number; rejected: number };
  groups: { band: ReviewBand; label: string; note: string | null; changes: ProposedChangeView[] }[];
  /** Every person, company, project or event the proposal names, and how each matched memory. */
  mentions: MentionView[];
  /** People you were in contact with, shown first as relationship cards. */
  contacts: ContactCardView[];
  /** True while identity search or research runs: the client polls. */
  researchActive: boolean;
  saved: { label: string; kind: RecordKind; verb: string; savedAt: string }[];
  researchable: { label: string; kind: 'person' | 'company' | 'project'; entityId: string | null }[];
  /** "Here is what I understood": the human summary a capture review leads with. Null for non-capture proposals. */
  confirmation: ConfirmationView | null;
}

export interface MentionView {
  name: string;
  kind: RecordKind;
  match: MatchView;
  note: string;
  candidates: { name: string; similarity: number | null }[];
  entityId: string | null;
}

const TEXT_FIELDS = ['content', 'summary', 'description', 'excerpt', 'statement', 'notes', 'context'];
/** Fields that matter to storage or are shown elsewhere in the view, not as details. */
const HIDDEN_DETAILS = new Set([
  'file_reference',
  'resolution_status',
  'rationale',
  'mention_text',
  'candidate_entity_id',
  // Shown another way: every change cites the capture it came from, the group
  // says what kind of statement it is, and confidence has its own label.
  'evidence_id',
  'source_evidence_id',
  'finding_type',
  'confidence',
  'proposed_display_name',
  'status',
  'action_type',
  'reliability',
  'is_current',
  'is_primary',
  'context',
  'relationship_status',
  'research_status',
  'entity_type',
  'subject',
]);
/** Details a person looks for first, shown ahead of the rest. */
const DETAIL_PRIORITY = ['organization_entity_id', 'role_title', 'person_entity_id', 'interaction_type', 'occurred_at', 'due_at', 'alias_type'];
/** Long text is shortened in the compact view; the full text stays on the web review. */
const TEXT_LIMIT = 280;
/** Fields that point at the person, company or project a change is about. */
const SUBJECT_FIELDS = ['related_entity_id', 'entity_id', 'person_entity_id', 'organization_entity_id', 'external_entity_id', 'candidate_entity_id'];
const DETAIL_LIMIT = 3;

const RESEARCH_KIND: Record<string, 'person' | 'company' | 'project'> = {
  person: 'person',
  organization: 'company',
  institution: 'company',
  project: 'project',
};

interface CandidateGroup {
  query?: string;
  status?: string;
  rationale?: string;
  candidates?: { id: string; displayName: string; similarity: number }[];
}

function effective(item: ProposalItemRecord): Record<string, unknown> {
  return { ...item.new_values, ...(item.edited_values ?? {}) };
}

export async function loadProposalView(session: Session, proposalId: string): Promise<ProposalView | null> {
  const workspaceId = session.activeWorkspace.workspaceId;
  if (!UUID.test(proposalId)) return null;

  const loaded = await withUserRead(session.user.id, async (db) => {
    const found = await getProposal(db, workspaceId, proposalId).catch(() => null);
    if (!found) return null;
    const readback = await readbackProposal(db, workspaceId, proposalId);
    const capture = await db.one<{
      id: string;
      body_text: string | null;
      source_url: string | null;
      captured_at: string;
      filename: string | null;
    }>(
      `select c.id, c.body_text, c.source_url, c.captured_at, u.filename
         from public.captures c
         left join public.uploads u on u.workspace_id = c.workspace_id and u.id = c.upload_id
        where c.workspace_id = $1 and c.proposal_id = $2
        limit 1`,
      [workspaceId, proposalId],
    );
    return { ...found, readback, capture };
  });
  if (!loaded) return null;
  const { proposal, items, readback, capture } = loaded;

  // Linked records are named, never shown as ids. Resolved under the user's
  // own access rules; an id they cannot read stays unnamed.
  const ids = new Set<string>();
  for (const item of items) {
    for (const [key, value] of Object.entries({ ...(item.old_values ?? {}), ...effective(item) })) {
      if (key.endsWith('_id') && typeof value === 'string' && UUID.test(value)) ids.add(value);
    }
  }
  const names = ids.size
    ? await withUserRead(session.user.id, (db) =>
        db.rows<{ id: string; name: string | null; entity_type: string | null }>(
          `select id::text, display_name as name, entity_type from public.entities where workspace_id = $1 and id = any($2::uuid[])
           union all select id::text, title, null from public.evidence where workspace_id = $1 and id = any($2::uuid[])
           union all select id::text, name, null from public.business_units where workspace_id = $1 and id = any($2::uuid[])
           union all select id::text, full_name, 'member' from public.members where workspace_id = $1 and id = any($2::uuid[])`,
          [workspaceId, [...ids]],
        ),
      )
    : [];
  const nameOf = new Map(names.filter((n) => n.name).map((n) => [n.id, n.name as string]));
  const typeOf = new Map(names.filter((n) => n.entity_type).map((n) => [n.id, n.entity_type as string]));
  const bySeq = new Map(items.map((i) => [i.seq, i]));

  const describe = (field: string, value: unknown): string | null => {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'object' && value !== null && '$ref' in value) {
      const seq = (value as { $ref: { seq: number } }).$ref.seq;
      const target = bySeq.get(seq);
      return target ? `${displayLabel(target.label)} (new)` : null;
    }
    if (typeof value === 'string' && UUID.test(value)) return nameOf.get(value) ?? 'a stored record';
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T00:00:00(\.000)?Z$/.test(value)) return value.slice(0, 10);
    if (field === 'entity_type' && typeof value === 'string') return recordKind('entities', { entity_type: value });
    if (typeof value === 'object') return null;
    return typeof value === 'string' ? humanValue(field, value) : String(value);
  };

  const researchRows = await withUserRead(session.user.id, (db) =>
    listContactResearch(db, session.activeWorkspace.workspaceId, proposalId),
  );
  const contactModel = await contactCardsFrom(session, items, nameOf, typeOf, researchRows);
  const inCard = new Set(contactModel.cardItemIds);

  const changes: (ProposedChangeView & { band: ReviewBand })[] = items.map((item) => {
    const values = effective(item);
    const kind = recordKind(item.target_table, { ...(item.old_values ?? {}), ...values });
    const textField = TEXT_FIELDS.find((f) => typeof values[f] === 'string' && (values[f] as string).trim());
    const details = Object.keys(values)
      .filter((f) => !SYSTEM_FIELDS.has(f) && !HIDDEN_DETAILS.has(f) && f !== textField && f !== 'display_name' && f !== 'title')
      .sort((a, b) => {
        const rank = (f: string) => (DETAIL_PRIORITY.includes(f) ? DETAIL_PRIORITY.indexOf(f) : DETAIL_PRIORITY.length);
        return rank(a) - rank(b);
      })
      .filter((f) => !item.old_values || String(item.old_values[f] ?? '') !== String(values[f] ?? ''))
      .map((f) => ({ label: fieldLabel(f), value: describe(f, values[f]) }))
      .filter((d): d is { label: string; value: string } => d.value !== null && d.value.length <= 200)
      .slice(0, DETAIL_LIMIT);

    const groups = (Array.isArray(item.candidates) ? item.candidates : []) as CandidateGroup[];
    const ambiguous = groups.find((g) => g.status === 'ambiguous' && (g.candidates?.length ?? 0) > 0);
    const isName = isSubjectKind(kind) || item.target_table === 'entity_mentions';
    const match: MatchView | null = !isName
      ? null
      : item.target_table === 'entity_mentions' || item.match_status === 'ambiguous'
        ? 'ambiguous'
        : item.match_status === 'existing' || item.target_id
          ? 'existing'
          : 'new';
    const blockers = Array.isArray(item.provenance?.blockers) ? (item.provenance.blockers as string[]) : [];
    const attention = (item.reason ?? '').includes('Needs attention')
      ? (item.reason ?? '').split('Needs attention:')[1]?.trim() || 'Needs attention before it can be saved.'
      : blockers[0] ?? null;

    return {
      band: reviewBand(item.target_table, item.claim_type),
      id: item.id,
      number: item.seq,
      action: opVerb(item.op),
      kind,
      title: displayLabel(item.label),
      text: textField ? shorten(String(values[textField])) : null,
      details,
      // On people, companies and links the claim label is shown only when it is an
      // inference; "fact" or "gap" on a record would read as a statement about it.
      claim:
        item.claim_type &&
        CLAIM_MEANING[item.claim_type] &&
        (reviewBand(item.target_table, item.claim_type) !== 'record' || item.claim_type === 'inference')
          ? CLAIM_MEANING[item.claim_type]!
          : null,
      confidence: item.confidence,
      match,
      matchNote:
        match === 'existing'
          ? 'Already in memory: this updates or links the stored record.'
          : match === 'new'
            ? 'Not in memory yet: saving creates it.'
            : match === 'ambiguous'
              ? (ambiguous?.rationale ??
                (typeof values.rationale === 'string' ? values.rationale : null) ??
                'A similar name is already in memory. It is not merged; confirm it later in Knowledge.')
              : null,
      candidates: candidatesFor(ambiguous, values, nameOf),
      decision: (item.decision as ProposedChangeView['decision']) ?? 'pending',
      saved: Boolean(item.applied_at),
      needsAttention: item.applied_at ? null : attention,
      needs: item.depends_on_seq ?? [],
      kindLabel: kindLabelFor(item.target_table, values, kind),
      inContactCard: inCard.has(item.id),
      fromResearch: Boolean((item.provenance as { from_research?: boolean })?.from_research),
      sources: Array.isArray((item.provenance as { source_urls?: unknown })?.source_urls)
        ? ((item.provenance as { source_urls: string[] }).source_urls ?? []).filter((u) => typeof u === 'string' && /^https?:\/\//.test(u)).slice(0, 5)
        : [],
    };
  });

  const groups = REVIEW_BAND_ORDER.map((band) => ({
    band,
    ...REVIEW_BANDS[band],
    changes: changes.filter((c) => c.band === band).map(({ band: _band, ...rest }) => rest),
  })).filter((g) => g.changes.length > 0);

  const mentions = mentionsFrom(items, nameOf, typeOf);

  // Where it happened ("at Cannes"). A place is context, not a record, so it is
  // read from the analysis rather than from a stored event.
  // What the analysis itself said: where it happened (a place is context, not a
  // record), and -- for a document -- what stays source-only and what research
  // would help. Read from the run's own stages; nothing here is knowledge.
  const analysis = capture
    ? await withUserRead(session.user.id, async (db) =>
        db.rows<{ stage: string; output: Record<string, unknown> | null }>(
          `select s.stage, s.output from public.run_stages s
             join public.captures c on c.run_id = s.run_id and c.workspace_id = s.workspace_id
            where s.workspace_id = $1 and c.id = $2 and s.stage in ('extract', 'classify')`,
          [workspaceId, capture.id],
        ),
      ).catch(() => [])
    : [];
  const extractOutput = (analysis.find((row) => row.stage === 'extract')?.output ?? {}) as {
    extraction?: { mentions?: { name: string; kind: string }[] } | null;
    /** The note budget's leftovers, for a capture that is not a document. */
    note?: {
      source_only?: { label: string; why: string }[];
      research_recommendations?: { subject: string; why: string }[];
    } | null;
    document?: {
      source_only?: { label: string; why: string }[];
      research_recommendations?: { subject: string; why: string }[];
    } | null;
  };
  const classifyOutput = (analysis.find((row) => row.stage === 'classify')?.output ?? {}) as {
    classification?: { description?: string } | null;
  };
  const places = (extractOutput.extraction?.mentions ?? []).filter((m) => m.kind === 'event').map((m) => m.name);
  // "Kept in your source" and "Research recommended" are not document-only: a
  // note is budgeted too, and its gaps are the only place a note-shaped capture
  // can offer research. A mixed capture contributes both, with the document's
  // items first because that is the order the review reads in.
  const noteOnly = extractOutput.note?.source_only ?? [];
  const noteResearch = extractOutput.note?.research_recommendations ?? [];
  const docOnly = extractOutput.document?.source_only ?? [];
  const docResearch = extractOutput.document?.research_recommendations ?? [];
  const sourceOnly = [...docOnly, ...noteOnly];
  const researchRecommendations = [...docResearch, ...noteResearch];
  const documentContext =
    extractOutput.document || sourceOnly.length > 0 || researchRecommendations.length > 0
      ? {
          readAs: classifyOutput.classification?.description ?? null,
          sourceOnly,
          researchRecommendations,
        }
      : null;

  const storedIds = contactModel.cards.map((c) => (c.match === 'existing' ? c.entityId : null)).filter((id): id is string => Boolean(id));
  const memberIds = contactModel.cards.map((c) => c.memberId).filter((id): id is string => Boolean(id));
  const storedLines = new Map<string, string>(
    storedIds.length
      ? (
          await withUserRead(session.user.id, (db) =>
            db.rows<{ id: string; line: string }>(
              `select distinct on (a.person_entity_id) a.person_entity_id::text as id,
                      case when coalesce(a.role_title, '') <> '' then a.role_title || ' at ' || o.display_name else 'Works at ' || o.display_name end as line
                 from public.entity_affiliations a
                 join public.entities o on o.id = a.organization_entity_id
                where a.workspace_id = $1 and a.is_current and a.person_entity_id = any($2::uuid[])
                order by a.person_entity_id, a.updated_at desc`,
              [workspaceId, storedIds],
            ),
          )
        ).map((r) => [r.id, r.line] as [string, string])
      : [],
  );
  // A colleague's role inside Globa 3, only when memory holds one.
  for (const row of memberIds.length
    ? await withUserRead(session.user.id, (db) =>
        db.rows<{ id: string; line: string | null }>(
          `select id::text, coalesce(nullif(trim(role_title), ''), nullif(trim(role), '')) as line
             from public.members where workspace_id = $1 and id = any($2::uuid[])`,
          [workspaceId, memberIds],
        ),
      )
    : []) {
    if (row.line) storedLines.set(row.id, `${row.line}, Globa 3`);
  }
  const attentionOf = new Map(changes.map((c) => [c.id, c.needsAttention]));
  const confirmation = capture
    ? buildConfirmation({
        title: displayLabel(proposal.title),
        proposalSummary: proposal.summary,
        capturedAt: capture.captured_at,
        timeZone: session.activeWorkspace.timezone || 'UTC',
        items,
        cards: contactModel.cards,
        places: [...places, ...mentions.filter((m) => m.kind === 'Event').map((m) => m.name)],
        researchRows,
        nameOf,
        storedLines,
        needsAttention: (item) => Boolean(attentionOf.get(item.id)),
        // An optional item can be turned on alone, so it must carry whatever it
        // needs with it.
        withDependencies: (itemId) => {
          const bySeq = new Map(items.map((i) => [i.seq, i]));
          const byId = new Map(items.map((i) => [i.id, i]));
          const out = new Set<string>();
          const walk = (id: string) => {
            const item = byId.get(id);
            if (!item || out.has(id) || item.applied_at) return;
            out.add(id);
            for (const seq of item.depends_on_seq ?? []) {
              const needed = bySeq.get(seq);
              if (needed) walk(needed.id);
            }
          };
          walk(itemId);
          return [...out];
        },
        documentContext,
      })
    : null;
  const researchable: ProposalView['researchable'] = mentions
    .map((m) => ({ label: m.name, kind: RESEARCH_KIND[kindToEntityType(m.kind)], entityId: m.entityId }))
    .filter((r): r is ProposalView['researchable'][number] => Boolean(r.kind));

  return {
    id: proposal.id,
    title: displayLabel(proposal.title),
    summary: proposal.summary,
    statusLabel: proposalStatusLabel(proposal.status),
    version: proposal.version,
    isMock: proposal.is_mock,
    sourceLabel: proposalSourceLabel(proposal.source_kind),
    canApprove: session.activeWorkspace.canApprove,
    capture: capture
      ? {
          id: capture.id,
          text: capture.body_text,
          filename: capture.filename,
          url: capture.source_url,
          capturedAt: capture.captured_at,
        }
      : null,
    counts: {
      total: items.length,
      awaiting: items.filter((i) => i.decision === 'pending' && !i.applied_at).length,
      approved: items.filter((i) => i.decision === 'approved' && !i.applied_at).length,
      saved: items.filter((i) => i.applied_at).length,
      rejected: items.filter((i) => i.decision === 'rejected').length,
    },
    groups,
    mentions,
    contacts: contactModel.cards,
    researchActive: researchRows.some((r) => ['identifying', 'researching'].includes(r.status)),
    saved: readback.map((entry) => ({
      label: plainTitle(entry.label),
      kind: recordKind(entry.table, entry.current),
      verb: entry.op === 'update' ? 'Updated' : entry.op === 'link' ? 'Linked' : 'Saved',
      savedAt: entry.appliedAt,
    })),
    researchable,
    confirmation,
  };
}


function kindToEntityType(kind: RecordKind): string {
  return kind === 'Person' ? 'person' : kind === 'Company' ? 'organization' : kind === 'Organisation' ? 'institution' : kind === 'Project' ? 'project' : '';
}

function similarityFrom(text: unknown): number | null {
  const match = typeof text === 'string' ? /at (0\.\d+|1(?:\.0+)?)/.exec(text) : null;
  return match ? Math.round(Number(match[1]) * 100) : null;
}

function candidatesFor(
  group: CandidateGroup | undefined,
  values: Record<string, unknown>,
  nameOf: Map<string, string>,
): { name: string; similarity: number | null }[] {
  if (group?.candidates?.length) {
    return group.candidates.slice(0, 4).map((c) => ({ name: c.displayName, similarity: Math.round(c.similarity * 100) }));
  }
  const id = values.candidate_entity_id;
  if (typeof id === 'string' && nameOf.has(id)) {
    return [{ name: nameOf.get(id)!, similarity: similarityFrom(values.rationale) }];
  }
  return [];
}

/**
 * Who and what a proposal names, and how each matched memory:
 *   existing  -- an exact name or recorded alias; changes link to the stored record;
 *   new       -- nothing similar in memory; saving creates it;
 *   ambiguous -- a similar name exists; staged as an unconfirmed name, never merged.
 */
function mentionsFrom(
  items: ProposalItemRecord[],
  nameOf: Map<string, string>,
  typeOf: Map<string, string>,
): MentionView[] {
  const out = new Map<string, MentionView>();
  const add = (mention: MentionView) => {
    const key = mention.name.toLowerCase();
    const current = out.get(key);
    // An explicit new or unconfirmed record outranks a mere reference.
    if (!current || (current.match === 'existing' && mention.match !== 'existing' && !current.entityId)) out.set(key, mention);
  };

  for (const item of items) {
    const values = { ...(item.old_values ?? {}), ...effective(item) };
    if (item.target_table === 'entities') {
      const existing = Boolean(item.target_id);
      add({
        name: displayLabel(String(values.display_name ?? item.label)),
        kind: recordKind('entities', values),
        match: existing ? 'existing' : 'new',
        note: existing ? 'Already in memory.' : 'Not in memory yet: approving creates it.',
        candidates: [],
        entityId: item.target_id ?? item.applied_row_id ?? null,
      });
    } else if (item.target_table === 'entity_mentions') {
      add({
        name: displayLabel(String(values.mention_text ?? item.label)),
        kind: recordKind('entities', { entity_type: values.proposed_entity_type }),
        match: 'ambiguous',
        note:
          typeof values.rationale === 'string'
            ? values.rationale
            : 'A similar name is already in memory. It is not merged.',
        candidates: candidatesFor(undefined, values, nameOf),
        entityId: null,
      });
    }
  }
  for (const item of items) {
    const values = { ...(item.old_values ?? {}), ...effective(item) };
    for (const field of SUBJECT_FIELDS) {
      if (field === 'candidate_entity_id') continue;
      const id = values[field];
      if (typeof id !== 'string' || !UUID.test(id) || !nameOf.has(id) || !typeOf.has(id)) continue;
      const name = nameOf.get(id)!;
      if (out.has(name.toLowerCase())) continue;
      add({
        name,
        kind: recordKind('entities', { entity_type: typeOf.get(id) }),
        match: 'existing',
        note: 'Already in memory: the proposed changes link to it.',
        candidates: [],
        entityId: id,
      });
    }
  }
  return [...out.values()];
}

function shorten(text: string): string {
  // Notes are written by the person reading them: "the writer" is "you".
  const clean = text.trim().replace(/\bThe writer\b/g, 'You').replace(/\bthe writer\b/g, 'you');
  return clean.length > TEXT_LIMIT ? `${clean.slice(0, TEXT_LIMIT - 1).trimEnd()}…` : clean;
}

function kindLabelFor(table: string, values: Record<string, unknown>, kind: RecordKind): string {
  if (table === 'evidence') return 'Your original note';
  if (table === 'entity_aliases') {
    const type = String(values.alias_type ?? '');
    return type === 'email' ? 'Email address' : type === 'phone' ? 'Phone number' : type === 'linkedin' ? 'LinkedIn profile' : 'Alternative name';
  }
  if (table === 'entity_affiliations') return 'Organisation and role';
  if (table === 'entities' && values.relationship_status === 'contact') return 'External contact';
  if (table === 'entity_mentions') return 'Possible match, not merged';
  if (table === 'actions') return 'Follow-up';
  return kind;
}

const PERSON_REF_FIELDS = ['entity_id', 'person_entity_id', 'external_entity_id', 'related_entity_id'];

/**
 * The relationship cards at the top of a capture proposal.
 *
 * A card is made for each person the note says you were in contact with: a new
 * person proposed as an external contact, a stored person being marked as one,
 * a stored person an interaction links to, or an unconfirmed name staged from a
 * contact. "What we still need" lists what neither the note nor memory holds;
 * nothing is filled in by guessing.
 */
async function contactCardsFrom(
  session: Session,
  items: ProposalItemRecord[],
  nameOf: Map<string, string>,
  typeOf: Map<string, string>,
  researchRows: ContactResearchRecord[] = [],
): Promise<{ cards: ContactCardView[]; cardItemIds: string[] }> {
  type Subject = { key: string; name: string; match: MatchView; entityId: string | null; seq: number | null; coreItemId: string | null; candidates: ContactCardView['candidates'] };
  const subjects: Subject[] = [];
  const bySeq = new Map(items.map((i) => [i.seq, i]));

  for (const item of items) {
    const values = { ...(item.old_values ?? {}), ...effective(item) };
    if (item.target_table === 'entities' && values.relationship_status === 'contact') {
      subjects.push({
        key: item.target_id ?? `seq:${item.seq}`,
        name: displayLabel(String(values.display_name ?? item.label)),
        match: item.target_id ? 'existing' : 'new',
        entityId: item.target_id ?? item.applied_row_id ?? null,
        seq: item.seq,
        coreItemId: item.id,
        candidates: [],
      });
    } else if (item.target_table === 'entity_mentions' && values.created_from === 'capture_contact') {
      subjects.push({
        key: `mention:${item.seq}`,
        name: displayLabel(String(values.mention_text ?? item.label)),
        match: 'ambiguous',
        entityId: null,
        seq: null,
        coreItemId: item.id,
        candidates: candidatesFor(undefined, values, nameOf),
      });
    }
  }
  // A colleague: the note's interaction is linked to them as an internal member,
  // and nothing external was proposed.
  for (const item of items.filter((i) => i.target_table === 'interactions')) {
    const memberId = effective(item).internal_owner_member_id;
    if (typeof memberId === 'string' && UUID.test(memberId) && !subjects.some((s) => s.key === memberId)) {
      subjects.push({
        key: memberId,
        name: nameOf.get(memberId) ?? 'A Globa 3 member',
        match: 'member',
        entityId: null,
        seq: null,
        coreItemId: null,
        candidates: [],
      });
    }
  }
  // A stored person an interaction links to, already marked as a contact.
  for (const item of items.filter((i) => i.target_table === 'interactions')) {
    const id = effective(item).external_entity_id;
    if (typeof id === 'string' && UUID.test(id) && typeOf.get(id) === 'person' && !subjects.some((s) => s.key === id)) {
      subjects.push({ key: id, name: nameOf.get(id) ?? 'A stored person', match: 'existing', entityId: id, seq: null, coreItemId: null, candidates: [] });
    }
  }
  if (subjects.length === 0) return { cards: [], cardItemIds: [] };

  const pointsAt = (values: Record<string, unknown>, subject: Subject): boolean =>
    PERSON_REF_FIELDS.some((f) => {
      const v = values[f];
      if (subject.entityId && v === subject.entityId) return true;
      return subject.seq !== null && typeof v === 'object' && v !== null && '$ref' in v && (v as { $ref: { seq: number } }).$ref.seq === subject.seq;
    });

  // What memory already holds for stored contacts, so "missing" is honest.
  const storedIds = subjects.map((s) => s.entityId).filter((id): id is string => Boolean(id));
  const stored = storedIds.length
    ? await withUserRead(session.user.id, (db) =>
        db.rows<{ id: string; affiliations: number; roles: number; details: number; findings: number; actions: number }>(
          `select e.id,
                  (select count(*)::int from public.entity_affiliations a where a.person_entity_id = e.id) as affiliations,
                  (select count(*)::int from public.entity_affiliations a where a.person_entity_id = e.id and coalesce(a.role_title, '') <> '') as roles,
                  (select count(*)::int from public.entity_aliases x where x.entity_id = e.id and x.alias_type in ('email', 'phone', 'linkedin')) as details,
                  (select count(*)::int from public.research_findings f where f.related_entity_id = e.id and f.finding_type in ('fact', 'inference')) as findings,
                  (select count(*)::int from public.actions t where t.related_entity_id = e.id) as actions
             from public.entities e
            where e.workspace_id = $1 and e.id = any($2::uuid[])`,
          [session.activeWorkspace.workspaceId, storedIds],
        ),
      )
    : [];
  const storedBy = new Map(stored.map((r) => [r.id, r]));

  const cardItemIds: string[] = [];
  const cards = subjects.map((subject): ContactCardView => {
    // An unconfirmed name is never linked, so its interactions and statements
    // are found by the name written in them instead.
    const mentionsName = (i: ProposalItemRecord) => {
      const v = effective(i);
      const text = `${String(v.subject ?? '')} ${String(v.summary ?? '')} ${String(v.title ?? '')}`.toLowerCase();
      return text.includes(subject.name.toLowerCase());
    };
    const related = items.filter(
      (i) =>
        pointsAt({ ...(i.old_values ?? {}), ...effective(i) }, subject) ||
        (subject.match === 'ambiguous' && ['interactions', 'research_findings', 'actions'].includes(i.target_table) && mentionsName(i)),
    );
    const fromNote: string[] = [];
    const fromResearch: string[] = [];
    const basic = new Set<string>(subject.coreItemId ? [subject.coreItemId] : []);
    let organisation = false;
    let role = false;
    let details = false;
    let why = false;
    let followUp = false;

    for (const item of related) {
      const v = effective(item);
      const researched = Boolean((item.provenance as { from_research?: boolean })?.from_research);
      const lines = researched ? fromResearch : fromNote;
      if (researched) {
        if (item.target_table === 'research_findings') fromResearch.push(`${String(v.finding_type) === 'fact' ? 'Fact' : String(v.finding_type) === 'inference' ? 'Inference' : String(v.finding_type) === 'gap' ? 'Still unknown' : 'Suggestion'}: ${String(v.title ?? item.label)}`);
      }
      if (item.target_table === 'interactions' && typeof v.summary === 'string') lines.push(v.summary);
      if (item.target_table === 'entity_affiliations') {
        organisation = true;
        if (!researched) basic.add(item.id);
        const org = v.organization_entity_id;
        const orgName =
          typeof org === 'string' ? nameOf.get(org) : typeof org === 'object' && org && '$ref' in org ? bySeq.get((org as { $ref: { seq: number } }).$ref.seq)?.label : null;
        if (typeof v.role_title === 'string' && v.role_title) role = true;
        lines.push(`${typeof v.role_title === 'string' && v.role_title ? `${v.role_title}, ` : 'Works at '}${orgName ?? 'an organisation'}`);
      }
      if (item.target_table === 'entity_aliases' && ['email', 'phone', 'linkedin'].includes(String(v.alias_type))) {
        details = true;
        if (!researched) basic.add(item.id);
        lines.push(`${String(v.alias_type) === 'email' ? 'Email' : String(v.alias_type) === 'phone' ? 'Phone' : 'LinkedIn'}: ${String(v.alias)}`);
      }
      if (item.target_table === 'research_findings' && ['fact', 'inference'].includes(String(v.finding_type))) why = true;
      if (item.target_table === 'opportunities') why = true;
      if (item.target_table === 'actions') followUp = true;
    }
    const memory = subject.entityId ? storedBy.get(subject.entityId) : undefined;
    if (memory) {
      organisation ||= memory.affiliations > 0;
      role ||= memory.roles > 0;
      details ||= memory.details > 0;
      why ||= memory.findings > 0;
      followUp ||= memory.actions > 0;
    }

    const unknown = subject.match === 'ambiguous' ? 'held back until confirmed' : 'unknown';
    const missing = subject.match === 'member' ? [] : [
      !organisation ? { label: 'Organisation', value: unknown } : null,
      !role ? { label: 'Role', value: unknown } : null,
      !details ? { label: 'Contact details', value: unknown } : null,
      !why ? { label: 'Why this relationship matters', value: unknown } : null,
      !followUp ? { label: 'Follow-up', value: 'not specified' } : null,
    ].filter((m): m is { label: string; value: string } => m !== null);

    if (subject.coreItemId) cardItemIds.push(subject.coreItemId);
    const key = slugify(subject.name);
    const row = researchRows.find((r) => r.contact_key === key) ?? null;
    const opportunity = items.some((i) => i.target_table === 'opportunities' && !i.applied_at);
    const researchReasons = subject.match === 'member' ? [] : [
      subject.match === 'new' && (!organisation || !role)
        ? 'This is a new contact and we do not yet know their organisation or role.'
        : null,
      opportunity ? 'Your note mentions a possible commercial opportunity.' : null,
      followUp && related.some((i) => i.target_table === 'actions') ? 'A follow-up is proposed; knowing more about them helps you prepare.' : null,
      row?.important ? 'You marked this contact as important.' : null,
      subject.match === 'ambiguous'
        ? 'The name is close to someone already in memory; clues from your note may tell them apart.'
        : null,
    ].filter((r): r is string => r !== null);
    return {
      key,
      important: row?.important ?? false,
      researchReasons,
      research: row ? researchViewOf(row) : null,
      fromResearch: [...new Set(fromResearch)],
      name: subject.name,
      match: subject.match,
      matchLabel:
        subject.match === 'new'
          ? 'New external contact'
          : subject.match === 'existing'
            ? 'Existing external contact'
            : subject.match === 'member'
              ? 'Existing Globa 3 member'
              : 'Possible match, not merged',
      needsMoreInfo: missing.length >= 3,
      candidates: subject.candidates,
      fromNote: [...new Set(fromNote)],
      missing,
      basicChangeIds: [...basic].filter((id) => !items.find((i) => i.id === id)?.applied_at),
      entityId: subject.entityId,
      memberId: subject.match === 'member' ? subject.key : null,
      coreItemId: subject.coreItemId,
    };
  });
  return { cards, cardItemIds };
}

const RESEARCH_STATUS_LABELS: Record<ContactResearchRecord['status'], string> = {
  not_started: 'Not researched',
  identifying: 'Looking for who this could be',
  awaiting_confirmation: 'Is this the person you met?',
  no_reliable_match: 'No reliable match found',
  none_of_these: 'None of the candidates -- nothing researched',
  needs_context: 'Waiting for more context',
  researching: 'Researching the confirmed person',
  completed: 'Research added to this review',
  failed: 'Research stopped',
};

function researchViewOf(row: ContactResearchRecord): ContactResearchView {
  const candidates = Array.isArray(row.candidates) ? row.candidates : [];
  return {
    status: row.status,
    statusLabel: RESEARCH_STATUS_LABELS[row.status],
    message: row.status_detail,
    active: row.status === 'identifying' || row.status === 'researching',
    candidates:
      row.status === 'awaiting_confirmation'
        ? candidates.map((c, index) => ({
            index,
            name: c.name,
            organization: c.organization,
            role: c.role,
            location: c.location,
            explanation: c.explanation,
            matches: c.matches_clues ?? [],
            conflicts: c.conflicts_with_clues ?? [],
            // Matches nothing but the name: shown, never recommended.
            nameOnly: (c.matches_clues ?? []).length === 0,
            confidence: c.confidence,
            sources: (c.sources ?? []).filter((s) => /^https?:\/\//.test(s.url)).slice(0, 4),
          }))
        : [],
    confirmed: row.confirmed_candidate
      ? { name: row.confirmed_candidate.name, organization: row.confirmed_candidate.organization, role: row.confirmed_candidate.role }
      : null,
    itemsAdded: row.items_added,
  };
}
