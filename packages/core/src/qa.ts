/**
 * Deterministic half of the QA and release gate.
 *
 * Every check a format marks `automated: true` is decided here, in code, over
 * the actual draft text and source list -- not by asking the model whether it
 * did a good job. The model's own hostile review is merged in for the
 * judgement-based checks, and the final release status is the more severe of the
 * two verdicts.
 */
import type { FormatConfig, QaVerdict, RunWindows, SourceRef } from '@g3/shared';

export interface AutomatedCheck {
  key: string;
  passed: boolean;
  severity: 'critical' | 'major' | 'minor';
  note: string;
  decidedBy: 'code';
}

const PLACEHOLDER_PATTERNS = [
  /\bdirect url\b/i,
  /\binsert link\b/i,
  /\bsource here\b/i,
  /\bTBD\b/,
  /\[link\]/i,
  /\[url\]/i,
  /\bxxx\b/i,
  /\blorem ipsum\b/i,
];

const URL_PATTERN = /https?:\/\/[^\s)\]>"']+/g;

function findUrls(text: string): string[] {
  return [...(text.match(URL_PATTERN) ?? [])].map((u) => u.replace(/[.,;:]+$/, ''));
}

function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export interface AutomatedQaInput {
  format: FormatConfig;
  windows: RunWindows;
  variables: Record<string, string>;
  missingVariables: string[];
  bodyMd: string;
  sources: SourceRef[];
  outputMode: string;
}

export function runAutomatedQa(input: AutomatedQaInput): AutomatedCheck[] {
  const checks: AutomatedCheck[] = [];
  const add = (
    key: string,
    passed: boolean,
    severity: 'critical' | 'major' | 'minor',
    note: string,
  ): void => {
    checks.push({ key, passed, severity, note, decidedBy: 'code' });
  };

  // --- metadata gate -------------------------------------------------------
  add(
    'metadata_gate',
    input.missingVariables.length === 0,
    'critical',
    input.missingVariables.length === 0
      ? `All ${input.format.requiredVariables.length} required variables were computed by the orchestrator before research.`
      : `Missing required run variables: ${input.missingVariables.join(', ')}.`,
  );

  const isoLike = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;
  const timestamps: [string, string | undefined][] = [
    ['RUN_TIME_ISO', input.windows.runTimeIso],
    ['COVERAGE_START_ISO', input.windows.coverageStartIso],
    ['COVERAGE_END_ISO', input.windows.coverageEndIso],
    ['BACKSTOP_START_ISO', input.windows.backstopStartIso],
    ['ROLLING_CONTEXT_START_ISO', input.windows.rollingContextStartIso],
  ];
  const badTimestamps = timestamps
    .filter(([, value]) => value !== undefined && !isoLike.test(value))
    .map(([name]) => name);
  add(
    'timestamps_iso8601',
    badTimestamps.length === 0,
    'critical',
    badTimestamps.length === 0
      ? 'Every timestamp is ISO-8601 with an explicit offset.'
      : `Not valid ISO-8601 with offset: ${badTimestamps.join(', ')}.`,
  );

  // --- coverage window shape ----------------------------------------------
  const elapsedHours =
    (new Date(input.windows.coverageEndIso).getTime() -
      new Date(input.windows.coverageStartIso).getTime()) /
    3_600_000;
  const expectedHours = input.format.windowShape.coverageHours;
  add(
    'window_exactly_24h',
    Math.abs(elapsedHours - expectedHours) < 0.001,
    'critical',
    `Primary coverage window is ${elapsedHours}h of elapsed time; the format requires ${expectedHours}h.` +
      (input.windows.coverageSpansDstChange
        ? ' The window crosses a DST transition, so the local clock boundaries are not both midnight.'
        : ''),
  );

  if (input.format.windowShape.rollingContextDays !== undefined) {
    const rollingDays =
      input.windows.rollingContextStartIso && input.windows.rollingContextEndIso
        ? (new Date(input.windows.rollingContextEndIso).getTime() -
            new Date(input.windows.rollingContextStartIso).getTime()) /
          86_400_000
        : 0;
    add(
      'rolling_context_window',
      Math.abs(rollingDays - input.format.windowShape.rollingContextDays) < 0.09,
      'major',
      `Rolling context window is ${rollingDays.toFixed(2)} days; expected ${input.format.windowShape.rollingContextDays}.`,
    );
  }

  if (input.format.outputSchemaVersion) {
    const declared = input.variables.OUTPUT_SCHEMA_VERSION;
    add(
      'schema_version',
      declared === input.format.outputSchemaVersion,
      'critical',
      `OUTPUT_SCHEMA_VERSION is "${declared ?? 'unset'}"; the format requires "${input.format.outputSchemaVersion}".`,
    );
  }

  // --- placeholders and URLs ----------------------------------------------
  const placeholders = PLACEHOLDER_PATTERNS.filter((p) => p.test(input.bodyMd)).map((p) => String(p));
  add(
    'no_placeholders',
    placeholders.length === 0,
    'critical',
    placeholders.length === 0
      ? 'No placeholder text found in the body.'
      : `Placeholder text found: ${placeholders.join(', ')}.`,
  );

  const badSourceUrls = input.sources.filter((s) => !isAbsoluteHttpUrl(s.url)).map((s) => s.url);
  add(
    'urls_absolute',
    badSourceUrls.length === 0,
    'critical',
    badSourceUrls.length === 0
      ? `All ${input.sources.length} source URLs are absolute http(s).`
      : `Not absolute http(s) URLs: ${badSourceUrls.slice(0, 5).join(', ')}.`,
  );

  // Every URL cited inline must appear in the source list.
  const listed = new Set(input.sources.map((s) => s.url.replace(/\/+$/, '')));
  const citedInBody = new Set(findUrls(input.bodyMd).map((u) => u.replace(/\/+$/, '')));
  const uncited = [...citedInBody].filter((u) => !listed.has(u));
  add(
    'citations_listed',
    uncited.length === 0,
    'major',
    uncited.length === 0
      ? 'Every URL in the body also appears in the source list.'
      : `Cited in the body but absent from the source list: ${uncited.slice(0, 5).join(', ')}.`,
  );

  // --- internal scoring must not leak ------------------------------------
  const scorePatterns = [
    /\b(?:score|scored|scoring)\s*[:=]?\s*\d{1,2}\s*\/\s*25\b/i,
    /\btotal\s+score\b/i,
    /\b\d{1,2}\s*\/\s*25\b/,
  ];
  const leaked = scorePatterns.some((p) => p.test(input.bodyMd));
  add(
    'no_numeric_scores',
    !leaked,
    'major',
    leaked
      ? 'The body appears to expose internal numerical scores, which the format forbids.'
      : 'No internal numerical scores appear in the body.',
  );

  // --- required reader structure ------------------------------------------
  const headings = [...input.bodyMd.matchAll(/^#{1,4}\s+(.+?)\s*$/gm)].map((m) =>
    (m[1] ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(),
  );
  const normalize = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const missingSections = input.format.readerSections
    .filter((section) => section.required)
    .filter((section) => {
      const want = normalize(section.heading);
      // Tolerate a numbered prefix and minor wording drift.
      const wantWithoutNumber = want.replace(/^\d+\s*/, '');
      return !headings.some(
        (h) => h.includes(wantWithoutNumber) || wantWithoutNumber.includes(h.replace(/^\d+\s*/, '')),
      );
    })
    .map((section) => section.heading);

  // A quiet window or failure record is legitimately shorter.
  const shortModes = ['quiet_window', 'fail', 'review', 'no_priority_signal', 'single_signal'];
  const structureRequired = !shortModes.includes(input.outputMode);
  add(
    'full_structure_gate',
    !structureRequired || missingSections.length === 0,
    'major',
    structureRequired
      ? missingSections.length === 0
        ? 'All required reader-facing sections are present.'
        : `Missing required sections: ${missingSections.join('; ')}.`
      : `Output mode "${input.outputMode}" permits a reduced structure; section check skipped.`,
  );

  // --- press-release handling --------------------------------------------
  const pressReleases = input.sources.filter((s) => s.is_press_release);
  const independent = input.sources.filter(
    (s) => !s.is_press_release && s.source_tier === 'tier2_independent',
  );
  add(
    'press_release_not_corroboration',
    pressReleases.length === 0 || independent.length > 0 || input.sources.length <= 1,
    'major',
    pressReleases.length === 0
      ? 'No press releases among the sources.'
      : independent.length > 0
        ? `${pressReleases.length} press release(s) present, with ${independent.length} independent source(s) alongside.`
        : 'Sources are press releases only, with no independent corroboration. Claims relying on them must stay at Watch.',
  );

  // Distinct hosts, so syndicated copies are not counted as confirmation.
  const hosts = new Set(
    input.sources
      .map((s) => {
        try {
          return new URL(s.url).host.replace(/^www\./, '');
        } catch {
          return null;
        }
      })
      .filter((h): h is string => h !== null),
  );
  add(
    'distinct_sources',
    input.sources.length === 0 || hosts.size > 0,
    'minor',
    `${input.sources.length} source(s) across ${hosts.size} distinct host(s).`,
  );

  return checks;
}

const SEVERITY_ORDER = { critical: 3, major: 2, minor: 1 } as const;

/**
 * Merges the code verdict with the model's hostile review. Code wins on any
 * check it can decide, and the resulting status is the more severe of the two.
 */
export function mergeQaVerdict(
  automated: AutomatedCheck[],
  modelVerdict: QaVerdict | null,
  format: FormatConfig,
): QaVerdict & { checks: (AutomatedCheck | (QaVerdict['checks'][number] & { decidedBy: 'model' }))[] } {
  const automatedKeys = new Set(automated.map((c) => c.key));
  const modelChecks = (modelVerdict?.checks ?? [])
    .filter((c) => !automatedKeys.has(c.key))
    .map((c) => ({ ...c, decidedBy: 'model' as const }));
  const checks = [...automated, ...modelChecks];

  const failedCritical = checks.filter((c) => !c.passed && c.severity === 'critical');
  const failedMajor = checks.filter((c) => !c.passed && c.severity === 'major');

  let status: QaVerdict['release_status'];
  if (failedCritical.length > 0) {
    status = 'fail_do_not_distribute';
  } else if (failedMajor.length > 0) {
    status = 'review_internal_only';
  } else {
    status = modelVerdict?.release_status ?? 'review_internal_only';
  }

  // Never report a cleaner status than the model asked for.
  if (modelVerdict) {
    const rank: Record<QaVerdict['release_status'], number> = {
      pass_internal_only: 0,
      pass_quiet_window_internal_only: 1,
      review_internal_only: 2,
      fail_do_not_distribute: 3,
    };
    if (rank[modelVerdict.release_status] > rank[status]) status = modelVerdict.release_status;
  }

  const worst = checks
    .filter((c) => !c.passed)
    .sort((a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity]);

  return {
    checks,
    release_status: status,
    summary:
      worst.length === 0
        ? `All ${checks.length} checks passed for ${format.name}.`
        : `${worst.length} of ${checks.length} checks failed. Most severe: ${worst[0]?.key} (${worst[0]?.severity}).`,
    required_corrections: [
      ...worst.filter((c) => c.severity !== 'minor').map((c) => `${c.key}: ${c.note}`),
      ...(modelVerdict?.required_corrections ?? []),
    ],
  };
}
