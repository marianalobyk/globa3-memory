/**
 * Turning a research result into a proposal, without letting the model do it.
 *
 * Until now the research pipeline asked the model for the proposal itself:
 * evidence records, findings, citation links, roles and dependencies, ready to
 * insert. That made every citation invariant a matter of the model following
 * instructions. A well-formed answer travelled correctly; a malformed one --
 * a primary URL that appears nowhere, two sources that are the same page with
 * different tracking parameters, an interpretation carrying citations, a fact
 * citing a source that was never described -- would have been written down as
 * given, and the review would have shown provenance that was not real.
 *
 * So the model now returns only what it can honestly know: the sources it
 * found, the facts it read from them, its own interpretations, and what it
 * could not establish. Everything structural -- which evidence records exist,
 * which finding cites which source, which citation is primary, and what depends
 * on what -- is decided here, in code, deterministically.
 *
 * The rules, and what happens when the model breaks them:
 *
 *   - A URL that does not parse, or is not http(s), is dropped. It never
 *     becomes evidence.
 *   - The same page cited twice in different forms is one source.
 *   - A fact citing a URL that appears in no source descriptor loses that
 *     citation. Losing all of them makes the claim unsupported.
 *   - An unsupported claim is NOT discarded and NOT given a source: it is kept
 *     as an interpretation and labelled as resting on nothing.
 *   - `primary` is set only when the fact names exactly one origin and that
 *     origin is among its own valid sources. Anything else is supporting-only.
 *   - Interpretations, gaps and risks never carry citations, whatever the model
 *     attached to them.
 *   - A source nothing ends up citing is not proposed at all.
 *
 * If, after all of that, there is nothing a person could review, the result is
 * rejected outright and no child proposal is created.
 */
import type { ProposedChange, CaptureProposal } from '@g3/shared';
import { z } from 'zod';
import { badRequest } from './errors.js';

/** Sanity ceilings. Beyond these the result is not a research answer. */
export const RESEARCH_LIMITS = {
  sources: 25,
  facts: 20,
  interpretations: 15,
  gaps: 15,
  titleChars: 190,
  statementChars: 2_000,
} as const;

/** The model returns meaning only. Records and citation structure are server-authored. */
export const ResearchProposalOutput = z.object({
  title: z.string(),
  summary: z.string(),
  sources: z.array(z.object({
    url: z.string(),
    title: z.string().nullable(),
    publisher: z.string().nullable(),
    published_date: z.string().nullable(),
  })),
  facts: z.array(z.object({
    statement: z.string(),
    source_urls: z.array(z.string()),
    origin_url: z.string().nullable(),
    confidence: z.enum(['high', 'medium', 'low']).nullable(),
  })),
  interpretations: z.array(z.object({
    statement: z.string(),
    based_on: z.string().nullable(),
    confidence: z.enum(['high', 'medium', 'low']).nullable(),
    source_urls: z.array(z.string()),
  })),
  recommendations: z.array(z.object({ statement: z.string(), rationale: z.string().nullable() })),
  gaps: z.array(z.object({ question: z.string(), why_it_matters: z.string().nullable() })),
  risks: z.array(z.object({ statement: z.string(), severity: z.enum(['high', 'medium', 'low']).nullable() })),
});
export type ResearchOutput = z.infer<typeof ResearchProposalOutput>;

export interface ResearchMappingNote {
  kind: 'dropped_source' | 'dropped_citation' | 'downgraded_fact' | 'stripped_citation' | 'truncated' | 'capped';
  detail: string;
}

export interface ResearchProposalResult {
  proposal: CaptureProposal;
  /** Every correction made to the model's answer, for the run log. */
  notes: ResearchMappingNote[];
}

/**
 * One page, one identity.
 *
 * Case in the host, no trailing slash, no fragment, and no tracking parameters:
 * `utm_*`, `gclid`, `fbclid` and friends identify a click, not a document.
 * Other query parameters are kept, because `?id=42` frequently is the document.
 */
export function normaliseUrl(raw: string): string | null {
  const trimmed = String(raw ?? '').trim();
  if (trimmed.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!parsed.hostname.includes('.')) return null;
  for (const key of [...parsed.searchParams.keys()]) {
    if (/^(utm_|mc_|ref$|referrer$|gclid$|fbclid$|igshid$|si$)/i.test(key)) parsed.searchParams.delete(key);
  }
  parsed.hash = '';
  parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
  parsed.protocol = 'https:';
  const path = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.origin}${path}${parsed.search}`;
}

const clip = (value: string, max: number) => (value.length <= max ? value : `${value.slice(0, max - 1)}…`);
const clean = (value: unknown): string | null => {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length > 0 ? text : null;
};

/**
 * Builds the reviewable proposal from a research result.
 *
 * Throws when nothing survives validation, so a malformed answer produces no
 * child proposal at all rather than an empty or misleading one.
 */
export function researchProposalFromOutput(
  output: ResearchOutput,
  context: { title: string; summary: string; subjectLabel: string | null },
): ResearchProposalResult {
  const notes: ResearchMappingNote[] = [];
  const note = (kind: ResearchMappingNote['kind'], detail: string) => notes.push({ kind, detail });

  // ---- 1. Sources: normalise, drop what cannot be a page, deduplicate. ----
  const sources = new Map<string, { url: string; title: string; publisher: string | null; date: string | null }>();
  for (const raw of (output.sources ?? []).slice(0, RESEARCH_LIMITS.sources)) {
    const url = normaliseUrl(raw.url);
    if (!url) {
      note('dropped_source', `"${clip(String(raw.url ?? ''), 80)}" is not a usable web address.`);
      continue;
    }
    if (sources.has(url)) continue;
    const publisher = clean(raw.publisher);
    let host: string | null = null;
    try { host = new URL(url).hostname; } catch { host = null; }
    sources.set(url, {
      url,
      title: clip(clean(raw.title) ?? publisher ?? host ?? url, RESEARCH_LIMITS.titleChars),
      publisher,
      date: clean(raw.published_date),
    });
  }
  if ((output.sources ?? []).length > RESEARCH_LIMITS.sources) {
    note('capped', `Only the first ${RESEARCH_LIMITS.sources} sources were considered.`);
  }

  // ---- 2. Facts: keep only citations that name a source we actually have. ----
  interface Claim {
    statement: string;
    cited: string[];
    origin: string | null;
    confidence: string;
    supported: boolean;
  }
  const claims: Claim[] = [];
  for (const fact of (output.facts ?? []).slice(0, RESEARCH_LIMITS.facts)) {
    const statement = clean(fact.statement);
    if (!statement) continue;
    const cited = [...new Set((fact.source_urls ?? []).map((u) => normaliseUrl(u)).filter((u): u is string => Boolean(u) && sources.has(u!)))];
    const unknown = (fact.source_urls ?? []).length - cited.length;
    if (unknown > 0) {
      note('dropped_citation', `${unknown} citation(s) on "${clip(statement, 60)}" named a source that was never described.`);
    }
    const originRaw = fact.origin_url ? normaliseUrl(fact.origin_url) : null;
    // A primary is only meaningful when it is one of this claim's own sources.
    const origin = originRaw && cited.includes(originRaw) ? originRaw : null;
    if (fact.origin_url && !origin) {
      note('dropped_citation', `The stated origin of "${clip(statement, 60)}" is not among its sources, so no primary was set.`);
    }
    if (cited.length === 0) {
      // Not discarded, and not given a source it does not have.
      note('downgraded_fact', `"${clip(statement, 60)}" cites no usable source, so it is kept as an unconfirmed reading.`);
      claims.push({ statement: clip(statement, RESEARCH_LIMITS.statementChars), cited: [], origin: null, confidence: 'low', supported: false });
      continue;
    }
    claims.push({
      statement: clip(statement, RESEARCH_LIMITS.statementChars),
      cited,
      origin,
      confidence: clean(fact.confidence) ?? 'medium',
      supported: true,
    });
  }

  // ---- 3. Only sources something actually cites are proposed. ----
  const used = new Set(claims.flatMap((c) => c.cited));
  for (const url of sources.keys()) {
    if (!used.has(url)) {
      note('dropped_source', `${sources.get(url)!.title} was found but nothing rests on it, so it is not saved.`);
      sources.delete(url);
    }
  }

  // ---- 4. Build the changes. Labels are unique within the proposal. ----
  const changes: ProposedChange[] = [];
  const taken = new Set<string>();
  const label = (text: string, suffix: string) => {
    let candidate = clip(text, RESEARCH_LIMITS.titleChars) || suffix;
    let n = 2;
    while (taken.has(candidate.toLowerCase())) {
      // Reserve exactly what the disambiguator costs. A fixed guess overflowed
      // the column budget for longer suffixes and two-digit counts.
      const tail = ` (${suffix} ${n})`;
      candidate = `${clip(text, RESEARCH_LIMITS.titleChars - tail.length)}${tail}`;
      n += 1;
    }
    taken.add(candidate.toLowerCase());
    return candidate;
  };
  const field = (name: string, value: string | null) => ({ name, value });

  const sourceLabel = new Map<string, string>();
  for (const [url, source] of sources) {
    const itemLabel = label(source.title, 'source');
    sourceLabel.set(url, itemLabel);
    changes.push({
      op: 'create',
      target_table: 'evidence',
      label: itemLabel,
      claim_type: null,
      confidence: null,
      reason: source.publisher
        ? `A public page from ${source.publisher}. Not verified.`
        : 'A public page found by research. Not verified.',
      fields: [
        field('source_type', 'url'),
        field('title', source.title),
        field('url', url),
        field('source_date', source.date),
        field('reliability', 'unverified'),
        // The page was not retrieved, so nothing of its content is claimed.
        field('provenance_note', 'Cited by research. The page itself was not stored.'),
      ],
      source_urls: [url],
    });
  }

  for (const claim of claims) {
    const findingLabel = label(claim.statement, claim.supported ? 'fact' : 'reading');
    const originLabel = claim.origin ? sourceLabel.get(claim.origin) ?? null : null;
    changes.push({
      op: 'create',
      target_table: 'research_findings',
      label: findingLabel,
      claim_type: claim.supported ? 'fact' : 'inference',
      confidence: claim.supported ? (claim.confidence as never) : 'low',
      reason: claim.supported
        ? 'Stated by the public sources cited with it.'
        : 'Research stated this but cited nothing that supports it, so it is kept as an unconfirmed reading.',
      fields: [
        field('finding_type', claim.supported ? 'fact' : 'inference'),
        field('title', findingLabel),
        field(
          'content',
          claim.supported ? claim.statement : `${claim.statement}\n\nNo source was cited for this.`,
        ),
        field('confidence', claim.supported ? claim.confidence : 'low'),
        // Only a stated, valid origin becomes the source it was written from.
        field('evidence_label', originLabel),
      ],
      source_urls: claim.cited,
    });

    // Citations, one per cited source, deduplicated by construction.
    for (const url of claim.cited) {
      const cited = sourceLabel.get(url);
      if (!cited) continue;
      changes.push({
        op: 'link',
        target_table: 'research_finding_evidence',
        label: label(`${findingLabel} ← ${cited}`, 'citation'),
        claim_type: null,
        confidence: null,
        reason: 'Records which source supports this, so the saved record can cite it later.',
        fields: [
          field('finding_label', findingLabel),
          field('evidence_label', cited),
          field('role', originLabel === cited ? 'primary' : 'supporting'),
        ],
        source_urls: [],
      });
    }
  }

  // Interpretations, gaps and risks never carry citations, whatever arrived.
  for (const interpretation of (output.interpretations ?? []).slice(0, RESEARCH_LIMITS.interpretations)) {
    const statement = clean(interpretation.statement);
    if (!statement) continue;
    if ((interpretation as { source_urls?: unknown[] }).source_urls?.length) {
      note('stripped_citation', `"${clip(statement, 60)}" is a reading, not a source-backed claim, so its citations were removed.`);
    }
    const itemLabel = label(statement, 'reading');
    changes.push({
      op: 'create',
      target_table: 'research_findings',
      label: itemLabel,
      claim_type: 'inference',
      confidence: 'low',
      reason: 'A reading of the research, not stated by any source.',
      fields: [
        field('finding_type', 'inference'),
        field('title', itemLabel),
        field('content', clean(interpretation.based_on) ? `${statement}\n\nBased on: ${interpretation.based_on}` : statement),
        field('confidence', clean(interpretation.confidence) ?? 'low'),
      ],
      source_urls: [],
    });
  }

  for (const recommendation of (output.recommendations ?? []).slice(0, RESEARCH_LIMITS.interpretations)) {
    const statement = clean(recommendation.statement);
    if (!statement) continue;
    const itemLabel = label(statement, 'recommendation');
    changes.push({
      op: 'create',
      target_table: 'research_findings',
      label: itemLabel,
      claim_type: 'recommendation',
      confidence: 'low',
      reason: 'A suggested next step based on the research, not a source-backed fact.',
      fields: [
        field('finding_type', 'recommendation'),
        field('title', itemLabel),
        field('content', clean(recommendation.rationale) ? `${statement}\n\nWhy: ${recommendation.rationale}` : statement),
        field('confidence', 'low'),
      ],
      source_urls: [],
    });
  }

  for (const gap of (output.gaps ?? []).slice(0, RESEARCH_LIMITS.gaps)) {
    const question = clean(gap.question);
    if (!question) continue;
    const itemLabel = label(question, 'gap');
    changes.push({
      op: 'create',
      target_table: 'research_findings',
      label: itemLabel,
      claim_type: 'gap',
      confidence: 'low',
      reason: 'Research could not establish this.',
      fields: [
        field('finding_type', 'gap'),
        field('title', itemLabel),
        field('content', clean(gap.why_it_matters) ? `${question}\n\nWhy it matters: ${gap.why_it_matters}` : question),
        field('confidence', 'low'),
      ],
      source_urls: [],
    });
  }

  for (const risk of (output.risks ?? []).slice(0, RESEARCH_LIMITS.gaps)) {
    const statement = clean(risk.statement);
    if (!statement) continue;
    const itemLabel = label(statement, 'risk');
    changes.push({
      op: 'create',
      target_table: 'research_findings',
      label: itemLabel,
      claim_type: 'risk',
      confidence: 'low',
      reason: 'Something to be careful about, raised by the research.',
      fields: [
        field('finding_type', 'risk'),
        field('title', itemLabel),
        field('content', statement),
        field('confidence', clean(risk.severity) ?? 'low'),
      ],
      source_urls: [],
    });
  }

  // ---- 5. Nothing reviewable means nothing to review. ----
  const findings = changes.filter((c) => c.target_table === 'research_findings');
  if (findings.length === 0) {
    throw badRequest('The research returned nothing that could be reviewed.');
  }

  return {
    proposal: {
      title: context.title,
      summary: context.summary,
      changes,
      unresolved_mentions: [],
      notes: notes.map((n) => n.detail),
    },
    notes,
  };
}
