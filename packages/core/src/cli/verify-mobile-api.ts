#!/usr/bin/env node
/**
 * Mobile capture API, end to end over real HTTP. Run through
 * scripts/test-mobile-api.mjs, which starts an isolated database and a web
 * server and passes MOBILE_API_URL.
 *
 *   npm run verify:mobile-api
 *
 * Every client call goes through the running Next.js server exactly as the iOS
 * app makes it: bearer token, JSON or multipart, no cookies. The worker runs in
 * this process with a scripted model (the live OpenAI extraction is NOT
 * exercised); the database is read directly only to check what was or was not
 * written.
 */
import { Buffer } from 'node:buffer';
import type { CaptureContextReview, CaptureExtraction, ContactIdentity, ContactProfile } from '@g3/shared';
import type { z } from 'zod';
import type { AiProvider, GenerateOptions, StructuredResult } from '../ai/index.js';
import { MockProvider } from '../ai/mock.js';
import { grantMembership, upsertDevUser } from '../auth.js';
import { closePool, withService } from '../db.js';
import { runCapturePipeline } from '../pipelines/capture.js';
import { redactForSearch, runContactIdentifyPipeline, runContactResearchPipeline, searchInputGuard } from '../contact-research.js';
import type { PipelineContext } from '../pipelines/context.js';
import { archiveJob, QUEUE_RUNS, readJobs } from '../queue.js';
import { claimRun, completeRun } from '../runs.js';
import { seedAdditionalWorkspace, seedWorkspace } from '../seed.js';
import { guardTarget } from './guard.js';

const target = await guardTarget('verify:mobile-api');
if (target.kind !== 'local') {
  console.error('verify:mobile-api writes test records; it runs only against a local throwaway database.');
  process.exit(1);
}
const API = process.env.MOBILE_API_URL;
if (!API) {
  console.error('MOBILE_API_URL is not set. Run npm run verify:mobile-api.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const checks: { name: string; passed: boolean }[] = [];
let currentSection = '';
const section = (title: string) => {
  currentSection = title;
  console.log(`\n\x1b[1m${title}\x1b[0m`);
};
const expect = (name: string, condition: boolean, detail = '') => {
  checks.push({ name: `${currentSection} / ${name}`, passed: condition });
  console.log(`  ${condition ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}`);
  if (detail) console.log(`        ${detail}`);
};

interface Reply<T = any> {
  status: number;
  body: T;
  text: string;
  headers: Headers;
}

async function call<T = any>(
  path: string,
  options: { token?: string | null; method?: string; json?: unknown; form?: FormData; headers?: Record<string, string>; redirect?: RequestRedirect } = {},
): Promise<Reply<T>> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.json !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${API}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.form ?? (options.json !== undefined ? JSON.stringify(options.json) : undefined),
    redirect: options.redirect ?? 'follow',
  });
  const text = await response.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: response.status, body, text, headers: response.headers };
}

// ---------------------------------------------------------------------------
// Scripted model: the drafts a model would plausibly return
// ---------------------------------------------------------------------------

const ANNA_NOTE =
  'I met Anna Smith from Horizon Studios at Cannes. She is looking for premium drama projects with European talent. She asked to see our New Foundation project. Follow up next week.';
const AMBIGUOUS_NOTE = 'Quick call with Horizon Studios Group about co-financing. Nothing agreed yet.';

function annaDraft(): CaptureExtraction {
  return {
    title: 'Met Anna Smith (Horizon Studios) at Cannes',
    summary: 'Anna Smith of Horizon Studios is looking for premium drama with European talent and asked to see New Foundation.',
    mentions: [
      { name: 'Anna Smith', kind: 'person', context: 'Met at Cannes' },
      { name: 'Horizon Studios', kind: 'organization', context: null },
      { name: 'New Foundation', kind: 'project', context: 'Our project' },
      { name: 'Cannes', kind: 'event', context: null },
    ],
    contacts: [{ name: 'Anna Smith', how: 'met', organization: 'Horizon Studios', role: null, email: null, phone: null, linkedin: null, why_it_matters: null }],
    facts: [
      { statement: 'Anna Smith asked to see the New Foundation project.', about: ['Anna Smith', 'New Foundation'], confidence: 'medium' },
      { statement: 'Horizon Studios is looking for premium drama projects with European talent.', about: ['Horizon Studios'], confidence: 'medium' },
    ],
    inferences: [
      {
        statement: 'New Foundation may fit what Horizon Studios is looking for.',
        about: ['Horizon Studios', 'New Foundation'],
        based_on: '"premium drama projects with European talent" and "asked to see our New Foundation project"',
        confidence: 'low',
      },
    ],
    recommendations: [],
    interactions: [
      {
        subject: 'Meeting with Anna Smith at Cannes',
        summary: 'Discussed Horizon Studios’ search for premium drama and New Foundation.',
        interaction_type: 'meeting',
        occurred_on: null,
        with_names: ['Anna Smith'],
      },
    ],
    actions: [
      { title: 'Follow up with Anna Smith', description: 'Send New Foundation materials.', due_on: null, related_names: ['Anna Smith'] },
    ],
    relationships: [
      { person: 'Anna Smith', organization: 'Horizon Studios', role: null, statement: 'Anna Smith is from Horizon Studios.', claim: 'fact' },
    ],
    opportunities: [],
    gaps: [{ question: 'What is Anna Smith’s role at Horizon Studios?', why_it_matters: 'Decides who else to involve.' }],
  };
}

function ambiguousDraft(): CaptureExtraction {
  return {
    title: 'Call with Horizon Studios Group',
    summary: 'Co-financing discussed; nothing agreed.',
    mentions: [{ name: 'Horizon Studios Group', kind: 'organization', context: null }],
    contacts: [],
    facts: [{ statement: 'A call with Horizon Studios Group covered co-financing.', about: ['Horizon Studios Group'], confidence: 'medium' }],
    inferences: [],
    recommendations: [],
    interactions: [],
    actions: [],
    relationships: [],
    opportunities: [],
    gaps: [],
  };
}

const BECKHAM_NOTE = 'I met David Beckham today.';
const RICH_NOTE = 'I met Anna Smith, Head of Drama at Horizon Studios, at Cannes. She wants to see New Foundation next week.';
const TOM_NOTE =
  'I met Tom Reyes, Head of Acquisitions at Blue Harbour Films, at MIPCOM in Cannes. His email is tom.reyes@blueharbour.example and his mobile is +44 7700 900123. LinkedIn: linkedin.com/in/tom-reyes-bh. He is going through a difficult divorce, so keep the follow-up gentle. He wants to see New Foundation.';
const TOM_WHY = 'He is going through a difficult divorce, so keep the follow-up gentle.';
const RADAR_NOTE = [
  '# Creative Radar - Athletes, Stories, Media & IP',
  '**Date:** 2026-09-23',
  '## Fresh Creative & IP Signals',
  '### Rumesh Tharanga turns equipment loss into an athlete-support proposition',
  '### The OCA Refugee Team creates an Azraq-to-Asian-Games story world',
  '## Forward Watch',
  '### Rumesh Tharanga / Asian Games javelin — 26 September 2026',
  '## Material Exclusions',
  'Routine heat results were excluded.',
].join('\n');
const MEMBER_NOTE = 'Spoke to Natan Bogin today about the Q4 plan.';
const UNKNOWN_NOTE = 'I met Priya Raman at the airport today.';
const LENA_NOTE = 'I met Lena Park, Head of Drama at Northlight Pictures, at Cannes.';
const MIA_NOTE = 'I met Mia Lopez today. She produces documentaries and now works at Northwind Pictures.';
const SIMILAR_NOTE = 'I met Anna Smith today.';

const none = { organization: null, role: null, email: null, phone: null, linkedin: null, why_it_matters: null };

/** What a model plausibly returns for the bare note -- including the mistakes the server must correct. */
function beckhamDraft(): CaptureExtraction {
  return {
    title: 'Meeting with David Beckham',
    summary: 'The speaker met David Beckham today.',
    mentions: [{ name: 'David Beckham', kind: 'person', context: null }],
    contacts: [{ name: 'David Beckham', how: 'met', ...none }],
    facts: [{ statement: 'The speaker met David Beckham today.', about: ['David Beckham'], confidence: 'high' }],
    inferences: [],
    recommendations: [],
    interactions: [
      { subject: 'Meeting with David Beckham', summary: 'The speaker met David Beckham.', interaction_type: 'meeting', occurred_on: null, with_names: ['David Beckham'] },
    ],
    actions: [],
    relationships: [],
    opportunities: [],
    gaps: [],
  };
}

function richDraft(): CaptureExtraction {
  return {
    title: 'Met Anna Smith of Horizon Studios',
    summary: 'You met Anna Smith, Head of Drama at Horizon Studios. She wants to see New Foundation next week.',
    mentions: [
      { name: 'Anna Smith', kind: 'person', context: 'Head of Drama at Horizon Studios' },
      { name: 'Horizon Studios', kind: 'organization', context: null },
      { name: 'New Foundation', kind: 'project', context: null },
      { name: 'Cannes', kind: 'event', context: null },
    ],
    contacts: [
      { name: 'Anna Smith', how: 'met', organization: 'Horizon Studios', role: 'Head of Drama', email: null, phone: null, linkedin: null, why_it_matters: 'She wants to see New Foundation.' },
    ],
    facts: [
      { statement: 'Anna Smith wants to see New Foundation next week.', about: ['Anna Smith', 'New Foundation'], confidence: 'high' },
      { statement: 'The speaker met Anna Smith.', about: ['Anna Smith'], confidence: 'high' },
    ],
    inferences: [],
    recommendations: [],
    interactions: [
      { subject: 'Met Anna Smith', summary: 'You met Anna Smith, Head of Drama at Horizon Studios.', interaction_type: 'encounter', occurred_on: null, with_names: ['Anna Smith'] },
    ],
    actions: [
      { title: 'Show New Foundation to Anna Smith', description: 'She asked to see it next week.', due_on: null, related_names: ['Anna Smith'] },
    ],
    relationships: [
      { person: 'Anna Smith', organization: 'Horizon Studios', role: 'Head of Drama', statement: 'Anna Smith is Head of Drama at Horizon Studios.', claim: 'fact' },
    ],
    opportunities: [],
    gaps: [],
  };
}

/** Shaped like the product example: a person, their stated role, and a place that is not an event record. */
/** A colleague of the workspace, not an outside contact. */
function memberDraft(): CaptureExtraction {
  return {
    title: 'Spoke to Natan Bogin',
    summary: 'You spoke to Natan Bogin about the Q4 plan.',
    mentions: [{ name: 'Natan Bogin', kind: 'person', context: null }],
    contacts: [{ name: 'Natan Bogin', how: 'spoke', ...none }],
    facts: [],
    inferences: [],
    recommendations: [],
    interactions: [{ subject: 'Spoke to Natan Bogin', summary: 'You spoke to Natan Bogin about the Q4 plan.', interaction_type: 'conversation', occurred_on: null, with_names: ['Natan Bogin'] }],
    actions: [],
    relationships: [],
    opportunities: [],
    gaps: [],
  };
}

/** Someone public sources cannot identify from the note. */
function unknownDraft(): CaptureExtraction {
  return {
    title: 'Met Priya Raman',
    summary: 'You met Priya Raman at the airport today.',
    mentions: [{ name: 'Priya Raman', kind: 'person', context: null }],
    contacts: [{ name: 'Priya Raman', how: 'met', ...none }],
    facts: [],
    inferences: [],
    recommendations: [],
    interactions: [{ subject: 'Met Priya Raman', summary: 'You met Priya Raman at the airport today.', interaction_type: 'encounter', occurred_on: null, with_names: ['Priya Raman'] }],
    actions: [],
    relationships: [],
    opportunities: [],
    gaps: [],
  };
}

function lenaDraft(): CaptureExtraction {
  return {
    title: 'Met Lena Park at Cannes',
    summary: 'You met Lena Park, Head of Drama at Northlight Pictures, at Cannes.',
    mentions: [
      { name: 'Lena Park', kind: 'person', context: 'Head of Drama at Northlight Pictures' },
      { name: 'Northlight Pictures', kind: 'organization', context: null },
      { name: 'Cannes', kind: 'event', context: 'where the writer met Lena Park' },
    ],
    contacts: [{ name: 'Lena Park', how: 'met', ...none, organization: 'Northlight Pictures', role: 'Head of Drama' }],
    facts: [{ statement: 'Lena Park is Head of Drama at Northlight Pictures.', about: ['Lena Park', 'Northlight Pictures'], confidence: 'high' }],
    inferences: [],
    recommendations: [],
    interactions: [{ subject: 'Met Lena Park', summary: 'You met Lena Park, Head of Drama at Northlight Pictures, at Cannes.', interaction_type: 'encounter', occurred_on: null, with_names: ['Lena Park'] }],
    actions: [],
    relationships: [],
    opportunities: [],
    gaps: [],
  };
}

function miaDraft(): CaptureExtraction {
  return {
    title: 'Met Mia Lopez',
    summary: 'You met Mia Lopez today.',
    mentions: [
      { name: 'Mia Lopez', kind: 'person', context: null },
      { name: 'Northwind Pictures', kind: 'organization', context: null },
    ],
    contacts: [{ name: 'Mia Lopez', how: 'met', ...none, organization: 'Northwind Pictures' }],
    facts: [
      { statement: 'Mia Lopez produces documentaries.', about: ['Mia Lopez'], confidence: 'high' },
      { statement: 'Mia Lopez now works at Northwind Pictures.', about: ['Mia Lopez', 'Northwind Pictures'], confidence: 'high' },
    ],
    inferences: [],
    recommendations: [],
    interactions: [{ subject: 'Met Mia Lopez', summary: 'You met Mia Lopez today.', interaction_type: 'encounter', occurred_on: null, with_names: ['Mia Lopez'] }],
    actions: [],
    relationships: [],
    opportunities: [],
    gaps: [],
  };
}

function tomDraft(): CaptureExtraction {
  return {
    title: 'Met Tom Reyes',
    summary: 'You met Tom Reyes at MIPCOM.',
    mentions: [
      { name: 'Tom Reyes', kind: 'person', context: 'Head of Acquisitions at Blue Harbour Films' },
      { name: 'Blue Harbour Films', kind: 'organization', context: null },
      { name: 'MIPCOM', kind: 'event', context: null },
      { name: 'Cannes', kind: 'event', context: null },
      { name: 'New Foundation', kind: 'project', context: null },
    ],
    contacts: [
      {
        name: 'Tom Reyes',
        how: 'met',
        organization: 'Blue Harbour Films',
        role: 'Head of Acquisitions',
        email: 'tom.reyes@blueharbour.example',
        phone: '+44 7700 900123',
        linkedin: 'linkedin.com/in/tom-reyes-bh',
        why_it_matters: TOM_WHY,
      },
    ],
    facts: [{ statement: 'Tom Reyes wants to see New Foundation.', about: ['Tom Reyes', 'New Foundation'], confidence: 'high' }],
    inferences: [],
    recommendations: [],
    interactions: [{ subject: 'Met Tom Reyes', summary: 'You met Tom Reyes at MIPCOM.', interaction_type: 'encounter', occurred_on: null, with_names: ['Tom Reyes'] }],
    actions: [],
    relationships: [],
    opportunities: [],
    gaps: [],
  };
}

const src = (url: string) => ({ url, title: null });
/** What a web-searching model plausibly returns for "who is this?". */
function identityFor(input: string): ContactIdentity {
  if (input.includes('Head of Drama')) {
    return {
      candidates: [
        { name: 'Anna Smith', organization: 'Horizon Studios', role: 'Head of Drama', location: 'London', explanation: 'Listed as Head of Drama at Horizon Studios; on the Cannes market attendee list.', matches_clues: ['Horizon Studios', 'Head of Drama', 'Cannes'], conflicts_with_clues: [], confidence: 'high', sources: [src('https://example.test/horizon/team')] },
        { name: 'Anna Smith', organization: 'Smith & Co Accountants', role: 'Partner', location: 'Leeds', explanation: 'Shares only the name.', matches_clues: [], conflicts_with_clues: ['not at Horizon Studios'], confidence: 'low', sources: [src('https://example.test/smith-co')] },
      ],
      reliable_match_found: true,
      note: 'Searched for Anna Smith with Horizon Studios, Head of Drama and Cannes.',
    };
  }
  if (input.includes('Head of Acquisitions')) {
    return {
      candidates: [
        { name: 'Tom Reyes', organization: 'Blue Harbour Films', role: 'Head of Acquisitions', location: null, explanation: 'Listed on the Blue Harbour Films team page.', matches_clues: ['Blue Harbour Films', 'Head of Acquisitions'], conflicts_with_clues: [], confidence: 'high', sources: [src('https://example.test/blueharbour/team')] },
      ],
      reliable_match_found: true,
      note: 'Searched with the organisation and role.',
    };
  }
  if (input.includes('David Beckham')) {
    return {
      candidates: [
        { name: 'David Beckham', organization: 'Inter Miami CF', role: 'Co-owner, former footballer', location: 'Miami', explanation: 'The best-known person with this name. Only the name matches your note.', matches_clues: [], conflicts_with_clues: [], confidence: 'low', sources: [src('https://example.test/beckham')] },
      ],
      reliable_match_found: false,
      note: 'Your note gives only the name, so nobody can be matched with confidence.',
    };
  }
  return { candidates: [], reliable_match_found: false, note: 'No public match.' };
}

function annaProfile(): ContactProfile {
  return {
    facts: [
      { statement: 'Anna Smith has led drama development at Horizon Studios since 2024.', sources: [src('https://example.test/horizon/team')] },
      { statement: 'Horizon Studios announced two European co-productions in 2026.', sources: [src('https://example.test/horizon/news')] },
    ],
    inferences: [{ statement: 'Anna Smith is likely looking for European co-production partners.', based_on: 'the 2026 co-production announcements', sources: [src('https://example.test/horizon/news')] }],
    recommendations: [{ statement: 'Send the New Foundation deck before next week.', rationale: 'She asked to see it.' }],
    gaps: [{ question: 'Anna Smith’s direct contact details', why_it_matters: 'Needed for the follow-up.' }],
    affiliations: [{ organization: 'Horizon Studios', role: 'Head of Drama', current: true, claim: 'fact', sources: [src('https://example.test/horizon/team')] }],
    public_profiles: [{ kind: 'linkedin', url: 'https://www.linkedin.com/in/anna-smith-example' }],
  };
}

function similarDraft(): CaptureExtraction {
  return {
    title: 'Met Anna Smith',
    summary: 'You met Anna Smith today.',
    mentions: [{ name: 'Anna Smith', kind: 'person', context: null }],
    contacts: [{ name: 'Anna Smith', how: 'met', ...none }],
    facts: [],
    inferences: [],
    recommendations: [],
    interactions: [
      { subject: 'Met Anna Smith', summary: 'You met Anna Smith today.', interaction_type: 'encounter', occurred_on: null, with_names: ['Anna Smith'] },
    ],
    actions: [],
    relationships: [],
    opportunities: [],
    gaps: [],
  };
}

class ScriptedProvider implements AiProvider {
  readonly kind = 'openai' as const;
  readonly isMock = false;
  researchCalls = 0;
  /** Every input the "model" received, by schema: what the tests check was (not) sent. */
  inputs: Record<string, string[]> = {};
  toolsUsed: Record<string, string[]> = {};
  /** Everything (system + input) sent to a call that may search the web. */
  webSearchInputs: string[] = [];
  private mock = new MockProvider();
  private wrap<T>(value: unknown, options: { schema: z.ZodType<T> }): StructuredResult<T> {
    return {
      value: options.schema.parse(value),
      usage: { model: 'scripted', tokensIn: 1, tokensOut: 1, reasoningTokens: 0, cachedTokens: 0, webSearches: 0, durationMs: 1, usageIsEstimated: true },
      sources: [],
      raw: { scripted: true },
    };
  }
  async generateStructured<T>(options: GenerateOptions & { schema: z.ZodType<T>; schemaName: string }): Promise<StructuredResult<T>> {
    (this.inputs[options.schemaName] ??= []).push(options.input);
    (this.toolsUsed[options.schemaName] ??= []).push(...(options.tools ?? []));
    if ((options.tools ?? []).includes('web_search')) this.webSearchInputs.push(`${options.system ?? ''}\n${options.input}`);
    if (options.schemaName === 'capture_classification') {
      return this.wrap(
        options.input.includes('Creative Radar')
          ? {
              material: 'research_document',
              document_kind: 'radar_brief',
              confidence: 'high',
              // Deliberately miscounted, the way a live classifier did: the review
              // must not repeat a number it did not decide.
              description: 'A creative radar brief dated 2026-09-23 with executive decisions, three current signals, four forward-watch items, and exclusions.',
              reason: 'Dated, sectioned, and about the outside world.',
            }
          : { material: 'relationship_note', document_kind: null, confidence: 'high', description: 'A note about someone you were in contact with.', reason: 'It describes a personal contact.' },
        options,
      );
    }
    if (options.schemaName === 'document_extraction') {
      return this.wrap(
        {
          artifact: {
            title: 'Creative Radar — 23 September 2026',
            artifact_type: 'radar_brief',
            summary: 'A daily radar of athlete, story, media and IP signals.',
            document_date: '2026-09-23',
            coverage: '2026-09-22 to 2026-09-23',
            external_use: 'Internal Only',
            source_urls: ['https://example.test/radar/1'],
          },
          signals: [
            {
              title: 'Rumesh Tharanga turns equipment loss into an athlete-support proposition',
              signal_type: 'creative_ip',
              what_changed: 'He asked that support reach other athletes instead of himself.',
              why_it_matters: 'A competitive moment could become an athlete-led platform.',
              decision_question: 'Can this become a durable platform?',
              recommended_next_step: 'Prepare a blueprint hypothesis after his campaign.',
              promotion_trigger: 'Concrete mechanics or partners.',
              priority: 'medium',
              confidence: 'medium',
              original_claim: 'He asked that support reach other athletes.',
              subjects: [{ name: 'Rumesh Tharanga', kind: 'person', role: 'subject' }],
              source_urls: ['https://example.test/radar/1'],
            },
            {
              title: 'The OCA Refugee Team creates an Azraq-to-Asian-Games story world',
              signal_type: 'story',
              what_changed: 'Two taekwondo athletes were presented as the first Asian Games refugee team.',
              why_it_matters: 'A contained human narrative with international resonance.',
              decision_question: 'Who controls access and life-story rights?',
              recommended_next_step: 'Map the institutional ecosystem.',
              promotion_trigger: null,
              priority: 'medium',
              confidence: 'medium',
              original_claim: 'No access or life-story rights are disclosed.',
              subjects: [{ name: 'OCA Refugee Team', kind: 'organization', role: 'subject' }],
              source_urls: [],
            },
          ],
          watch_items: [
            {
              title: 'Rumesh Tharanga / Asian Games javelin',
              trigger_date: '2026-09-26',
              why_it_matters: 'Interviews may show whether the initiative has durable intent.',
              promotion_condition: 'Promote only with concrete mechanics.',
              about: 'Rumesh Tharanga',
              priority: 'medium',
            },
          ],
          hypotheses: [
            {
              title: 'Convert a performance peak into a national athlete-access platform',
              description: 'An athlete-led equipment and access platform could follow the campaign.',
              about: 'Rumesh Tharanga',
              from_signal: 'Rumesh Tharanga turns equipment loss into an athlete-support proposition',
            },
          ],
          unknowns: [
            { kind: 'gap', statement: 'No initiative name, entity or launch date is confirmed', why_it_matters: 'Nothing to attach a decision to.', about: 'Rumesh Tharanga' },
            { kind: 'risk', statement: 'Athlete safeguarding and consent require verification', why_it_matters: 'Refugee athletes need care before any approach.', about: 'OCA Refugee Team' },
          ],
          research_recommendations: [
            { subject: 'Rumesh Tharanga', kind: 'person', why: 'To learn whether the initiative has mechanics behind it.' },
            { subject: 'OCA Refugee Team', kind: 'organization', why: 'To find who controls access and media commitments.' },
          ],
          source_only: [{ label: 'Routine heat results', why: 'Nothing here changes a decision.' }],
        },
        options,
      );
    }
    if (options.schemaName === 'capture_context') {
      const review: CaptureContextReview = options.input.includes('Maria Lopez')
        ? {
            already_stored_fact_numbers: [1],
            contradictions: [{ name: 'Maria Lopez', note_says: 'She now works at Northwind Pictures.', memory_says: 'Producer at Horizon Studios.' }],
            match_explanations: [],
            follow_up_suggestions: [],
          }
        : { already_stored_fact_numbers: [], contradictions: [], match_explanations: [], follow_up_suggestions: [] };
      return this.wrap(review, options);
    }
    if (options.schemaName === 'contact_identity') {
      this.researchCalls += 1;
      return this.wrap(identityFor(options.input), options);
    }
    if (options.schemaName === 'contact_profile') {
      this.researchCalls += 1;
      if (options.input.includes('Tom Reyes')) {
        return this.wrap(
          { facts: [{ statement: 'Blue Harbour Films acquires European drama.', sources: [src('https://example.test/blueharbour')] }], inferences: [], recommendations: [], gaps: [], affiliations: [], public_profiles: [] },
          options,
        );
      }
      return this.wrap(annaProfile(), options);
    }
    if (options.schemaName !== 'capture_extraction') return this.mock.generateStructured(options);
    const source = options.input;
    const draft = source.includes(MEMBER_NOTE)
      ? memberDraft()
      : source.includes(UNKNOWN_NOTE)
      ? unknownDraft()
      : source.includes(LENA_NOTE)
      ? lenaDraft()
      : source.includes(TOM_NOTE)
      ? tomDraft()
      : source.includes(MIA_NOTE)
      ? miaDraft()
      : source.includes(BECKHAM_NOTE)
      ? beckhamDraft()
      : source.includes('Head of Drama')
        ? richDraft()
        : source.includes(SIMILAR_NOTE)
          ? similarDraft()
          : source.includes('Anna Smith')
            ? annaDraft()
            : source.includes('Horizon Studios Group')
              ? ambiguousDraft()
              : (await this.mock.generateStructured(options)).value;
    return {
      value: options.schema.parse(draft),
      usage: { model: 'scripted', tokensIn: 1, tokensOut: 1, reasoningTokens: 0, cachedTokens: 0, webSearches: 0, durationMs: 1, usageIsEstimated: true },
      sources: [],
      raw: { scripted: true },
    };
  }
  generateText(options: GenerateOptions) {
    return this.mock.generateText(options);
  }
  startBackgroundResearch(options: GenerateOptions) {
    this.researchCalls += 1;
    return this.mock.startBackgroundResearch(options);
  }
  pollBackgroundResearch(id: string) {
    return this.mock.pollBackgroundResearch(id);
  }
  cancelBackgroundResearch() {
    return this.mock.cancelBackgroundResearch();
  }
}
const provider = new ScriptedProvider();

/** The worker, in this process: claims the capture's run and analyses it. */
async function analyse(captureId: string, workspaceId: string) {
  const runId = await withService(async (db) =>
    (await db.oneOrFail<{ run_id: string }>(`select run_id from public.captures where id = $1`, [captureId])).run_id,
  );
  const run = await claimRun(runId, 'verify-mobile-worker', 120);
  if (!run) throw new Error('run not claimable');
  const ctx: PipelineContext = { run, workspaceId, provider, keepAlive: async () => undefined };
  await runCapturePipeline(ctx);
  await completeRun(workspaceId, runId);
}

/** The worker, in this process: runs every queued contact identity/research job. */
async function processContactRuns(workspaceId: string) {
  const queued = await withService((db) =>
    db.rows<{ id: string; kind: string }>(
      `select id, kind from public.runs where workspace_id = $1 and status = 'queued' and kind in ('contact_identify', 'contact_research') order by created_at`,
      [workspaceId],
    ),
  );
  for (const job of queued) {
    const run = await claimRun(job.id, 'verify-mobile-worker', 120);
    if (!run) continue;
    const ctx: PipelineContext = { run, workspaceId, provider, keepAlive: async () => undefined };
    if (job.kind === 'contact_identify') await runContactIdentifyPipeline(ctx);
    else await runContactResearchPipeline(ctx);
    await completeRun(workspaceId, job.id);
  }
  return queued.length;
}
/** The phone's path: open the privacy preflight, keep every clue except `drop`, confirm both. */
async function startResearch(token: string, proposalId: string, contactKey: string, drop: string[] = []) {
  const pre = await call(`/api/mobile/proposals/${proposalId}`, { token, method: 'POST', json: { action: 'research_preflight', contactKey } });
  const clueIds = (pre.body?.preflight?.clues ?? []).filter((c: any) => !c.required && !drop.includes(c.value)).map((c: any) => c.id);
  const started = await call(`/api/mobile/proposals/${proposalId}`, {
    token,
    method: 'POST',
    json: { action: 'research', contactKey, acknowledgeCost: true, acknowledgeDisclosure: true, clueIds },
  });
  return { preflight: pre, started };
}
const runCount = (workspaceId: string, kind: string) =>
  withService((db) => db.oneOrFail<{ n: number }>(`select count(*)::int as n from public.runs where workspace_id = $1 and kind = $2`, [workspaceId, kind])).then((r) => r.n);

// `research_finding_evidence` is counted here deliberately: a citation is a
// memory row like any other, so every "nothing was written" assertion and the
// exact-approval count in §13 now cover citations too. Without it, sources
// could be linked by a side effect and no test would notice.
const KNOWLEDGE_TABLES = ['entities', 'evidence', 'research_findings', 'interactions', 'actions', 'opportunities', 'entity_mentions', 'entity_affiliations', 'research_finding_evidence'] as const;
async function counts(workspaceId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  await withService(async (db) => {
    for (const table of KNOWLEDGE_TABLES) {
      out[table] = (await db.oneOrFail<{ n: number }>(`select count(*)::int as n from public.${table} where workspace_id = $1`, [workspaceId])).n;
    }
  });
  return out;
}
const total = (c: Record<string, number>) => Object.values(c).reduce((a, b) => a + b, 0);
const same = (a: Record<string, number>, b: Record<string, number>) => KNOWLEDGE_TABLES.every((t) => a[t] === b[t]);
const delta = (a: Record<string, number>, b: Record<string, number>) =>
  Object.fromEntries(KNOWLEDGE_TABLES.map((t) => [t, (a[t] ?? 0) - (b[t] ?? 0)]).filter(([, n]) => n !== 0));

/** Submits a note as the given user, runs the analysis, and returns its proposal view. */
async function captureAndView(token: string, text: string, workspaceId: string) {
  const form = new FormData();
  form.append('text', text);
  const submitted = await call('/api/captures', { token, method: 'POST', form });
  await analyse(submitted.body.captureId, workspaceId);
  const ready = await call(`/api/captures/${submitted.body.captureId}`, { token });
  const view = await call(`/api/mobile/proposals/${ready.body.proposal.id}`, { token });
  return { captureId: submitted.body.captureId as string, proposalId: ready.body.proposal.id as string, view };
}

/** Words a person should never see in the app: storage and job internals. */
const INTERNAL = /research_findings|entity_mentions|entity_affiliations|target_table|proposal_items|applied_changes|workspace_id|run_id|current_stage|idempotency|service_role|\bpgmq\b|stack/i;

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

console.log('\x1b[1mMobile capture API verification\x1b[0m');
console.log(`Server: ${API}  ·  model: scripted drafts (no live model call)`);

section('Setup');
const seeded = await seedWorkspace({
  adminEmail: 'mobile-admin@example.test',
  adminPassword: 'mobile-admin-password',
  clientEmail: 'mobile-client@example.test',
  clientPassword: 'mobile-client-password',
});
const ws = seeded.workspaceId;
const viewerId = await upsertDevUser('mobile-viewer@example.test', 'mobile-viewer-password', 'Viewer');
await withService((db) => grantMembership(db, ws, viewerId, 'viewer', false));
const other = await seedAdditionalWorkspace('mobile-other', 'Other Workspace', 'mobile-other@example.test', 'mobile-other-password');
const stored = await withService(async (db) => {
  const insert = (workspaceId: string, type: string, name: string, slug: string) =>
    db.oneOrFail<{ id: string }>(
      `insert into public.entities (workspace_id, entity_type, display_name, slug, status, research_status, relationship_status)
       values ($1,$2,$3,$4,'active','existing','unknown') returning id`,
      [workspaceId, type, name, slug],
    );
  return {
    horizon: (await insert(ws, 'organization', 'Horizon Studios', 'horizon-studios')).id,
    annaSmithson: (await insert(ws, 'person', 'Anna Smithson', 'anna-smithson')).id,
    otherHorizon: (await insert(other.workspaceId, 'organization', 'Horizon Studios', 'horizon-studios')).id,
  };
});
// An existing contact known by an alias, with a stored role and fact.
const maria = await withService(async (db) => {
  const id = (await db.oneOrFail<{ id: string }>(
    `insert into public.entities (workspace_id, entity_type, display_name, slug, status, research_status, relationship_status)
     values ($1,'person','Maria Lopez','maria-lopez','active','existing','unknown') returning id`,
    [ws],
  )).id;
  await db.query(`insert into public.entity_aliases (workspace_id, entity_id, alias, alias_slug, alias_type) values ($1,$2,'Mia Lopez','mia-lopez','name')`, [ws, id]);
  await db.query(
    `insert into public.entity_affiliations (workspace_id, person_entity_id, organization_entity_id, role_title, is_current) values ($1,$2,$3,'Producer',true)`,
    [ws, id, stored.horizon],
  );
  await db.query(
    `insert into public.research_findings (workspace_id, finding_type, title, content, related_entity_id) values ($1,'fact','Maria Lopez produces documentaries.','Maria Lopez produces documentaries.',$2)`,
    [ws, id],
  );
  return id;
});
// Earlier seeding may have queued jobs; the in-process worker handles runs explicitly.
for (;;) {
  const messages = await readJobs(QUEUE_RUNS, 20, 1);
  if (messages.length === 0) break;
  for (const message of messages) await archiveJob(QUEUE_RUNS, message.msgId);
}
expect('memory seeded: "Horizon Studios" (company) and "Anna Smithson" (person)', Boolean(stored.horizon && stored.annaSmithson));

let exitCode = 1;
try {
  // =========================================================================
  section('1. Sign-in for the app: a token in the body, verified on every request');
  const login = async (email: string, password: string) =>
    call<{ accessToken: string; refreshToken: string | null; workspaceId: string }>('/api/mobile/session', {
      method: 'POST',
      json: { email, password },
    });
  const clientLogin = await login('mobile-client@example.test', 'mobile-client-password');
  expect('the right password returns a session token and the workspace', clientLogin.status === 200 && Boolean(clientLogin.body?.accessToken) && clientLogin.body?.workspaceId === ws);
  const token = clientLogin.body.accessToken as string;
  const viewerToken = (await login('mobile-viewer@example.test', 'mobile-viewer-password')).body.accessToken as string;
  const outsiderToken = (await login('mobile-other@example.test', 'mobile-other-password')).body.accessToken as string;

  const wrong = await login('mobile-client@example.test', 'not-the-password');
  expect('a wrong password is refused and returns no token', wrong.status === 401 && !wrong.body?.accessToken, `status ${wrong.status}`);
  expect('no cookie is set for the app', clientLogin.headers.get('set-cookie') === null);

  const me = await call('/api/mobile/session', { token });
  expect('GET session with the bearer token names the user, workspace and rights', me.status === 200 && me.body?.user?.email === 'mobile-client@example.test' && me.body?.workspace?.canApprove === true && me.body?.workspace?.isAdmin === false);
  expect('the app is told analysis is mock when no model is configured', me.body?.aiMode === 'mock');
  const noToken = await call('/api/mobile/session');
  expect('without a token: 401', noToken.status === 401);
  const tampered = await call('/api/mobile/session', { token: `${token.slice(0, -4)}AAAA` });
  expect('a tampered token: 401', tampered.status === 401);
  const anonCapture = await call('/api/captures', { method: 'POST', json: { text: 'no session' } });
  expect('an unauthenticated capture is refused', anonCapture.status === 401);
  const home = await call('/', { token });
  expect('the web home page leads with "Add anything"', home.status === 200 && home.text.includes('Add anything'));
  expect('and has no brief or research-queue actions', !/Generate brief|Choose what to research|Sources/.test(home.text));

  // =========================================================================
  section('2. Capture from the phone: stored as a private source, nothing trusted written');
  const before = await counts(ws);
  const form = new FormData();
  form.append('text', ANNA_NOTE);
  const submitted = await call('/api/captures', { token, method: 'POST', form });
  const captureId = submitted.body?.captureId as string;
  expect('multipart capture with a bearer token is accepted', submitted.status === 200 && submitted.body?.created === true && Boolean(captureId));
  expect('the response carries no job identifier', !('runId' in (submitted.body ?? {})));
  expect('no trusted record is written on submit', same(await counts(ws), before), JSON.stringify(delta(await counts(ws), before)));
  const received = await call(`/api/captures/${captureId}`, { token });
  expect('processing state is in plain words', ['received', 'analysing'].includes(received.body?.phase) && received.body?.steps?.length === 4 && received.body?.steps?.[2]?.label === 'Checking what you already know', `${received.body?.phase} / ${received.body?.steps?.map((s: { label: string }) => s.label).join(' → ')}`);
  expect('the processing response has no internal words', !INTERNAL.test(received.text));
  const researchRunsBefore = await withService((db) => db.oneOrFail<{ n: number }>(`select count(*)::int as n from public.runs where workspace_id = $1 and kind = 'research'`, [ws]));

  await analyse(captureId, ws);
  const ready = await call(`/api/captures/${captureId}`, { token });
  expect('after analysis: proposal ready, with a proposal to open', ready.body?.phase === 'ready' && Boolean(ready.body?.proposal?.id), ready.body?.phaseLabel);
  const proposalId = ready.body.proposal.id as string;
  expect('analysis started no research and made no web search', provider.researchCalls === 0 && (await withService((db) => db.oneOrFail<{ n: number }>(`select count(*)::int as n from public.runs where workspace_id = $1 and kind = 'research'`, [ws]))).n === researchRunsBefore.n);
  expect('still no trusted record after analysis', same(await counts(ws), before), JSON.stringify(delta(await counts(ws), before)));

  // =========================================================================
  section('3. Compact review: grouped, matched, in plain words');
  const view = await call(`/api/mobile/proposals/${proposalId}`, { token });
  expect('the proposal loads for the phone', view.status === 200 && view.body?.id === proposalId);
  const labels = (view.body?.groups ?? []).map((g: { label: string }) => g.label);
  expect('groups: stated / our reading / follow-ups / still unknown', ['Stated in the source', 'Our reading, not stated directly', 'Suggested follow-ups', 'Still unknown'].every((l) => labels.includes(l)), labels.join(' | '));
  const changes = (view.body?.groups ?? []).flatMap((g: { label: string; changes: any[] }) => g.changes.map((c) => ({ ...c, group: g.label })));
  const find = (predicate: (c: any) => boolean) => changes.find(predicate);
  const mentions = (view.body?.mentions ?? []) as { name: string; kind: string; match: string; candidates: { name: string; similarity: number | null }[]; entityId: string | null }[];
  const mention = (name: string) => mentions.find((m) => m.name === name);
  expect('"Horizon Studios" matches the stored company', mention('Horizon Studios')?.match === 'existing' && mention('Horizon Studios')?.entityId === stored.horizon, mentions.map((m) => `${m.name}=${m.match}`).join(', '));
  const anna = mention('Anna Smith');
  expect('"Anna Smith" is a possible match for "Anna Smithson", not merged', anna?.match === 'ambiguous' && anna.candidates.some((x) => x.name === 'Anna Smithson'), anna ? `${anna.kind}: ${anna.candidates.map((x) => `${x.name} ${x.similarity ?? '?'}%`).join(', ')}` : 'not found');
  const annaChange = find((c) => c.kind === 'Unconfirmed name' && c.title === 'Anna Smith');
  expect('the unconfirmed name change shows the candidate too', annaChange?.match === 'ambiguous' && annaChange.candidates.some((x: { name: string }) => x.name === 'Anna Smithson'));
  expect('no new person record is proposed for Anna Smith', !find((c) => c.kind === 'Person' && c.match === 'new' && c.title.includes('Anna')));
  const project = find((c) => c.title === 'New Foundation');
  expect('"New Foundation" is proposed as a new project', project?.match === 'new' && project?.kind === 'Project' && mention('New Foundation')?.match === 'new');
  const inference = find((c) => c.group === 'Our reading, not stated directly');
  expect('the inference is labelled as an inference', inference?.claim?.label === 'Inference');
  const followUp = find((c) => c.group === 'Suggested follow-ups' && c.kind === 'Action');
  expect('the follow-up is a proposed action', Boolean(followUp), followUp?.title);
  expect('the source note is shown with the proposal', view.body?.capture?.text === ANNA_NOTE);
  expect('research is offered for named people/companies/projects, not started', view.body?.researchable?.some((r: { label: string; entityId: string | null }) => r.label === 'Horizon Studios' && r.entityId === stored.horizon));
  expect('the review response has no internal words or storage references', !INTERNAL.test(view.text) && !view.text.includes('capture:'), (INTERNAL.exec(view.text) ?? [])[0] ?? '');

  // =========================================================================
  section('4. Nothing writes before approval, and only people allowed to approve can');
  const viewerApprove = await call(`/api/mobile/proposals/${proposalId}`, { token: viewerToken, method: 'POST', json: { action: 'approve', expectedVersion: view.body.version, itemIds: [inference.id] } });
  expect('a viewer cannot approve (403)', viewerApprove.status === 403, `status ${viewerApprove.status}`);
  const stale = await call(`/api/mobile/proposals/${proposalId}`, { token, method: 'POST', json: { action: 'approve', expectedVersion: view.body.version + 5, itemIds: [inference.id] } });
  expect('an approval for a version the person did not see is refused (409)', stale.status === 409);
  const malformed = await call(`/api/mobile/proposals/${proposalId}`, { token, method: 'POST', json: { action: 'approve', itemIds: ['nope'] } });
  expect('a malformed request is a 400, not a server error', malformed.status === 400);
  expect('still nothing written', same(await counts(ws), before), JSON.stringify(delta(await counts(ws), before)));

  // =========================================================================
  section('5. Approve selected: exactly those are saved, once');
  const byNumber = new Map(changes.map((c: any) => [c.number, c]));
  const chosen = new Set<string>([inference.id, followUp.id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const c of changes.filter((x: any) => chosen.has(x.id))) {
      for (const n of c.needs as number[]) {
        const needed = byNumber.get(n) as any;
        if (needed && !chosen.has(needed.id)) {
          chosen.add(needed.id);
          grew = true;
        }
      }
    }
  }
  const approved = await call(`/api/mobile/proposals/${proposalId}`, { token, method: 'POST', json: { action: 'approve', expectedVersion: view.body.version, itemIds: [...chosen] } });
  expect('approve selected succeeds', approved.status === 200, approved.body?.error ?? '');
  expect('it reports exactly the selected changes as written', approved.body?.written === chosen.size, `written ${approved.body?.written}, selected ${chosen.size}`);
  const afterApprove = await counts(ws);
  expect('the database gained exactly that many records', total(afterApprove) - total(before) === chosen.size, JSON.stringify(delta(afterApprove, before)));
  expect('the ambiguous person was not saved as a record', (await withService((db) => db.oneOrFail<{ n: number }>(`select count(*)::int as n from public.entities where workspace_id = $1 and display_name ilike 'anna smith'`, [ws]))).n === 0);
  expect('unselected changes are still awaiting review', approved.body?.proposal?.counts?.awaiting === changes.filter((c: any) => !chosen.has(c.id)).length);
  const again = await call(`/api/mobile/proposals/${proposalId}`, { token, method: 'POST', json: { action: 'approve', expectedVersion: approved.body.proposal.version, itemIds: [...chosen] } });
  expect('approving the same changes again writes nothing', again.status === 200 && again.body?.written === 0 && again.body?.alreadySaved === chosen.size && same(await counts(ws), afterApprove), `status ${again.status} written ${again.body?.written}`);

  // =========================================================================
  section('6. Saved: read back, on Today, in Activity and Knowledge');
  const saved = approved.body.proposal.saved as { label: string; kind: string }[];
  expect('the saved screen lists exactly the saved records', saved.length === chosen.size, saved.map((s) => `${s.kind}: ${s.label}`).join(' | '));
  const today = await call('/api/mobile/today', { token });
  expect('Today shows them as saved', today.status === 200 && saved.every((s) => today.body.saved.some((t: { label: string }) => t.label === s.label)), today.body?.savedTitle);
  expect('Today counts what still awaits approval', today.body?.awaiting?.changes >= changes.length - chosen.size);
  expect('Today has no internal words', !INTERNAL.test(today.text));
  const savedRows = (today.body?.saved ?? []) as { label: string; kind: string }[];
  const PLAIN_WORDS = ['Your note', 'Contact', 'Company', 'Organisation', 'Project', 'Event', 'Role at a company', 'What happened', 'Follow-up', 'Something we know', 'Opportunity', 'Possible match', 'Contact detail', 'Business unit', 'Signal'];
  expect('Today says what each saved thing is in plain words, with no storage prefix',
    savedRows.length > 0 && savedRows.every((row) => PLAIN_WORDS.includes(row.kind)) && savedRows.every((row) => !/^Capture:/i.test(row.label)),
    savedRows.map((r) => `${r.kind}: ${r.label}`).join(' | '));
  const activity = await withService((db) =>
    db.rows<{ action: string; summary: string | null }>(`select action, summary from public.activity_log where workspace_id = $1 order by created_at`, [ws]),
  );
  expect('Activity records the capture, the analysis and the save', ['capture.created', 'capture.analyzed', 'proposal.applied'].every((a) => activity.some((row) => row.action === a)), activity.map((r) => r.action).filter((a) => a.startsWith('capture') || a.startsWith('proposal')).join(', '));
  expect('Activity summaries do not contain the note text', !activity.some((row) => (row.summary ?? '').includes('premium drama')));
  const ask = await call('/api/ask', { token, method: 'POST', json: { question: 'What do we know about Horizon Studios and New Foundation?' } });
  expect('Knowledge search over saved memory finds the saved records', ask.status === 200 && ask.body?.retrievedCount > 0, `retrieved ${ask.body?.retrievedCount}, citations ${ask.body?.citations?.length}`);
  const noBriefing = await call('/api/ask', { token, method: 'POST', json: { question: 'What do we know about pricing in general?' } });
  expect('a question that is not about a stored person gets no briefing', noBriefing.status === 200 && noBriefing.body?.briefing === null);
  // Without a briefing there is still an answer to read: this is the branch both
  // clients fall back to, and it must carry everything they render.
  expect('  and that answer still carries the ordinary grounded answer the clients render',
    typeof noBriefing.body?.answerMd === 'string' && noBriefing.body.answerMd.length > 0
      && Array.isArray(noBriefing.body?.citations) && Array.isArray(noBriefing.body?.unanswered)
      && typeof noBriefing.body?.retrievedCount === 'number',
    JSON.stringify({ answerMd: noBriefing.body?.answerMd?.slice(0, 80), citations: noBriefing.body?.citations?.length }));

  // =========================================================================
  section('7. Capturing the same note again does not duplicate anything');
  const repeatForm = new FormData();
  repeatForm.append('text', ANNA_NOTE);
  const repeat = await call('/api/captures', { token, method: 'POST', form: repeatForm });
  expect('the same capture is returned, not a new one', repeat.status === 200 && repeat.body?.captureId === captureId && repeat.body?.created === false);
  expect('no canonical record was added', same(await counts(ws), afterApprove));

  // =========================================================================
  section('8. A similar company name stays ambiguous over the API');
  const ambForm = new FormData();
  ambForm.append('text', AMBIGUOUS_NOTE);
  const amb = await call('/api/captures', { token, method: 'POST', form: ambForm });
  await analyse(amb.body.captureId, ws);
  const ambReady = await call(`/api/captures/${amb.body.captureId}`, { token });
  const ambView = await call(`/api/mobile/proposals/${ambReady.body.proposal.id}`, { token });
  const ambChanges = ambView.body.groups.flatMap((g: { changes: any[] }) => g.changes);
  const group = (ambView.body.mentions as { name: string; match: string; candidates: { name: string }[] }[]).find((m) => m.name === 'Horizon Studios Group');
  expect('"Horizon Studios Group" is a possible match for "Horizon Studios", not a new company', group?.match === 'ambiguous' && group.candidates.some((x) => x.name === 'Horizon Studios') && !ambChanges.some((c: any) => c.kind === 'Company' && c.match === 'new'), group ? `${group.match}: ${group.candidates.map((x) => x.name).join(', ')}` : 'missing');

  // =========================================================================
  section('9. Another workspace cannot read the capture, its proposal or its file');
  const fileForm = new FormData();
  fileForm.append('text', 'Deck from Horizon Studios attached.');
  fileForm.append('file', new Blob([Buffer.from('# Horizon slate\nPrivate notes.')], { type: 'text/markdown' }), 'horizon-slate.md');
  const fileCapture = await call('/api/captures', { token, method: 'POST', form: fileForm });
  expect('a file capture is accepted from the phone', fileCapture.status === 200 && Boolean(fileCapture.body?.captureId));
  const storagePath = await withService(async (db) =>
    (await db.oneOrFail<{ storage_path: string }>(
      `select u.storage_path from public.captures c join public.uploads u on u.id = c.upload_id where c.id = $1`,
      [fileCapture.body.captureId],
    )).storage_path,
  );
  const relative = storagePath.split('/').slice(1).join('/');
  const ownFile = await call(`/api/files/${relative}`, { token });
  expect('the owner can open the private file', ownFile.status === 200 && ownFile.text.includes('Horizon slate'));
  const spoof = { 'x-g3-workspace': ws };
  const outsiderCapture = await call(`/api/captures/${captureId}`, { token: outsiderToken, headers: spoof });
  expect('outsider: capture not found, even naming this workspace in the header', outsiderCapture.status === 404, `status ${outsiderCapture.status}`);
  const outsiderProposal = await call(`/api/mobile/proposals/${proposalId}`, { token: outsiderToken, headers: spoof });
  expect('outsider: proposal not found', outsiderProposal.status === 404, `status ${outsiderProposal.status}`);
  const outsiderApprove = await call(`/api/mobile/proposals/${proposalId}`, { token: outsiderToken, headers: spoof, method: 'POST', json: { action: 'approve', expectedVersion: 1, itemIds: [followUp.id] } });
  expect('outsider: cannot approve', outsiderApprove.status === 404 || outsiderApprove.status === 403, `status ${outsiderApprove.status}`);
  const outsiderFile = await call(`/api/files/${relative}`, { token: outsiderToken, headers: spoof });
  expect('outsider: cannot open the file', outsiderFile.status === 404 && !outsiderFile.text.includes('Horizon slate'), `status ${outsiderFile.status}`);
  const outsiderToday = await call('/api/mobile/today', { token: outsiderToken, headers: spoof });
  expect('outsider: their Today shows none of it', outsiderToday.status === 200 && !outsiderToday.text.includes('Anna') && !outsiderToday.text.includes('Horizon'));

  // =========================================================================
  section('10. Research only on explicit request');
  const noAck = await call('/api/research/requests', { token, method: 'POST', json: { entityId: stored.horizon } });
  expect('without acknowledging cost it is refused', noAck.status === 400);
  const viewerResearch = await call('/api/research/requests', { token: viewerToken, method: 'POST', json: { entityId: stored.horizon, acknowledgeCost: true } });
  expect('a viewer cannot start research', viewerResearch.status === 403);
  const fromCapture = await call('/api/research/requests', { token, method: 'POST', json: { entityId: stored.horizon, captureId, acknowledgeCost: true } });
  expect('research tied to a capture is refused here (it belongs to the capture review)', fromCapture.status === 409, `status ${fromCapture.status}`);
  const research = await call('/api/research/requests', { token, method: 'POST', json: { entityId: stored.horizon, acknowledgeCost: true } });
  expect('with acknowledgement, research on Horizon Studios is queued', research.status === 200 && research.body?.started === true && research.body?.label === 'Horizon Studios', JSON.stringify(research.body));
  const researchRun = await withService((db) =>
    db.one<{ kind: string; input: { requestedExplicitly?: boolean } }>(`select kind, input from public.runs where workspace_id = $1 and kind = 'research' order by created_at desc limit 1`, [ws]),
  );
  expect('it is a separate research run, marked as explicitly requested', researchRun?.input?.requestedExplicitly === true);
  const researchAgain = await call('/api/research/requests', { token, method: 'POST', json: { entityId: stored.horizon, acknowledgeCost: true } });
  expect('asking again the same day does not queue a second run', researchAgain.status === 200 && researchAgain.body?.started === false);
  const outsiderResearch = await call('/api/research/requests', { token: outsiderToken, headers: spoof, method: 'POST', json: { entityId: stored.horizon, acknowledgeCost: true } });
  expect('an outsider cannot research this workspace’s record', outsiderResearch.status === 404, `status ${outsiderResearch.status}`);

  // =========================================================================
  section('12. "I met David Beckham today." -- a potential external contact, nothing invented');
  const beforeBeckham = await counts(ws);
  const researchBefore = provider.researchCalls;
  const beckham = await captureAndView(token, BECKHAM_NOTE, ws);
  const bv = beckham.view.body;
  const allChanges = (v: any) => v.groups.flatMap((g: any) => g.changes.map((c: any) => ({ ...c, group: g.label })));
  const bChanges = allChanges(bv);
  expect('the original note is preserved with the proposal', bv.capture?.text === BECKHAM_NOTE && bChanges.some((c: any) => c.kindLabel === 'Your original note'));
  const bCard = bv.contacts?.[0];
  expect('the lead item is a potential external contact card for David Beckham', bv.contacts?.length === 1 && bCard?.name === 'David Beckham' && bCard?.match === 'new' && bCard?.matchLabel === 'New external contact', JSON.stringify(bv.contacts?.map((c: any) => [c.name, c.matchLabel])));
  expect('the contact record is marked as an external contact, not a generic person', bChanges.some((c: any) => c.inContactCard && c.kindLabel === 'External contact'));
  expect('no Finding restates that you met him', !bChanges.some((c: any) => c.kind === 'Finding' && /met david beckham/i.test(c.title)), bChanges.filter((c: any) => c.kind === 'Finding').map((c: any) => c.title).join(' | '));
  expect('nothing says "speaker"', !/speaker/i.test(beckham.view.text));
  expect('the title does not call it a meeting', !/meeting/i.test(bv.title), bv.title);
  const bInteraction = bChanges.find((c: any) => c.kind === 'Interaction');
  const bType = bInteraction?.details.find((d: any) => d.label === 'Interaction type')?.value;
  expect('one interaction, worded to you, not overclaimed as a meeting', bChanges.filter((c: any) => c.kind === 'Interaction').length === 1 && bType === 'Met' && !/^meeting/i.test(bInteraction.title) && /^You met David Beckham/.test(bInteraction.text ?? ''), `${bInteraction?.title} / ${bType} / ${bInteraction?.text}`);
  const missingLabels = (bCard?.missing ?? []).map((m: any) => `${m.label}: ${m.value}`);
  expect('missing organisation, role and contact details are explicit', ['Organisation: unknown', 'Role: unknown', 'Contact details: unknown'].every((m) => missingLabels.includes(m)) && bCard?.needsMoreInfo === true, missingLabels.join(' | '));
  expect('research is recommended, with the reason', (bCard?.researchReasons ?? []).includes('This is a new contact and we do not yet know their organisation or role.'), (bCard?.researchReasons ?? []).join(' | '));
  const identifyBefore = await runCount(ws, 'contact_identify');
  expect('research does not start by itself', provider.researchCalls === researchBefore && bCard?.research === null && identifyBefore === 0);
  const bNoAck = await call(`/api/mobile/proposals/${beckham.proposalId}`, { token, method: 'POST', json: { action: 'research', contactKey: bCard.key } });
  expect('research without acknowledging cost is refused', bNoAck.status === 400);
  const bViewer = await call(`/api/mobile/proposals/${beckham.proposalId}`, { token: viewerToken, method: 'POST', json: { action: 'research', contactKey: bCard.key, acknowledgeCost: true, acknowledgeDisclosure: true, clueIds: [] } });
  expect('a viewer cannot start research', bViewer.status === 403, `status ${bViewer.status}`);
  const bAsk = (await startResearch(token, beckham.proposalId, bCard.key)).started;
  expect('asking starts an identity search, not profile research', bAsk.status === 200 && bAsk.body.proposal.contacts[0].research?.status === 'identifying' && (await runCount(ws, 'contact_identify')) === 1 && (await runCount(ws, 'contact_research')) === 0);
  await processContactRuns(ws);
  const bIdentity = (await call(`/api/mobile/proposals/${beckham.proposalId}`, { token })).body;
  const bResearch = bIdentity.contacts[0].research;
  const identityInput = (provider.inputs.contact_identity ?? []).at(-1) ?? '';
  expect('the identity search used web search with only the name -- not the note', (provider.toolsUsed.contact_identity ?? []).includes('web_search') && identityInput.includes('Name: David Beckham') && !identityInput.includes(BECKHAM_NOTE), identityInput);
  expect('it asks "Is this the person you met?" -- the footballer is only a candidate, flagged as name-only', bResearch?.status === 'awaiting_confirmation' && bResearch.candidates.length === 1 && bResearch.candidates[0].nameOnly === true, JSON.stringify(bResearch?.candidates?.map((c: any) => [c.name, c.nameOnly])));
  expect('nothing about the footballer entered the proposal', bIdentity.counts.total === bv.counts.total && !allChanges(bIdentity).some((c: any) => c.fromResearch) && (await runCount(ws, 'contact_research')) === 0);
  const profileCallsBeforeNone = (provider.inputs.contact_profile ?? []).length;
  const bNone = await call(`/api/mobile/proposals/${beckham.proposalId}`, { token, method: 'POST', json: { action: 'confirm_identity', contactKey: bCard.key, choice: 'none' } });
  const afterNone = bNone.body.proposal;
  expect('"None of these": no profile research call was made', (provider.inputs.contact_profile ?? []).length === profileCallsBeforeNone);
  expect('"None of these": nothing researched, no public-profile facts', bNone.status === 200 && afterNone.contacts[0].research?.status === 'none_of_these' && afterNone.counts.total === bv.counts.total && (await runCount(ws, 'contact_research')) === 0 && !allChanges(afterNone).some((c: any) => c.fromResearch));
  expect('nothing is written before approval', same(await counts(ws), beforeBeckham), JSON.stringify(delta(await counts(ws), beforeBeckham)));
  const savedBasic = await call(`/api/mobile/proposals/${beckham.proposalId}`, { token, method: 'POST', json: { action: 'approve', expectedVersion: afterNone.version, itemIds: bCard.basicChangeIds.concat(bChanges.filter((c: any) => c.kindLabel === 'Your original note').map((c: any) => c.id)) } });
  const afterBasic = await counts(ws);
  const beckhamRecord = await withService((db) => db.one<{ relationship_status: string; research_status: string; description: string | null }>(`select relationship_status, research_status, description from public.entities where workspace_id = $1 and display_name = 'David Beckham'`, [ws]));
  expect('"Save the basic contact now" saves the contact (and its source note) only', savedBasic.status === 200 && beckhamRecord?.relationship_status === 'contact' && beckhamRecord.description === null && JSON.stringify(delta(afterBasic, beforeBeckham)) === JSON.stringify({ entities: 1, evidence: 1 }), `${JSON.stringify(delta(afterBasic, beforeBeckham))} ${JSON.stringify(beckhamRecord)}`);
  expect('the interaction is not saved unless selected', delta(afterBasic, beforeBeckham).interactions === undefined);

  // =========================================================================
  section('13. Anna Smith at Cannes: clues -> identity -> research joins the same proposal -> approve once');
  const beforeRich = await counts(other.workspaceId);
  const rich = await captureAndView(outsiderToken, RICH_NOTE, other.workspaceId);
  const rv = rich.view.body;
  const rChanges = allChanges(rv);
  const rCard = rv.contacts?.[0];
  expect('Anna Smith is a new external contact', rv.contacts?.length === 1 && rCard?.name === 'Anna Smith' && rCard?.match === 'new', JSON.stringify(rv.contacts?.map((c: any) => [c.name, c.match])));
  expect('what the note states about her is on the card', rCard?.fromNote.includes('Head of Drama, Horizon Studios'), (rCard?.fromNote ?? []).join(' | '));
  expect('organisation and role are known; contact details are honestly missing', !(rCard?.missing ?? []).some((m: any) => ['Organisation', 'Role', 'Follow-up'].includes(m.label)) && (rCard?.missing ?? []).some((m: any) => m.label === 'Contact details'), (rCard?.missing ?? []).map((m: any) => m.label).join(', '));
  const affiliations = rChanges.filter((c: any) => c.kindLabel === 'Organisation and role');
  expect('one affiliation to the stored Horizon Studios, as a fact (not an inference)', affiliations.length === 1 && affiliations[0].details.some((d: any) => d.label === 'Organisation' && d.value === 'Horizon Studios') && affiliations[0].claim?.label !== 'Inference', affiliations.map((a: any) => `${a.title} ${JSON.stringify(a.details)}`).join(' | '));
  const interest = rChanges.find((c: any) => c.kind === 'Finding' && /wants to see New Foundation/.test(c.title));
  expect('her stated interest is "Stated in the source", not an inference', interest?.group === 'Stated in the source', interest?.group);
  expect('no inference was invented and no opportunity proposed', !rv.groups.some((g: any) => g.label === 'Our reading, not stated directly') && !rChanges.some((c: any) => c.kind === 'Opportunity'));
  expect('the restated "met" fact was dropped, and nothing says "speaker"', !rChanges.some((c: any) => c.kind === 'Finding' && /met anna smith/i.test(c.title)) && !/speaker/i.test(rich.view.text));
  expect('one interaction and one follow-up are proposed', rChanges.filter((c: any) => c.kind === 'Interaction').length === 1 && rChanges.filter((c: any) => c.kind === 'Action').length === 1);
  expect('New Foundation is linked only where the note supports it (named project, no invented deal)', rv.mentions.some((m: any) => m.name === 'New Foundation' && m.kind === 'Project'));
  expect('nothing is written before approval', same(await counts(other.workspaceId), beforeRich));
  const proposalsBefore = await withService((db) => db.oneOrFail<{ n: number }>(`select count(*)::int as n from public.proposals where workspace_id = $1`, [other.workspaceId])).then((r) => r.n);

  // Research: identity first, with the note's clues.
  const annaPre = await startResearch(outsiderToken, rich.proposalId, rCard.key);
  expect('the preflight offers her name, organisation, role, event and project', ['Anna Smith', 'Horizon Studios', 'Head of Drama', 'Cannes', 'New Foundation'].every((v) => annaPre.preflight.body.preflight.clues.some((c: any) => c.value === v)), JSON.stringify(annaPre.preflight.body.preflight?.clues?.map((c: any) => c.value)));
  await processContactRuns(other.workspaceId);
  const annaIdentityInput = (provider.inputs.contact_identity ?? []).at(-1) ?? '';
  expect('research received the role, company, event and project as clues', ['Head of Drama', 'Horizon Studios', 'Cannes', 'New Foundation'].every((clue) => annaIdentityInput.includes(clue)) && !annaIdentityInput.includes(RICH_NOTE) && !annaIdentityInput.includes('<note>'), annaIdentityInput);
  const rIdentity = (await call(`/api/mobile/proposals/${rich.proposalId}`, { token: outsiderToken })).body;
  expect('while it waits for your answer, the inbox says so plainly', rIdentity.confirmation?.statusLabel === 'Needs your answer', rIdentity.confirmation?.statusLabel);
  const rResearch = rIdentity.contacts[0].research;
  expect('identity candidates are shown before any research facts', rResearch?.status === 'awaiting_confirmation' && rResearch.candidates.length === 2 && rResearch.candidates[0].sources.length > 0 && !allChanges(rIdentity).some((c: any) => c.fromResearch));
  const confirmed = await call(`/api/mobile/proposals/${rich.proposalId}`, { token: outsiderToken, method: 'POST', json: { action: 'confirm_identity', contactKey: rCard.key, choice: 0 } });
  expect('"This is the person" starts focused research', confirmed.status === 200 && confirmed.body.proposal.contacts[0].research?.status === 'researching');
  await processContactRuns(other.workspaceId);
  const enriched = (await call(`/api/mobile/proposals/${rich.proposalId}`, { token: outsiderToken })).body;
  const eChanges = allChanges(enriched);
  const researched = eChanges.filter((c: any) => c.fromResearch);
  const profileInput = (provider.inputs.contact_profile ?? []).at(-1) ?? '';
  expect('research used the confirmed identity plus the selected clues -- not the note', profileInput.includes('Head of Drama') && !profileInput.includes(RICH_NOTE) && profileInput.includes('example.test/horizon/team'), profileInput);
  expect('the results joined the SAME proposal, with a new version', enriched.id === rich.proposalId && enriched.version > rv.version && enriched.contacts[0].research?.status === 'completed' && researched.length > 0, `version ${rv.version} -> ${enriched.version}, research items ${researched.length}`);
  const proposalsAfter = await withService((db) => db.oneOrFail<{ n: number }>(`select count(*)::int as n from public.proposals where workspace_id = $1`, [other.workspaceId])).then((r) => r.n);
  expect('no parallel proposal was created', proposalsAfter === proposalsBefore, `${proposalsBefore} -> ${proposalsAfter}`);
  expect('research items keep their sources and are classified', researched.filter((c: any) => c.kind === 'Finding' && c.claim?.label === 'Fact').every((c: any) => c.sources.length > 0) && researched.some((c: any) => c.claim?.label === 'Inference') && researched.some((c: any) => c.group === 'Still unknown'));
  const ec = enriched.confirmation;
  expect('the summary gains "Research found": confirmed role, profile, sourced facts, labelled inference and suggestion', ec?.researchFound?.confirmedAs === 'Head of Drama at Horizon Studios' && ec.researchFound.profiles.some((x: any) => x.label === 'LinkedIn profile') && ec.researchFound.facts.length === 2 && ec.researchFound.facts.every((f: any) => f.sources.length > 0) && ec.researchFound.readings.some((r: any) => r.label === 'Inference' && r.basis) && ec.researchFound.readings.some((r: any) => r.label === 'Suggestion'), JSON.stringify(ec?.researchFound));
  expect('"Save contact" lists the follow-up, project link and research findings as optional items', ['Follow-up:', 'Link to New Foundation', 'research finding'].every((t) => ec?.save.optional.some((o: string) => o.includes(t))), JSON.stringify(ec?.save.optional));
  expect('no duplicate person and no duplicate company link', eChanges.filter((c: any) => c.kindLabel === 'External contact').length === 1 && eChanges.filter((c: any) => c.kindLabel === 'Organisation and role').length === 1);

  // One approval: contact, interaction, project, follow-up, and the sourced research facts.
  const itemByNumber = new Map<number, any>(eChanges.map((c: any) => [c.number as number, c]));
  const pick = eChanges.filter((c: any) =>
    (c.inContactCard && c.kindLabel === 'External contact') ||
    c.kind === 'Interaction' ||
    (c.kind === 'Project' && c.title === 'New Foundation') ||
    c.kind === 'Action' ||
    (c.fromResearch && c.kind === 'Finding' && c.claim?.label === 'Fact'),
  );
  const closure = new Set<string>(pick.map((c: any) => c.id));
  for (let grew = true; grew; ) {
    grew = false;
    for (const c of eChanges.filter((x: any) => closure.has(x.id))) {
      for (const n of c.needs as number[]) {
        const d = itemByNumber.get(n) as any;
        if (d && !closure.has(d.id)) { closure.add(d.id); grew = true; }
      }
    }
  }
  const expected: Record<string, number> = {};
  const tableOf: Record<string, string> = { 'Your original note': 'evidence', 'External contact': 'entities', Project: 'entities', Interaction: 'interactions', Action: 'actions', 'Follow-up': 'actions', Finding: 'research_findings', Source: 'evidence', Citation: 'research_finding_evidence', Relationship: 'entity_affiliations' };
  for (const c of eChanges.filter((x: any) => closure.has(x.id))) {
    const table = tableOf[c.kindLabel] ?? tableOf[c.kind] ?? c.kind;
    expected[table] = (expected[table] ?? 0) + 1;
  }
  const beforeApprove = await counts(other.workspaceId);
  const once = await call(`/api/mobile/proposals/${rich.proposalId}`, { token: outsiderToken, method: 'POST', json: { action: 'approve', expectedVersion: enriched.version, itemIds: [...closure] } });
  const savedDelta = delta(await counts(other.workspaceId), beforeApprove);
  expect('one approval saves exactly the selected items (and what they depend on)', once.status === 200 && once.body.written === closure.size && JSON.stringify(Object.keys(savedDelta).sort().map((k) => [k, savedDelta[k]])) === JSON.stringify(Object.keys(expected).sort().map((k) => [k, expected[k]])), `saved ${JSON.stringify(savedDelta)} expected ${JSON.stringify(expected)}`);
  const savedContact = await withService((db) => db.oneOrFail<{ n: number; status: string }>(`select count(*)::int as n, max(relationship_status) as status from public.entities where workspace_id = $1 and slug = 'anna-smith'`, [other.workspaceId]));
  expect('exactly one Anna Smith record, saved as an external contact', savedContact.n === 1 && savedContact.status === 'contact');

  // =========================================================================
  section('14. One review session; repeated steps stay idempotent');
  const identifyRuns = await runCount(other.workspaceId, 'contact_identify');
  const researchRuns = await runCount(other.workspaceId, 'contact_research');
  const researchRepeat = (await startResearch(outsiderToken, rich.proposalId, rCard.key)).started;
  const confirmAgain = await call(`/api/mobile/proposals/${rich.proposalId}`, { token: outsiderToken, method: 'POST', json: { action: 'confirm_identity', contactKey: rCard.key, choice: 0 } });
  expect('asking to research or confirm again starts nothing new', researchRepeat.status === 200 && confirmAgain.status === 200 && (await runCount(other.workspaceId, 'contact_identify')) === identifyRuns && (await runCount(other.workspaceId, 'contact_research')) === researchRuns);
  const itemsBefore = await withService((db) => db.oneOrFail<{ n: number }>(`select count(*)::int as n from public.proposal_items where proposal_id = $1`, [rich.proposalId])).then((r) => r.n);
  const lastResearchRun = await withService((db) => db.oneOrFail<any>(`select * from public.runs where workspace_id = $1 and kind = 'contact_research' order by created_at desc limit 1`, [other.workspaceId]));
  await runContactResearchPipeline({ run: lastResearchRun, workspaceId: other.workspaceId, provider, keepAlive: async () => undefined });
  const captureRun = await withService((db) => db.oneOrFail<any>(`select r.* from public.runs r join public.captures c on c.run_id = r.id where c.id = $1`, [rich.captureId]));
  await runCapturePipeline({ run: captureRun, workspaceId: other.workspaceId, provider, keepAlive: async () => undefined });
  const itemsAfter = await withService((db) => db.oneOrFail<{ n: number }>(`select count(*)::int as n from public.proposal_items where proposal_id = $1`, [rich.proposalId])).then((r) => r.n);
  const proposalsFinal = await withService((db) => db.oneOrFail<{ n: number }>(`select count(*)::int as n from public.proposals where workspace_id = $1`, [other.workspaceId])).then((r) => r.n);
  expect('re-running the research and the capture jobs adds nothing and creates no proposal', itemsAfter === itemsBefore && proposalsFinal === proposalsBefore, `items ${itemsBefore} -> ${itemsAfter}, proposals ${proposalsBefore} -> ${proposalsFinal}`);
  const sessions = await withService((db) => db.oneOrFail<{ n: number }>(`select count(*)::int as n from public.contact_research where proposal_id = $1`, [rich.proposalId])).then((r) => r.n);
  expect('one research session for this contact in this capture', sessions === 1);

  // =========================================================================
  section('15. Existing contact by alias (with memory context), and a similar name that stays a possible match');
  const beforeMia = await counts(ws);
  const mia = await captureAndView(token, MIA_NOTE, ws);
  const mv = mia.view.body;
  const mCard = mv.contacts?.[0];
  const mChanges = allChanges(mv);
  expect('"Mia Lopez" resolves by alias to the stored Maria Lopez: Existing external contact', mv.contacts?.length === 1 && mCard?.name === 'Maria Lopez' && mCard?.match === 'existing' && mCard?.matchLabel === 'Existing external contact', JSON.stringify(mv.contacts?.map((c: any) => [c.name, c.matchLabel])));
  expect('no new person is proposed for her', !mChanges.some((c: any) => (c.kind === 'Person' || c.kindLabel === 'External contact') && c.action === 'Create'));
  const contextInput = (provider.inputs.capture_context ?? []).at(-1) ?? '';
  expect('the analysis saw her stored role and fact -- and nothing unrelated', contextInput.includes('Maria Lopez') && contextInput.includes('Producer at Horizon Studios') && !contextInput.includes('Anna Smithson') && !contextInput.includes('David Beckham') && !contextInput.includes('@'));
  expect('a fact memory already holds is not proposed again', !mChanges.some((c: any) => c.kind === 'Finding' && /produces documentaries/i.test(c.title)));
  expect('the contradiction with memory is shown as something to decide', mChanges.some((c: any) => c.title === 'Contradiction about Maria Lopez' && c.group === 'Still unknown'));
  const miaAll = await call(`/api/mobile/proposals/${mia.proposalId}`, { token, method: 'POST', json: { action: 'approve', expectedVersion: mv.version, itemIds: mChanges.filter((c: any) => !c.needsAttention).map((c: any) => c.id).concat(mCard.basicChangeIds) } });
  const mariaAfter = await withService((db) => db.oneOrFail<{ n: number; status: string }>(`select count(*)::int as n, max(relationship_status) as status from public.entities where workspace_id = $1 and slug in ('maria-lopez', 'mia-lopez')`, [ws]));
  expect('approving everything keeps one Maria Lopez, now an external contact', miaAll.status === 200 && mariaAfter.n === 1 && mariaAfter.status === 'contact' && (delta(await counts(ws), beforeMia).entities ?? 0) <= 1, `${JSON.stringify(mariaAfter)} ${JSON.stringify(delta(await counts(ws), beforeMia))}`);

  const similar = await captureAndView(token, SIMILAR_NOTE, ws);
  const sv = similar.view.body;
  const sCard = sv.contacts?.[0];
  expect('"Anna Smith" is "Possible match, not merged" against Anna Smithson', sCard?.match === 'ambiguous' && sCard?.matchLabel === 'Possible match, not merged' && sCard.candidates.some((c: any) => c.name === 'Anna Smithson'), JSON.stringify(sCard?.candidates));
  const sChanges = allChanges(sv);
  expect('no person record is proposed for her', !sChanges.some((c: any) => c.kind === 'Person' || c.kindLabel === 'External contact'));
  const approveAll = await call(`/api/mobile/proposals/${similar.proposalId}`, { token, method: 'POST', json: { action: 'approve', expectedVersion: sv.version, itemIds: sChanges.filter((c: any) => !c.needsAttention).map((c: any) => c.id).concat(sCard.basicChangeIds) } });
  const annaRecords = await withService((db) => db.oneOrFail<{ people: number; smithson: string | null }>(`select (select count(*)::int from public.entities where workspace_id = $1 and slug = 'anna-smith') as people, (select relationship_status from public.entities where workspace_id = $1 and slug = 'anna-smithson') as smithson`, [ws]));
  const reloaded = await call(`/api/mobile/proposals/${similar.proposalId}`, { token });
  expect('after approving everything: no Anna Smith record, Anna Smithson unchanged, still a possible match', approveAll.status === 200 && annaRecords.people === 0 && annaRecords.smithson === 'unknown' && reloaded.body.contacts?.[0]?.match === 'ambiguous', `${approveAll.status} ${JSON.stringify(annaRecords)}`);

  // =========================================================================
  section('16. Research privacy preflight: only selected, public-safe clues reach web search');
  const tom = await captureAndView(token, TOM_NOTE, ws);
  const tCard = tom.view.body.contacts?.[0];
  const tomPath = `/api/mobile/proposals/${tom.proposalId}`;
  const identifyRunsBefore = await runCount(ws, 'contact_identify');
  const callsBefore = provider.researchCalls;
  const pre = await call(tomPath, { token, method: 'POST', json: { action: 'research_preflight', contactKey: tCard.key } });
  const offered = pre.body?.preflight?.clues ?? [];
  const withheld = pre.body?.preflight?.withheld ?? [];
  expect('the preflight lists name, organisation, role, event/place and project as identity clues', pre.status === 200 && ['Tom Reyes', 'Blue Harbour Films', 'Head of Acquisitions', 'MIPCOM', 'Cannes', 'New Foundation'].every((v) => offered.some((c: any) => c.value === v)), JSON.stringify(offered.map((c: any) => `${c.label}: ${c.value}`)));
  expect('only the name is required; everything else can be removed', offered.filter((c: any) => c.required).map((c: any) => c.value).join() === 'Tom Reyes');
  const offeredText = JSON.stringify(offered);
  expect('no offered clue carries the email, phone, LinkedIn or the private remark', !/@|7700|900123|linkedin|divorce/i.test(offeredText), offeredText);
  expect('the preflight says what is kept private -- and that this note has email, phone and LinkedIn', ['Email address', 'Phone number', 'LinkedIn and other private contact details', 'Your full note, as written', 'Anything else in your workspace memory', 'Internal notes and why this relationship matters'].every((label) => withheld.some((w: any) => w.label === label && w.inThisCapture)), JSON.stringify(withheld));
  expect('the disclosure statement is shown verbatim', pre.body?.preflight?.statement === 'This research may use OpenAI and public web sources. Only the selected identity clues will be used for external search. The original note remains private in Globa 3.');
  expect('opening the preflight starts nothing', provider.researchCalls === callsBefore && (await runCount(ws, 'contact_identify')) === identifyRunsBefore);

  const optional = offered.filter((c: any) => !c.required).map((c: any) => c.id);
  const noDisclosure = await call(tomPath, { token, method: 'POST', json: { action: 'research', contactKey: tCard.key, acknowledgeCost: true, clueIds: optional } });
  const noCost = await call(tomPath, { token, method: 'POST', json: { action: 'research', contactKey: tCard.key, acknowledgeDisclosure: true, clueIds: optional } });
  const falseDisclosure = await call(tomPath, { token, method: 'POST', json: { action: 'research', contactKey: tCard.key, acknowledgeCost: true, acknowledgeDisclosure: false, clueIds: optional } });
  const smuggled = await call(tomPath, { token, method: 'POST', json: { action: 'research', contactKey: tCard.key, acknowledgeCost: true, acknowledgeDisclosure: true, clueIds: [...optional, 'email:tom-reyes-blueharbour-example'] } });
  expect('research cannot start without cost AND privacy confirmation, or with a clue not in the preview', [noDisclosure, noCost, falseDisclosure, smuggled].every((r) => r.status === 400) && provider.researchCalls === callsBefore && (await runCount(ws, 'contact_identify')) === identifyRunsBefore, [noDisclosure, noCost, falseDisclosure, smuggled].map((r) => r.status).join(','));

  const tomStart = await startResearch(token, tom.proposalId, tCard.key, ['MIPCOM']);
  expect('with both confirmations it starts the identity search', tomStart.started.status === 200 && tomStart.started.body.proposal.contacts[0].research?.status === 'identifying');
  const storedClues = await withService((db) => db.oneOrFail<{ search_clues: { value: string }[]; disclosure_acknowledged_at: string | null }>(`select search_clues, disclosure_acknowledged_at from public.contact_research where workspace_id = $1 and proposal_id = $2`, [ws, tom.proposalId]));
  expect('what is stored is exactly the selected clues, with the confirmation time', storedClues.disclosure_acknowledged_at !== null && JSON.stringify(storedClues.search_clues.map((c) => c.value)) === JSON.stringify(['Tom Reyes', 'Blue Harbour Films', 'Head of Acquisitions', 'Cannes', 'New Foundation']), JSON.stringify(storedClues.search_clues.map((c) => c.value)));
  await processContactRuns(ws);
  const tomIdentity = (provider.inputs.contact_identity ?? []).at(-1) ?? '';
  expect('identity research received only the selected clues (the removed event is absent)', ['Tom Reyes', 'Blue Harbour Films', 'Head of Acquisitions', 'Cannes', 'New Foundation'].every((v) => tomIdentity.includes(v)) && !tomIdentity.includes('MIPCOM'), tomIdentity);
  expect('its input has no email, phone, LinkedIn or private remark', !/@|7700|900123|linkedin|divorce|gentle/i.test(tomIdentity), tomIdentity);
  await call(tomPath, { token, method: 'POST', json: { action: 'confirm_identity', contactKey: tCard.key, choice: 0 } });
  await processContactRuns(ws);
  const tomProfile = (provider.inputs.contact_profile ?? []).at(-1) ?? '';
  expect('profile research on the confirmed person is equally clean', tomProfile.includes('Tom Reyes') && !/@|7700|900123|linkedin\.com\/in\/tom|divorce|MIPCOM/i.test(tomProfile), tomProfile);

  // Every call that could search the web, across this whole run.
  const notes = [BECKHAM_NOTE, RICH_NOTE, TOM_NOTE, MIA_NOTE, SIMILAR_NOTE];
  const web = provider.webSearchInputs;
  expect(`no web-search input (${web.length} calls) contains an email, phone number or LinkedIn`, web.length >= 5 && web.every((input) => !/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(input) && !/\+?\d[\d\s().-]{5,}\d/.test(input.replace(/\b(19|20)\d\d\b/g, '')) && !/linkedin\.com\/in\/(tom|anna)/i.test(input)));
  expect('no web-search input is, or quotes, a capture note', web.every((input) => notes.every((note) => !input.includes(note) && !input.includes(note.slice(0, 40)))) && web.every((input) => !input.includes('<note>') && !input.includes('<memory>')));

  // The guard itself, and the worker refusing a tampered row.
  expect('redaction strips contact details from a clue', redactForSearch('Tom Reyes tom@x.example +44 7700 900123 linkedin.com/in/tom-x') === 'Tom Reyes');
  const details = { note: TOM_NOTE, emails: ['tom.reyes@blueharbour.example'], phones: ['+44 7700 900123'], linkedins: ['linkedin.com/in/tom-reyes-bh'], whyItMatters: TOM_WHY };
  const refuses = (input: string) => { try { searchInputGuard(input, details); return false; } catch { return true; } };
  expect('the guard refuses a note quote, an email, a phone, the LinkedIn and the private remark', refuses(TOM_NOTE) && refuses('Head of Acquisitions at Blue Harbour Films, at MIPCOM in Cannes. His email is') && refuses('Tom tom.reyes@blueharbour.example') && refuses('call 07700900123') && refuses('see linkedin.com/in/tom-reyes-bh') && refuses(TOM_WHY) && !refuses('- Name: Tom Reyes\n- Organisation: Blue Harbour Films'));
  const tamperedCalls = provider.researchCalls;
  const tamperedId = await withService(async (db) => {
    const row = await db.oneOrFail<{ id: string }>(`select id from public.contact_research where workspace_id = $1 and proposal_id = $2`, [ws, tom.proposalId]);
    await db.query(`update public.contact_research set status = 'identifying', search_clues = $3::jsonb where workspace_id = $1 and id = $2`, [ws, row.id, JSON.stringify([{ id: 'name', kind: 'name', label: 'Name', value: 'Tom Reyes tom.reyes@blueharbour.example', required: true }])]);
    return row.id;
  });
  const tamperedRun = await withService((db) => db.oneOrFail<any>(`insert into public.runs (workspace_id, kind, status, input, attempt, max_attempts, idempotency_key, is_mock) values ($1, 'contact_identify', 'running', $2::jsonb, 1, 1, $3, true) returning *`, [ws, JSON.stringify({ contactResearchId: tamperedId }), `verify-tampered:${tamperedId}`]));
  let tamperedRefused = false;
  try { await runContactIdentifyPipeline({ run: tamperedRun, workspaceId: ws, provider, keepAlive: async () => undefined }); } catch { tamperedRefused = true; }
  expect('a stored clue carrying an email is refused by the worker before any model call', tamperedRefused && provider.researchCalls === tamperedCalls);

  // =========================================================================
  section('17. Capture confirmation: "Here is what I understood", one save, a clean inbox');
  const lena = await captureAndView(token, LENA_NOTE, ws);
  const lc = lena.view.body.confirmation;
  expect('one human summary: New contact, name, role line', lc?.contact?.label === 'New contact' && lc.contact.name === 'Lena Park' && lc.contact.line === 'Head of Drama at Northlight Pictures', JSON.stringify(lc?.contact));
  expect('context in your words: "You met Lena at Cannes today."', lc?.context === 'You met Lena at Cannes today.', lc?.context);
  expect('still missing: "Contact details and a follow-up."', lc?.missing === 'Contact details and a follow-up.', lc?.missing);
  expect('status is "Ready to review" and nothing is researched', lc?.status === 'ready' && lc.statusLabel === 'Ready to review' && lc.researchFound === null);
  expect('"You are about to save" lists exactly the contact, organisation and interaction', JSON.stringify(lc?.save.lines) === JSON.stringify(['Lena Park as a new external contact', 'Northlight Pictures as Lena’s organisation', 'Your interaction with Lena from today']) && lc.save.optional.length === 0 && lc.save.keepsNote, JSON.stringify(lc?.save));
  const lChanges = allChanges(lena.view.body);
  const restated = lChanges.find((c: any) => c.kind === 'Finding');
  expect('the place is not a record at all, and the restated role is not saved', !lChanges.some((c: any) => c.kind === 'Event') && Boolean(restated) && !lc.save.itemIds.includes(restated.id),
    lChanges.map((c: any) => `${c.kind}:${c.title}`).join(' | '));
  expect('technical wording is human: "the writer" reads as "you"', !JSON.stringify(lena.view.body.groups).includes('the writer'));
  const inbox = (await call('/api/mobile/review', { token })).body.proposals.find((x: any) => x.proposalId === lena.proposalId);
  expect('the inbox row shows only name, one-line summary, status and date', inbox?.name === 'Lena Park' && inbox.summary === 'You met Lena at Cannes today.' && inbox.statusLabel === 'Ready to review' && Boolean(inbox.createdAt), JSON.stringify(inbox));
  const beforeLena = await counts(ws);
  const confirmSave = await call(`/api/mobile/proposals/${lena.proposalId}`, { token, method: 'POST', json: { action: 'approve', expectedVersion: lena.view.body.version, itemIds: lc.save.itemIds, closeRest: true } });
  const lenaSaved = delta(await counts(ws), beforeLena);
  expect('"Confirm and save" writes exactly the note, contact, organisation, its link and the interaction', confirmSave.status === 200 && JSON.stringify(lenaSaved) === JSON.stringify({ entities: 2, evidence: 1, interactions: 1, entity_affiliations: 1 }), JSON.stringify(lenaSaved));
  const afterLena = confirmSave.body.proposal;
  expect('what was not kept is closed, so the capture shows as saved', afterLena.confirmation.status === 'saved' && afterLena.counts.awaiting === 0 && afterLena.counts.rejected === 1, JSON.stringify(afterLena.counts));
  const inboxAfter = (await call('/api/mobile/review', { token })).body.proposals.some((x: any) => x.proposalId === lena.proposalId);
  expect('and it leaves the Review inbox', !inboxAfter);
  const lenaEvent = await withService((db) => db.oneOrFail<{ n: number }>(`select count(*)::int as n from public.entities where workspace_id = $1 and entity_type = 'event' and display_name = 'Cannes'`, [ws]));
  expect('no "Cannes" event record was created', lenaEvent.n === 0);
  const briefingAsk = await call('/api/ask', { token, method: 'POST', json: { question: 'Why does Lena Park matter to us?' } });
  const brief = briefingAsk.body?.briefing;
  expect('a question about a saved subject is answered as a briefing, not an audit list',
    briefingAsk.status === 200 && brief?.name === 'Lena Park' && brief.subtitle === 'Head of Drama at Northlight Pictures' && typeof brief.lead === 'string',
    JSON.stringify(brief)?.slice(0, 200));
  expect('  it opens with what the source says, and what is missing comes after',
    !/unconfirmed|unknown/i.test(brief?.lead ?? '') && brief?.sections.every((x: any) => ['What we know', 'Why it matters', 'Why it matters to AMV', 'What to watch next', 'Still unconfirmed'].includes(x.heading)) === true,
    JSON.stringify(brief?.sections.map((x: any) => x.heading)));
  expect('  no table name or row id reaches the visible answer',
    !/research_findings|signal_entities|entity_id|[0-9a-f]{8}-[0-9a-f]{4}-/i.test(JSON.stringify({ lead: brief?.lead, sections: brief?.sections })),
    JSON.stringify(brief?.lead));
  expect('  and the records behind it stay under source details', Array.isArray(brief?.sources) && brief.sources.length > 0, JSON.stringify(brief?.sources));

  const plainApprove = await call(`/api/mobile/proposals/${lena.proposalId}`, { token: viewerToken, method: 'POST', json: { action: 'approve', expectedVersion: afterLena.version, itemIds: lc.save.itemIds, closeRest: true } });
  expect('a viewer cannot confirm and save', plainApprove.status === 403, `status ${plainApprove.status}`);

  // =========================================================================
  section('18. A colleague is a colleague: no external contact, no public research');
  await withService((db) =>
    db.query(
      `insert into public.members (workspace_id, full_name, slug, role_title, status) values ($1,'Natan Bogin','natan-bogin','Founder & CEO','active')
       on conflict do nothing`,
      [ws],
    ),
  );
  const beforeMember = await counts(ws);
  const colleague = await captureAndView(token, MEMBER_NOTE, ws);
  const cv = colleague.view.body;
  const cc = cv.confirmation;
  expect('one card: "Existing Globa 3 member", with their role', cv.contacts?.length === 1 && cv.contacts[0].matchLabel === 'Existing Globa 3 member' && cc?.contact?.label === 'Existing Globa 3 member' && cc.contact.line === 'Founder & CEO, Globa 3', `${cv.contacts?.[0]?.matchLabel} / ${JSON.stringify(cc?.contact)}`);
  expect('the next action is "Save interaction", and research is not offered', cc?.primaryActionLabel === 'Save interaction' && cc.canResearch === false && (cv.contacts[0].researchReasons ?? []).length === 0);
  expect('nothing says "New external contact" or proposes a person record', !JSON.stringify(cv.contacts).includes('New external contact') && !allChanges(cv).some((c: any) => c.kindLabel === 'External contact'), allChanges(cv).map((c: any) => c.kindLabel).join(', '));
  const colleagueResearch = await call(`/api/mobile/proposals/${colleague.proposalId}`, { token, method: 'POST', json: { action: 'research_preflight', contactKey: cv.contacts[0].key } });
  expect('asking to research a colleague is refused by the server too', colleagueResearch.status === 404, `status ${colleagueResearch.status}`);
  expect('what it saves is the conversation, with your note kept privately', JSON.stringify(cc?.save.lines) === JSON.stringify(['Your interaction with Natan from today']) && cc?.save.keepsNote === true, JSON.stringify(cc?.save));
  const colleagueSaved = await call(`/api/mobile/proposals/${colleague.proposalId}`, { token, method: 'POST', json: { action: 'approve', expectedVersion: cv.version, itemIds: cc!.save.itemIds, closeRest: true } });
  const colleagueDelta = delta(await counts(ws), beforeMember);
  expect('saving writes the interaction and the note, and no person', colleagueSaved.status === 200 && colleagueDelta.entities === undefined && colleagueDelta.interactions === 1 && colleagueDelta.evidence === 1, JSON.stringify(colleagueDelta));

  // =========================================================================
  section('19. When nobody can be identified, the way forward is not "research again"');
  const unknown = await captureAndView(token, UNKNOWN_NOTE, ws);
  const unknownCard = unknown.view.body.contacts[0];
  await startResearch(token, unknown.proposalId, unknownCard.key);
  await processContactRuns(ws);
  const afterSearch = (await call(`/api/mobile/proposals/${unknown.proposalId}`, { token })).body;
  expect('the search honestly reports no reliable match', afterSearch.contacts[0].research?.status === 'no_reliable_match' && afterSearch.contacts[0].research.itemsAdded === 0);
  expect('nothing public was added, and the contact can still be saved as it is', !allChanges(afterSearch).some((c: any) => c.fromResearch) && afterSearch.confirmation.save.itemIds.length > 0 && afterSearch.confirmation.status === 'ready');
  expect('the card still holds only what your note says', afterSearch.confirmation.contact.label === 'New contact' && afterSearch.confirmation.contact.line === null && afterSearch.confirmation.missing !== null);

  // =========================================================================
  section('20. A captured document is reviewed as material, in four groups');
  const beforeRadar = await counts(ws);
  const identifyRunsBeforeRadar = await runCount(ws, 'contact_identify');
  const topicsBeforeRadar = (await withService((db) => db.oneOrFail<{ n: number }>(`select count(*)::int as n from public.research_topics where workspace_id = $1`, [ws]))).n;
  const radar = await captureAndView(token, RADAR_NOTE, ws);
  const rv2 = radar.view.body;
  const dc = rv2.confirmation;
  const groupOf = (key: string) => dc?.document?.groups.find((g: any) => g.key === key);
  expect('it is reviewed as a document, not as a contact', dc?.kind === 'document' && dc.contact === null && (rv2.contacts ?? []).length === 0, `${dc?.kind} / contacts ${rv2.contacts?.length}`);
  expect('the headline counts what a person cares about', dc?.document?.headline === 'We found 2 signals worth keeping, 2 research suggestions, 1 date to watch, 1 thing to be careful about.', dc?.document?.headline);
  expect('it says how the material was read', (dc?.document?.readAs ?? '').includes('radar brief'), dc?.document?.readAs);
  expect('a count the classifier guessed is never repeated: only the review counts',
    !/\b(three|four|\d+)\s+(current\s+)?(signals?|forward[- ]watch items?)/i.test(dc?.document?.readAs ?? '') &&
      dc?.document?.headline.startsWith('We found 2 signals worth keeping'),
    `${dc?.document?.readAs} || ${dc?.document?.headline}`);
  expect('the four groups are Save to memory, Research recommended, Keep as source only and Still unclear',
    JSON.stringify(dc?.document?.groups.map((g: any) => g.label)) === JSON.stringify(['Save to memory', 'Research recommended', 'Keep as source only', 'Still unclear']),
    JSON.stringify(dc?.document?.groups.map((g: any) => g.label)));
  expect('"Research recommended" names both subjects with a reason, and says nothing is searched yet',
    groupOf('research')?.lines.length === 2 && groupOf('research')!.lines.every((l: any) => Boolean(l.detail)) && groupOf('research')!.why.includes('nothing is searched until you confirm'),
    JSON.stringify(groupOf('research')?.lines));
  // Each question is a real, selectable item now, not a sentence: ticking one
  // has to change what the save call actually sends. A control that changes no
  // payload is a false affordance.
  expect('  each question carries a control that is off by default and maps to a real item',
    groupOf('research')!.lines.every((l: any) => typeof l.itemId === 'string' && l.optional && Array.isArray(l.optional.itemIds) && l.optional.itemIds.length > 0),
    JSON.stringify(groupOf('research')?.lines.map((l: any) => ({ itemId: l.itemId, toggle: l.optional?.toggleLabel }))));
  expect('  and none of them is counted among the records to save',
    !dc?.save?.itemIds?.some((id: string) => groupOf('research')!.lines.some((l: any) => l.itemId === id)),
    JSON.stringify({ save: dc?.save?.itemIds?.length, research: groupOf('research')?.lines.map((l: any) => l.itemId) }));
  expect('  and the document started no research run and no research target',
    (await runCount(ws, 'contact_identify')) === identifyRunsBeforeRadar &&
      (await withService((db) => db.oneOrFail<{ n: number }>(`select count(*)::int as n from public.research_topics where workspace_id = $1`, [ws]))).n === topicsBeforeRadar);
  expect('"Keep as source only" explains what stays in the document', groupOf('source_only')?.lines.some((l: any) => l.text === 'Routine heat results'), JSON.stringify(groupOf('source_only')?.lines));
  expect('the unvalidated idea waits under "Still unclear"', groupOf('unclear')?.lines.some((l: any) => l.text.includes('athlete-access platform')), JSON.stringify(groupOf('unclear')?.lines));
  expect('the next action is "Save to memory", and no public research is offered', dc?.primaryActionLabel === 'Save to memory' && dc.canResearch === false);
  expect('nothing is written before approval', same(await counts(ws), beforeRadar), JSON.stringify(delta(await counts(ws), beforeRadar)));
  expect('the final confirmation counts what a document keeps, in plain words',
    JSON.stringify(dc?.save.lines) === JSON.stringify([
      '“Creative Radar — 23 September 2026” as a research document, with its cited sources',
      '2 signals worth keeping',
      '1 date to watch',
      '1 thing the document says is not yet known',
      '1 thing to be careful about',
      '2 records the signals are about',
    ]) && dc?.save.keepsNote === true,
    JSON.stringify(dc?.save.lines));
  // The optional idea: a real choice, off by default.
  const unclearLines = dc?.document?.groups.find((g: any) => g.key === 'unclear')?.lines ?? [];
  const optionalLine = unclearLines.find((l: any) => l.optional);
  expect('the unvalidated idea is a choice, not a statement: it carries a toggle, off by default',
    Boolean(optionalLine?.itemId) && optionalLine.optional.toggleLabel === 'Keep this as an unvalidated opportunity hypothesis' &&
      Array.isArray(optionalLine.optional.itemIds) && optionalLine.optional.itemIds.length > 0,
    JSON.stringify(optionalLine));
  expect('  and it is not in the default save set', !dc!.save.itemIds.includes(optionalLine.itemId), `${dc!.save.itemIds.length} default item(s)`);
  const savedGroupLines = dc?.document?.groups.find((g: any) => g.key === 'save')?.lines.length ?? 0;
  expect('  so the button counts the decisions without it', savedGroupLines > 0, `${savedGroupLines} decisions`);

  const radarStatus = await call(`/api/captures/${radar.captureId}`, { token });
  expect('the capture status screen shows the decision summary, not a row count',
    radarStatus.body?.proposal?.summary === 'We found 2 signals worth keeping, 2 research suggestions, 1 date to watch, 1 thing to be careful about.' &&
      typeof radarStatus.body?.proposal?.changes === 'number',
    radarStatus.body?.proposal?.summary);

  // Re-reading the same stored document, without touching the file.
  const reread = await call(`/api/mobile/proposals/${radar.proposalId}`, { token, method: 'POST', json: { action: 'reanalyse' } });
  expect('"Read this document again" withdraws the old reading and starts a new one', reread.status === 200 && reread.body?.reanalysing === true && reread.body?.captureId === radar.captureId);
  const oldProposal = await withService((db) =>
    db.oneOrFail<{ status: string; pending: number }>(
      `select p.status, (select count(*)::int from public.proposal_items i where i.proposal_id = p.id and i.decision = 'pending') as pending
         from public.proposals p where p.id = $1`,
      [radar.proposalId],
    ),
  );
  expect('  the old proposal is superseded, with nothing left to approve', oldProposal.status === 'superseded' && oldProposal.pending === 0, JSON.stringify(oldProposal));
  expect('  and it no longer sits in the Review inbox', !(await call('/api/mobile/review', { token })).body.proposals.some((p: any) => p.proposalId === radar.proposalId));
  const beforeSecond = await counts(ws);
  await analyse(radar.captureId, ws);
  const second = await withService((db) =>
    db.oneOrFail<{ id: string; supersedes: string | null }>(
      `select id, supersedes_proposal_id as supersedes from public.proposals where workspace_id = $1 and supersedes_proposal_id = $2`,
      [ws, radar.proposalId],
    ),
  );
  expect('the fresh reading is a new proposal that records what it replaced', second.supersedes === radar.proposalId);
  expect('  and re-reading wrote nothing to memory', same(await counts(ws), beforeSecond), JSON.stringify(delta(await counts(ws), beforeSecond)));
  const secondView = (await call(`/api/mobile/proposals/${second.id}`, { token })).body;
  expect('  the new reading is reviewed the same way, with the same four groups', secondView.confirmation?.kind === 'document' && secondView.confirmation.document.groups.length === 4);
  // Saving WITH the choice turned on: the union of the default set and what the
  // toggle adds, exactly as the client sends it.
  const secondUnclear = secondView.confirmation.document.groups.find((g: any) => g.key === 'unclear')?.lines ?? [];
  const secondOptional = secondUnclear.find((l: any) => l.optional);
  const withChoice = [...new Set([...secondView.confirmation.save.itemIds, ...secondOptional.optional.itemIds])];
  expect('turning the choice on adds exactly one more record to save', withChoice.length === secondView.confirmation.save.itemIds.length + 1,
    `${secondView.confirmation.save.itemIds.length} -> ${withChoice.length}`);
  const beforeChoice = await counts(ws);
  const savedRadar = await call(`/api/mobile/proposals/${second.id}`, { token, method: 'POST', json: { action: 'approve', expectedVersion: secondView.version, itemIds: withChoice, closeRest: true } });
  const choiceDelta = delta(await counts(ws), beforeChoice);
  expect('the opportunity is written only because it was chosen', choiceDelta.opportunities === 1, JSON.stringify(choiceDelta));
  const savedIdea = await withService((db) =>
    db.one<{ stage: string; opportunity_type: string; description: string }>(
      `select stage, opportunity_type, description from public.opportunities where workspace_id = $1 order by created_at desc limit 1`,
      [ws],
    ),
  );
  expect('  and it is stored as an unvalidated idea, not a live opportunity',
    savedIdea?.stage === 'idea' && savedIdea.opportunity_type === 'hypothesis' && savedIdea.description.startsWith('Unvalidated hypothesis.'),
    JSON.stringify(savedIdea));
  const radarDelta = delta(await counts(ws), beforeRadar);
  expect('saving writes the document, its signals, subjects, watch date, gap and risk',
    savedRadar.status === 200 && radarDelta.evidence === 1 && radarDelta.entities === 2 && radarDelta.actions === 1 && radarDelta.research_findings === 2,
    JSON.stringify(radarDelta));
  const radarAfter = savedRadar.body.proposal;
  // The readback for a subject that came from a document, not a meeting.
  const radarAsk = await call('/api/ask', { token, method: 'POST', json: { question: 'Why does Rumesh Tharanga matter to AMV?' } });
  const rb = radarAsk.body?.briefing;
  expect('a document subject reads as a briefing: the fact first, then why, then what to watch, then what is unconfirmed',
    rb?.name === 'Rumesh Tharanga' &&
      JSON.stringify(rb.sections.map((x: any) => x.heading)) === JSON.stringify(['What we know', 'Why it matters', 'What to watch next', 'Still unconfirmed']),
    JSON.stringify(rb?.sections?.map((x: any) => x.heading)));
  expect('  the possibility is marked as unvalidated, apart from the facts',
    rb?.sections.find((x: any) => x.key === 'why')?.lines.some((l: any) => l.note === 'Unvalidated') === true &&
      rb?.sections.find((x: any) => x.key === 'known')?.lines.every((l: any) => l.note === null || !/unvalidated/i.test(l.note)) === true,
    JSON.stringify(rb?.sections.find((x: any) => x.key === 'why')?.lines));
  expect('  the watch date is written the way a person reads it',
    rb?.sections.find((x: any) => x.key === 'watch')?.lines.some((l: any) => /\d{1,2} September 2026/.test(l.note ?? '')) === true,
    JSON.stringify(rb?.sections.find((x: any) => x.key === 'watch')?.lines));
  expect('  and the phone and the web get the same structure from the server', Array.isArray(rb?.sources) && typeof rb.lead === 'string');

  expect('re-reading then saving created no duplicate records', (await withService((db) => db.oneOrFail<{ n: number }>(`select count(*)::int as n from public.signals where workspace_id = $1`, [ws]))).n === 2);
  expect('after saving, the capture is done and leaves the inbox', radarAfter.confirmation.status === 'saved' && radarAfter.counts.awaiting === 0);

  // =========================================================================
  section('11. Briefs are gone from the product; secrets never reach a client');
  const briefs = await call('/briefs', { token, redirect: 'manual' });
  expect('/briefs redirects to Capture', [307, 308].includes(briefs.status) && (briefs.headers.get('location') ?? '').endsWith('/capture'), `${briefs.status} → ${briefs.headers.get('location')}`);
  const everything = [clientLogin.text, me.text, received.text, view.text, today.text, ask.text].join('\n');
  const secretValues = [process.env.DEV_AUTH_SECRET, process.env.DATABASE_URL].filter((v): v is string => Boolean(v && v.length > 8));
  const leaked = secretValues.filter((v) => everything.includes(v)).length + (/postgres:\/\/|service_role|sk-[a-z0-9]{20}/i.test(everything) ? 1 : 0);
  expect('no response contains the auth secret, a database URL or a key', leaked === 0, leaked ? `${leaked} leak(s)` : '');

  exitCode = checks.every((c) => c.passed) ? 0 : 1;
} catch (error) {
  console.error('\nUnexpected error:', error);
  exitCode = 1;
} finally {
  section('Summary');
  const failed = checks.filter((c) => !c.passed);
  console.log(`  ${checks.length - failed.length}/${checks.length} checks passed`);
  for (const f of failed) console.log(`  \x1b[31mFAILED\x1b[0m ${f.name}`);
  await closePool();
  process.exit(failed.length > 0 ? 1 : exitCode);
}
