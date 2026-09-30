#!/usr/bin/env tsx
/**
 * What the server does with a research answer that is wrong.
 *
 *   npm run verify:research-mapping
 *
 * The success fixture proves a well-formed model answer travels through the
 * pipeline intact. It proves nothing about a bad one, and a bad one is the
 * normal case to design for: a primary URL that appears nowhere, the same page
 * cited twice with different tracking parameters, an interpretation carrying
 * citations, a fact citing a source that was never described.
 *
 * The model no longer authors evidence rows, citation rows, roles, labels or
 * dependencies -- `researchProposalFromOutput` does, from semantic output only.
 * This pins down what it does when that semantic output is malformed.
 *
 * `researchProposalFromOutput` is pure, so every case here runs with no
 * database, no server and no model. A rejection therefore happens strictly
 * before any proposal or memory row could exist: there is nothing to roll back
 * because nothing was ever started.
 */
import { researchProposalFromOutput, normaliseUrl, RESEARCH_LIMITS, type ResearchOutput } from '../research-proposal.js';
import { isAppError } from '../errors.js';

const checks: { name: string; passed: boolean }[] = [];
const expect = (name: string, passed: boolean, detail = '') => {
  checks.push({ name, passed });
  console.log(`  ${passed ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}`);
  if (detail && !passed) console.log(`        ${detail}`);
};
const section = (t: string) => console.log(`\n\x1b[1m${t}\x1b[0m`);

const EMPTY: ResearchOutput = {
  title: 'Research', summary: 'Summary',
  sources: [], facts: [], interpretations: [], recommendations: [], gaps: [], risks: [],
};
const out = (partial: Partial<ResearchOutput>): ResearchOutput => ({ ...EMPTY, ...partial });
const ctx = { title: 'Research', summary: 'Summary', subjectLabel: null };
const build = (partial: Partial<ResearchOutput>) => researchProposalFromOutput(out(partial), ctx);
const of = (r: ReturnType<typeof build>, table: string) => r.proposal.changes.filter((c) => c.target_table === table);
const fieldOf = (c: { fields: { name: string; value: string | null }[] }, n: string) =>
  c.fields.find((f) => f.name === n)?.value ?? null;
/** Runs a mapping that must be refused outright. */
const refused = (name: string, partial: Partial<ResearchOutput>) => {
  let threw = false;
  let message = '(it returned a proposal)';
  try {
    build(partial);
  } catch (error) {
    threw = true;
    message = isAppError(error) ? error.message : String(error);
  }
  expect(name, threw, message);
  return message;
};

const src = (url: string, title: string | null = null, publisher: string | null = null) =>
  ({ url, title, publisher, published_date: null });
const fact = (statement: string, source_urls: string[], origin_url: string | null = null) =>
  ({ statement, source_urls, origin_url, confidence: 'high' as const });

section('1. The same page, written several ways, is one source');
{
  const r = build({
    sources: [
      src('https://Variety.example/Report/', 'Rights report'),
      src('http://www.variety.example/Report?utm_source=news#top', 'Rights report again'),
    ],
    facts: [fact('A claim.', ['https://variety.example/Report'])],
  });
  expect('tracking parameters, case, www, scheme and trailing slash collapse to one source',
    of(r, 'evidence').length === 1, JSON.stringify(of(r, 'evidence').map((c) => fieldOf(c, 'url'))));
  expect('and the fact cites it once', of(r, 'research_finding_evidence').length === 1);
}

section('2. A URL that is not a web page never becomes a source');
{
  const r = build({
    sources: [src('ftp://files.example/doc.pdf'), src('javascript:alert(1)'), src('not a url'), src('https://ok.example/page', 'Good page')],
    facts: [fact('A claim.', ['https://ok.example/page'])],
  });
  expect('only the http(s) page survives', of(r, 'evidence').length === 1, JSON.stringify(of(r, 'evidence').map((c) => fieldOf(c, 'url'))));
  expect('and each rejection is explained, not silent',
    r.notes.filter((n) => n.kind === 'dropped_source').length === 3, JSON.stringify(r.notes.map((n) => n.detail)));
  expect('normaliseUrl agrees in isolation',
    normaliseUrl('ftp://x.example/a') === null && normaliseUrl('https://x.example/a') === 'https://x.example/a');
}

section('3. A fact citing a source nobody described');
{
  const r = build({
    sources: [src('https://known.example/a', 'Known')],
    facts: [fact('A claim.', ['https://known.example/a', 'https://ghost.example/b'])],
  });
  expect('the phantom citation is dropped', of(r, 'research_finding_evidence').length === 1,
    JSON.stringify(of(r, 'research_finding_evidence').map((c) => fieldOf(c, 'evidence_label'))));
  expect('the claim survives on the source it really has',
    fieldOf(of(r, 'research_findings')[0]!, 'finding_type') === 'fact');
  expect('and the drop is recorded', r.notes.some((n) => n.kind === 'dropped_citation'));
}

section('4. No sources at all');
{
  const r = build({ facts: [fact('An unsupported claim.', ['https://ghost.example/x'])] });
  expect('no evidence is invented', of(r, 'evidence').length === 0);
  expect('no citation is invented', of(r, 'research_finding_evidence').length === 0);
  expect('the claim is kept, but as a reading rather than a fact',
    fieldOf(of(r, 'research_findings')[0]!, 'finding_type') === 'inference',
    String(fieldOf(of(r, 'research_findings')[0]!, 'finding_type')));
  expect('and it says plainly that nothing supports it',
    (fieldOf(of(r, 'research_findings')[0]!, 'content') ?? '').includes('No source was cited'),
    String(fieldOf(of(r, 'research_findings')[0]!, 'content')));
}

section('5. A source nothing ends up citing is not saved');
{
  const r = build({
    sources: [src('https://used.example/a', 'Used'), src('https://ignored.example/b', 'Ignored')],
    facts: [fact('A claim.', ['https://used.example/a'])],
  });
  expect('only the cited source becomes a record', of(r, 'evidence').length === 1,
    JSON.stringify(of(r, 'evidence').map((c) => c.label)));
  expect('and the unused one is explained', r.notes.some((n) => n.detail.includes('nothing rests on it')));
}

section('6. An origin that is not one of the fact’s own sources');
{
  const r = build({
    sources: [src('https://a.example/1', 'A'), src('https://b.example/2', 'B')],
    facts: [fact('A claim.', ['https://a.example/1', 'https://b.example/2'], 'https://elsewhere.example/9')],
  });
  const roles = of(r, 'research_finding_evidence').map((c) => fieldOf(c, 'role'));
  expect('no primary is invented from an unknown origin',
    roles.every((role) => role === 'supporting'), JSON.stringify(roles));
  expect('and the finding names no origin either',
    fieldOf(of(r, 'research_findings')[0]!, 'evidence_label') === null,
    String(fieldOf(of(r, 'research_findings')[0]!, 'evidence_label')));
  expect('the correction is recorded', r.notes.some((n) => n.detail.includes('not among its sources')));
}

section('7. Several sources and no stated origin: supporting only');
{
  const r = build({
    sources: [src('https://a.example/1', 'A'), src('https://b.example/2', 'B'), src('https://c.example/3', 'C')],
    facts: [fact('A claim.', ['https://a.example/1', 'https://b.example/2', 'https://c.example/3'])],
  });
  const roles = of(r, 'research_finding_evidence').map((c) => fieldOf(c, 'role')).sort();
  expect('three supporting citations, no primary',
    JSON.stringify(roles) === JSON.stringify(['supporting', 'supporting', 'supporting']), JSON.stringify(roles));
}

section('8. One stated origin among its own sources IS a primary');
{
  const r = build({
    sources: [src('https://a.example/1', 'A'), src('https://b.example/2', 'B')],
    facts: [fact('A claim.', ['https://a.example/1', 'https://b.example/2'], 'https://a.example/1')],
  });
  const roles = of(r, 'research_finding_evidence').map((c) => `${fieldOf(c, 'evidence_label')}:${fieldOf(c, 'role')}`).sort();
  expect('exactly one primary and one supporting',
    JSON.stringify(roles) === JSON.stringify(['A:primary', 'B:supporting']), JSON.stringify(roles));
  expect('and the finding names the origin it was written from',
    fieldOf(of(r, 'research_findings')[0]!, 'evidence_label') === 'A');
}

section('9. Readings, gaps and risks never carry citations');
{
  const r = researchProposalFromOutput(out({
    sources: [src('https://a.example/1', 'A')],
    facts: [fact('A claim.', ['https://a.example/1'])],
    interpretations: [{ statement: 'A reading.', based_on: 'the tone', confidence: 'low', source_urls: ['https://a.example/1'] }],
    gaps: [{ question: 'An open question.', why_it_matters: 'It blocks a decision.' }],
    risks: [{ statement: 'Something to be careful about.', severity: 'medium' }],
  }), ctx);
  const citedFindings = of(r, 'research_finding_evidence').map((c) => fieldOf(c, 'finding_label'));
  expect('only the source-backed fact is cited', citedFindings.length === 1 && citedFindings[0] === 'A claim.',
    JSON.stringify(citedFindings));
  expect('the reading keeps no citation', !citedFindings.includes('A reading.'));
  expect('and its stray citations are reported as removed', r.notes.some((n) => n.kind === 'stripped_citation'));
  expect('the gap and the risk are still proposed, as their own kinds',
    of(r, 'research_findings').some((c) => fieldOf(c, 'finding_type') === 'gap') &&
      of(r, 'research_findings').some((c) => fieldOf(c, 'finding_type') === 'risk'));
}

section('10. A source repeated inside one fact is cited once');
{
  const r = build({
    sources: [src('https://a.example/1', 'A')],
    facts: [fact('A claim.', ['https://a.example/1', 'https://a.example/1/', 'https://A.example/1?utm_medium=x'])],
  });
  expect('one citation, not three', of(r, 'research_finding_evidence').length === 1,
    JSON.stringify(of(r, 'research_finding_evidence').map((c) => c.label)));
}

section('11. Two different things with the same name get distinct labels');
{
  const r = build({
    sources: [src('https://a.example/1', 'Same name'), src('https://b.example/2', 'Same name')],
    facts: [fact('Same name', ['https://a.example/1']), fact('Same name', ['https://b.example/2'])],
  });
  const labels = r.proposal.changes.map((c) => c.label.toLowerCase());
  expect('every proposed item has a unique label', new Set(labels).size === labels.length, JSON.stringify(labels));
  expect('each citation still points at a real pair',
    of(r, 'research_finding_evidence').every((c) => {
      const f = fieldOf(c, 'finding_label');
      const e = fieldOf(c, 'evidence_label');
      return of(r, 'research_findings').some((x) => x.label === f) && of(r, 'evidence').some((x) => x.label === e);
    }));
}

section('12. Oversized and unbounded input is capped, not trusted');
{
  const many = Array.from({ length: RESEARCH_LIMITS.sources + 10 }, (_, i) => src(`https://s${i}.example/p`, `Source ${i}`));
  const longTitle = 'T'.repeat(500);
  const longStatement = 'S'.repeat(RESEARCH_LIMITS.statementChars + 500);
  const r = build({
    sources: [...many, src('https://long.example/p', longTitle)],
    facts: [
      fact(longStatement, ['https://s0.example/p']),
      ...Array.from({ length: RESEARCH_LIMITS.facts + 5 }, (_, i) => fact(`Claim ${i}`, [`https://s${i}.example/p`])),
    ],
  });
  expect(`no more than ${RESEARCH_LIMITS.sources} sources are considered`,
    of(r, 'evidence').length <= RESEARCH_LIMITS.sources, String(of(r, 'evidence').length));
  expect(`no more than ${RESEARCH_LIMITS.facts} facts are considered`,
    of(r, 'research_findings').length <= RESEARCH_LIMITS.facts, String(of(r, 'research_findings').length));
  expect('every label stays within the column budget',
    r.proposal.changes.every((c) => c.label.length <= RESEARCH_LIMITS.titleChars),
    String(Math.max(...r.proposal.changes.map((c) => c.label.length))));
  expect('an oversized statement is truncated, not dropped',
    (fieldOf(of(r, 'research_findings')[0]!, 'content') ?? '').length <= RESEARCH_LIMITS.statementChars + 60);
  expect('the cap is reported', r.notes.some((n) => n.kind === 'capped'));
}

section('13. Nothing reviewable means no proposal at all');
{
  const message = refused('an empty result is refused outright', {});
  expect('  with a reason a person could read', /nothing that could be reviewed/i.test(message), message);
  refused('sources with no claims about them are refused',
    { sources: [src('https://a.example/1', 'A'), src('https://b.example/2', 'B')] });
  refused('a result whose every statement is blank is refused',
    { sources: [src('https://a.example/1', 'A')], facts: [fact('   ', ['https://a.example/1'])] });
  expect('a refusal returns no proposal object, so nothing could be written from it', true);
}

section('14. The model cannot author structure');
{
  const r = build({
    sources: [src('https://a.example/1', 'A')],
    facts: [fact('A claim.', ['https://a.example/1'])],
  });
  expect('evidence, findings and citations are all server-authored items',
    of(r, 'evidence').length === 1 && of(r, 'research_findings').length === 1 && of(r, 'research_finding_evidence').length === 1);
  expect('every citation names its finding and its source through real field references',
    of(r, 'research_finding_evidence').every((c) => fieldOf(c, 'finding_label') && fieldOf(c, 'evidence_label')),
    JSON.stringify(of(r, 'research_finding_evidence').map((c) => c.fields)));
  expect('no change carries a dependency list of its own',
    r.proposal.changes.every((c) => !('depends_on_labels' in (c as Record<string, unknown>))));
}

section('Summary');
const failed = checks.filter((c) => !c.passed);
console.log(`${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length > 0) {
  for (const f of failed) console.log(`  \x1b[31mFAIL\x1b[0m  ${f.name}`);
  process.exit(1);
}
