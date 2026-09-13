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
    'opportunities', 'outcomes', 'knowledge', 'rules',
  ]),
  label: z.string().describe('Human-readable name of the record, e.g. the person or the finding title.'),
  claim_type: ClaimType.nullable(),
  confidence: Confidence.nullable(),
  reason: z.string(),
  /** Field values as a list, because structured-output mode forbids open maps. */
  fields: z.array(z.object({ name: z.string(), value: z.string().nullable() })),
  /** Names of other proposed records this one depends on, matched by label. */
  depends_on_labels: z.array(z.string()),
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
