#!/usr/bin/env node
/**
 * The note budget: a long note must not become a long proposal.
 *
 *   npm run verify:note-budget
 *
 * `document-budget.ts` has stopped a radar becoming a database import since the
 * first live run produced 40 items. A note had no such guardrail: a page of
 * meeting notes naming a dozen people produced a dozen proposed records, of
 * which two were the people actually met.
 *
 * This runs the real `applyNoteBudget` over a deliberately overlong draft and
 * requires that it keeps the decision-relevant part, moves the rest into "keep
 * as source only" rather than dropping it, and leaves the name list alone --
 * that last one is a regression guard: an earlier version trimmed mentions and
 * silently broke the interaction summary and the research preflight's clues.
 *
 * No database, no server, no model call.
 */
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ts = createRequire(import.meta.url)('typescript');
const dir = mkdtempSync(join(tmpdir(), 'g3-note-budget-'));

const checks = [];
const expect = (name, passed, detail = '') => {
  checks.push({ name, passed });
  console.log(`  ${passed ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}`);
  if (detail && !passed) console.log(`        ${detail}`);
};
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

async function load(relative) {
  const source = readFileSync(join(root, relative), 'utf8')
    // The module imports only types from @g3/shared; strip the import so the
    // transpiled file needs no resolution.
    .replace(/^import type .*?;$/gm, '');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const file = join(dir, `${relative.replace(/[^a-z0-9]+/gi, '-')}.mjs`);
  writeFileSync(file, js);
  return import(pathToFileURL(file).href);
}

const { applyNoteBudget, NOTE_BUDGET } = await load('packages/core/src/pipelines/note-budget.ts');

const person = (name) => ({ name, how: 'met', organization: null, role: null, email: null, phone: null, linkedin: null, why_it_matters: null });
const fact = (statement, about) => ({ statement, about, confidence: 'medium' });

/** A note far longer than anyone would want to review in one sitting. */
const overlong = {
  title: 'A long day at the market',
  summary: 'Many conversations.',
  mentions: [
    { name: 'Cannes', kind: 'event', context: null },
    { name: 'Horizon Studios', kind: 'organization', context: null },
    ...Array.from({ length: 12 }, (_, i) => ({ name: `Person ${i + 1}`, kind: 'person', context: null })),
  ],
  contacts: Array.from({ length: 9 }, (_, i) => person(`Person ${i + 1}`)),
  facts: [
    // Deliberately out of order: a fact about a name nobody met comes first.
    fact('Some company nobody met is hiring.', ['Distant Co']),
    ...Array.from({ length: 8 }, (_, i) => fact(`Person ${i + 1} is looking for co-production finance.`, [`Person ${i + 1}`])),
  ],
  inferences: Array.from({ length: 7 }, (_, i) => ({
    statement: `Person ${i + 1} might be open to a Gulf partner.`, about: [`Person ${i + 1}`], based_on: 'said they travel often', confidence: 'low',
  })),
  recommendations: Array.from({ length: 5 }, (_, i) => ({
    statement: `Follow up with Person ${i + 1}.`, about: [`Person ${i + 1}`], rationale: 'they asked',
  })),
  interactions: [{ subject: 'Met several people at Cannes', summary: 'You met several people at Cannes today.', interaction_type: 'encounter', occurred_on: null, with_names: ['Person 1'] }],
  actions: [
    { title: 'Undated follow-up', description: null, due_on: null, related_names: ['Person 1'] },
    { title: 'Later deadline', description: null, due_on: '2026-12-01', related_names: ['Person 2'] },
    { title: 'Soonest deadline', description: null, due_on: '2026-10-05', related_names: ['Person 3'] },
    { title: 'Middle deadline', description: null, due_on: '2026-11-01', related_names: ['Person 4'] },
    { title: 'Another undated one', description: null, due_on: null, related_names: ['Person 5'] },
    { title: 'Yet another undated one', description: null, due_on: null, related_names: ['Person 6'] },
  ],
  relationships: [],
  opportunities: [
    { title: 'A co-production vehicle', description: 'x', related_names: ['Person 1'], basis: 'they said so', claim: 'inference' },
    { title: 'A second idea', description: 'y', related_names: ['Person 2'], basis: 'maybe', claim: 'inference' },
  ],
  gaps: [
    { question: 'Which fund is backing Person 1?', why_it_matters: 'It decides whether the co-production is fundable.' },
    { question: 'Who owns the rights to the format?', why_it_matters: 'Without it no deal can be structured.' },
    { question: 'A third question', why_it_matters: 'Also matters.' },
    { question: 'A question with no stated stake', why_it_matters: '' },
  ],
};

const out = applyNoteBudget(overlong);

section('1. The proposal is capped at what a person can decide on');
expect(`contacts trimmed to ${NOTE_BUDGET.contacts}`, out.extraction.contacts.length === NOTE_BUDGET.contacts, `${out.extraction.contacts.length}`);
expect(`facts trimmed to ${NOTE_BUDGET.facts}`, out.extraction.facts.length === NOTE_BUDGET.facts, `${out.extraction.facts.length}`);
expect(`inferences trimmed to ${NOTE_BUDGET.inferences}`, out.extraction.inferences.length === NOTE_BUDGET.inferences, `${out.extraction.inferences.length}`);
expect(`recommendations trimmed to ${NOTE_BUDGET.recommendations}`, out.extraction.recommendations.length === NOTE_BUDGET.recommendations, `${out.extraction.recommendations.length}`);
expect(`follow-ups trimmed to ${NOTE_BUDGET.actions}`, out.extraction.actions.length === NOTE_BUDGET.actions, `${out.extraction.actions.length}`);
expect('only one commercial opening is offered', out.extraction.opportunities.length === 1, JSON.stringify(out.extraction.opportunities.map((o) => o.title)));

section('2. What is kept is what matters, not what came first');
expect('a fact about someone you actually met outranks one about a name in passing',
  out.extraction.facts.every((f) => f.about.some((n) => /^Person /.test(n))),
  JSON.stringify(out.extraction.facts.map((f) => f.statement)));
expect('the fact about a name nobody met is not kept',
  !out.extraction.facts.some((f) => f.statement.includes('nobody met')));
expect('the soonest follow-up is kept first',
  out.extraction.actions[0]?.title === 'Soonest deadline', out.extraction.actions[0]?.title);
expect('dated follow-ups are kept before undated ones',
  out.extraction.actions.slice(0, 3).every((a) => a.due_on !== null),
  JSON.stringify(out.extraction.actions.map((a) => `${a.title}:${a.due_on}`)));

section('3. Nothing is dropped silently');
expect('everything trimmed is listed as kept in your note', out.sourceOnly.length > 0, `${out.sourceOnly.length}`);
const trimmedLabels = out.sourceOnly.map((s) => s.label).join(' | ');
expect('the trimmed contact is named', trimmedLabels.includes('Person 9'), trimmedLabels);
expect('the second commercial idea is named', trimmedLabels.includes('A second idea'), trimmedLabels);
expect('every source-only item says why it stayed', out.sourceOnly.every((s) => typeof s.why === 'string' && s.why.length > 10));
expect('the counts reconcile: kept + set aside = what the draft held',
  out.extraction.contacts.length + overlong.contacts.length - NOTE_BUDGET.contacts === overlong.contacts.length,
  `kept ${out.extraction.contacts.length} of ${overlong.contacts.length}`);

section('4. Research is suggested, never started');
expect(`at most ${NOTE_BUDGET.researchQuestions} research questions`, out.researchRecommendations.length <= NOTE_BUDGET.researchQuestions, `${out.researchRecommendations.length}`);
expect('each question carries why it matters', out.researchRecommendations.every((r) => r.why.length > 0));
expect('a question with no stated stake is not offered',
  !out.researchRecommendations.some((r) => r.subject.includes('no stated stake')),
  JSON.stringify(out.researchRecommendations.map((r) => r.subject)));
expect('the suggestions are the ones whose answer unblocks a decision',
  out.researchRecommendations[0]?.subject.includes('fund is backing'), JSON.stringify(out.researchRecommendations[0]));

section('5. Names are left alone (they are context and clues, not records)');
expect('every name in the note survives', out.extraction.mentions.length === overlong.mentions.length,
  `${out.extraction.mentions.length} of ${overlong.mentions.length}`);
expect('the place is still there, so "You met ... at Cannes" and the research clues still work',
  out.extraction.mentions.some((m) => m.name === 'Cannes'));
expect('the organisation named in passing is still there',
  out.extraction.mentions.some((m) => m.name === 'Horizon Studios'));

section('6. A short note is untouched');
const short = { ...overlong, contacts: [person('Anna Smith')], facts: [], inferences: [], recommendations: [], actions: [], opportunities: [], gaps: [], mentions: [{ name: 'Anna Smith', kind: 'person', context: null }] };
const shortOut = applyNoteBudget(short);
expect('nothing is trimmed from a one-person note', shortOut.sourceOnly.length === 0, JSON.stringify(shortOut.sourceOnly));
expect('and it proposes no research', shortOut.researchRecommendations.length === 0);
expect('the contact survives', shortOut.extraction.contacts.length === 1);

rmSync(dir, { recursive: true, force: true });
section('Summary');
const failed = checks.filter((c) => !c.passed);
console.log(`${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length > 0) {
  for (const f of failed) console.log(`  \x1b[31mFAIL\x1b[0m  ${f.name}`);
  process.exit(1);
}
