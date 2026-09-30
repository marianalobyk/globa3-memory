/**
 * Structured contracts between the pipelines and the model.
 *
 * Every schema is "closed": all properties required, nullable instead of
 * optional, no free-form dictionaries. That is what the OpenAI structured-output
 * mode requires, and it also means a malformed model response is rejected at the
 * boundary rather than half-written into the database.
 *
 * Hidden model reasoning is deliberately not part of any contract. What is
 * persisted is the claim, its provenance, its dates and its verification state.
 */
import { z } from 'zod';

export const ClaimType = z.enum(['fact', 'inference', 'recommendation', 'next_step', 'gap', 'risk']);
export type ClaimType = z.infer<typeof ClaimType>;

export const Confidence = z.enum(['high', 'medium', 'low']);
export type Confidence = z.infer<typeof Confidence>;

export const SourceTier = z.enum(['tier1_primary', 'tier2_independent', 'tier3_supporting', 'unknown']);

export const SourceRef = z.object({
  url: z.string().describe('Direct http(s) URL. Never a placeholder.'),
  title: z.string(),
  publisher: z.string().nullable(),
  source_tier: SourceTier,
  published_date: z.string().nullable().describe('YYYY-MM-DD of publication, or null if unknown.'),
  event_date: z.string().nullable().describe('YYYY-MM-DD the underlying event happened, tracked separately from publication.'),
  is_press_release: z.boolean(),
  quality_label: z.string().nullable(),
  verification_note: z.string().nullable(),
});
export type SourceRef = z.infer<typeof SourceRef>;

/** A named person, organisation, project, event or institution found in material. */
export const MentionedEntity = z.object({
  name: z.string(),
  entity_type: z.enum(['person', 'organization', 'project', 'institution', 'event', 'other']),
  role_or_context: z.string().nullable(),
  affiliation: z.string().nullable().describe('Organisation this person is connected to, if stated.'),
  why_relevant: z.string(),
  source_urls: z.array(z.string()),
});
export type MentionedEntity = z.infer<typeof MentionedEntity>;

export const ScoreBreakdown = z.object({
  dimension: z.string(),
  score: z.number().int().min(0).max(5),
  rationale: z.string(),
});

/** One candidate in the internal ledger, before editorial selection. */
export const CandidateSignal = z.object({
  fingerprint: z.string().describe('Stable short slug for deduplication across runs.'),
  headline: z.string(),
  lane: z.string(),
  what_happened: z.string(),
  why_it_matters: z.string(),
  classification: z.string(),
  freshness_label: z.string(),
  scores: z.array(ScoreBreakdown),
  total_score: z.number().int().min(0).max(25),
  tier: z.string().describe('Priority tier from the format thresholds, e.g. P1 / Radar / Watch / Exclude.'),
  confidence: Confidence,
  external_use_status: z.string(),
  recommended_action: z.string(),
  decision_question: z.string().nullable(),
  entities: z.array(MentionedEntity),
  sources: z.array(SourceRef),
  unknowns: z.array(z.string()),
  excluded_reason: z.string().nullable(),
});
export type CandidateSignal = z.infer<typeof CandidateSignal>;

export const LaneOutcome = z.object({
  lane: z.string(),
  searched: z.boolean(),
  found_count: z.number().int().min(0),
  note: z.string(),
});

/** Stage 2 output: the research ledger. */
export const ResearchLedger = z.object({
  lane_outcomes: z.array(LaneOutcome),
  candidates: z.array(CandidateSignal),
  coverage_note: z.string(),
  research_status: z.enum(['full', 'partial', 'failed']),
  limitations: z.array(z.string()),
});
export type ResearchLedger = z.infer<typeof ResearchLedger>;

/** Stage 3 output: the reader-facing brief. */
export const BriefDraft = z.object({
  title: z.string(),
  output_mode: z.string(),
  body_md: z.string().describe('The complete reader-facing brief in Markdown, following the format structure.'),
  sections_present: z.array(z.string()),
  word_count: z.number().int().min(0),
});
export type BriefDraft = z.infer<typeof BriefDraft>;

/** Stage 4 output: the QA and release gate. */
export const QaCheckResult = z.object({
  key: z.string(),
  passed: z.boolean(),
  severity: z.enum(['critical', 'major', 'minor']),
  note: z.string(),
});
export const QaVerdict = z.object({
  checks: z.array(QaCheckResult),
  release_status: z.enum([
    'pass_internal_only',
    'pass_quiet_window_internal_only',
    'review_internal_only',
    'fail_do_not_distribute',
  ]),
  summary: z.string(),
  required_corrections: z.array(z.string()),
});
export type QaVerdict = z.infer<typeof QaVerdict>;

/** Stage 5 output: what is worth researching next, and what is missing. */
export const ProposedResearchTopic = z.object({
  label: z.string(),
  target_type: z.enum(['person', 'company', 'project', 'topic', 'opportunity', 'event', 'institution']),
  priority: z.enum(['high', 'medium', 'low', 'skip']),
  research_question: z.string(),
  why_useful: z.string(),
  business_unit_hint: z.string().nullable(),
  source_urls: z.array(z.string()),
});
export type ProposedResearchTopic = z.infer<typeof ProposedResearchTopic>;

export const BriefExtraction = z.object({
  entities: z.array(MentionedEntity),
  findings: z.array(
    z.object({
      title: z.string(),
      content: z.string(),
      claim_type: ClaimType,
      confidence: Confidence,
      subject_name: z.string().nullable(),
      source_urls: z.array(z.string()),
    }),
  ),
  gaps: z.array(z.object({ question: z.string(), why_it_matters: z.string() })),
  proposed_topics: z.array(ProposedResearchTopic),
});
export type BriefExtraction = z.infer<typeof BriefExtraction>;

/** Deep research on one selected topic. */
export const DeepResearchResult = z.object({
  topic_label: z.string(),
  summary: z.string(),
  brief_claim_assessment: z
    .enum(['confirmed', 'partially_confirmed', 'not_confirmed', 'not_applicable'])
    .describe('How well the original brief claim held up against primary sources.'),
  facts: z.array(
    z.object({
      statement: z.string(),
      as_of_date: z.string().nullable(),
      confidence: Confidence,
      source_urls: z.array(z.string()),
    }),
  ),
  inferences: z.array(z.object({ statement: z.string(), based_on: z.string(), confidence: Confidence })),
  recommendations: z.array(z.object({ statement: z.string(), rationale: z.string(), decision_supported: z.string() })),
  risks: z.array(z.object({ statement: z.string(), severity: z.enum(['high', 'medium', 'low']) })),
  gaps: z.array(z.object({ question: z.string(), why_it_matters: z.string() })),
  controller_or_decision_makers: z.array(MentionedEntity),
  entities: z.array(MentionedEntity),
  sources: z.array(SourceRef),
  confidence: Confidence,
  depth_standard_met: z.boolean(),
  depth_note: z.string(),
});
export type DeepResearchResult = z.infer<typeof DeepResearchResult>;

/**
 * A proposed database change, as the model suggests it. The server resolves
 * entities, computes old/new values and decides the final target itself; the
 * model never supplies a row id.
 */
export const ProposedChange = z.object({
  op: z.enum(['create', 'update', 'link', 'attach', 'skip']),
  target_table: z.enum([
    'entities', 'entity_aliases', 'entity_affiliations', 'entity_mentions',
    'evidence', 'research_artifacts', 'research_findings',
    'interactions', 'actions', 'signals', 'signal_entities',
    'opportunities', 'outcomes', 'research_topics', 'research_finding_evidence',
  ]),
  label: z.string().describe('Human-readable name of the record, e.g. the person or the finding title.'),
  claim_type: ClaimType.nullable(),
  confidence: Confidence.nullable(),
  reason: z.string(),
  /** Field values as a list, because structured-output mode forbids open maps. */
  fields: z.array(z.object({ name: z.string(), value: z.string().nullable() })),
  /** Names of other proposed records this one depends on, matched by label. */
  source_urls: z.array(z.string()),
});
export type ProposedChange = z.infer<typeof ProposedChange>;

export const CaptureProposal = z.object({
  title: z.string(),
  summary: z.string(),
  changes: z.array(ProposedChange),
  unresolved_mentions: z.array(
    z.object({
      name: z.string(),
      entity_type: z.string(),
      why_unresolved: z.string(),
      possible_matches: z.array(z.string()),
    }),
  ),
  notes: z.array(z.string()),
});
export type CaptureProposal = z.infer<typeof CaptureProposal>;

/**
 * Capture analysis: a strictly structured draft of what one captured source
 * (a note, a pasted URL, a file) actually says.
 *
 * Every array is "only what the source supports". Names are copied as written;
 * the server resolves them against memory afterwards, so the model never
 * decides whether a name is an existing record. Structured-output mode forbids
 * optional fields, so absent values are null and absent lists are empty.
 */
const CaptureNameKind = z.enum(['person', 'organization', 'project', 'institution', 'event', 'other']);

export const CaptureExtraction = z.object({
  title: z.string().describe('A short neutral title for the source, at most 80 characters.'),
  summary: z.string().describe('Two sentences at most, restating only what the source says.'),
  mentions: z.array(
    z.object({
      name: z.string().describe('The name exactly as written in the source.'),
      kind: CaptureNameKind,
      context: z.string().nullable().describe('Role or context stated in the source, if any.'),
    }),
  ),
  contacts: z
    .array(
      z.object({
        name: z.string().describe('A person the writer actually met, spoke to, called, emailed, messaged or was introduced to, exactly as written.'),
        how: z
          .enum(['met', 'introduced', 'spoke', 'called', 'emailed', 'messaged', 'other'])
          .describe('How the writer was in contact, as the source says it.'),
        organization: z.string().nullable().describe('Organisation the source states for this person, else null.'),
        role: z.string().nullable().describe('Role or title the source states, else null.'),
        email: z.string().nullable().describe('Email address written in the source, else null.'),
        phone: z.string().nullable().describe('Phone number written in the source, else null.'),
        linkedin: z.string().nullable().describe('LinkedIn URL written in the source, else null.'),
        why_it_matters: z
          .string()
          .nullable()
          .describe('Why this relationship matters, only if the source states an interest, need or purpose; else null.'),
      }),
    )
    .describe('People the writer was personally in contact with. Not people who are only talked about.'),
  facts: z.array(
    z.object({
      statement: z
        .string()
        .describe(
          'Durable information the source states directly: an interest, role, need, plan or commitment. Never a restatement that the contact or meeting happened.',
        ),
      about: z.array(z.string()).describe('Names from mentions this statement is about.'),
      confidence: Confidence,
    }),
  ),
  inferences: z.array(
    z.object({
      statement: z.string().describe('A reasonable reading of the source that it does not state directly.'),
      about: z.array(z.string()),
      based_on: z.string().describe('The words in the source this reading rests on.'),
      confidence: Confidence,
    }),
  ),
  recommendations: z.array(
    z.object({
      statement: z.string(),
      about: z.array(z.string()),
      rationale: z.string(),
    }),
  ),
  interactions: z.array(
    z.object({
      subject: z.string().describe('Short, e.g. "Met David Beckham". Not "Meeting with" unless the source says it was a meeting.'),
      summary: z
        .string()
        .describe('Addressed to the writer as "You", e.g. "You met David Beckham today." Never "the speaker", "the user" or "the author".'),
      interaction_type: z
        .enum(['introduction', 'encounter', 'meeting', 'call', 'conversation', 'email', 'message', 'event', 'other'])
        .describe('"meeting" only when the source calls it a meeting; "met X" is an encounter.'),
      occurred_on: z
        .string()
        .nullable()
        .describe('YYYY-MM-DD only when the source states or clearly implies when it happened.'),
      with_names: z.array(z.string()),
    }),
  ),
  actions: z.array(
    z.object({
      title: z.string().describe('A follow-up or next step the source actually states or asks for.'),
      description: z.string().nullable(),
      due_on: z.string().nullable().describe('YYYY-MM-DD when the source gives timing; for a month, its first day.'),
      related_names: z.array(z.string()),
    }),
  ),
  relationships: z.array(
    z.object({
      person: z.string(),
      organization: z.string(),
      role: z.string().nullable(),
      statement: z.string(),
      claim: z.enum(['fact', 'inference']),
    }),
  ),
  opportunities: z.array(
    z.object({
      title: z.string(),
      description: z.string(),
      related_names: z.array(z.string()),
      basis: z.string().describe('The words in the source that suggest the opening.'),
      claim: z.enum(['inference', 'recommendation']),
    }),
  ),
  gaps: z.array(z.object({ question: z.string(), why_it_matters: z.string() })),
});
export type CaptureExtraction = z.infer<typeof CaptureExtraction>;

/**
 * Second look at a capture draft, with a small slice of what memory already
 * holds about the names that resolved. The model does not decide identity; it
 * only points out what is already stored, what contradicts memory, why a
 * possible match needs review, and which follow-ups would help.
 */
export const CaptureContextReview = z.object({
  already_stored_fact_numbers: z
    .array(z.number().int())
    .describe('Numbers of draft facts that memory already holds (same meaning, not just similar topic).'),
  contradictions: z.array(
    z.object({
      name: z.string().describe('The record the contradiction is about, as named in memory.'),
      note_says: z.string(),
      memory_says: z.string(),
    }),
  ),
  match_explanations: z.array(
    z.object({
      name: z.string().describe('A name that is a possible match, as written in the note.'),
      explanation: z.string().describe('What in the note and memory makes the match uncertain. No verdict.'),
    }),
  ),
  follow_up_suggestions: z.array(
    z.object({
      statement: z.string().describe('A concrete next step, as a suggestion to the reader.'),
      about: z.array(z.string()),
      rationale: z.string(),
    }),
  ),
});
export type CaptureContextReview = z.infer<typeof CaptureContextReview>;

/**
 * What a research run was asked to do.
 *
 * Two origins, and the worker must never have to guess which it is holding:
 * a brief queues topics from a generated document, a capture queues the
 * questions a person selected on a capture review. Loose optional fields made
 * that a matter of inspection; a discriminated union makes it a matter of type.
 *
 * Runs created before this schema existed carry `{ briefDocumentId, topicIds }`
 * with no `kind`. `parseResearchRunInput` below reads those as briefs, so no
 * queued run is stranded by the change.
 */
export const ResearchRunInput = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('brief'),
    briefDocumentId: z.string().uuid(),
    topicIds: z.array(z.string().uuid()).min(1),
  }),
  z.object({
    kind: z.literal('capture_proposal'),
    proposalId: z.string().uuid(),
    topicIds: z.array(z.string().uuid()).min(1),
  }),
]);
export type ResearchRunInput = z.infer<typeof ResearchRunInput>;

/** Reads a stored run input, accepting the pre-`kind` brief shape. */
export function parseResearchRunInput(raw: unknown): ResearchRunInput {
  const value = (raw ?? {}) as Record<string, unknown>;
  if (value.kind === undefined && typeof value.briefDocumentId === 'string') {
    return ResearchRunInput.parse({ ...value, kind: 'brief' });
  }
  return ResearchRunInput.parse(value);
}

const ResearchSource = z.object({ url: z.string(), title: z.string().nullable() });

/**
 * Who a contact could be, from public sources and the clues in the capture.
 * Candidates are guesses for a person to confirm, never facts.
 */
export const ContactIdentity = z.object({
  candidates: z
    .array(
      z.object({
        name: z.string(),
        organization: z.string().nullable(),
        role: z.string().nullable(),
        location: z.string().nullable(),
        explanation: z
          .string()
          .describe('Which clues from the capture this candidate matches, and which it does not.'),
        matches_clues: z.array(z.string()),
        conflicts_with_clues: z.array(z.string()),
        confidence: z.enum(['high', 'medium', 'low']),
        sources: z.array(ResearchSource),
      }),
    )
    .describe('At most three. Empty when nobody can be matched to the clues with reasonable confidence.'),
  reliable_match_found: z.boolean().describe('False when no candidate fits the clues well enough to show.'),
  note: z.string().describe('One sentence for the reader: what was searched and how sure the match is.'),
});
export type ContactIdentity = z.infer<typeof ContactIdentity>;

/** Focused research on one confirmed person. Every item carries its sources. */
export const ContactProfile = z.object({
  facts: z.array(z.object({ statement: z.string(), sources: z.array(ResearchSource) })),
  inferences: z.array(z.object({ statement: z.string(), based_on: z.string(), sources: z.array(ResearchSource) })),
  recommendations: z.array(z.object({ statement: z.string(), rationale: z.string() })),
  gaps: z.array(z.object({ question: z.string(), why_it_matters: z.string() })),
  affiliations: z.array(
    z.object({
      organization: z.string(),
      role: z.string().nullable(),
      current: z.boolean(),
      claim: z.enum(['fact', 'inference']),
      sources: z.array(ResearchSource),
    }),
  ),
  public_profiles: z.array(z.object({ kind: z.enum(['linkedin', 'website', 'other']), url: z.string() })),
});
export type ContactProfile = z.infer<typeof ContactProfile>;

/** Ask Knowledge: answers only from stored records, always cited. */
export const AskAnswer = z.object({
  answer_md: z.string(),
  citations: z.array(
    z.object({
      table_name: z.string(),
      row_id: z.string(),
      label: z.string(),
      quote: z.string().nullable(),
    }),
  ),
  unanswered: z.array(z.string()).describe('Parts of the question the stored data does not cover.'),
  used_no_sources: z.boolean(),
});
export type AskAnswer = z.infer<typeof AskAnswer>;

/** Parsed structure of an uploaded document. */
export const UploadParse = z.object({
  documents: z.array(
    z.object({
      title: z.string(),
      doc_type: z.enum(['brief', 'dossier', 'other']),
      detected_format_key: z.string().nullable(),
      detected_run_date: z.string().nullable(),
      start_line: z.number().int().min(0),
      end_line: z.number().int().min(0),
    }),
  ),
});
export type UploadParse = z.infer<typeof UploadParse>;

export function fieldsToRecord(
  fields: { name: string; value: string | null }[],
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const f of fields) out[f.name] = f.value;
  return out;
}

// ---------------------------------------------------------------------------
// Universal capture: what kind of material is this, and what a document holds
// ---------------------------------------------------------------------------

/**
 * The first question about any capture: what kind of material is it? A note
 * about a meeting is read for relationships; a radar or dossier is read for
 * what it says matters. Getting this wrong is worse than a missing detail, so
 * the classifier also says why it decided, in words a person can check.
 */
export const CaptureClassification = z.object({
  material: z
    .enum(['relationship_note', 'research_document', 'reference_material', 'mixed', 'unreadable'])
    .describe('relationship_note: about people you were in contact with. research_document: a brief, radar, dossier or report about the outside world. reference_material: background with nothing decision-relevant. mixed: both a contact and a document. unreadable: nothing usable could be read.'),
  document_kind: z.enum(['radar_brief', 'research_brief', 'dossier', 'report', 'other']).nullable(),
  confidence: z.enum(['high', 'medium', 'low']),
  /** One line a person reads: "A daily radar brief with four signals and four watch dates." */
  description: z.string(),
  /** Why it was classified this way, from the material itself. */
  reason: z.string(),
});
export type CaptureClassification = z.infer<typeof CaptureClassification>;

const SubjectRef = z.object({
  name: z.string(),
  kind: z.enum(['person', 'organization', 'project', 'institution', 'event', 'other']),
  role: z.enum(['subject', 'organisation', 'mentioned']),
});

/**
 * What a research document holds, in the document's own terms. Nothing here is
 * a record yet: the mapper decides what becomes memory, and a person approves.
 */
export const DocumentExtraction = z.object({
  artifact: z.object({
    title: z.string(),
    artifact_type: z.enum(['radar_brief', 'research_brief', 'dossier', 'report', 'other']),
    summary: z.string().describe('What this document is and what it covers, in plain words.'),
    document_date: z.string().nullable().describe('YYYY-MM-DD as the document states it.'),
    coverage: z.string().nullable().describe('The window or scope the document states.'),
    external_use: z.string().nullable().describe('Any external-use restriction the document states.'),
    source_urls: z.array(z.string()).describe('Sources the document cites.'),
  }),
  signals: z
    .array(
      z.object({
        title: z.string(),
        signal_type: z.enum(['creative_ip', 'athlete_momentum', 'story', 'market', 'other']),
        what_changed: z.string(),
        why_it_matters: z.string(),
        decision_question: z.string().nullable(),
        recommended_next_step: z.string().nullable(),
        promotion_trigger: z.string().nullable(),
        priority: z.enum(['high', 'medium', 'low']),
        confidence: z.enum(['high', 'medium', 'low']),
        original_claim: z.string().nullable().describe("The document's own sentence, quoted, not paraphrased."),
        source_facts: z
          .array(
            z.object({
              statement: z.string().describe('A checkable fact explicitly stated in the document.'),
              about: z.string().nullable().describe('The subject this fact is about, when the document makes that clear.'),
              confidence: z.enum(['high', 'medium', 'low']),
            }),
          )
          .nullable()
          .optional()
          .describe('One essential source-backed fact that makes the signal understandable. Do not include analysis, recommendations or anything inferred.'),
        subjects: z.array(SubjectRef),
        source_urls: z.array(z.string()),
      }),
    )
    .describe('Only decision-relevant items. Routine results and background belong in source_only.'),
  watch_items: z.array(
    z.object({
      title: z.string(),
      trigger_date: z.string().nullable().describe('YYYY-MM-DD when the document gives one.'),
      why_it_matters: z.string(),
      promotion_condition: z.string().nullable(),
      about: z.string().nullable().describe('The name this watch is about, when it has one.'),
      priority: z.enum(['high', 'medium', 'low']),
    }),
  ),
  hypotheses: z
    .array(
      z.object({
        title: z.string(),
        description: z.string(),
        about: z.string().nullable(),
        from_signal: z.string().nullable().describe('The signal title this idea came from.'),
      }),
    )
    .describe('Ideas the document raises without confirming them. Never treated as real opportunities.'),
  unknowns: z.array(
    z.object({
      kind: z
        .enum(['gap', 'risk'])
        .describe('gap: something unknown or unconfirmed (rights, representation, access, mechanics, timing). risk: a substantive concern needing care (safeguarding, consent, trauma-informed development, reputational or legal sensitivity).'),
      statement: z.string(),
      why_it_matters: z.string(),
      about: z.string().nullable(),
    }),
  ),
  research_recommendations: z.array(
    z.object({
      subject: z.string(),
      kind: z.enum(['person', 'organization', 'project', 'other']),
      why: z.string().describe('What a decision would gain from researching this subject.'),
    }),
  ),
  source_only: z
    .array(z.object({ label: z.string(), why: z.string() }))
    .describe('Routine results, exclusions and generic mentions: kept in the document, never saved as records.'),
});
export type DocumentExtraction = z.infer<typeof DocumentExtraction>;
