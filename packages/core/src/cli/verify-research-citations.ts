#!/usr/bin/env tsx
/**
 * Research sources are records a person approves, not URLs in a text field.
 *
 *   npm run verify:research-citations
 *
 * `contactResearchChanges` is a pure function: given a research profile it
 * returns the changes a person will review. That makes the citation rules
 * testable exactly, with no database, no server and no model.
 *
 * What it used to do, and why this exists: every source was concatenated into
 * the `notes` of a single "Public research: X" evidence row. The saved finding
 * then pointed at one record that mentioned several pages, so nothing could say
 * which source supported which claim, and a finding resting on three sources
 * cited none of them. Each source is now its own reviewable item, and each
 * finding-to-source link is its own item too.
 *
 * The rule this pins down hardest: a finding with several sources and nothing
 * saying which one it came from gets NO primary citation. Promoting one at
 * random would be invented provenance.
 */
import { contactResearchChanges } from '../contact-research.js';
import { researchProposalFromOutput } from '../research-proposal.js';

const checks: { name: string; passed: boolean }[] = [];
const expect = (name: string, passed: boolean, detail = '') => {
  checks.push({ name, passed });
  console.log(`  ${passed ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}`);
  if (detail && !passed) console.log(`        ${detail}`);
};
const section = (t: string) => console.log(`\n\x1b[1m${t}\x1b[0m`);

const src = (url: string, title: string | null = null) => ({ url, title });
const emptyProfile = {
  facts: [] as { statement: string; sources: { url: string; title: string | null }[] }[],
  inferences: [] as { statement: string; based_on: string; sources: { url: string; title: string | null }[] }[],
  recommendations: [] as { statement: string; rationale: string }[],
  gaps: [] as { question: string; why_it_matters: string }[],
  affiliations: [] as unknown[],
  public_profiles: [] as unknown[],
};
const row = { id: 'r1', contact_name: 'Anna Smith', confirmed_candidate: { name: 'Anna Smith', sources: [], explanation: 'x' } };
const build = (profile: Partial<typeof emptyProfile>) =>
  contactResearchChanges({
    profile: { ...emptyProfile, ...profile } as never,
    row: row as never,
    contact: null,
    existingItems: [],
  });

const mapResearch = (output: Omit<Parameters<typeof researchProposalFromOutput>[0], 'title' | 'summary'>) =>
  researchProposalFromOutput(
    { title: 'Research review', summary: 'A safe research result.', ...output },
    { title: 'Research review', summary: 'A safe research result.', subjectLabel: null },
  ).proposal;

const of = (result: ReturnType<typeof build>, table: string) => result.changes.filter((c) => c.target_table === table);
const fieldOf = (change: { fields: { name: string; value: string | null }[] }, name: string) =>
  change.fields.find((f) => f.name === name)?.value ?? null;

section('1. One source becomes one reviewable item, and one primary citation');
{
  const result = build({ facts: [{ statement: 'She runs drama at Horizon.', sources: [src('https://horizon.example/team', 'Horizon team page')] }] });
  const sources = of(result, 'evidence');
  const findings = of(result, 'research_findings');
  const citations = of(result, 'research_finding_evidence');
  expect('the source is its own item', sources.length === 1, JSON.stringify(sources.map((s) => s.label)));
  expect('it is titled readably, not by URL', sources[0]?.label === 'Horizon team page', String(sources[0]?.label));
  expect('and carries the real URL', fieldOf(sources[0]!, 'url') === 'https://horizon.example/team');
  expect('no page content is claimed for a page that was not fetched',
    fieldOf(sources[0]!, 'excerpt') === null && fieldOf(sources[0]!, 'notes') === null,
    JSON.stringify({ excerpt: fieldOf(sources[0]!, 'excerpt'), notes: fieldOf(sources[0]!, 'notes') }));
  expect('exactly one citation is proposed', citations.length === 1);
  expect('with a single source, that source is the origin', fieldOf(citations[0]!, 'role') === 'primary', String(fieldOf(citations[0]!, 'role')));
  expect('and the finding names it as the source it was written from',
    fieldOf(findings[0]!, 'evidence_label') === 'Horizon team page', String(fieldOf(findings[0]!, 'evidence_label')));
  // Dependencies come from the label REFERENCES in `fields`, which is the only
  // mechanism the apply path reads. The citation names both sides, so neither
  // can be written without the other having been approved.
  expect('the citation names BOTH the finding and the source as references',
    fieldOf(citations[0]!, 'finding_label') === findings[0]!.label &&
      fieldOf(citations[0]!, 'evidence_label') === 'Horizon team page',
    JSON.stringify(citations[0]!.fields));
}

section('2. One finding, three sources: no invented origin');
{
  const result = build({
    facts: [{
      statement: 'She produced three features last year.',
      sources: [src('https://a.example/one', 'Variety report'), src('https://b.example/two', 'Deadline report'), src('https://c.example/three', 'Screen Daily')],
    }],
  });
  const sources = of(result, 'evidence');
  const findings = of(result, 'research_findings');
  const citations = of(result, 'research_finding_evidence');
  expect('three sources, three reviewable items', sources.length === 3, JSON.stringify(sources.map((s) => s.label)));
  expect('three citations, one per source', citations.length === 3);
  expect('NONE is promoted to primary, because nothing says which came first',
    citations.every((c) => fieldOf(c, 'role') === 'supporting'),
    JSON.stringify(citations.map((c) => fieldOf(c, 'role'))));
  expect('and the finding claims no origin either',
    fieldOf(findings[0]!, 'evidence_label') === null, String(fieldOf(findings[0]!, 'evidence_label')));
  // With no stated origin the finding names no source directly; all three reach
  // it through their citations, each of which names the finding and its source.
  expect('all three sources reach the finding through their citations',
    citations.length === 3 && citations.every((c) => fieldOf(c, 'finding_label') === findings[0]!.label),
    JSON.stringify(citations.map((c) => fieldOf(c, 'finding_label'))));
}

section('3. The same page cited twice is one item, not two');
{
  const result = build({
    facts: [
      { statement: 'First claim.', sources: [src('https://same.example/page', 'The page')] },
      { statement: 'Second claim.', sources: [src('https://same.example/page?utm=x#frag', 'The page')] },
    ],
  });
  const sources = of(result, 'evidence');
  const citations = of(result, 'research_finding_evidence');
  expect('one page, one source item even with tracking parameters', sources.length === 1, JSON.stringify(sources.map((s) => s.label)));
  expect('but both findings cite it', citations.length === 2, JSON.stringify(citations.map((c) => c.label)));
  expect('each citation names its own finding',
    new Set(citations.map((c) => fieldOf(c, 'finding_label'))).size === 2,
    JSON.stringify(citations.map((c) => fieldOf(c, 'finding_label'))));
}

section('4. A claim with no source is not a source-backed fact');
{
  const result = build({ facts: [{ statement: 'Something unsourced.', sources: [] }] });
  const findings = of(result, 'research_findings');
  expect('it is recorded as an inference, not a fact',
    findings.length === 1 && fieldOf(findings[0]!, 'finding_type') === 'inference',
    JSON.stringify(findings.map((f) => fieldOf(f, 'finding_type'))));
  expect('it proposes no source and no citation',
    of(result, 'evidence').length === 0 && of(result, 'research_finding_evidence').length === 0);
}

section('5. Sources with nothing said about them are not a research result');
{
  const result = build({});
  expect('a profile with only a gap proposes findings, not bare pages',
    of(result, 'evidence').length === 0, JSON.stringify(result.changes.map((c) => c.target_table)));
}

section('6. Every citation is reviewable, and none is hidden');
{
  const result = build({
    facts: [{ statement: 'A claim.', sources: [src('https://x.example/1', 'X one'), src('https://y.example/2', 'Y two')] }],
  });
  const citations = of(result, 'research_finding_evidence');
  expect('each citation is an explicit proposal item with a reason a person can read',
    citations.every((c) => typeof c.reason === 'string' && c.reason.length > 20 && !/research_finding_evidence|evidence_id|finding_id/i.test(c.reason)),
    JSON.stringify(citations.map((c) => c.reason)));
  expect('no citation invents a primary when the origin is unknown',
    citations.every((c) => fieldOf(c, 'role') === 'supporting'));
}

section('7. The server, not the model, authors the citation graph');
{
  const result = mapResearch({
    sources: [
      { url: 'http://WWW.Example.com/report/?utm_source=news#top', title: 'Report', publisher: 'Example', published_date: null },
      { url: 'https://example.com/report', title: 'Duplicate', publisher: null, published_date: null },
      { url: 'mailto:editor@example.com', title: 'Not a page', publisher: null, published_date: null },
    ],
    facts: [{ statement: 'A supported claim.', source_urls: ['https://example.com/report', 'https://missing.example/nope'], origin_url: 'https://example.com/report', confidence: 'high' }],
    interpretations: [], recommendations: [], gaps: [], risks: [],
  });
  const sources = of(result, 'evidence');
  const citations = of(result, 'research_finding_evidence');
  expect('URL variants become one canonical source', sources.length === 1 && fieldOf(sources[0]!, 'url') === 'https://example.com/report', JSON.stringify(sources));
  expect('an unknown cited URL is not turned into evidence', sources.length === 1 && citations.length === 1, JSON.stringify(result.changes));
  expect('a validated origin becomes the one primary citation', fieldOf(citations[0]!, 'role') === 'primary', JSON.stringify(citations));
}

section('8. Ambiguous or unsupported model attribution never becomes invented provenance');
{
  const result = mapResearch({
    sources: [
      { url: 'https://one.example/a', title: 'One', publisher: null, published_date: null },
      { url: 'https://two.example/b', title: 'Two', publisher: null, published_date: null },
    ],
    facts: [
      { statement: 'Several sources agree.', source_urls: ['https://one.example/a', 'https://two.example/b'], origin_url: null, confidence: 'medium' },
      { statement: 'No usable source.', source_urls: ['https://missing.example/c'], origin_url: 'https://missing.example/c', confidence: 'high' },
    ],
    interpretations: [{ statement: 'A reading with accidental citations.', based_on: null, confidence: 'medium', source_urls: ['https://one.example/a'] }],
    recommendations: [], gaps: [], risks: [],
  });
  const citations = of(result, 'research_finding_evidence');
  const findings = of(result, 'research_findings');
  expect('uncertain origin yields supporting-only citations', citations.length === 2 && citations.every((c) => fieldOf(c, 'role') === 'supporting'), JSON.stringify(citations));
  expect('an unsupported fact is downgraded to an inference', findings.some((f) => f.label.startsWith('No usable source') && fieldOf(f, 'finding_type') === 'inference'), JSON.stringify(findings));
  expect('interpretation citations are stripped', !citations.some((c) => fieldOf(c, 'finding_label')?.startsWith('A reading')), JSON.stringify(citations));
}

section('9. A wholly unusable model answer creates no reviewable proposal');
{
  let refused = false;
  try {
    mapResearch({
      sources: [{ url: 'file:///private/source', title: 'Private file', publisher: null, published_date: null }],
      facts: [], interpretations: [], recommendations: [], gaps: [], risks: [],
    });
  } catch {
    refused = true;
  }
  expect('nothing reviewable is rejected before a proposal exists', refused);
}

section('Summary');
const failed = checks.filter((c) => !c.passed);
console.log(`${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length > 0) {
  for (const f of failed) console.log(`  \x1b[31mFAIL\x1b[0m  ${f.name}`);
  process.exit(1);
}
