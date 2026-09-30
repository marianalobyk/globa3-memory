#!/usr/bin/env node
/**
 * The Knowledge readback must never crash on a briefing it does not recognise.
 *
 *   npm run verify:readback-fallback
 *
 * The app and the server ship separately, so a phone or a browser tab can meet a
 * server older or newer than itself. A regression here is not cosmetic: the
 * previous client assumed `briefing.sections` and threw
 * "Cannot read properties of undefined (reading 'map')" on the whole screen,
 * losing an answer the server had already produced correctly.
 *
 * So this runs the two real shape guards -- apps/mobile/src/briefing-view.ts and
 * apps/web/src/lib/briefing-view.ts -- over the same answers, and requires:
 *
 *   1. both reach the same verdict on every answer, so the phone and the web
 *      never disagree about what is renderable;
 *   2. a missing, old-shaped or half-formed briefing falls back to null, which
 *      is the branch that renders the ordinary grounded answer and citations;
 *   3. a good briefing survives intact, with half-formed parts dropped;
 *   4. neither screen calls .map() on anything that could be undefined.
 *
 * No database, no server, no network: these are pure functions and source text.
 */
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const ts = require('typescript');
const dir = mkdtempSync(join(tmpdir(), 'g3-readback-'));

const checks = [];
const expect = (name, passed, detail = '') => {
  checks.push({ name, passed });
  console.log(`  ${passed ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}`);
  if (detail && !passed) console.log(`        ${detail}`);
};
const section = (title) => console.log(`\n\x1b[1m${title}\x1b[0m`);

/** Loads a TypeScript module by type-stripping it -- the real file, not a copy. */
async function load(relative) {
  const source = readFileSync(join(root, relative), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const file = join(dir, `${relative.replace(/[^a-z0-9]+/gi, '-')}.mjs`);
  writeFileSync(file, js);
  return import(pathToFileURL(file).href);
}

const newShape = {
  name: 'Rumesh Tharanga',
  subtitle: 'Named in the AMV Creative Radar',
  lead: 'A source-backed opening line.',
  sections: [
    { key: 'know', heading: 'What we know', lines: [{ text: 'A fact from an approved record.', note: null }] },
    { key: 'why', heading: 'Why it matters to AMV', lines: [{ text: 'Our reading of it.', note: 'Our reading' }] },
  ],
  sources: [{ label: 'AMV Creative Radar (captured file)', kind: 'Document', date: '26 September 2026' }],
};

/** The shapes a client can actually be handed, and whether it can render them. */
const cases = [
  ['an answer with no briefing field at all', {}, false],
  ['an answer whose briefing is null', { briefing: null }, false],
  ['an answer whose briefing is undefined', { briefing: undefined }, false],
  ['a null answer (nothing asked yet)', null, false],
  ['an older server: a briefing with no sections array',
    { briefing: { name: 'Rumesh Tharanga', whoThisIs: 'A director', whatHappened: 'Named in a radar' } }, false],
  ['a briefing whose sections are not an array',
    { briefing: { name: 'Rumesh Tharanga', sections: 'soon', lead: null } }, false],
  ['a briefing with sections but no name', { briefing: { ...newShape, name: '' } }, false],
  ['a briefing whose only sections are empty',
    { briefing: { name: 'X', lead: null, sections: [{ key: 'a', heading: 'What we know', lines: [] }] } }, false],
  ['a briefing with a lead but no sections yet',
    { briefing: { name: 'X', lead: 'One sentence.', sections: [] } }, true],
  ['a briefing missing sources entirely', { briefing: { ...newShape, sources: undefined } }, true],
  ['the current four-section briefing', { briefing: newShape }, true],
  ['a briefing where one section is half-formed',
    { briefing: { ...newShape, sections: [...newShape.sections, { key: 'bad', heading: 'Broken' }, null] } }, true],
  ['a briefing where one line is half-formed',
    { briefing: { ...newShape, sections: [{ key: 'know', heading: 'What we know', lines: [{ text: 'Kept.' }, null, { note: 'no text' }] }] } }, true],
];

const mobile = await load('apps/mobile/src/briefing-view.ts');
const web = await load('apps/web/src/lib/briefing-view.ts');

section('1. The phone and the web agree on what they can render');
for (const [name, answer, renderable] of cases) {
  let mobileOut;
  let webOut;
  let threw = null;
  try {
    mobileOut = mobile.usableBriefing(answer);
    webOut = web.usableBriefing(answer);
  } catch (failure) {
    threw = failure;
  }
  expect(`${name}: neither guard throws`, threw === null, String(threw));
  if (threw) continue;
  expect(`  ${renderable ? 'renders the briefing' : 'falls back to the ordinary answer'}`,
    (mobileOut !== null) === renderable, JSON.stringify(mobileOut));
  expect('  and both clients decide the same way', JSON.stringify(mobileOut) === JSON.stringify(webOut),
    `mobile ${JSON.stringify(mobileOut)} vs web ${JSON.stringify(webOut)}`);
}

section('2. A briefing that survives keeps its content, without the broken parts');
const kept = mobile.usableBriefing({ briefing: newShape });
expect('the four-section layout is passed through unchanged',
  kept?.name === 'Rumesh Tharanga' && kept.sections.length === 2 && kept.sections[0].heading === 'What we know'
    && kept.sections[1].lines[0].note === 'Our reading' && kept.sources.length === 1,
  JSON.stringify(kept));
const partial = mobile.usableBriefing({
  briefing: { ...newShape, sections: [...newShape.sections, { key: 'bad', heading: 'Broken' }, null] },
});
expect('a section with no lines is dropped rather than rendered', partial?.sections.length === 2,
  JSON.stringify(partial?.sections.map((s) => s.heading)));
const looseLines = mobile.usableBriefing({
  briefing: { ...newShape, sections: [{ key: 'know', heading: 'What we know', lines: [{ text: 'Kept.' }, null, { note: 'no text' }] }] },
});
expect('a line with no text is dropped, and the rest of the section still shows',
  looseLines?.sections[0].lines.length === 1 && looseLines.sections[0].lines[0].text === 'Kept.',
  JSON.stringify(looseLines?.sections[0].lines));

section('3. Neither screen maps over something that might not be there');
for (const file of ['apps/mobile/app/(tabs)/knowledge.tsx', 'apps/web/src/components/ask-knowledge.tsx']) {
  const source = readFileSync(join(root, file), 'utf8');
  // Every `.map(` and every `.length` must read from an expression that already
  // defaulted to an array -- `(x ?? []).map(` -- or from a string literal/local.
  const unguarded = [...source.matchAll(/([A-Za-z0-9_.?\])]+)\.map\(/g)]
    .map((match) => match[1])
    .filter((receiver) => !receiver.endsWith('])'));
  expect(`${file}: no .map() on a value that could be undefined`, unguarded.length === 0, unguarded.join(', '));
  const unguardedLength = [...source.matchAll(/(?:answer|briefing|section)\.([A-Za-z_]+)\.length/g)].map((m) => m[1]);
  expect(`${file}: no .length on a list that could be undefined`, unguardedLength.length === 0, unguardedLength.join(', '));
}

section('4. Both guards are the same rule, kept in one place per client');
const mobileSource = readFileSync(join(root, 'apps/mobile/src/briefing-view.ts'), 'utf8');
const webSource = readFileSync(join(root, 'apps/web/src/lib/briefing-view.ts'), 'utf8');
const body = (text) => text.slice(text.indexOf('export function usableBriefing')).replace(/\s+/g, ' ');
expect('the phone and the web run identical logic', body(mobileSource).includes('if (sections.length === 0 && !lead) return null;')
  && body(webSource).includes('if (sections.length === 0 && !lead) return null;'));

section('Summary');
rmSync(dir, { recursive: true, force: true });
const failed = checks.filter((c) => !c.passed);
console.log(`${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length > 0) {
  for (const check of failed) console.log(`  \x1b[31mFAIL\x1b[0m  ${check.name}`);
  process.exit(1);
}
