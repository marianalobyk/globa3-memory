/**
 * Mock provider, used when no OPENAI_API_KEY is configured.
 *
 * It is not a stub that returns empty objects: it returns schema-valid content
 * designed to exercise the parts of the system that matter -- an entity that
 * already exists, one whose name is confusingly close to an existing record, and
 * one that is genuinely new -- so entity resolution, ambiguity handling, dedup
 * and the approval gate are all genuinely covered without a key.
 *
 * Everything it produces is prefixed [MOCK], and every run, brief, proposal and
 * usage row it touches is flagged is_mock in the database so nothing synthetic
 * can be mistaken for a real result.
 */
import type { z } from 'zod';
import type {
  AiProvider,
  BackgroundHandle,
  BackgroundPoll,
  GenerateOptions,
  StructuredResult,
  TextResult,
  UsageReport,
} from './types.js';
import { AppError } from '../errors.js';

export const MOCK_PREFIX = '[MOCK]';

/** Deterministic pseudo-usage so cost accounting has something to add up. */
function mockUsage(model: string, input: string, output: string, webSearches: number): UsageReport {
  return {
    model,
    tokensIn: Math.ceil(input.length / 4),
    tokensOut: Math.ceil(output.length / 4),
    reasoningTokens: 0,
    cachedTokens: 0,
    webSearches,
    durationMs: 40,
    // Nothing here was reported by a provider; it is arithmetic on string length.
    usageIsEstimated: true,
  };
}

function readVariable(input: string, name: string): string | null {
  const match = input.match(new RegExp(`\\[${name}\\]\\s*=\\s*(.+)`));
  return match?.[1]?.trim() ?? null;
}

const MOCK_SOURCES = [
  { url: 'https://example.com/mock/primary-announcement', title: `${MOCK_PREFIX} Primary announcement` },
  { url: 'https://example.com/mock/trade-report', title: `${MOCK_PREFIX} Trade report` },
];

function source(index: number, tier: string) {
  const s = MOCK_SOURCES[index % MOCK_SOURCES.length] as { url: string; title: string };
  return {
    url: s.url,
    title: s.title,
    publisher: 'Mock Publisher',
    source_tier: tier,
    published_date: null,
    event_date: null,
    is_press_release: index === 0,
    quality_label: index === 0 ? 'Official' : 'Strong Trade',
    verification_note: `${MOCK_PREFIX} synthetic source, not a real publication.`,
  };
}

/**
 * The recurring cast used across mock outputs.
 *   - "Sports One" is seeded into the database, so it must resolve as existing.
 *   - "Sports One Holdings" is deliberately close to it, so it must come back
 *     ambiguous and never be merged automatically.
 *   - "Meridian Story Lab" does not exist, so it must resolve as new.
 */
export const MOCK_CAST = {
  existingOrg: 'Sports One',
  ambiguousOrg: 'Sports One Holdings',
  newOrg: 'Meridian Story Lab',
  existingPerson: 'Paul Misir',
  nearDuplicatePerson: 'Paul Misir Jr',
  newPerson: 'Amara Nwosu',
} as const;

function mockEntities() {
  return [
    {
      name: MOCK_CAST.existingOrg,
      entity_type: 'organization' as const,
      role_or_context: 'Athlete-value infrastructure',
      affiliation: null,
      why_relevant: `${MOCK_PREFIX} already tracked; used to prove an existing match resolves rather than duplicating.`,
      source_urls: [MOCK_SOURCES[0]!.url],
    },
    {
      name: MOCK_CAST.ambiguousOrg,
      entity_type: 'organization' as const,
      role_or_context: 'Possible parent or unrelated namesake',
      affiliation: null,
      why_relevant: `${MOCK_PREFIX} deliberately close to an existing name; must surface as ambiguous.`,
      source_urls: [MOCK_SOURCES[1]!.url],
    },
    {
      name: MOCK_CAST.newPerson,
      entity_type: 'person' as const,
      role_or_context: 'Director',
      affiliation: MOCK_CAST.newOrg,
      why_relevant: `${MOCK_PREFIX} new person, to prove a genuinely new entity is created only after approval.`,
      source_urls: [MOCK_SOURCES[1]!.url],
    },
    {
      name: MOCK_CAST.newOrg,
      entity_type: 'organization' as const,
      role_or_context: 'Story lab',
      affiliation: null,
      why_relevant: `${MOCK_PREFIX} new organisation linked to the new person.`,
      source_urls: [MOCK_SOURCES[1]!.url],
    },
  ];
}

function scores(keys: string[], value: number) {
  return keys.map((dimension) => ({
    dimension,
    score: value,
    rationale: `${MOCK_PREFIX} fixed score for deterministic testing.`,
  }));
}

function buildFixture(schemaName: string, options: GenerateOptions): unknown {
  const runDate = readVariable(options.input, 'RUN_DATE') ?? readVariable(options.input, 'RUN_DATE ') ?? 'unknown-date';

  switch (schemaName) {
    case 'research_ledger':
      return {
        lane_outcomes: [
          { lane: 'A', searched: true, found_count: 2, note: `${MOCK_PREFIX} lane scanned.` },
          { lane: 'B', searched: true, found_count: 1, note: `${MOCK_PREFIX} lane scanned.` },
        ],
        candidates: [
          {
            fingerprint: `mock-signal-${runDate}-1`,
            headline: `${MOCK_PREFIX} Athlete-owned media platform announces ownership restructuring`,
            lane: 'A',
            what_happened: `${MOCK_PREFIX} A synthetic signal used to exercise the pipeline end to end.`,
            why_it_matters: `${MOCK_PREFIX} Demonstrates elevation, scoring and source handling.`,
            classification: 'DIRECT',
            freshness_label: 'same_window',
            scores: scores(
              ['ownership_rights_depth', 'amv_strategic_fit', 'decision_value', 'materiality_novelty', 'evidence_quality'],
              4,
            ),
            total_score: 20,
            tier: 'P2',
            confidence: 'medium' as const,
            external_use_status: 'internal_only',
            recommended_action: 'Track',
            decision_question: `${MOCK_PREFIX} Should this be researched further?`,
            entities: mockEntities(),
            sources: [source(0, 'tier1_primary'), source(1, 'tier2_independent')],
            unknowns: [`${MOCK_PREFIX} Commercial terms not disclosed.`],
            excluded_reason: null,
          },
          {
            fingerprint: `mock-signal-${runDate}-2`,
            headline: `${MOCK_PREFIX} Adjacent category item, retained as a watch candidate`,
            lane: 'B',
            what_happened: `${MOCK_PREFIX} Second synthetic candidate.`,
            why_it_matters: `${MOCK_PREFIX} Exercises the watch tier.`,
            classification: 'WATCH',
            freshness_label: 'same_window',
            scores: scores(
              ['ownership_rights_depth', 'amv_strategic_fit', 'decision_value', 'materiality_novelty', 'evidence_quality'],
              2,
            ),
            total_score: 12,
            tier: 'Watch',
            confidence: 'low' as const,
            external_use_status: 'do_not_use_externally',
            recommended_action: 'Watch',
            decision_question: null,
            entities: [],
            sources: [source(1, 'tier3_supporting')],
            unknowns: [],
            excluded_reason: null,
          },
        ],
        coverage_note: `${MOCK_PREFIX} Synthetic coverage; no live search was performed.`,
        research_status: 'partial' as const,
        limitations: [
          `${MOCK_PREFIX} No OPENAI_API_KEY configured, so no live research ran. Treat all content as synthetic.`,
        ],
      };

    case 'brief_draft': {
      const title = `${MOCK_PREFIX} Brief for ${runDate}`;
      const body = [
        `# ${title}`,
        '',
        '> This document was produced by the mock provider with no live research.',
        '> It exists to exercise the pipeline, not to inform a decision.',
        '',
        '## Executive Decisions',
        '',
        `- ${MOCK_PREFIX} No real decision is implied by this document.`,
        '',
        '## Priority Signals',
        '',
        `### ${MOCK_PREFIX} Athlete-owned media platform announces ownership restructuring`,
        '',
        `- What happened: synthetic signal for ${runDate}.`,
        '- Confidence: Medium.',
        `- Source: [${MOCK_SOURCES[0]!.title}](${MOCK_SOURCES[0]!.url})`,
        '',
        '## Supporting Watch Signals',
        '',
        `- ${MOCK_PREFIX} Adjacent category item retained as watch.`,
        '',
        '## Material Exclusions',
        '',
        `- ${MOCK_PREFIX} Nothing genuinely excluded; no live candidates existed.`,
        '',
        '## Sources',
        '',
        ...MOCK_SOURCES.map((s, i) => `${i + 1}. [${s.title}](${s.url})`),
        '',
        '## Research And Approval Record',
        '',
        '- Research: mock provider, no live sources.',
        '- Approval: none. Nothing in this document has been approved into the knowledge base.',
      ].join('\n');
      return {
        title,
        output_mode: 'active_day',
        body_md: body,
        sections_present: [
          'Executive Decisions',
          'Priority Signals',
          'Supporting Watch Signals',
          'Material Exclusions',
          'Sources',
          'Research And Approval Record',
        ],
        word_count: body.split(/\s+/).length,
      };
    }

    case 'qa_verdict':
      return {
        checks: [
          { key: 'metadata_gate', passed: true, severity: 'critical' as const, note: 'Windows computed by the orchestrator.' },
          { key: 'urls_absolute', passed: true, severity: 'critical' as const, note: 'All mock URLs are absolute.' },
          { key: 'no_placeholders', passed: true, severity: 'critical' as const, note: 'None present.' },
          {
            key: 'citations_listed',
            passed: true,
            severity: 'major' as const,
            note: 'Mock sources are listed.',
          },
        ],
        release_status: 'review_internal_only' as const,
        summary: `${MOCK_PREFIX} Cannot pass a release gate: no live research was performed.`,
        required_corrections: ['Run again with a configured OPENAI_API_KEY before treating this as a real brief.'],
      };

    case 'brief_extraction':
      return {
        entities: mockEntities(),
        findings: [
          {
            title: `${MOCK_PREFIX} Ownership restructuring reported`,
            content: `${MOCK_PREFIX} Synthetic fact used to exercise the capture and approval path.`,
            claim_type: 'fact' as const,
            confidence: 'medium' as const,
            subject_name: MOCK_CAST.existingOrg,
            source_urls: [MOCK_SOURCES[0]!.url],
          },
          {
            title: `${MOCK_PREFIX} Category consolidation may follow`,
            content: `${MOCK_PREFIX} Synthetic inference, deliberately separated from the fact above.`,
            claim_type: 'inference' as const,
            confidence: 'low' as const,
            subject_name: MOCK_CAST.existingOrg,
            source_urls: [],
          },
        ],
        gaps: [
          {
            question: `${MOCK_PREFIX} Who controls ${MOCK_CAST.newOrg}?`,
            why_it_matters: 'Ownership determines whether a relationship path exists.',
          },
        ],
        proposed_topics: [
          {
            label: MOCK_CAST.newOrg,
            target_type: 'company' as const,
            priority: 'high' as const,
            research_question: `Who controls ${MOCK_CAST.newOrg} and what is its current status?`,
            why_useful: `${MOCK_PREFIX} New organisation with no existing record.`,
            business_unit_hint: null,
            source_urls: [MOCK_SOURCES[1]!.url],
          },
          {
            label: MOCK_CAST.newPerson,
            target_type: 'person' as const,
            priority: 'high' as const,
            research_question: `What is ${MOCK_CAST.newPerson}'s current role and connection?`,
            why_useful: `${MOCK_PREFIX} Named person, an explicit research target.`,
            business_unit_hint: null,
            source_urls: [MOCK_SOURCES[1]!.url],
          },
          {
            label: MOCK_CAST.ambiguousOrg,
            target_type: 'company' as const,
            priority: 'medium' as const,
            research_question: `Is ${MOCK_CAST.ambiguousOrg} the same entity as ${MOCK_CAST.existingOrg}?`,
            why_useful: `${MOCK_PREFIX} Deliberate near-duplicate that must not be merged silently.`,
            business_unit_hint: null,
            source_urls: [],
          },
        ],
      };

    case 'deep_research_result': {
      const topic = readVariable(options.input, 'TOPIC') ?? 'Unnamed topic';
      return {
        topic_label: topic,
        summary: `${MOCK_PREFIX} Synthetic deep research on "${topic}". No live sources were consulted.`,
        brief_claim_assessment: 'partially_confirmed' as const,
        facts: [
          {
            statement: `${MOCK_PREFIX} ${topic} is described in the source material as an active initiative.`,
            as_of_date: null,
            confidence: 'medium' as const,
            source_urls: [MOCK_SOURCES[0]!.url],
          },
        ],
        inferences: [
          {
            statement: `${MOCK_PREFIX} A relationship path may exist through the named director.`,
            based_on: 'The affiliation stated in the brief.',
            confidence: 'low' as const,
          },
        ],
        recommendations: [
          {
            statement: `${MOCK_PREFIX} Verify controller and status before any outreach.`,
            rationale: 'Ownership is unresolved.',
            decision_supported: 'Whether to open a relationship path.',
          },
        ],
        risks: [{ statement: `${MOCK_PREFIX} Status may be stale.`, severity: 'medium' as const }],
        gaps: [{ question: `${MOCK_PREFIX} Who funds ${topic}?`, why_it_matters: 'Determines the decision-maker.' }],
        controller_or_decision_makers: [mockEntities()[2]!],
        entities: mockEntities(),
        sources: [source(0, 'tier1_primary'), source(1, 'tier2_independent')],
        confidence: 'low' as const,
        depth_standard_met: false,
        depth_note: `${MOCK_PREFIX} The depth standard cannot be met without live research.`,
      };
    }

    case 'capture_proposal':
      return {
        title: `${MOCK_PREFIX} Proposed changes from mock research`,
        summary: `${MOCK_PREFIX} Synthetic proposal covering an existing match, an ambiguous match and a new record.`,
        changes: [
          {
            op: 'create' as const,
            target_table: 'evidence' as const,
            label: `${MOCK_PREFIX} Primary announcement`,
            claim_type: null,
            confidence: null,
            reason: 'The underlying source for every finding below.',
            fields: [
              { name: 'source_type', value: 'url' },
              { name: 'title', value: `${MOCK_PREFIX} Primary announcement` },
              { name: 'url', value: MOCK_SOURCES[0]!.url },
              { name: 'reliability', value: 'unverified' },
              { name: 'provenance_note', value: `${MOCK_PREFIX} synthetic source.` },
            ],
            depends_on_labels: [],
            source_urls: [MOCK_SOURCES[0]!.url],
          },
          {
            op: 'create' as const,
            target_table: 'entities' as const,
            label: MOCK_CAST.newOrg,
            claim_type: 'fact' as const,
            confidence: 'medium' as const,
            reason: 'New organisation named in the research with no existing record.',
            fields: [
              { name: 'entity_type', value: 'organization' },
              { name: 'display_name', value: MOCK_CAST.newOrg },
              { name: 'research_status', value: 'research_only' },
              { name: 'relationship_status', value: 'none' },
              { name: 'visibility', value: 'internal' },
            ],
            depends_on_labels: [`${MOCK_PREFIX} Primary announcement`],
            source_urls: [MOCK_SOURCES[1]!.url],
          },
          {
            op: 'create' as const,
            target_table: 'entities' as const,
            label: MOCK_CAST.newPerson,
            claim_type: 'fact' as const,
            confidence: 'medium' as const,
            reason: 'Named person; stored as a research-only entity, not a contact.',
            fields: [
              { name: 'entity_type', value: 'person' },
              { name: 'display_name', value: MOCK_CAST.newPerson },
              { name: 'research_status', value: 'research_only' },
              { name: 'relationship_status', value: 'none' },
            ],
            depends_on_labels: [],
            source_urls: [MOCK_SOURCES[1]!.url],
          },
          {
            op: 'link' as const,
            target_table: 'entity_affiliations' as const,
            label: `${MOCK_CAST.newPerson} -> ${MOCK_CAST.newOrg}`,
            claim_type: 'fact' as const,
            confidence: 'medium' as const,
            reason: 'Source-backed role, so the person-to-organisation link belongs in affiliations.',
            fields: [
              { name: 'person_entity_label', value: MOCK_CAST.newPerson },
              { name: 'organization_entity_label', value: MOCK_CAST.newOrg },
              { name: 'role_title', value: 'Director' },
              { name: 'context', value: `${MOCK_PREFIX} stated in synthetic research` },
              { name: 'is_current', value: 'true' },
            ],
            depends_on_labels: [MOCK_CAST.newPerson, MOCK_CAST.newOrg],
            source_urls: [MOCK_SOURCES[1]!.url],
          },
          {
            op: 'create' as const,
            target_table: 'research_findings' as const,
            label: `${MOCK_PREFIX} Ownership restructuring reported`,
            claim_type: 'fact' as const,
            confidence: 'medium' as const,
            reason: 'A source-backed fact worth keeping.',
            fields: [
              { name: 'finding_type', value: 'fact' },
              { name: 'title', value: `${MOCK_PREFIX} Ownership restructuring reported` },
              { name: 'content', value: `${MOCK_PREFIX} Synthetic fact retained to exercise the approval path.` },
              { name: 'confidence', value: 'medium' },
              { name: 'related_entity_label', value: MOCK_CAST.existingOrg },
            ],
            depends_on_labels: [`${MOCK_PREFIX} Primary announcement`],
            source_urls: [MOCK_SOURCES[0]!.url],
          },
          {
            op: 'create' as const,
            target_table: 'signals' as const,
            label: `${MOCK_PREFIX} Why ${MOCK_CAST.newOrg} entered the system`,
            claim_type: 'inference' as const,
            confidence: 'low' as const,
            reason: 'Records the reason this organisation is now tracked.',
            fields: [
              { name: 'signal_type', value: 'research' },
              { name: 'title', value: `${MOCK_PREFIX} New story lab worth watching` },
              { name: 'why_it_matters', value: `${MOCK_PREFIX} Possible project pathway.` },
              { name: 'decision_question', value: 'Watch or research further?' },
              { name: 'status', value: 'watch' },
              { name: 'related_entity_label', value: MOCK_CAST.newOrg },
            ],
            depends_on_labels: [MOCK_CAST.newOrg],
            source_urls: [MOCK_SOURCES[1]!.url],
          },
          {
            op: 'create' as const,
            target_table: 'entity_mentions' as const,
            label: MOCK_CAST.ambiguousOrg,
            claim_type: 'gap' as const,
            confidence: 'low' as const,
            reason:
              'Name is close to an existing record but not confirmed to be the same. Staged as a mention instead of creating or merging an entity.',
            fields: [
              { name: 'mention_text', value: MOCK_CAST.ambiguousOrg },
              { name: 'proposed_entity_type', value: 'organization' },
              { name: 'resolution_status', value: 'pending' },
              { name: 'rationale', value: `Possible match with ${MOCK_CAST.existingOrg}; needs human confirmation.` },
            ],
            depends_on_labels: [],
            source_urls: [],
          },
        ],
        unresolved_mentions: [
          {
            name: MOCK_CAST.ambiguousOrg,
            entity_type: 'organization',
            why_unresolved: `Similar to "${MOCK_CAST.existingOrg}" but a shared name is not evidence of the same organisation.`,
            possible_matches: [MOCK_CAST.existingOrg],
          },
        ],
        notes: [`${MOCK_PREFIX} No live research informed this proposal.`],
      };

    case 'ask_answer':
      return {
        answer_md: `${MOCK_PREFIX} No language model is configured, so this answer is assembled from the retrieved records only. See the citations below for what the knowledge base actually holds.`,
        citations: [],
        unanswered: ['Set OPENAI_API_KEY to get a synthesised answer over the retrieved records.'],
        used_no_sources: true,
      };

    case 'upload_parse':
      return { documents: [] };

    default:
      throw new AppError(
        `Mock provider has no fixture for schema "${schemaName}". Add one in ai/mock.ts.`,
        500,
        'mock_fixture_missing',
      );
  }
}

export class MockProvider implements AiProvider {
  readonly kind = 'mock' as const;
  readonly isMock = true;

  async generateStructured<T>(
    options: GenerateOptions & { schema: z.ZodType<T>; schemaName: string },
  ): Promise<StructuredResult<T>> {
    const fixture = buildFixture(options.schemaName, options);
    // Parse through the real schema so a drifting fixture fails loudly here
    // rather than producing invalid data downstream.
    const value = options.schema.parse(fixture);
    const serialized = JSON.stringify(value);
    return {
      value,
      usage: mockUsage(options.model, options.input, serialized, 0),
      sources: MOCK_SOURCES.map((s) => ({ url: s.url, title: s.title })),
      raw: { mock: true, schemaName: options.schemaName },
    };
  }

  async generateText(options: GenerateOptions): Promise<TextResult> {
    const text = `${MOCK_PREFIX} No OPENAI_API_KEY is configured, so no model was called for "${options.label}".`;
    return {
      text,
      usage: mockUsage(options.model, options.input, text, 0),
      sources: [],
      raw: { mock: true },
    };
  }

  async startBackgroundResearch(options: GenerateOptions): Promise<BackgroundHandle> {
    // A stable fake id so resume-after-restart can still be exercised.
    const id = `mock_bg_${Buffer.from(options.label).toString('hex').slice(0, 24)}`;
    return { responseId: id, status: 'completed' };
  }

  async pollBackgroundResearch(responseId: string): Promise<BackgroundPoll> {
    const text = `${MOCK_PREFIX} Synthetic background research result for ${responseId}.`;
    return {
      status: 'completed',
      text,
      usage: mockUsage('mock-deep-research', responseId, text, 0),
      sources: MOCK_SOURCES.map((s) => ({ url: s.url, title: s.title })),
      error: null,
    };
  }

  async cancelBackgroundResearch(): Promise<void> {
    // Nothing to cancel.
  }
}
