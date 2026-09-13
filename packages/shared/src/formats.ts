/**
 * Structured rules for the three initial formats.
 *
 * Each format keeps its own search lanes, source families and tiers, scoring
 * rubric, thresholds, freshness vocabulary, coverage-window shape, reader
 * structure and QA gate. These are consumed by code: the prompt builder injects
 * them, the QA step checks against them, and the Settings screen edits them.
 *
 * The full run prompt text lives separately, in prompt_versions.body, seeded
 * from the archive's run_prompts/*.md. Nothing here paraphrases that text; this
 * is the machine-readable half.
 */
import type { RunWindowShape } from './time.js';

export type FormatKey = 'amv_daily' | 'amv_creative_radar' | 'globa3_creative_radar';

export interface ScoringDimension {
  key: string;
  label: string;
  max: number;
  /** Anchor descriptions for specific points, where the prompt defines them. */
  anchors?: Record<string, string>;
}

export interface ScoringThreshold {
  tier: string;
  minScore: number;
  maxScore: number;
  /** Extra conditions beyond the raw score, stated in the prompt. */
  requires?: string[];
}

export interface QaCheck {
  key: string;
  /** What must be true. Failing checks push the run to review or fail. */
  assertion: string;
  severity: 'critical' | 'major' | 'minor';
  /** True when code can decide this check without the model's opinion. */
  automated: boolean;
}

export interface FormatConfig {
  key: FormatKey;
  name: string;
  productLine: string;
  description: string;
  /** Never distribute externally without the format's own clearance rules. */
  confidentiality: string;
  windowShape: RunWindowShape;
  outputSchemaVersion?: string;
  outputFilePattern: string;
  /** Placeholder names the prompt expects the orchestrator to inject. */
  requiredVariables: string[];
  researchLanes: { key: string; label: string; detail: string }[];
  sourceFamilies: string[];
  sourceTiers: { tier: string; label: string; detail: string }[];
  sourceRules: string[];
  searchSequence: string[];
  freshnessLabels: { key: string; label: string; elevatable: boolean }[];
  classifications: string[];
  scoring: { dimensions: ScoringDimension[]; maxScore: number; showScoresToReader: false };
  thresholds: ScoringThreshold[];
  confidenceLevels: { key: string; detail: string }[];
  externalUseStatuses: { key: string; detail: string }[];
  outputModes: { key: string; label: string; when: string; wordTarget?: [number, number] }[];
  readerSections: { key: string; heading: string; required: boolean }[];
  qaChecks: QaCheck[];
  releaseStatuses: { key: string; label: string; detail: string }[];
  cleanOutputExclusions: string[];
  /** Entity kinds this format must treat as explicit research targets. */
  entityTargetTypes: string[];
}

const SHARED_QA: QaCheck[] = [
  {
    key: 'metadata_gate',
    assertion:
      'Run metadata was computed and validated by the orchestrator before any research call, and every timestamp is valid ISO-8601 with offset in the declared timezone.',
    severity: 'critical',
    automated: true,
  },
  {
    key: 'urls_absolute',
    assertion: 'Every cited source has a direct http(s) URL.',
    severity: 'critical',
    automated: true,
  },
  {
    key: 'no_placeholders',
    assertion:
      'No placeholder text remains (Direct URL, insert link, source here, TBD, link).',
    severity: 'critical',
    automated: true,
  },
  {
    key: 'citations_listed',
    assertion: 'Every source cited in the body also appears in the source list.',
    severity: 'major',
    automated: true,
  },
  {
    key: 'no_numeric_scores',
    assertion: 'Internal numerical scores are not shown in the reader-facing output.',
    severity: 'major',
    automated: true,
  },
  {
    key: 'confidence_separate',
    assertion: 'Confidence is stated separately from priority.',
    severity: 'major',
    automated: false,
  },
  {
    key: 'press_release_not_corroboration',
    assertion:
      'A press release is treated as primary evidence, never as independent corroboration, and syndicated copies count as one source.',
    severity: 'major',
    automated: false,
  },
  {
    key: 'no_implied_mandate',
    assertion:
      'No mandate, relationship, investment or affiliation is implied without internal confirmation.',
    severity: 'critical',
    automated: false,
  },
  {
    key: 'no_professional_advice',
    assertion: 'No legal, tax, financial, investment or representation advice is given.',
    severity: 'critical',
    automated: false,
  },
  {
    key: 'freshness_labelled',
    assertion:
      'Every elevated item carries a freshness label, and publication date is not conflated with the underlying event date.',
    severity: 'major',
    automated: false,
  },
];

const RELEASE_STATUSES = [
  {
    key: 'pass_internal_only',
    label: 'PASS - INTERNAL ONLY',
    detail:
      'Required research completed, elevated claims source-valid, citations and URLs complete, mode and length compliant.',
  },
  {
    key: 'pass_quiet_window_internal_only',
    label: 'PASS - QUIET WINDOW - INTERNAL ONLY',
    detail: 'Research completed and nothing qualified for elevation; watch items and triggers stated.',
  },
  {
    key: 'review_internal_only',
    label: 'REVIEW - INTERNAL ONLY',
    detail:
      'A material lane or previous-state comparison is incomplete, or a claim needs verification. Sufficient for internal review, not a clean pass.',
  },
  {
    key: 'fail_do_not_distribute',
    label: 'FAIL - DO NOT DISTRIBUTE',
    detail:
      'Research failed, metadata invalid, elevated claims unsupported, or coverage too incomplete to support a safe brief.',
  },
];

const CLEAN_OUTPUT_EXCLUSIONS = [
  'run manifest',
  'evidence ledger',
  'hidden scoring',
  'model reasoning',
  'raw source cards',
  'rejected-candidate logs beyond allowed material exclusions',
  'QA notes',
  'workflow commentary',
  'prompt explanations',
  'JSON schemas',
  'placeholder text',
  'duplicate source sections',
  'raw search-result IDs',
  'unsupported relationship claims',
  'wide tables',
];

export const AMV_DAILY: FormatConfig = {
  key: 'amv_daily',
  name: 'AMV by Globa 3 Daily Athlete Ownership & Platform Intelligence Brief',
  productLine: 'AMV',
  description:
    'Private internal intelligence on athlete ownership, media, IP and platform economics. AMV = Athlete Media & Ventures; the strategic frame is from endorsement to ownership, and the delivery frame is Blueprint -> Build -> Operate -> Scale.',
  confidentiality:
    'Internal product for authorised Globa 3 leadership. Not a sports-news digest, transfer tracker, sponsorship newsletter, investment memo or outreach list.',
  windowShape: {
    timeZone: 'Europe/Paris',
    coverageHours: 24,
    // Section 4: exact 72-hour backstop for late-indexed primary material.
    backstopHours: 72,
  },
  outputFilePattern: 'amv_daily_briefing_{run_date}.md',
  requiredVariables: [
    'RUN_ID', 'RUN_DATE', 'RUN_TIME_ISO', 'TIMEZONE',
    'COVERAGE_START_ISO', 'COVERAGE_END_ISO', 'BACKSTOP_START_ISO',
    'STATE_MODE', 'EXECUTION_MODE',
    'PRIORITY_GEOGRAPHIES', 'PRIORITY_SPORTS_OR_ATHLETE_CATEGORIES',
    'CURRENT_PRIORITIES', 'CURRENT_TARGETS', 'CURRENT_PROJECTS',
    'PARTNER_COMPETITOR_WATCHLIST', 'DO_NOT_CONTACT', 'SPECIAL_QUESTIONS',
    'OPEN_WATCH_ITEMS', 'PREVIOUS_ACCEPTED_SIGNALS', 'PREVIOUS_REJECTED_FINGERPRINTS',
    'OPEN_ACTIONS', 'STATE_WARNINGS', 'OUTPUT_FOLDER',
  ],
  researchLanes: [
    { key: 'A', label: 'Athlete-Owned Media and IP', detail: 'Athlete-founded media and production companies, podcasts, video franchises, newsletters, documentaries, publishing, CTV/FAST, DTC media, licensing, format deals, original IP, platform migration, rights acquisition, distribution, audience monetisation.' },
    { key: 'B', label: 'Athlete Ventures, Equity and Ownership', detail: 'Athlete-founded companies, holding companies, funds, founder roles, equity participation, strategic investments, acquisitions, exits, operating hires, sports ownership, international expansion.' },
    { key: 'C', label: 'Sponsor Architecture', detail: 'Co-created products, joint ventures, athlete-owned content, revenue share, equity, athlete IP licensing, sponsor-funded media, brand-backed franchises, ambassador-to-owner transitions.' },
    { key: 'D', label: 'Distribution, Audience, Data and Technology', detail: 'Streaming, audio distribution, YouTube/social video, CTV/FAST, DTC, first-party data, membership, commerce, AI, digital likeness, synthetic media, rights management, gaming, interactive formats.' },
    { key: 'E', label: 'Rights, Regulation and Reputation', detail: 'Group licensing, individual athlete NIL, union licensee approval, team/league marks, image and personality rights, digital replica and AI likeness, representation rules, advertising restrictions, data/privacy, material commercial disputes.' },
    { key: 'F', label: 'Representation and Athlete-Business Infrastructure', detail: 'Agencies, managers, family offices, athlete networks, business-building firms, venture studios, ownership platforms, executive hires.' },
    { key: 'G', label: 'Capital and Transactions', detail: 'Official filings and credible financial sources for athlete-economy funds, sports-media investment vehicles, acquisitions, minority investments, venture financing, institutional capital, material valuations.' },
    { key: 'H', label: 'Global Market Expansion', detail: 'North America; UAE, Saudi Arabia, Qatar and wider Gulf; Nigeria and wider Africa; UK, France and wider Europe; other markets only when strategically material.' },
    { key: 'I', label: 'Competitive and Category Infrastructure', detail: 'Athlete-owned networks, athlete media companies, athlete venture platforms, sports-media studios, sponsor-backed ventures, distribution platforms, athlete-IP technology.' },
    { key: 'J', label: 'Wider Globa 3 Relevance', detail: 'Concrete Studios, Advisory or Ventures implications only.' },
  ],
  sourceFamilies: [
    'official athlete, athlete-company, brand, league, team, union, platform, regulator, court, filing and investor-relations sources',
    'Reuters, Bloomberg, Financial Times, Wall Street Journal and other major financial/news organisations',
    'Sports Business Journal, Sportico, Front Office Sports, SportsPro and credible sports-business trades',
    'credible media, entertainment, advertising, legal, technology and regional business trades',
    'official Gulf and African institutions and credible regional business media',
    'local-language sources for priority geographies (Arabic for the Gulf, French for France and Francophone Africa)',
    'current targets, current priorities and open watch items',
  ],
  sourceTiers: [
    { tier: 'tier1_primary', label: 'Tier 1 - Primary', detail: 'Official athlete/company/brand/team/league/union/platform statements, filings, court and regulatory records, investor materials, on-record executive statements.' },
    { tier: 'tier2_independent', label: 'Tier 2 - Independent', detail: 'Credible financial, sports-business, legal, media, advertising, entertainment and regional trade reporting.' },
    { tier: 'tier3_supporting', label: 'Tier 3 - Supporting/discovery', detail: 'Official social posts, interviews, podcasts, conference presentations, job postings, trademark filings, app listings, credible local reporting.' },
  ],
  sourceRules: [
    'A press release is primary evidence, not independent corroboration.',
    'Syndicated copies of a release count as one source.',
    'Search snippets cannot support final claims when the source can be opened.',
    'A trademark filing, job listing or social-only claim is normally Watch until corroborated.',
    'Promotional issuer claims and performance metrics must be flagged.',
    'Every final source must have a valid direct http(s) URL.',
  ],
  searchSequence: [
    'Confirm the metadata gate passed before any research begins.',
    'Strict-window primary-source search by lane.',
    'Strict-window independent-source search by lane.',
    'Local-language and geographic source search.',
    'Backstop search from BACKSTOP_START_ISO for late-indexed primary material.',
    'Refresh every open watch item and evaluate fresh same-window Watch candidates.',
    'Search current targets and named priorities.',
    'Rights/licensing recall pass: athlete NIL, union group licensing, league and team marks, athlete-created products, likeness approvals, licensing prohibitions, dispute-driven rights clarification.',
    'Adversarial recall pass using alternate terminology.',
    'Deduplicate against accepted and rejected fingerprints.',
  ],
  freshnessLabels: [
    { key: 'same_window', label: 'Same window', elevatable: true },
    { key: 'backstop_late_discovered', label: 'Backstop, late discovered', elevatable: true },
    { key: 'active_condition_update', label: 'Active condition update', elevatable: true },
    { key: 'outside_window_context', label: 'Outside window context', elevatable: false },
    { key: 'stale_or_republished', label: 'Stale or republished', elevatable: false },
  ],
  classifications: ['DIRECT', 'ADJACENT', 'WATCH', 'EXCLUDE'],
  scoring: {
    dimensions: [
      {
        key: 'ownership_rights_depth',
        label: 'Ownership / rights depth',
        max: 5,
        anchors: {
          '0': 'no athlete ownership or rights relevance',
          '1': 'athlete is subject, ambassador or participant only',
          '2': 'approval, licensing or revenue participation suggested but unclear',
          '3': 'confirmed athlete-controlled rights, equity or platform participation',
          '4': 'material ownership/control across IP, venture, audience or distribution',
          '5': 'category-defining ownership or infrastructure shift',
        },
      },
      { key: 'amv_strategic_fit', label: 'AMV strategic fit', max: 5 },
      { key: 'decision_value', label: 'Decision value / actionability', max: 5 },
      { key: 'materiality_novelty', label: 'Materiality / novelty', max: 5 },
      { key: 'evidence_quality', label: 'Evidence quality', max: 5 },
    ],
    maxScore: 25,
    showScoresToReader: false,
  },
  thresholds: [
    { tier: 'P1', minScore: 21, maxScore: 25, requires: ['Direct', 'ownership/rights depth >= 4', 'evidence >= 4', 'a concrete AMV decision'] },
    { tier: 'P2', minScore: 16, maxScore: 20, requires: ['Direct or exceptional Adjacent', 'decision value >= 3', 'evidence >= 3'] },
    { tier: 'Watch', minScore: 11, maxScore: 15 },
    { tier: 'Exclude', minScore: 0, maxScore: 10, requires: ['or any hard-gate failure'] },
  ],
  confidenceLevels: [
    { key: 'high', detail: 'Primary source or direct on-record party confirmation; material mechanics sufficiently clear.' },
    { key: 'medium', detail: 'Credible independent source with partial confirmation or undisclosed terms.' },
    { key: 'low', detail: 'Single supporting source, social discovery, promotional issuer, unverified metrics or material inconsistency.' },
  ],
  externalUseStatuses: [
    { key: 'internal_only', detail: 'Default for this product: it is an internal leadership brief.' },
    { key: 'needs_review', detail: 'Requires clearance before any external reuse.' },
  ],
  outputModes: [
    { key: 'active_day', label: 'ACTIVE_DAY', when: 'One or more P1/P2 signals qualified.' },
    { key: 'single_signal', label: 'SINGLE_SIGNAL', when: 'Exactly one qualifying signal.' },
    { key: 'quiet_window', label: 'QUIET_WINDOW', when: 'Research completed and nothing qualified for elevation.' },
    { key: 'review', label: 'REVIEW', when: 'A material lane or verification issue remains.' },
    { key: 'fail', label: 'FAIL', when: 'Metadata invalid or research failed; short record only.' },
  ],
  readerSections: [
    { key: 'executive_decisions', heading: 'Executive Decisions', required: true },
    { key: 'priority_signals', heading: 'Priority Signals', required: true },
    { key: 'supporting_watch_signals', heading: 'Supporting Watch Signals', required: true },
    { key: 'amv_implications', heading: 'AMV Implications', required: true },
    { key: 'recommended_actions', heading: 'Recommended Actions', required: true },
    { key: 'watch_triggers', heading: 'Watch Triggers And Continuity', required: true },
    { key: 'material_exclusions', heading: 'Material Exclusions', required: true },
    { key: 'sources', heading: 'Sources', required: true },
    { key: 'research_record', heading: 'Research And Approval Record', required: true },
  ],
  qaChecks: [
    ...SHARED_QA,
    {
      key: 'direct_rights_not_omitted',
      assertion:
        'A Direct rights, ownership or licensing signal was not omitted in favour of a more visible Adjacent announcement.',
      severity: 'critical',
      automated: false,
    },
    {
      key: 'adjacent_not_overpromoted',
      assertion: 'Adjacent signals are capped at Watch unless they score >= 18 and create a defined AMV product or relationship decision.',
      severity: 'major',
      automated: false,
    },
    {
      key: 'watch_not_dropped',
      assertion: 'Materially relevant Watch items were not silently dropped.',
      severity: 'major',
      automated: false,
    },
    {
      key: 'outreach_authorised',
      assertion: 'No outreach is proposed without route, reason, timing and authorisation.',
      severity: 'critical',
      automated: false,
    },
  ],
  releaseStatuses: RELEASE_STATUSES,
  cleanOutputExclusions: CLEAN_OUTPUT_EXCLUSIONS,
  entityTargetTypes: ['person', 'organization', 'project', 'institution', 'event'],
};

export const AMV_CREATIVE_RADAR: FormatConfig = {
  key: 'amv_creative_radar',
  name: 'AMV Creative Radar - Athletes, Stories, Media & IP',
  productLine: 'AMV',
  description:
    'Daily creative-intelligence and scouting radar for athletes, stories, media and IP. Distinct from the Daily Intelligence Brief: this one scouts creative and career-trajectory potential rather than deciding on ownership transactions.',
  confidentiality:
    'Internal scouting product. Priorities, targets, relationship paths, prior radar content and item memory are confidential.',
  windowShape: {
    timeZone: 'Europe/Paris',
    coverageHours: 24,
    rollingContextDays: 7,
    forwardWatchDays: 30,
  },
  outputSchemaVersion: 'AMV_CREATIVE_RADAR_V2',
  outputFilePattern: 'amv_creative_radar_{run_date}.md',
  requiredVariables: [
    'RUN_ID', 'RUN_DATE', 'RUN_TIME_ISO', 'RUN_TIMEZONE',
    'COVERAGE_START_ISO', 'COVERAGE_END_ISO',
    'PRIMARY_COVERAGE_WINDOW_MODE', 'PRIMARY_COVERAGE_WINDOW_HOURS', 'PRIMARY_COVERAGE_OVERRIDE_REASON',
    'ROLLING_CONTEXT_START_ISO', 'ROLLING_CONTEXT_END_ISO',
    'FORWARD_WATCH_START', 'FORWARD_WATCH_END',
    'EXECUTION_MODE', 'STATE_MODE', 'OUTPUT_SCHEMA_VERSION',
    'PRIORITY_GEOGRAPHIES', 'PRIORITY_SPORTS',
    'CURRENT_AMV_PRIORITIES', 'CURRENT_ATHLETE_TARGETS', 'CURRENT_CREATIVE_TARGETS',
    'CURRENT_PROJECTS', 'CURRENT_RELATIONSHIP_WATCHLIST', 'CURRENT_RIGHTS_OR_STORY_WATCHLIST',
    'PREVIOUS_APPROVED_RADAR', 'ITEM_MEMORY',
    'DO_NOT_CONTACT_OR_CONFIDENTIAL_RESTRICTIONS', 'SPECIAL_RESEARCH_QUESTIONS', 'OUTPUT_FOLDER',
  ],
  researchLanes: [
    { key: 'athlete_moments', label: 'Material athlete moments', detail: 'Breakthroughs, records, debuts, comebacks, retirements, transfers with a story consequence, injuries with a career consequence, and performances that pass the performance-to-platform elevation test.' },
    { key: 'athlete_to_media', label: 'Athlete-to-media and IP', detail: 'Documentaries, scripted adaptations, podcasts, publishing, athlete-led projects, archive and rights scouting.' },
    { key: 'career_inflection', label: 'Career inflection and momentum', detail: 'Moments that change an athlete\'s platform potential or timing, including retirement, first title, transfer to a major market, or cultural crossover.' },
    { key: 'creative_partners', label: 'Creative partners, platforms and relationships', detail: 'Producers, directors, writers, production companies, commissioners, distributors and platform decision-makers.' },
    { key: 'story_worlds', label: 'Story worlds and franchise potential', detail: 'Repeatable formats, franchise-capable stories, archive libraries and rights packages.' },
    { key: 'regional', label: 'Regional and cross-border scouting', detail: 'Gulf, Africa, Europe, North America, women\'s sport, para sport and emerging sports; diaspora and home-market paths.' },
  ],
  sourceFamilies: [
    'official athlete, club, league, federation, production, platform and festival sources',
    'major sports-business and entertainment trades',
    'credible documentary, film and television trades',
    'regional Gulf and African creative and sports media',
    'local-language sources for priority geographies',
    'item memory and the previous approved radar, for deduplication only',
  ],
  sourceTiers: [
    { tier: 'tier1_primary', label: 'Official', detail: 'Athlete, club, league, production, platform or festival statement or filing.' },
    { tier: 'tier2_independent', label: 'Strong Trade', detail: 'Established sports-business or entertainment trade reporting.' },
    { tier: 'tier3_supporting', label: 'Credible Secondary / Single-Source / Requires Verification / Weak', detail: 'Everything below strong trade; the weaker labels demand a verification note.' },
  ],
  sourceRules: [
    'Assign exactly one source-quality label: Official, Strong Trade, Credible Secondary, Single-Source, Requires Verification, Weak.',
    'Put extra caution under an explicit verification note.',
    'Do not include an item merely because it involves a famous athlete.',
    'Do not let easy US mainstream coverage crowd out Gulf, African, European, women\'s, para or emerging-sport scouting.',
  ],
  searchSequence: [
    'Validate the hard preflight gate before any research call.',
    'Scan every mandatory athlete-moment category inside the coverage window.',
    'Apply the performance-to-platform elevation test to sporting achievements.',
    'Scan athlete-to-media, IP, partner and platform lanes.',
    'Scan regional and cross-border lanes, including local languages.',
    'Compare against item memory and the previous approved radar for repeat control.',
    'Build the rolling context set from the 7-day window.',
    'Build the forward watch set inside the 30-day window.',
  ],
  freshnessLabels: [
    { key: 'fresh_same_window', label: 'Fresh (same window)', elevatable: true },
    { key: 'developing', label: 'Developing (fresh trigger in window)', elevatable: true },
    { key: 'rolling_context', label: 'Rolling context - not fresh today', elevatable: false },
    { key: 'outside_rolling_window', label: 'Outside rolling window - no new update today', elevatable: false },
  ],
  classifications: [
    'Emerging Athlete', 'Established Athlete - New Creative Signal', 'Retired Athlete - New Platform Potential',
    'Breakout Athlete / Performance Trigger', 'Career Inflection / Momentum Trigger',
    'Athlete-to-Media', 'Athlete-to-IP', 'Athlete-to-Film/TV', 'Athlete-to-Podcast',
    'Athlete-to-Publishing', 'Athlete-to-Culture', 'Athlete-Led Project', 'Sports-Led Story',
    'Documentary Scouting', 'Scripted Adaptation Potential', 'Story World / Franchise Potential',
    'Archive / Rights Scouting', 'Creative Collaborator', 'Production Partner',
    'Distribution / Platform Signal', 'Sponsor-Funded Media',
    'Gulf Opportunity', 'Africa Opportunity', 'Europe Opportunity', 'North America Opportunity',
    'Cross-Border Opportunity', 'Relationship Target', 'Momentum Watch', 'Watch-Only',
  ],
  scoring: {
    dimensions: [
      { key: 'creative_ip_potential', label: 'Creative / IP potential', max: 5 },
      { key: 'amv_strategic_fit', label: 'AMV strategic fit', max: 5 },
      { key: 'decision_relationship_value', label: 'Decision / relationship action value', max: 5 },
      { key: 'timing_trajectory_novelty', label: 'Timing, trajectory and novelty', max: 5 },
      { key: 'evidence_quality', label: 'Evidence quality', max: 5 },
    ],
    maxScore: 25,
    showScoresToReader: false,
  },
  thresholds: [
    { tier: 'Priority', minScore: 21, maxScore: 25, requires: ['not on athletic performance alone'] },
    { tier: 'Radar', minScore: 16, maxScore: 20 },
    { tier: 'Watch', minScore: 11, maxScore: 15 },
    { tier: 'Exclude', minScore: 0, maxScore: 10, requires: ['or any hard-gate failure'] },
  ],
  confidenceLevels: [
    { key: 'high', detail: 'Official or strong-trade confirmation of the core claim.' },
    { key: 'medium', detail: 'Credible secondary confirmation, or partial detail.' },
    { key: 'low', detail: 'Single source, weak source, or status that needs rechecking.' },
  ],
  externalUseStatuses: [
    { key: 'external_safe', detail: 'Current reliable facts, accurate roles and status, no speculative relationship mapping, no implied AMV relationship.' },
    { key: 'internal_only', detail: 'Scouting, relationship mapping, internal interpretation, creative hypotheses, potential rights interest or AMV-specific analysis.' },
    { key: 'refresh_required', detail: 'Project, rights, credits, release, selection, commission or distribution status needs rechecking.' },
    { key: 'do_not_use_externally', detail: 'Weak or speculative sourcing, confidential targeting, or a hypothesis that could imply a relationship.' },
  ],
  outputModes: [
    { key: 'active_day', label: 'Active Day', when: 'One or more items qualified for Priority or Radar.' },
    { key: 'single_signal', label: 'Single Signal', when: 'Exactly one qualifying item.' },
    { key: 'quiet_window', label: 'Quiet Window', when: 'Nothing qualified; watch and forward items only.' },
    { key: 'review', label: 'Review', when: 'Material verification or coverage issue remains.' },
    { key: 'fail', label: 'Failure', when: 'Preflight or research failed; short record only.' },
  ],
  readerSections: [
    { key: 'executive_creative_decisions', heading: 'Executive Creative Decisions', required: true },
    { key: 'fresh_creative_ip_signals', heading: '1. Fresh Creative & IP Signals', required: true },
    { key: 'athlete_momentum', heading: '2. Athlete Momentum & Career Inflection Radar', required: true },
    { key: 'rolling_radar', heading: '3. Rolling Athlete, Project & Story Radar', required: true },
    { key: 'creative_partners', heading: '4. Creative Partners, Platforms & Relationship Radar', required: true },
    { key: 'opportunity_hypotheses', heading: '5. AMV Opportunity Hypotheses', required: true },
    { key: 'forward_watch', heading: '6. Forward Watch', required: true },
    { key: 'material_exclusions', heading: '7. Material Exclusions', required: true },
    { key: 'sources_approval', heading: '8. Sources & Approval Record', required: true },
  ],
  qaChecks: [
    ...SHARED_QA,
    {
      key: 'schema_version',
      assertion: 'OUTPUT_SCHEMA_VERSION equals AMV_CREATIVE_RADAR_V2.',
      severity: 'critical',
      automated: true,
    },
    {
      key: 'window_exactly_24h',
      assertion: 'The primary window is exactly 24 hours in standard_24h mode and the rolling context is exactly 7 days unless explicitly overridden.',
      severity: 'critical',
      automated: true,
    },
    {
      key: 'coverage_not_us_dominated',
      assertion: 'Gulf, African, European, women\'s, para and emerging-sport scouting was not crowded out by US mainstream coverage.',
      severity: 'major',
      automated: false,
    },
    {
      key: 'performance_trigger_discipline',
      assertion: 'A performance trigger is not elevated to Priority on athletic merit alone.',
      severity: 'major',
      automated: false,
    },
    {
      key: 'action_proportionate',
      assertion: 'Every elevated item carries exactly one proportionate action from the allowed list, and no contact/pitch/investment action appears without a credible route and internal authorisation.',
      severity: 'critical',
      automated: false,
    },
    {
      key: 'external_use_status_present',
      assertion: 'Every elevated item carries exactly one external-use status and one source-quality label.',
      severity: 'major',
      automated: false,
    },
  ],
  releaseStatuses: RELEASE_STATUSES,
  cleanOutputExclusions: CLEAN_OUTPUT_EXCLUSIONS,
  entityTargetTypes: ['person', 'organization', 'project', 'event', 'institution'],
};

export const GLOBA3_CREATIVE_RADAR: FormatConfig = {
  key: 'globa3_creative_radar',
  name: 'Globa 3 Creative Radar',
  productLine: 'Globa 3',
  description:
    'Daily creative-intelligence and scouting product for emerging talent, projects, story worlds, festival and market validation, labs, grants, regional IP, diaspora projects, women-led and sports-led stories, and creator-economy signals. Gulf, Africa and diaspora first.',
  confidentiality:
    'Internal scouting product. Must not become celebrity news, gossip, a streaming guide, a review roundup, a culture newsletter or a source log.',
  windowShape: {
    timeZone: 'Europe/Paris',
    coverageHours: 24,
    rollingContextDays: 7,
    forwardWatchDays: 30,
  },
  outputFilePattern: 'globa3_creative_radar_{run_date}.md',
  requiredVariables: [
    'RUN_DATE', 'RUN_TIMEZONE', 'COVERAGE_START', 'COVERAGE_END',
    'ROLLING_CONTEXT_START', 'ROLLING_CONTEXT_END',
    'FORWARD_WATCH_START', 'FORWARD_WATCH_END', 'OUTPUT_FOLDER',
  ],
  researchLanes: [
    { key: 'talent', label: 'Talent scan', detail: 'Gulf, African and diaspora filmmakers, producers, writers, directors, actors; emerging production companies; film schools, labs and short-film pathways.' },
    { key: 'projects', label: 'Project scan', detail: 'Short films, features, documentaries, series, animation, unscripted, sports documentaries; festival-, market- and lab-selected Gulf/African/diaspora projects; funded projects.' },
    { key: 'story_worlds', label: 'Story worlds and IP', detail: 'Regional story worlds, IP packages, women-led Arab and African stories, sports-led stories.' },
    { key: 'crossover', label: 'Artist / athlete / creator to IP', detail: 'Musician-to-screen, artist-to-IP, athlete-to-media, creator-to-platform and creator-to-IP signals.' },
    { key: 'institutional', label: 'Institutional, festival and funding', detail: 'Festivals, markets, labs, grants, funds, film institutes, commissions and foundations - but only where they reveal talent, project, IP or relationship pathways.' },
    { key: 'relationships', label: 'Relationship targets', detail: 'People and organisations worth a mapped relationship path, with the reason and the route.' },
  ],
  sourceFamilies: [
    'Variety; Deadline; The Hollywood Reporter; Screen Daily / Screen International; IndieWire',
    'BroadcastPro ME; C21 Media; TBI Vision; World Screen; Cineuropa and Film New Europe where relevant',
    'official festival, market, lab, fund and grant sources',
    'official platform, streamer and broadcaster press rooms',
    'official film institute, commission and foundation sources',
    'Music Business Worldwide and Billboard where music-to-screen or artist-to-IP relevant',
    'SportBusiness, SportsPro and Front Office Sports where athlete-media or sports-IP relevant',
    'Gulf / MENA film, culture and creative-economy sources',
    'African film, music, creator and creative-economy sources; diaspora creative sources',
  ],
  sourceTiers: [
    { tier: 'tier1_primary', label: 'Official source', detail: 'Festival, market, lab, fund, institute, platform or rights-holder statement.' },
    { tier: 'tier2_independent', label: 'Strong trade', detail: 'Established film, television or creative-industry trade reporting.' },
    { tier: 'tier3_supporting', label: 'Credible secondary / single-source / requires verification', detail: 'Weaker sourcing that must be labelled and, where elevated, flagged.' },
  ],
  sourceRules: [
    'Every item must carry exactly one primary source-quality label.',
    'Institutional live status is a hard rule: do not present a closed, past or dormant programme as live.',
    'Do not overstate festival awards, grant availability or project status.',
    'Do not overuse the Institutional proof point label.',
    'Do not fall back to broader project context, memory, old outputs or unrelated desk files to compensate for a missing selected file.',
  ],
  searchSequence: [
    'Run the source preflight and classify desk files as selected, missing or ignored.',
    'Scan every mandatory source lane inside the coverage window.',
    'Run the mandatory talent/project scan across all listed categories before drafting.',
    'Apply the talent/project-first rule: institutional items may not crowd out talent and projects.',
    'Apply the small-creative-signal rule so modest but real talent signals are not discarded.',
    'Verify institutional live status for every festival, lab, grant and fund item.',
    'Build rolling context from the 7-day window and compress repeats.',
    'Build forward watch inside the 30-day window.',
  ],
  freshnessLabels: [
    { key: 'type_a_fresh', label: 'Type A - Fresh', elevatable: true },
    { key: 'type_b_developing', label: 'Type B - Developing', elevatable: true },
    { key: 'rolling_context', label: 'Rolling context - not fresh today', elevatable: false },
    { key: 'outside_rolling_window', label: 'Outside rolling window - no new update today', elevatable: false },
  ],
  classifications: [
    'Emerging talent', 'Established talent with new signal', 'Project scouting', 'Story world / IP',
    'Artist-to-IP', 'Athlete-to-IP', 'Creator-to-IP', 'Sports-led story', 'Women-led story',
    'Youth / creator-economy signal', 'Institutional proof point', 'Festival validation',
    'Market validation', 'Platform validation', 'Funding pathway', 'Relationship target',
    'Watch-only', 'Rolling context', 'Outside rolling window',
  ],
  scoring: {
    dimensions: [
      { key: 'talent_project_value', label: 'Talent / project value', max: 5 },
      { key: 'globa3_relevance', label: 'Globa 3 relevance', max: 5 },
      { key: 'relationship_or_action_value', label: 'Relationship or action value', max: 5 },
      { key: 'freshness_and_timing', label: 'Freshness and timing', max: 5 },
      { key: 'source_quality', label: 'Source quality', max: 5 },
    ],
    maxScore: 25,
    showScoresToReader: false,
  },
  thresholds: [
    { tier: 'Priority', minScore: 21, maxScore: 25, requires: ['same-window fresh only for Section 1'] },
    { tier: 'Radar', minScore: 16, maxScore: 20 },
    { tier: 'Watch', minScore: 11, maxScore: 15 },
    { tier: 'Exclude', minScore: 0, maxScore: 10, requires: ['or any hard-gate failure'] },
  ],
  confidenceLevels: [
    { key: 'high', detail: 'Official source or strong trade confirms the core claim and the current status.' },
    { key: 'medium', detail: 'Credible secondary confirmation, or status partially unclear.' },
    { key: 'low', detail: 'Single or weak source, or live status unverified.' },
  ],
  externalUseStatuses: [
    { key: 'external_safe', detail: 'Source-controlled, current, non-speculative, no internal relationship mapping or unsupported analysis.' },
    { key: 'internal_only', detail: 'Useful for Globa 3 but includes relationship mapping, scouting, interpretation, sensitive positioning or incomplete external proof.' },
    { key: 'refresh_required', detail: 'Source status, availability, official mechanics, application, release, project or relationship path needs rechecking.' },
    { key: 'do_not_use_externally', detail: 'Weak, under-sourced, speculative, or internal-only by nature.' },
  ],
  outputModes: [
    { key: 'active_day', label: 'Active day', when: 'At least one same-window priority creative signal.' },
    { key: 'no_priority_signal', label: 'No priority signal', when: 'Nothing qualifies for Section 1; the no-priority-signal rule applies.' },
    { key: 'review', label: 'Review', when: 'Coverage, source-quality or live-status issue remains.' },
    { key: 'fail', label: 'Failure', when: 'Required selected files or preflight could not be verified.' },
  ],
  readerSections: [
    { key: 'executive_summary', heading: 'Executive Summary', required: true },
    { key: 'priority_creative_signals', heading: '1. Priority Creative Signals Today', required: true },
    { key: 'talent_relationship_radar', heading: '2. Talent & Relationship Radar', required: true },
    { key: 'projects_story_worlds', heading: '3. Projects & Story Worlds to Watch', required: true },
    { key: 'institutional_signals', heading: '4. Institutional / Festival / Funding Signals', required: true },
    { key: 'creator_to_ip_watch', heading: '5. Athlete / Artist / Creator-to-IP Watch', required: true },
    { key: 'top_signals_week', heading: '6. Top Creative Signals This Week', required: true },
    { key: 'relationship_targets', heading: '7. Relationship Targets', required: true },
    { key: 'projects_to_watch', heading: '8. Projects to Watch', required: true },
    { key: 'newsletter_themes', heading: '9. Possible Newsletter Themes', required: true },
    { key: 'rejected_not_elevated', heading: '10. Rejected / Not Elevated', required: true },
  ],
  qaChecks: [
    ...SHARED_QA,
    {
      key: 'talent_project_coverage_gate',
      assertion: 'The mandatory talent/project scan ran and talent or project items are present, not only institutional ones.',
      severity: 'critical',
      automated: false,
    },
    {
      key: 'institutional_overweight_gate',
      assertion: 'Institutional items do not dominate the radar.',
      severity: 'major',
      automated: false,
    },
    {
      key: 'institutional_live_status',
      assertion: 'Every festival, lab, grant and fund item states a verified live status; nothing closed or dormant is presented as open.',
      severity: 'critical',
      automated: false,
    },
    {
      key: 'section1_same_window_only',
      assertion: 'Section 1 contains only same-window fresh items.',
      severity: 'critical',
      automated: false,
    },
    {
      key: 'priority_geography',
      assertion: 'Gulf, Africa and diaspora come first; global items appear only when tied to those markets or to Globa 3 relationship value.',
      severity: 'major',
      automated: false,
    },
    {
      key: 'external_use_status_present',
      assertion: 'Every elevated item carries an external-use status and a Globa 3 relevance line.',
      severity: 'major',
      automated: false,
    },
    {
      key: 'full_structure_gate',
      assertion: 'All ten reader-facing sections are present, even when a section states that nothing qualified.',
      severity: 'major',
      automated: true,
    },
  ],
  releaseStatuses: RELEASE_STATUSES,
  cleanOutputExclusions: CLEAN_OUTPUT_EXCLUSIONS,
  entityTargetTypes: ['person', 'organization', 'project', 'institution', 'event'],
};

export const FORMAT_CONFIGS: Record<FormatKey, FormatConfig> = {
  amv_daily: AMV_DAILY,
  amv_creative_radar: AMV_CREATIVE_RADAR,
  globa3_creative_radar: GLOBA3_CREATIVE_RADAR,
};

export const FORMAT_KEYS = Object.keys(FORMAT_CONFIGS) as FormatKey[];

/** Source run-prompt file in the archive, used by the seed step. */
export const FORMAT_PROMPT_SOURCES: Record<FormatKey, { runPrompt: string; deskFiles: string[] }> = {
  amv_daily: { runPrompt: 'run_amv_daily_briefing.md', deskFiles: [] },
  amv_creative_radar: { runPrompt: 'run_amv_creative_radar.md', deskFiles: [] },
  globa3_creative_radar: {
    runPrompt: 'run_globa3_creative_radar.md',
    deskFiles: [
      'briefs/creative_radar/01_brief_creative_radar.md',
      'briefs/creative_radar/02_item_memory_creative_radar.md',
      'briefs/creative_radar/03_creative_radar_rules.md',
      'briefs/creative_radar/04_creative_radar_qa.md',
    ],
  },
};
