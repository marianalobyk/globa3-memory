#!/usr/bin/env node
/**
 * Capture inbox verification. Run through scripts/test-capture.mjs, which gives
 * it an isolated throwaway database.
 *
 *   npm run verify:capture
 *
 * The model is replaced by a scripted provider that returns the draft a model
 * would plausibly produce for each note. What is under test is everything the
 * server does with a draft: storing the source, resolution, the proposal,
 * approval, saving, readback, retries, permissions and isolation. The live
 * OpenAI extraction is NOT exercised here.
 */
import { Buffer } from 'node:buffer';
import type { CaptureExtraction, DocumentExtraction, Session } from '@g3/shared';
import type { z } from 'zod';
import type { AiProvider, GenerateOptions, StructuredResult } from '../ai/index.js';
import { MockProvider } from '../ai/mock.js';
import { applyApprovedItems, readbackProposal } from '../apply.js';
import { grantMembership, loadWorkspaceAccess, upsertDevUser } from '../auth.js';
import { createCapture, getCapture, retryCapture } from '../capture.js';
import { subjectBriefing } from '../briefing.js';
import { closePool, withOwner, withService, withUser } from '../db.js';
import { isAppError } from '../errors.js';
import { addAuditedSubjects, runCapturePipeline } from '../pipelines/capture.js';
import { documentProposalFromExtraction } from '../pipelines/document-capture.js';
import { applyDocumentBudget } from '../pipelines/document-budget.js';
import { retrieveRecords } from '../pipelines/ask.js';
import type { PipelineContext } from '../pipelines/context.js';
import { decideProposalItems, getProposal, recordApproval, type ProposalItemRecord } from '../proposals.js';
import { archiveJob, QUEUE_RUNS, readJobs } from '../queue.js';
import { claimRun, completeRun, failRun } from '../runs.js';
import { seedAdditionalWorkspace, seedWorkspace } from '../seed.js';
import { getStorage } from '../storage.js';
import { guardTarget } from './guard.js';

const target = await guardTarget('verify:capture');
if (target.kind !== 'local') {
  console.error('verify:capture writes test captures and records; it runs only against a local throwaway database.');
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
async function expectRejection(name: string, action: () => Promise<unknown>, test: (code: string | null, message: string) => boolean) {
  try {
    await action();
    expect(name, false, 'Expected a rejection, but the call succeeded.');
  } catch (error) {
    const code = isAppError(error) ? error.code : ((error as { code?: string }).code ?? null);
    const message = error instanceof Error ? error.message : String(error);
    expect(name, test(code, message), `Rejected with [${code ?? 'no code'}] ${message.slice(0, 140)}`);
  }
}

// ---------------------------------------------------------------------------
// Scripted provider: the drafts a model would return for the test notes
// ---------------------------------------------------------------------------

const BRIAN_NOTE =
  'Spoke to Brian today. He is interested in New Foundation. Time Zone could potentially finance Saudi incentive receivables. He wants to see a concrete project once we have one. Follow up in October.';
const AMBIGUOUS_COMPANY_NOTE = 'Short call with Time Zone Capital about receivables financing. No next step agreed.';
const MEMBER_NOTE = 'Spoke to Natan Bogin today about the Q4 plan.';
const NEAR_MEMBER_NOTE = 'Spoke to Nathan Bogin today.';
const MINIMAL_NOTE = 'I met Anna Smith today.';
const RICH_NOTE = 'I met Lena Park, Head of Drama at Northlight Pictures, at Cannes. She wants to see Night Harbour next week.';
const LATER_NOTE = 'Called Lena Park again today. She confirmed the Night Harbour screening.';

/** A radar brief, in the shape the real one has: sections, signals, watch dates, exclusions. */
const RADAR_NOTE = [
  '# Creative Radar - Athletes, Stories, Media & IP',
  '**Date:** 2026-09-23',
  '**Forward watch window:** 2026-09-23 to 2026-10-23',
  '## 1. Fresh Creative & IP Signals',
  '### Rumesh Tharanga turns equipment loss into an athlete-support proposition',
  'He declined public financial offers and asked that support reach other athletes. No initiative name, entity, funding model or launch date is confirmed.',
  '### The OCA Refugee Team creates an Azraq-to-Asian-Games story world',
  'The OCA presented two taekwondo athletes as its first Asian Games refugee team. No documentary, life-story or access rights are disclosed.',
  '## 2. Forward Watch',
  '### Rumesh Tharanga / Asian Games javelin — qualification 26 September, final 28 September 2026',
  '### SPORTFILM Liberec — 30 September to 4 October 2026',
  '## 3. Material Exclusions',
  'Routine heat results and generic tournament previews were excluded.',
].join('\n');

/**
 * The shape the first LIVE run actually returned for the AMV radar: 11 named
 * actors across four signals, six unknowns, two hypotheses and six research
 * suggestions -- 40 proposal items. The budget must bring this back to a
 * decision list without losing anything from the document.
 */
const LIVE_RADAR_NOTE = '# AMV Creative Radar — live shape\n**Date:** 2026-09-23\nLive-shaped regression fixture.';

function liveRadarExtraction() {
  const signal = (title: string, subjects: [string, string, 'subject' | 'organisation' | 'mentioned'][], priority: 'high' | 'medium' | 'low') => ({
    title,
    signal_type: 'creative_ip' as const,
    what_changed: `${title}: what changed, as the document states it.`,
    why_it_matters: 'Why this could change a decision.',
    decision_question: 'What would we need to know?',
    recommended_next_step: 'Prepare a hypothesis.',
    promotion_trigger: null,
    priority,
    confidence: 'medium' as const,
    original_claim: 'Quoted from the document.',
    source_facts: [],
    subjects: subjects.map(([name, kind, role]) => ({ name, kind: kind as 'person' | 'organization', role })),
    source_urls: [],
  });
  return {
    artifact: {
      title: 'AMV Creative Radar — 23 September 2026',
      artifact_type: 'radar_brief' as const,
      summary: 'A daily radar of athlete, story, media and IP signals.',
      document_date: '2026-09-23',
      coverage: '22–23 September 2026',
      external_use: 'Internal Only',
      source_urls: ['https://example.test/radar/1'],
    },
    signals: [
      signal('Rumesh Tharanga redirects equipment-damage attention into an athlete-support proposition', [['Rumesh Tharanga', 'person', 'subject']], 'medium'),
      signal('OCA Refugee Team introduces a specific Azraq-to-Asian-Games story world', [
        ['Mahmoud Al Jasem Al Mohammad Al Hussein', 'person', 'subject'],
        ['Talah Al Hassan Al Hinide', 'person', 'subject'],
        ['OCA', 'organization', 'organisation'],
        ['World Taekwondo', 'organization', 'mentioned'],
      ], 'medium'),
      signal('Kim Young-beom moves from prospect to leading Asian sprint swimmer', [['Kim Young-beom', 'person', 'subject']], 'low'),
      signal('Colin Kaepernick memoir functions as an integrated athlete-owned media asset', [
        ['Colin Kaepernick', 'person', 'subject'],
        ['Kaepernick Publishing', 'organization', 'organisation'],
        ['Legacy Lit', 'organization', 'organisation'],
        ['Audible', 'organization', 'mentioned'],
        ['CAA', 'organization', 'mentioned'],
      ], 'low'),
      signal('A fifth signal the document ranks lowest', [['Someone Else', 'person', 'subject']], 'low'),
    ],
    watch_items: [
      { title: 'Rumesh Tharanga / Asian Games javelin', trigger_date: '2026-09-26', why_it_matters: 'Interviews may clarify intent.', promotion_condition: null, about: 'Rumesh Tharanga', priority: 'medium' as const },
      { title: 'Mick Fanning / All Heart', trigger_date: '2026-09-29', why_it_matters: 'A memoir publication.', promotion_condition: null, about: null, priority: 'low' as const },
      { title: 'The Match / Haifa International Film Festival', trigger_date: '2026-09-26', why_it_matters: 'Festival screenings.', promotion_condition: null, about: null, priority: 'low' as const },
      { title: 'SPORTFILM Liberec', trigger_date: '2026-09-30', why_it_matters: 'A European discovery point.', promotion_condition: null, about: null, priority: 'low' as const },
      { title: 'A fifth date beyond the window', trigger_date: '2026-10-20', why_it_matters: 'Later than the rest.', promotion_condition: null, about: null, priority: 'low' as const },
    ],
    hypotheses: [
      { title: 'Convert a performance peak into a national athlete-access platform', description: 'An athlete-led access platform could follow.', about: 'Rumesh Tharanga', from_signal: 'Rumesh Tharanga redirects equipment-damage attention into an athlete-support proposition' },
      { title: "Test Kim Young-beom's high-performance and personality narrative", description: 'A personality-led format could follow the record.', about: 'Kim Young-beom', from_signal: 'Kim Young-beom moves from prospect to leading Asian sprint swimmer' },
    ],
    unknowns: [
      { kind: 'gap' as const, statement: "Rumesh Tharanga's proposed initiative has no confirmed mechanics", why_it_matters: 'Nothing to attach a decision to.', about: 'Rumesh Tharanga' },
      { kind: 'risk' as const, statement: 'For the proposed initiative, delivery capacity and governance are unproven', why_it_matters: 'Acting early could expose us.', about: 'Rumesh Tharanga' },
      { kind: 'gap' as const, statement: 'For the OCA Refugee Team story, no documentary or publishing rights are disclosed', why_it_matters: 'Rights are unknown.', about: 'Mahmoud Al Jasem Al Mohammad Al Hussein' },
      { kind: 'risk' as const, statement: 'Refugee-team work would require trauma-informed safeguarding and consent', why_it_matters: 'Athlete welfare comes first.', about: 'Talah Al Hassan Al Hinide' },
      { kind: 'gap' as const, statement: 'OCA and World Taekwondo access and representation are unconfirmed', why_it_matters: 'Access is unknown.', about: null },
      { kind: 'gap' as const, statement: "For Colin Kaepernick's memoir, adaptation rights are unconfirmed", why_it_matters: 'Rights are unknown.', about: 'Colin Kaepernick' },
    ],
    research_recommendations: [
      { subject: 'Rumesh Tharanga', kind: 'person' as const, why: 'To learn whether the initiative has mechanics behind it.' },
      { subject: 'OCA Refugee Team', kind: 'organization' as const, why: 'To find who controls access.' },
      { subject: 'Mahmoud Al Jasem Al Mohammad Al Hussein', kind: 'person' as const, why: 'Background.' },
      { subject: 'Talah Al Hassan Al Hinide', kind: 'person' as const, why: 'Background.' },
      { subject: 'Kim Young-beom', kind: 'person' as const, why: 'Background.' },
      { subject: 'Colin Kaepernick - The Perilous Fight', kind: 'person' as const, why: 'Background.' },
    ],
    source_only: [{ label: 'Routine heat results', why: 'Nothing here changes a decision.' }],
  };
}

const none = { organization: null, role: null, email: null, phone: null, linkedin: null, why_it_matters: null };
const emptyDraft = (over: Partial<CaptureExtraction>): CaptureExtraction => ({
  title: 'Note', summary: 'Note.', mentions: [], contacts: [], facts: [], inferences: [], recommendations: [],
  interactions: [], actions: [], relationships: [], opportunities: [], gaps: [], ...over,
});

/** A colleague: the workspace's own member, not an outside contact. */
function memberDraft(): CaptureExtraction {
  return emptyDraft({
    title: 'Spoke to Natan Bogin',
    summary: 'You spoke to Natan Bogin about the Q4 plan.',
    mentions: [{ name: 'Natan Bogin', kind: 'person', context: null }],
    contacts: [{ name: 'Natan Bogin', how: 'spoke', ...none }],
    interactions: [{ subject: 'Spoke to Natan Bogin', summary: 'You spoke to Natan Bogin about the Q4 plan.', interaction_type: 'conversation', occurred_on: null, with_names: ['Natan Bogin'] }],
  });
}
function nearMemberDraft(): CaptureExtraction {
  return emptyDraft({
    title: 'Spoke to Nathan Bogin',
    summary: 'You spoke to Nathan Bogin.',
    mentions: [{ name: 'Nathan Bogin', kind: 'person', context: null }],
    contacts: [{ name: 'Nathan Bogin', how: 'spoke', ...none }],
    interactions: [{ subject: 'Spoke to Nathan Bogin', summary: 'You spoke to Nathan Bogin.', interaction_type: 'conversation', occurred_on: null, with_names: ['Nathan Bogin'] }],
  });
}
/** The least a note can say: a person and that you met them. */
function minimalDraft(): CaptureExtraction {
  return emptyDraft({
    title: 'Met Anna Smith',
    summary: 'You met Anna Smith today.',
    mentions: [{ name: 'Anna Smith', kind: 'person', context: null }],
    contacts: [{ name: 'Anna Smith', how: 'met', ...none }],
    facts: [{ statement: 'The writer met Anna Smith.', about: ['Anna Smith'], confidence: 'high' }],
    interactions: [{ subject: 'Met Anna Smith', summary: 'You met Anna Smith today.', interaction_type: 'encounter', occurred_on: null, with_names: ['Anna Smith'] }],
  });
}
function richDraft(): CaptureExtraction {
  return emptyDraft({
    title: 'Met Lena Park at Cannes',
    summary: 'You met Lena Park, Head of Drama at Northlight Pictures, at Cannes.',
    mentions: [
      { name: 'Lena Park', kind: 'person', context: 'Head of Drama at Northlight Pictures' },
      { name: 'Northlight Pictures', kind: 'organization', context: null },
      { name: 'Cannes', kind: 'event', context: null },
      { name: 'Night Harbour', kind: 'project', context: null },
    ],
    contacts: [{ name: 'Lena Park', how: 'met', ...none, organization: 'Northlight Pictures', role: 'Head of Drama' }],
    facts: [{ statement: 'Lena Park wants to see Night Harbour next week.', about: ['Lena Park', 'Night Harbour'], confidence: 'high' }],
    interactions: [{ subject: 'Met Lena Park', summary: 'You met Lena Park, Head of Drama at Northlight Pictures, at Cannes.', interaction_type: 'encounter', occurred_on: null, with_names: ['Lena Park'] }],
    actions: [{ title: 'Show Night Harbour to Lena Park', description: 'She asked to see it next week.', due_on: null, related_names: ['Lena Park', 'Night Harbour'] }],
    relationships: [{ person: 'Lena Park', organization: 'Northlight Pictures', role: 'Head of Drama', statement: 'Lena Park is Head of Drama at Northlight Pictures.', claim: 'fact' }],
  });
}
/** A later note about the same person: an update, never a second record. */
function laterDraft(): CaptureExtraction {
  return emptyDraft({
    title: 'Called Lena Park',
    summary: 'You called Lena Park; she confirmed the Night Harbour screening.',
    mentions: [{ name: 'Lena Park', kind: 'person', context: null }, { name: 'Night Harbour', kind: 'project', context: null }],
    contacts: [{ name: 'Lena Park', how: 'called', ...none }],
    facts: [{ statement: 'Lena Park confirmed the Night Harbour screening.', about: ['Lena Park', 'Night Harbour'], confidence: 'high' }],
    interactions: [{ subject: 'Called Lena Park', summary: 'You called Lena Park; she confirmed the Night Harbour screening.', interaction_type: 'call', occurred_on: null, with_names: ['Lena Park'] }],
  });
}

function brianDraft(): CaptureExtraction {
  return {
    title: 'Conversation with Brian about New Foundation',
    summary: 'Brian is interested in New Foundation and wants to see a concrete project. Time Zone could potentially finance Saudi incentive receivables.',
    mentions: [
      { name: 'Brian', kind: 'person', context: null },
      { name: 'New Foundation', kind: 'project', context: null },
      { name: 'Time Zone', kind: 'organization', context: 'Possible financier' },
    ],
    contacts: [],
    facts: [
      { statement: 'Brian is interested in New Foundation.', about: ['Brian', 'New Foundation'], confidence: 'medium' },
      { statement: 'Brian wants to see a concrete project once one exists.', about: ['Brian'], confidence: 'medium' },
    ],
    inferences: [
      {
        statement: 'Time Zone could potentially finance Saudi incentive receivables.',
        about: ['Time Zone'],
        based_on: '"Time Zone could potentially finance Saudi incentive receivables"',
        confidence: 'low',
      },
    ],
    recommendations: [],
    interactions: [
      {
        subject: 'Conversation with Brian',
        summary: 'Discussed New Foundation and possible Time Zone financing.',
        interaction_type: 'conversation',
        occurred_on: null,
        with_names: ['Brian'],
      },
    ],
    actions: [
      {
        title: 'Follow up with Brian',
        description: 'Share a concrete project once one exists.',
        due_on: '2026-10-01',
        related_names: ['Brian'],
      },
    ],
    relationships: [],
    opportunities: [
      {
        title: 'Time Zone financing of Saudi incentive receivables',
        description: 'Time Zone as a possible financier of Saudi incentive receivables.',
        related_names: ['Time Zone'],
        basis: '"could potentially finance Saudi incentive receivables"',
        claim: 'inference',
      },
    ],
    gaps: [{ question: 'Which Brian is this?', why_it_matters: 'Only a first name is given.' }],
  };
}

function ambiguousCompanyDraft(): CaptureExtraction {
  return {
    title: 'Call with Time Zone Capital',
    summary: 'A short call about receivables financing with no next step.',
    mentions: [{ name: 'Time Zone Capital', kind: 'organization', context: null }],
    contacts: [],
    facts: [{ statement: 'A call with Time Zone Capital covered receivables financing.', about: ['Time Zone Capital'], confidence: 'medium' }],
    inferences: [],
    recommendations: [],
    interactions: [
      {
        subject: 'Call with Time Zone Capital',
        summary: 'Receivables financing.',
        interaction_type: 'call',
        occurred_on: null,
        with_names: ['Time Zone Capital'],
      },
    ],
    actions: [],
    relationships: [],
    opportunities: [],
    gaps: [],
  };
}

/** What a model would return for the radar: the document read as a document. */
function radarClassification() {
  return {
    material: 'research_document' as const,
    document_kind: 'radar_brief' as const,
    confidence: 'high' as const,
    description: 'A daily radar brief with two signals, two watch dates and an exclusions section.',
    reason: 'It is dated, sectioned, cites no personal meeting, and lists forward-watch items.',
  };
}

function radarExtraction() {
  return {
    artifact: {
      title: 'AMV Creative Radar — 23 September 2026',
      artifact_type: 'radar_brief' as const,
      summary: 'A daily radar of athlete, story, media and IP signals, with a forward-watch window to 23 October 2026.',
      document_date: '2026-09-23',
      coverage: '2026-09-22 to 2026-09-23, forward watch to 2026-10-23',
      external_use: 'Internal Only',
      source_urls: ['https://example.test/radar/source-1', 'https://example.test/radar/source-2'],
    },
    signals: [
      {
        title: 'Rumesh Tharanga turns equipment loss into an athlete-support proposition',
        signal_type: 'creative_ip' as const,
        what_changed: 'He declined public financial offers after five javelins were damaged in transit, and asked that the support reach other Sri Lankan athletes who struggle to fund equipment.',
        why_it_matters: 'For AMV, a competitive moment could become an athlete-led platform with durable national relevance.',
        decision_question: 'Can this become a durable athlete-access platform?',
        recommended_next_step: 'Prepare a blueprint hypothesis after his Asian Games campaign.',
        promotion_trigger: 'Concrete mechanics, partners or a launch path.',
        priority: 'medium' as const,
        confidence: 'medium' as const,
        original_claim: 'He asked that support reach other athletes who struggle to fund equipment.',
        source_facts: [
          {
            statement: 'Rumesh Tharanga declined public financial offers after five javelins were damaged in transit and asked that the support reach other Sri Lankan athletes who struggle to fund equipment.',
            about: 'Rumesh Tharanga',
            confidence: 'high' as const,
          },
        ],
        subjects: [{ name: 'Rumesh Tharanga', kind: 'person' as const, role: 'subject' as const }],
        source_urls: ['https://example.test/radar/source-1'],
      },
      {
        title: 'The OCA Refugee Team creates an Azraq-to-Asian-Games story world',
        signal_type: 'story' as const,
        what_changed: 'The OCA presented two taekwondo athletes as its first Asian Games refugee team.',
        why_it_matters: 'A contained human narrative with international resonance, if rights and access can be established.',
        decision_question: 'Who controls access and life-story rights?',
        recommended_next_step: 'Map the institutional and storytelling ecosystem.',
        promotion_trigger: null,
        priority: 'medium' as const,
        confidence: 'medium' as const,
        original_claim: 'No documentary, life-story or access rights are disclosed.',
        source_facts: [],
        subjects: [
          { name: 'OCA Refugee Team', kind: 'organization' as const, role: 'subject' as const },
          { name: 'Olympic Council of Asia', kind: 'organization' as const, role: 'organisation' as const },
        ],
        source_urls: ['https://example.test/radar/source-2'],
      },
    ],
    watch_items: [
      {
        title: 'Rumesh Tharanga / Asian Games javelin',
        trigger_date: '2026-09-26',
        why_it_matters: 'Post-event interviews may show whether the proposed initiative has durable intent.',
        promotion_condition: 'Promote only with concrete mechanics, partners or a launch path.',
        about: 'Rumesh Tharanga',
        priority: 'medium' as const,
      },
      {
        title: 'SPORTFILM Liberec',
        trigger_date: '2026-09-30',
        why_it_matters: 'A concentrated European discovery point for sports films and creators.',
        promotion_condition: 'Elevate only a specific athlete, project or creator with verified credits.',
        about: null,
        priority: 'low' as const,
      },
    ],
    hypotheses: [
      {
        title: 'Convert a performance peak into a national athlete-access platform',
        description: 'An athlete-led equipment and access platform could follow his Asian Games campaign.',
        about: 'Rumesh Tharanga',
        from_signal: 'Rumesh Tharanga turns equipment loss into an athlete-support proposition',
      },
    ],
    unknowns: [
      {
        kind: 'gap' as const,
        statement: 'No initiative name, entity, funding model or launch date is confirmed',
        why_it_matters: 'Without mechanics there is nothing to attach a decision to.',
        about: 'Rumesh Tharanga',
      },
      {
        kind: 'risk' as const,
        statement: 'Athlete safeguarding, consent and trauma-informed development require verification',
        why_it_matters: 'Refugee athletes need care before any approach or development work.',
        about: 'OCA Refugee Team',
      },
      {
        kind: 'gap' as const,
        statement: 'Rights availability and representation are unconfirmed',
        why_it_matters: 'Nothing can be developed without knowing who holds the rights.',
        about: 'OCA Refugee Team',
      },
    ],
    research_recommendations: [
      { subject: 'Rumesh Tharanga', kind: 'person' as const, why: 'To learn whether the proposed initiative has mechanics behind it.' },
      { subject: 'OCA Refugee Team', kind: 'organization' as const, why: 'To find who controls access and existing media commitments.' },
    ],
    source_only: [
      { label: 'Routine heat results', why: 'Nothing here changes a decision.' },
      { label: 'Generic tournament previews', why: 'Background only; the document already excludes it.' },
    ],
  };
}

class ScriptedProvider implements AiProvider {
  readonly kind = 'openai' as const;
  readonly isMock = false;
  calls = 0;
  failNext = 0;
  private mock = new MockProvider();

  async generateStructured<T>(options: GenerateOptions & { schema: z.ZodType<T>; schemaName: string }): Promise<StructuredResult<T>> {
    const scripted = (value: unknown): StructuredResult<T> => ({
      value: options.schema.parse(value),
      usage: { model: 'scripted', tokensIn: 10, tokensOut: 10, reasoningTokens: 0, cachedTokens: 0, webSearches: 0, durationMs: 1, usageIsEstimated: true },
      sources: [],
      raw: { scripted: true },
    });
    if (options.schemaName === 'capture_classification') {
      return scripted(
        options.input.includes('Creative Radar') || options.input.includes('live shape')
          ? radarClassification()
          : { material: 'relationship_note', document_kind: null, confidence: 'high', description: 'A note about someone you were in contact with.', reason: 'It describes a personal contact.' },
      );
    }
    if (options.schemaName === 'document_extraction') {
      return scripted(options.input.includes('live shape') ? liveRadarExtraction() : radarExtraction());
    }
    if (options.schemaName !== 'capture_extraction') return this.mock.generateStructured(options);
    this.calls += 1;
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error('Scripted provider failure (simulated timeout).');
    }
    const draft = options.input.includes('Spoke to Brian')
      ? brianDraft()
      : options.input.includes('Time Zone Capital')
        ? ambiguousCompanyDraft()
        : options.input.includes(MEMBER_NOTE)
          ? memberDraft()
          : options.input.includes(NEAR_MEMBER_NOTE)
            ? nearMemberDraft()
            : options.input.includes(RICH_NOTE)
              ? richDraft()
              : options.input.includes(LATER_NOTE)
                ? laterDraft()
                : options.input.includes(MINIMAL_NOTE)
                  ? minimalDraft()
                  : (await this.mock.generateStructured(options)).value;
    return {
      value: options.schema.parse(draft),
      usage: {
        model: 'scripted', tokensIn: 100, tokensOut: 100, reasoningTokens: 0, cachedTokens: 0,
        webSearches: 0, durationMs: 1, usageIsEstimated: true,
      },
      sources: [],
      raw: { scripted: true },
    };
  }
  generateText(options: GenerateOptions) { return this.mock.generateText(options); }
  startBackgroundResearch(options: GenerateOptions) { return this.mock.startBackgroundResearch(options); }
  pollBackgroundResearch(id: string) { return this.mock.pollBackgroundResearch(id); }
  cancelBackgroundResearch() { return this.mock.cancelBackgroundResearch(); }
}

const provider = new ScriptedProvider();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function buildSession(email: string, workspaceId: string): Promise<Session> {
  const user = await withOwner((db) =>
    db.oneOrFail<{ id: string; email: string; display_name: string | null }>(
      `select id, email, display_name from public.app_users where email = $1`,
      [email],
    ),
  );
  const workspaces = await loadWorkspaceAccess(user.id);
  const active = workspaces.find((w) => w.workspaceId === workspaceId) ?? workspaces[0];
  if (!active) throw new Error(`${email} has no workspace access`);
  return { user: { id: user.id, email: user.email, displayName: user.display_name }, workspaces, activeWorkspace: active, isDevAuth: true };
}

/** One worker visit, the same sequence the worker performs. */
async function workerVisit(runId: string, workspaceId: string, useProvider: AiProvider = provider) {
  const run = await claimRun(runId, 'verify-capture-worker', 120);
  if (!run) return { ok: false as const, claimed: false, willRetry: false, error: 'not claimable' };
  const ctx: PipelineContext = { run, workspaceId, provider: useProvider, keepAlive: async () => undefined };
  try {
    const result = await runCapturePipeline(ctx);
    await completeRun(workspaceId, runId);
    return { ok: true as const, claimed: true, willRetry: false, result };
  } catch (error) {
    const outcome = await failRun(workspaceId, runId, error, run.current_stage);
    return { ok: false as const, claimed: true, willRetry: outcome.willRetry, error: error instanceof Error ? error.message : String(error) };
  }
}

const KNOWLEDGE_TABLES = ['entities', 'evidence', 'research_findings', 'interactions', 'actions', 'opportunities', 'entity_mentions', 'entity_affiliations'] as const;
async function knowledgeCounts(workspaceId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  await withService(async (db) => {
    for (const table of KNOWLEDGE_TABLES) {
      out[table] = (await db.oneOrFail<{ n: number }>(`select count(*)::int as n from public.${table} where workspace_id = $1`, [workspaceId])).n;
    }
  });
  return out;
}
const diff = (after: Record<string, number>, before: Record<string, number>) =>
  Object.fromEntries(KNOWLEDGE_TABLES.map((t) => [t, (after[t] ?? 0) - (before[t] ?? 0)]));
const sameCounts = (a: Record<string, number>, b: Record<string, number>) => KNOWLEDGE_TABLES.every((t) => a[t] === b[t]);

async function approveAndSave(session: Session, workspaceId: string, proposalId: string, items: ProposalItemRecord[]) {
  const ids = items.map((i) => i.id);
  await decideProposalItems(session, workspaceId, proposalId, ids.map((itemId) => ({ itemId, decision: 'approved' as const })));
  await recordApproval(session, workspaceId, proposalId, ids);
  const { proposal } = await withService((db) => getProposal(db, workspaceId, proposalId));
  return applyApprovedItems({ session, workspaceId, proposalId, expectedVersion: proposal.version, itemIds: ids });
}

async function drainQueue() {
  for (;;) {
    const messages = await readJobs(QUEUE_RUNS, 20, 1);
    if (messages.length === 0) break;
    for (const message of messages) await archiveJob(QUEUE_RUNS, message.msgId);
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

console.log('\x1b[1mCapture inbox verification\x1b[0m');
console.log('Provider: scripted drafts (no live model call). The live OpenAI extraction is not exercised.');

section('Setup');
const seeded = await seedWorkspace({
  adminEmail: 'capture-admin@example.test',
  adminPassword: 'capture-admin-password',
  clientEmail: 'capture-client@example.test',
  clientPassword: 'capture-client-password',
});
const ws = seeded.workspaceId;
const admin = await buildSession('capture-admin@example.test', ws);
const client = await buildSession('capture-client@example.test', ws);

const viewerId = await upsertDevUser('capture-viewer@example.test', 'capture-viewer-password', 'Viewer');
await withService((db) => grantMembership(db, ws, viewerId, 'viewer', false));
const viewer = await buildSession('capture-viewer@example.test', ws);

const other = await seedAdditionalWorkspace('capture-other', 'Other Workspace', 'capture-other@example.test', 'capture-other-password');
const outsider = await buildSession('capture-other@example.test', other.workspaceId);

// Memory the notes will be resolved against.
const stored = await withService(async (db) => {
  const insert = (workspaceId: string, type: string, name: string, slug: string) =>
    db.oneOrFail<{ id: string }>(
      `insert into public.entities (workspace_id, entity_type, display_name, slug, status, research_status, relationship_status)
       values ($1,$2,$3,$4,'active','existing','unknown')
       on conflict (workspace_id, slug) do update set display_name = excluded.display_name
       returning id`,
      [workspaceId, type, name, slug],
    );
  return {
    timeZone: (await insert(ws, 'organization', 'Time Zone', 'time-zone')).id,
    brianMercer: (await insert(ws, 'person', 'Brian Mercer', 'brian-mercer')).id,
    otherTimeZone: (await insert(other.workspaceId, 'organization', 'Time Zone', 'time-zone')).id,
  };
});
expect('memory seeded: "Time Zone" (organisation) and "Brian Mercer" (person)', Boolean(stored.timeZone && stored.brianMercer));
await drainQueue();

let exitCode = 1;
try {
  // =========================================================================
  section('1. Submit the note: stored as an untrusted source, nothing trusted written');
  const before = await knowledgeCounts(ws);
  const submitted = await createCapture({ session: client, workspaceId: ws, text: BRIAN_NOTE });
  const capture = submitted.capture;
  expect('a capture is created with the original note', submitted.created && capture.body_text === BRIAN_NOTE && capture.kind === 'text');
  expect('its analysis is queued as a background run', Boolean(capture.run_id) && capture.status === 'analyzing');
  expect('no trusted knowledge record exists yet', sameCounts(await knowledgeCounts(ws), before), JSON.stringify(diff(await knowledgeCounts(ws), before)));

  const again = await createCapture({ session: client, workspaceId: ws, text: `  ${BRIAN_NOTE}\n` });
  expect('submitting the same note again returns the same capture (no second analysis)', !again.created && again.capture.id === capture.id && again.capture.run_id === capture.run_id);

  const activityCreated = await withService((db) =>
    db.one<{ summary: string }>(`select summary from public.activity_log where workspace_id = $1 and action = 'capture.created' and subject_id = $2`, [ws, capture.id]),
  );
  expect('Activity records the capture without its content', Boolean(activityCreated) && !activityCreated!.summary.includes('Brian'), activityCreated?.summary ?? '');

  // =========================================================================
  section('2. A failed analysis is retried without duplicates');
  provider.failNext = 1;
  const firstVisit = await workerVisit(capture.run_id!, ws);
  expect('the first attempt fails and is scheduled for retry', !firstVisit.ok && firstVisit.willRetry, firstVisit.ok ? '' : firstVisit.error);
  const afterFailure = await withService((db) => getCapture(db, ws, capture.id));
  expect('the capture says the analysis will be retried', afterFailure?.status === 'analyzing' && Boolean(afterFailure?.status_detail?.includes('retried')), afterFailure?.status_detail ?? '');
  expect('nothing trusted was written by the failed attempt', sameCounts(await knowledgeCounts(ws), before));
  const loadStage = await withService((db) =>
    db.one<{ status: string }>(`select status from public.run_stages where run_id = $1 and stage = 'load'`, [capture.run_id]),
  );
  expect('the stage finished before the failure is kept', loadStage?.status === 'succeeded');

  const secondVisit = await workerVisit(capture.run_id!, ws);
  expect('the retry succeeds', secondVisit.ok, secondVisit.ok ? '' : secondVisit.error);
  const resumedEvent = await withService((db) =>
    db.one<{ n: number }>(`select count(*)::int as n from public.run_events where run_id = $1 and message like 'Stage "load" already completed%'`, [capture.run_id]),
  );
  expect('the retry resumed instead of redoing finished stages', (resumedEvent?.n ?? 0) >= 1);
  expect('the model was called once per extraction attempt (2), not again for resume', provider.calls === 2, `calls = ${provider.calls}`);

  const analysed = await withService((db) => getCapture(db, ws, capture.id));
  expect('the capture now points at its proposal', analysed?.status === 'proposed' && Boolean(analysed?.proposal_id));
  const proposalId = analysed!.proposal_id!;

  // Simulate a crash after the proposal was built but before the stage was marked done.
  await withService(async (db) => {
    await db.query(`update public.run_stages set status = 'running', output = null where run_id = $1 and stage = 'propose'`, [capture.run_id]);
    await db.query(`update public.runs set status = 'queued', lease_owner = null, lease_expires_at = null where id = $1`, [capture.run_id]);
  });
  const crashVisit = await workerVisit(capture.run_id!, ws);
  const proposalsForCapture = await withService((db) =>
    db.oneOrFail<{ n: number }>(`select count(*)::int as n from public.proposals where workspace_id = $1 and run_id = $2`, [ws, capture.run_id]),
  );
  expect('re-running an interrupted propose stage reuses the proposal (exactly one)', crashVisit.ok && proposalsForCapture.n === 1, `proposals = ${proposalsForCapture.n}`);

  // Explicit retry of a job that exhausted its attempts.
  const exhausted = await createCapture({ session: client, workspaceId: ws, text: 'Note for the retry test: coffee with a contact, nothing else.' });
  await withService((db) => db.query(`update public.runs set max_attempts = 1 where id = $1`, [exhausted.capture.run_id]));
  provider.failNext = 1;
  const exhaustedVisit = await workerVisit(exhausted.capture.run_id!, ws);
  const failedCapture = await withService((db) => getCapture(db, ws, exhausted.capture.id));
  expect('at the attempt ceiling the capture is marked failed', !exhaustedVisit.ok && !exhaustedVisit.willRetry && failedCapture?.status === 'failed');
  const retried = await retryCapture(client, ws, exhausted.capture.id);
  expect('"Retry analysis" requeues it', retried.status === 'analyzing');
  const retriedVisit = await workerVisit(exhausted.capture.run_id!, ws);
  const retriedCapture = await withService((db) => getCapture(db, ws, exhausted.capture.id));
  expect('and the retried analysis produces a proposal', retriedVisit.ok && retriedCapture?.status === 'proposed');
  await drainQueue();

  // =========================================================================
  section('3. The proposal: resolved, ambiguous and new names, nothing merged');
  const { items } = await withService((db) => getProposal(db, ws, proposalId));
  const byTable = (table: string) => items.filter((i) => i.target_table === table);
  const brianEntity = byTable('entities').find((i) => /brian/i.test(i.label));
  expect('no person record is proposed for "Brian"', !brianEntity);
  const brianMention = byTable('entity_mentions').find((i) => i.label === 'Brian');
  expect('"Brian" is staged as an unconfirmed name', Boolean(brianMention) && brianMention!.claim_type === 'gap');
  expect('  with "Brian Mercer" as the candidate, not merged', brianMention?.new_values.candidate_entity_id === stored.brianMercer);
  expect('"Time Zone" resolves to the stored record, with no new organisation proposed', !byTable('entities').some((i) => i.label === 'Time Zone'));
  const inference = byTable('research_findings').find((i) => i.claim_type === 'inference');
  expect('the financing statement is a clearly labelled inference', Boolean(inference) && inference!.new_values.finding_type === 'inference');
  expect('  linked to the stored Time Zone record', inference?.new_values.related_entity_id === stored.timeZone);
  expect('"New Foundation" is proposed as a new project', byTable('entities').some((i) => i.label === 'New Foundation' && i.op === 'create' && i.new_values.entity_type === 'project'));
  const interaction = byTable('interactions')[0];
  expect('an interaction is proposed', Boolean(interaction) && interaction!.op === 'create');
  expect('  not linked to an ambiguous "Brian", and it says so', interaction?.new_values.external_entity_id == null && /Not linked to "Brian"/.test(interaction?.reason ?? ''));
  const action = byTable('actions')[0];
  expect('a follow-up action is proposed for October', Boolean(action) && action!.claim_type === 'next_step' && String(action!.new_values.due_at ?? '').startsWith('2026-10-01'));
  const opportunity = byTable('opportunities')[0];
  expect('an opportunity is proposed as an inference, linked to Time Zone', Boolean(opportunity) && opportunity!.claim_type === 'inference' && opportunity!.new_values.related_entity_id === stored.timeZone);
  expect('no relationship is invented', byTable('entity_affiliations').length === 0);
  const evidence = byTable('evidence')[0];
  expect('the source is proposed as an unverified source record', evidence?.new_values.reliability === 'unverified' && String(evidence?.new_values.file_reference ?? '').startsWith('capture:'));
  expect('facts, inferences and gaps keep separate claim types', ['fact', 'inference', 'gap'].every((t) => items.some((i) => i.claim_type === t)));
  expect('every item carries the capture as provenance', items.every((i) => i.provenance.capture_id === capture.id));
  expect('still no trusted record before approval', sameCounts(await knowledgeCounts(ws), before));

  // =========================================================================
  section('4. Unapproved writes are refused');
  await expectRejection('a viewer cannot approve items', () => decideProposalItems(viewer, ws, proposalId, [{ itemId: interaction!.id, decision: 'approved' }]), (code) => code === 'forbidden');
  await expectRejection('a viewer cannot save', () => applyApprovedItems({ session: viewer, workspaceId: ws, proposalId, expectedVersion: 1, itemIds: [interaction!.id] }), (code) => code === 'forbidden');
  await expectRejection('a viewer cannot add a capture', () => createCapture({ session: viewer, workspaceId: ws, text: 'Viewer note' }), (code) => code === 'forbidden');
  await expectRejection('saving without an approval is refused, even for an approver', () => applyApprovedItems({ session: admin, workspaceId: ws, proposalId, expectedVersion: 1, itemIds: [evidence!.id] }), (code) => code === 'conflict');
  await expectRejection(
    'a signed-in user cannot insert an interaction directly (database-enforced)',
    () => withUser(client.user.id, (db) => db.query(`insert into public.interactions (workspace_id, interaction_type, subject) values ($1, 'call', 'bypass')`, [ws])),
    (code) => code === '42501',
  );
  await expectRejection(
    'a signed-in user cannot write a capture row directly',
    () => withUser(client.user.id, (db) => db.query(`update public.captures set status = 'proposed' where id = $1`, [capture.id])),
    (code) => code === '42501',
  );
  expect('nothing was written by any refused attempt', sameCounts(await knowledgeCounts(ws), before));

  // =========================================================================
  section('5. Approve selected items: exactly those are saved, once');
  const selected = [evidence!, interaction!, inference!, action!, opportunity!];
  const applied = await approveAndSave(admin, ws, proposalId, selected);
  const afterSave = await knowledgeCounts(ws);
  const delta = diff(afterSave, before);
  expect('five changes saved', applied.applied.filter((a) => a.status === 'applied').length === 5, JSON.stringify(delta));
  expect('exactly one source, interaction, finding, action and opportunity were created',
    delta.evidence === 1 && delta.interactions === 1 && delta.research_findings === 1 && delta.actions === 1 && delta.opportunities === 1 && delta.entities === 0 && delta.entity_mentions === 0,
    JSON.stringify(delta));
  const unselected = await withService((db) =>
    db.oneOrFail<{ n: number }>(`select count(*)::int as n from public.proposal_items where proposal_id = $1 and applied_at is null`, [proposalId]),
  );
  expect('the unselected items are still awaiting review', unselected.n === items.length - 5, `${unselected.n} awaiting`);
  const savedAction = await withService((db) => db.one<{ related_interaction_id: string | null }>(`select related_interaction_id from public.actions where id = $1`, [applied.applied.find((a) => a.table === 'actions')?.rowId]));
  expect('the follow-up is linked to the saved interaction', savedAction?.related_interaction_id === applied.applied.find((a) => a.table === 'interactions')?.rowId);

  const reapply = await applyApprovedItems({ session: admin, workspaceId: ws, proposalId, expectedVersion: (await withService((db) => getProposal(db, ws, proposalId))).proposal.version, itemIds: selected.map((i) => i.id) });
  expect('saving the same approval again writes nothing new', reapply.applied.every((a) => a.status === 'already_applied') && sameCounts(await knowledgeCounts(ws), afterSave));

  // =========================================================================
  section('6. Readback, Activity, Today and Knowledge');
  const readback = await withUser(admin.user.id, (db) => readbackProposal(db, ws, proposalId));
  expect('readback returns the five stored records, each matching what was approved', readback.length === 5 && readback.every((r) => r.readbackOk));
  const appliedActivity = await withService((db) =>
    db.one<{ n: number }>(`select count(*)::int as n from public.activity_log where workspace_id = $1 and action = 'proposal.applied' and subject_id = $2`, [ws, proposalId]),
  );
  const analysedActivity = await withService((db) =>
    db.one<{ n: number }>(`select count(*)::int as n from public.activity_log where workspace_id = $1 and action = 'capture.analyzed' and subject_id = $2`, [ws, capture.id]),
  );
  expect('Activity shows the capture was analysed and the changes saved', (appliedActivity?.n ?? 0) >= 1 && (analysedActivity?.n ?? 0) >= 1);

  // The queries Today and Knowledge run, with the user's own access rules.
  const savedToday = await withUser(admin.user.id, (db) =>
    db.rows<{ label: string; table_name: string }>(
      `select i.label, c.table_name
         from public.applied_changes c
         join public.proposal_items i on i.id = c.proposal_item_id
        where c.workspace_id = $1 and c.applied_at >= date_trunc('day', now())`,
      [ws],
    ),
  );
  expect('Today would list the saved interaction under Saved today', savedToday.some((r) => r.table_name === 'interactions' && r.label === interaction!.label));
  const knowledgeHits = await withUser(admin.user.id, (db) =>
    db.rows<{ finding_type: string; title: string }>(
      `select finding_type, title from public.research_findings
        where title ilike '%Saudi incentive%' or content ilike '%Saudi incentive%'`,
      [],
    ),
  );
  expect('Knowledge finds the saved inference, readable by the user', knowledgeHits.some((f) => f.finding_type === 'inference'));
  const knowledgeInteraction = await withUser(admin.user.id, (db) =>
    db.rows<{ subject: string }>(`select subject from public.interactions where subject = $1`, [interaction!.label]),
  );
  expect('  and the interaction is readable too', knowledgeInteraction.length === 1);

  // =========================================================================
  section('7. Re-running the same capture creates no duplicate canonical records');
  const rest = (await withService((db) => getProposal(db, ws, proposalId))).items.filter((i) => !i.applied_at);
  await approveAndSave(admin, ws, proposalId, rest);
  const afterAll = await knowledgeCounts(ws);
  expect('the remaining items were saved (New Foundation, facts, the unconfirmed name, the gap)', diff(afterAll, afterSave).entities === 1 && diff(afterAll, afterSave).entity_mentions === 1);

  const resubmit = await createCapture({ session: client, workspaceId: ws, text: BRIAN_NOTE });
  expect('submitting the note again returns the existing capture', !resubmit.created && resubmit.capture.id === capture.id);

  const rerun = await createCapture({ session: client, workspaceId: ws, text: BRIAN_NOTE, force: true });
  expect('an explicit re-analysis creates a new capture and keeps the old one', rerun.created && rerun.capture.id !== capture.id && (await withService((db) => getCapture(db, ws, capture.id)))?.status === 'proposed');
  const rerunVisit = await workerVisit(rerun.capture.run_id!, ws);
  const rerunCapture = await withService((db) => getCapture(db, ws, rerun.capture.id));
  const rerunItems = (await withService((db) => getProposal(db, ws, rerunCapture!.proposal_id!))).items;
  expect('the re-analysis proposes no new records: every item targets what is already stored', rerunVisit.ok && rerunItems.length > 0 && rerunItems.every((i) => i.op !== 'create' && i.target_id !== null),
    rerunItems.filter((i) => i.op === 'create').map((i) => `${i.target_table}:${i.label}`).join(', '));
  await approveAndSave(admin, ws, rerunCapture!.proposal_id!, rerunItems);
  expect('approving and saving all of it leaves every canonical count unchanged', sameCounts(await knowledgeCounts(ws), afterAll), JSON.stringify(diff(await knowledgeCounts(ws), afterAll)));
  await drainQueue();

  // =========================================================================
  section('8. Ambiguous company match');
  const company = await createCapture({ session: client, workspaceId: ws, text: AMBIGUOUS_COMPANY_NOTE });
  const companyVisit = await workerVisit(company.capture.run_id!, ws);
  const companyCapture = await withService((db) => getCapture(db, ws, company.capture.id));
  const companyItems = (await withService((db) => getProposal(db, ws, companyCapture!.proposal_id!))).items;
  expect('the analysis completes', companyVisit.ok);
  expect('"Time Zone Capital" is not proposed as a new company', !companyItems.some((i) => i.target_table === 'entities'));
  const companyMention = companyItems.find((i) => i.target_table === 'entity_mentions');
  expect('it is staged as an unconfirmed name with "Time Zone" as a candidate', companyMention?.new_values.candidate_entity_id === stored.timeZone);
  const candidates = (companyMention?.candidates ?? []) as unknown[];
  expect('  and the candidates and rationale are recorded', JSON.stringify(candidates).includes('Time Zone') || /Time Zone/.test(String(companyMention?.new_values.rationale ?? '')));
  expect('the call is not linked to either company', companyItems.find((i) => i.target_table === 'interactions')?.new_values.external_entity_id == null);
  await drainQueue();

  // =========================================================================
  section('9. Private to its workspace');
  const outsiderRead = await withUser(outsider.user.id, (db) => db.rows(`select id from public.captures where id = $1`, [capture.id]));
  expect('a member of another workspace cannot read the capture (RLS)', outsiderRead.length === 0);
  const outsiderProposal = await withUser(outsider.user.id, (db) => db.rows(`select id from public.proposals where id = $1`, [proposalId]));
  expect('nor its proposal', outsiderProposal.length === 0);
  expect('the server lookup scoped to the other workspace finds nothing', (await withService((db) => getCapture(db, other.workspaceId, capture.id))) === null);
  await expectRejection('the outsider cannot add a capture to this workspace', () => createCapture({ session: outsider, workspaceId: ws, text: 'Cross-workspace note' }), (code) => code === 'forbidden');

  const fileCapture = await createCapture({
    session: client,
    workspaceId: ws,
    text: 'Dossier attached.',
    file: { name: 'dossier.md', type: 'text/markdown', bytes: Buffer.from('# Dossier\nConfidential notes.') },
  });
  const upload = await withService((db) => db.oneOrFail<{ storage_path: string }>(`select storage_path from public.uploads where id = $1`, [fileCapture.capture.upload_id]));
  expect('an attached file is stored under its workspace prefix', upload.storage_path.startsWith(`${ws}/`));
  const relative = upload.storage_path.slice(ws.length + 1);
  let crossRead = false;
  try {
    await getStorage().get(other.workspaceId, relative);
    crossRead = true;
  } catch {
    crossRead = false;
  }
  expect('the same file path is not readable from the other workspace', !crossRead);
  const fileVisit = await workerVisit(fileCapture.capture.run_id!, ws, new MockProvider());
  expect('a file capture is analysed', fileVisit.ok, fileVisit.ok ? '' : String(fileVisit.error));
  const fileProposal = await withService((db) => getCapture(db, ws, fileCapture.capture.id));
  const fileItems = fileProposal?.proposal_id
    ? (await withService((db) => getProposal(db, ws, fileProposal.proposal_id as string))).items
    : [];
  expect('without a model it proposes only the source, a statement and a gap, all labelled mock',
    fileItems.every((i) => ['evidence', 'research_findings'].includes(i.target_table)) &&
      (await withService((db) => getProposal(db, ws, fileProposal!.proposal_id!))).proposal.is_mock);
  const resolvedOutside = await withService((db) =>
    db.one<{ id: string }>(`select id from public.proposal_items where proposal_id = $1 and new_values->>'related_entity_id' = $2`, [proposalId, stored.otherTimeZone]),
  );
  expect('resolution never used the other workspace\'s "Time Zone"', !resolvedOutside);

  // =========================================================================
  // Capture data correctness: the canonical model, and nothing beyond the note.
  // =========================================================================
  /** Submits a note, analyses it, and returns its proposal items. */
  const capturing = async (text: string, session: Session = client) => {
    const created = await createCapture({ session, workspaceId: ws, text });
    if (created.capture.run_id) await workerVisit(created.capture.run_id, ws);
    const stored = await withService((db) => getCapture(db, ws, created.capture.id));
    const loaded = stored?.proposal_id ? await withService((db) => getProposal(db, ws, stored.proposal_id as string)) : null;
    return { capture: stored!, proposalId: stored?.proposal_id ?? null, items: loaded?.items ?? [], created: created.created };
  };
  const valuesOf = (item: ProposalItemRecord) => ({ ...item.new_values, ...(item.edited_values ?? {}) }) as Record<string, unknown>;
  const ofTable = (items: ProposalItemRecord[], table: string) => items.filter((i) => i.target_table === table);
  const creates = (items: ProposalItemRecord[], type: string) =>
    ofTable(items, 'entities').filter((i) => !i.target_id && valuesOf(i).entity_type === type);

  section('10. An internal member is never proposed as an external contact');
  const natan = await withService((db) =>
    db.oneOrFail<{ id: string }>(
      `insert into public.members (workspace_id, full_name, slug, role_title, status) values ($1,'Natan Bogin','natan-bogin','Founder & CEO','active') returning id`,
      [ws],
    ),
  );
  const beforeMember = await knowledgeCounts(ws);
  const member = await capturing(MEMBER_NOTE);
  const memberInteraction = ofTable(member.items, 'interactions')[0];
  expect('no person record is proposed for a colleague', creates(member.items, 'person').length === 0 && ofTable(member.items, 'entity_mentions').length === 0,
    member.items.map((i) => `${i.target_table}:${i.label}`).join(' | '));
  expect('the interaction is linked to them as a Globa 3 member', valuesOf(memberInteraction!).internal_owner_member_id === natan.id);
  expect('nothing external is proposed: no affiliation, alias, finding or opportunity',
    ['entity_affiliations', 'entity_aliases', 'opportunities'].every((t) => ofTable(member.items, t).length === 0));
  const memberSaved = await approveAndSave(admin, ws, member.proposalId!, member.items.filter((i) => !i.applied_at));
  const memberDelta = diff(await knowledgeCounts(ws), beforeMember);
  expect('approving saves the note and the interaction only', memberSaved.applied.every((a) => a.status === 'applied') && memberDelta.entities === 0 && memberDelta.interactions === 1 && memberDelta.evidence === 1,
    JSON.stringify(memberDelta));

  const nearMember = await capturing(NEAR_MEMBER_NOTE);
  expect('a name close to a member stays an unconfirmed name for review', creates(nearMember.items, 'person').length === 0 && ofTable(nearMember.items, 'entity_mentions').length === 1,
    nearMember.items.map((i) => i.target_table).join(','));
  expect('  and it names the member it might be', String(valuesOf(ofTable(nearMember.items, 'entity_mentions')[0]!).rationale ?? '').length > 0);

  section('11. A minimal note creates only what it states');
  const beforeMinimal = await knowledgeCounts(ws);
  const minimal = await capturing(MINIMAL_NOTE);
  const minimalPerson = creates(minimal.items, 'person')[0];
  expect('one person, as a contact, and nothing else of that kind', creates(minimal.items, 'person').length === 1 && valuesOf(minimalPerson!).relationship_status === 'contact');
  expect('no company, no event, no affiliation, no follow-up, no opportunity',
    creates(minimal.items, 'organization').length === 0 && creates(minimal.items, 'event').length === 0 &&
      ofTable(minimal.items, 'entity_affiliations').length === 0 && ofTable(minimal.items, 'actions').length === 0 &&
      ofTable(minimal.items, 'opportunities').length === 0,
    minimal.items.map((i) => `${i.target_table}:${i.label}`).join(' | '));
  expect('no finding that only repeats the interaction', ofTable(minimal.items, 'research_findings').length === 0);
  expect('exactly: your note, the person, the interaction', minimal.items.length === 3 && ofTable(minimal.items, 'evidence').length === 1 && ofTable(minimal.items, 'interactions').length === 1,
    minimal.items.map((i) => i.target_table).join(','));
  await approveAndSave(admin, ws, minimal.proposalId!, minimal.items);
  const minimalDelta = diff(await knowledgeCounts(ws), beforeMinimal);
  expect('saving writes one person, one interaction and the note', JSON.stringify([minimalDelta.entities, minimalDelta.interactions, minimalDelta.evidence]) === '[1,1,1]', JSON.stringify(minimalDelta));
  // The legacy CRM tables were dropped by 0021. The guarantee they used to
  // protect -- that capture never creates a second representation of a person --
  // is now structural: there is nowhere else for one to go.
  const legacy = await withService((db) =>
    db.oneOrFail<{ present: string }>(
      `select coalesce(string_agg(t, ', '), '') as present from (
         select unnest(array['external_contacts','external_companies','relationship_interactions']) t) x
        where to_regclass('public.' || quote_ident(t)) is not null`,
    ),
  );
  expect('the legacy CRM tables do not exist at all', legacy.present === '', legacy.present);

  section('12. A richer note: only supported records, and a place is not an event');
  const rich = await capturing(RICH_NOTE);
  expect('Lena is a contact, Northlight a company, Night Harbour a project',
    creates(rich.items, 'person').length === 1 && creates(rich.items, 'organization').length === 1 && creates(rich.items, 'project').length === 1);
  expect('her role at Horizon is an affiliation, with the interaction and the follow-up',
    ofTable(rich.items, 'entity_affiliations').length === 1 && ofTable(rich.items, 'interactions').length === 1 && ofTable(rich.items, 'actions').length === 1);
  expect('"Cannes" is context, not an Event record', creates(rich.items, 'event').length === 0 && !rich.items.some((i) => i.label.toLowerCase() === 'cannes'),
    rich.items.map((i) => i.label).join(' | '));
  expect('and the note\'s own words keep the place', String(valuesOf(ofTable(rich.items, 'interactions')[0]!).summary ?? '').includes('Cannes'));
  expect('no opportunity is invented from a wish to see a project', ofTable(rich.items, 'opportunities').length === 0);
  const beforeRichSave = await knowledgeCounts(ws);
  await approveAndSave(admin, ws, rich.proposalId!, rich.items);
  const richDelta = diff(await knowledgeCounts(ws), beforeRichSave);
  expect('saving writes Lena, Northlight, Night Harbour, the link, the interaction and the follow-up',
    richDelta.entities === 3 && richDelta.entity_affiliations === 1 && richDelta.interactions === 1 && richDelta.actions === 1,
    JSON.stringify(richDelta));

  section('13. Repeating a note, and a later note about the same person');
  const beforeRepeat = await knowledgeCounts(ws);
  const repeat = await capturing(RICH_NOTE);
  expect('submitting the same note again reuses the same capture, with nothing new proposed', repeat.created === false && repeat.capture.id === rich.capture.id);
  expect('and no canonical record changed', sameCounts(await knowledgeCounts(ws), beforeRepeat));
  const later = await capturing(LATER_NOTE);
  const laterPerson = ofTable(later.items, 'entities').find((i) => String(valuesOf(i).display_name ?? i.label) === 'Lena Park');
  expect('a later note links to the stored Lena Park instead of creating another', creates(later.items, 'person').length === 0 && (laterPerson === undefined || Boolean(laterPerson.target_id)),
    later.items.map((i) => `${i.target_table}:${i.label}`).join(' | '));
  const beforeLaterSave = await knowledgeCounts(ws);
  await approveAndSave(admin, ws, later.proposalId!, later.items.filter((i) => !i.applied_at));
  const laterDelta = diff(await knowledgeCounts(ws), beforeLaterSave);
  expect('saving it adds an interaction, not a person', laterDelta.entities === 0 && laterDelta.interactions === 1, JSON.stringify(laterDelta));
  const lenaRows = await withService((db) => db.oneOrFail<{ n: number }>(`select count(*)::int as n from public.entities where workspace_id = $1 and slug = 'lena-park'`, [ws]));
  expect('exactly one Lena Park exists after three notes about her', lenaRows.n === 1, `${lenaRows.n} rows`);

  section('14. Knowledge readback: a briefing, from saved records only');
  const lena = await withUser(admin.user.id, (db) => subjectBriefing(db, ws, 'Lena Park', { timeZone: 'Europe/Paris' }));
  const lenaSection = (key: string) => lena?.sections.find((x) => x.key === key);
  expect('it leads with what the sources actually say', Boolean(lena?.lead) && !/unknown|unconfirmed/i.test(lena!.lead!), lena?.lead ?? 'none');
  expect('who this is sits in the subtitle, not in the answer', lena?.subtitle === 'Head of Drama at Northlight Pictures', lena?.subtitle ?? 'none');
  const knownAt = lena?.sections.findIndex((x) => x.key === 'known') ?? -1;
  const unconfirmedAt = lena?.sections.findIndex((x) => x.key === 'unconfirmed') ?? -1;
  expect('what we know comes before still unconfirmed', knownAt >= 0 && (unconfirmedAt === -1 || knownAt < unconfirmedAt),
    lena?.sections.map((x) => x.heading).join(' → '));
  expect('what to watch next carries the follow-up', lenaSection('watch')?.lines.some((l) => l.text.includes('Night Harbour')) === true,
    JSON.stringify(lenaSection('watch')?.lines));
  expect('the records behind it stay in source details', (lena?.sources.length ?? 0) > 0);
  const unknownPerson = await withUser(admin.user.id, (db) => subjectBriefing(db, ws, 'Someone Not Stored'));
  expect('a name memory does not hold gets no briefing', unknownPerson === null);

  section('15. A radar brief is read as a document, not as a relationship');
  const beforeRadar = await knowledgeCounts(ws);
  const radar = await capturing(RADAR_NOTE);
  const radarItems = radar.items;
  const of = (table: string) => ofTable(radarItems, table);
  expect('the document is kept as one source and one research document',
    of('evidence').length === 1 && of('research_artifacts').length === 1 && String(valuesOf(of('evidence')[0]!).source_type) === 'brief',
    of('evidence').map((i) => `${i.label}:${valuesOf(i).source_type}`).join(' | '));
  expect('cited URLs ride as provenance, not as separate sources',
    of('evidence').length === 1 && ((of('research_artifacts')[0]!.provenance as { source_urls?: string[] })?.source_urls ?? []).length === 2,
    JSON.stringify((of('research_artifacts')[0]!.provenance as { source_urls?: string[] })?.source_urls));
  expect('both signals are proposed, with why they matter and what to do next',
    of('signals').length === 2 && of('signals').every((i) => String(valuesOf(i).why_it_matters ?? '').length > 0) && of('signals').some((i) => String(valuesOf(i).recommended_next_step ?? '').includes('blueprint')),
    of('signals').map((i) => i.label).join(' | '));
  expect('each signal is linked only to what it is about', of('signal_entities').length === 2, of('signal_entities').map((i) => i.label).join(' | '));
  expect('the governing body named alongside it stays in the document', !of('entities').some((i) => i.label === 'Olympic Council of Asia'), of('entities').map((i) => i.label).join(' | '));
  expect('subjects are plain records, never contacts',
    creates(radarItems, 'person').length === 1 && of('entities').every((i) => valuesOf(i).relationship_status === 'none'),
    of('entities').map((i) => `${i.label}:${valuesOf(i).relationship_status}`).join(' | '));
  expect('nobody from the document is proposed as an external contact', !radarItems.some((i) => valuesOf(i).relationship_status === 'contact'));
  expect('forward watch becomes dated watch items, not signals',
    of('actions').length === 2 && of('actions').every((i) => valuesOf(i).action_type === 'watch') && of('actions').some((i) => String(valuesOf(i).due_at ?? '').startsWith('2026-09-26')),
    of('actions').map((i) => `${i.label}:${valuesOf(i).due_at}`).join(' | '));
  expect('a festival is a date to watch, not an Event record', creates(radarItems, 'event').length === 0 && of('actions').some((i) => i.label.includes('SPORTFILM')));
  const gaps = of('research_findings').filter((i) => valuesOf(i).finding_type === 'gap');
  const risks = of('research_findings').filter((i) => valuesOf(i).finding_type === 'risk');
  const sourceFacts = of('research_findings').filter((i) => valuesOf(i).finding_type === 'fact');
  expect('what is unknown is a gap; what needs care is a risk',
    gaps.length === 2 && risks.length === 1 && String(valuesOf(risks[0]!).title).toLowerCase().includes('safeguarding'),
    [...gaps, ...risks].map((i) => `${valuesOf(i).finding_type}:${i.label}`).join(' | '));
  expect(
    'a key source-backed fact is proposed for the signal subject, not only the interpretation',
    sourceFacts.length === 1 && String(valuesOf(sourceFacts[0]!).content).includes('declined public financial offers'),
    sourceFacts.map((item) => String(valuesOf(item).content)).join(' | '),
  );
  const hypothesis = of('opportunities')[0];
  expect('the idea is staged as an unvalidated hypothesis at stage "idea"',
    of('opportunities').length === 1 && valuesOf(hypothesis!).stage === 'idea' && valuesOf(hypothesis!).opportunity_type === 'hypothesis' && String(valuesOf(hypothesis!).description).startsWith('Unvalidated hypothesis.'),
    JSON.stringify({ stage: valuesOf(hypothesis!).stage, type: valuesOf(hypothesis!).opportunity_type }));
  expect('no research target, topic or run is created', (await withService((db) => db.oneOrFail<{ n: number }>(`select count(*)::int as n from public.research_topics where workspace_id = $1`, [ws]))).n === 0 && (await withService((db) => db.oneOrFail<{ n: number }>(`select count(*)::int as n from public.runs where workspace_id = $1 and kind in ('research', 'contact_identify', 'contact_research')`, [ws]))).n === 0);
  expect('nothing is written before approval', sameCounts(await knowledgeCounts(ws), beforeRadar), JSON.stringify(diff(await knowledgeCounts(ws), beforeRadar)));

  // Partial approval: everything except the unvalidated idea.
  const withoutHypothesis = radarItems.filter((i) => i.target_table !== 'opportunities');
  await approveAndSave(admin, ws, radar.proposalId!, withoutHypothesis);
  const radarDelta = diff(await knowledgeCounts(ws), beforeRadar);
  const savedSignals = await withService((db) => db.oneOrFail<{ n: number }>(`select count(*)::int as n from public.signals where workspace_id = $1`, [ws]));
  const savedLinks = await withService((db) => db.oneOrFail<{ n: number }>(`select count(*)::int as n from public.signal_entities where workspace_id = $1`, [ws]));
  const savedArtifact = await withService((db) => db.one<{ title: string; provenance_note: string | null }>(`select title, provenance_note from public.research_artifacts where workspace_id = $1 order by created_at desc limit 1`, [ws]));
  expect('approving writes exactly the selected records', savedSignals.n === 2 && savedLinks.n === 2 && radarDelta.opportunities === 0 && radarDelta.actions === 2 && radarDelta.evidence === 1,
    JSON.stringify(radarDelta));
  expect('the saved document keeps its cited sources in provenance', (savedArtifact?.provenance_note ?? '').includes('https://example.test/radar/source-1'));
  const rumeshReadback = await withService((db) => retrieveRecords(db, ws, 'What do we know about Rumesh Tharanga?'));
  const rumeshSignal = rumeshReadback.find((record) => record.table === 'signals' && record.label.includes('Rumesh Tharanga'));
  expect(
    'Knowledge readback keeps the document facts that explain a saved signal',
    Boolean(rumeshSignal?.body.includes('What the document says: He declined public financial offers')) &&
      Boolean(rumeshSignal?.body.includes('Source claim: He asked that support reach other athletes')),
    rumeshSignal?.body ?? 'Rumesh signal was not retrieved',
  );
  expect(
    'Knowledge readback also retrieves the source-backed fact attached to Rumesh',
    rumeshReadback.some((record) => record.table === 'research_findings' && record.body.includes('declined public financial offers')),
    rumeshReadback.map((record) => `${record.table}:${record.label}`).join(' | '),
  );
  const hypothesisRows = await withService((db) =>
    db.oneOrFail<{ n: number }>(`select count(*)::int as n from public.opportunities where workspace_id = $1 and opportunity_type = 'hypothesis'`, [ws]),
  );
  expect('the unvalidated idea is still waiting, unsaved', hypothesisRows.n === 0 && radarDelta.opportunities === 0, `${hypothesisRows.n} hypothesis row(s)`);

  // Idempotency: the same document again.
  const radarAgain = await capturing(RADAR_NOTE);
  expect('capturing the same document again reuses the capture and writes nothing', radarAgain.created === false && sameCounts(await knowledgeCounts(ws), await knowledgeCounts(ws)));
  await workerVisit(radar.capture.run_id!, ws);
  const afterRerun = await withService((db) => db.oneOrFail<{ n: number }>(`select count(*)::int as n from public.proposal_items where proposal_id = $1`, [radar.proposalId!]));
  expect('re-running the analysis adds no duplicate item', afterRerun.n === radarItems.length, `${afterRerun.n} vs ${radarItems.length}`);

  section('15b. "Why does Rumesh Tharanga matter?" -- the readback a person reads');
  const rumesh = await withUser(admin.user.id, (db) => subjectBriefing(db, ws, 'Rumesh Tharanga', { timeZone: 'Europe/Paris' }));
  const part = (key: string) => rumesh?.sections.find((x) => x.key === key);
  const rendered = [rumesh?.lead ?? '', ...(rumesh?.sections ?? []).flatMap((x) => [x.heading, ...x.lines.map((l) => `${l.text} ${l.note ?? ''}`)])].join('\n');
  expect('it leads with the concrete fact, not with what is missing',
    (rumesh?.lead ?? '').includes('javelins') && (rumesh?.lead ?? '').includes('Sri Lankan athletes') && !/unconfirmed|unknown/i.test(rumesh?.lead ?? ''),
    rumesh?.lead ?? 'none');
  expect('the four sections read in the order a person needs them',
    JSON.stringify(rumesh?.sections.map((x) => x.heading)) === JSON.stringify(['What we know', 'Why it matters to AMV', 'What to watch next', 'Still unconfirmed']),
    JSON.stringify(rumesh?.sections.map((x) => x.heading)));
  expect('the possible platform is kept apart from what is confirmed',
    part('why')?.lines.some((l) => /possibility|not a confirmed/i.test(l.text) && l.note === 'Unvalidated') === true &&
      !part('known')?.lines.some((l) => /platform/i.test(l.text) && !/could/i.test(l.text)),
    JSON.stringify(part('why')?.lines));
  expect('why it matters is marked as our reading, never as fact', part('why')?.lines.some((l) => l.note === 'Our reading') === true,
    JSON.stringify(part('why')?.lines.map((l) => l.note)));
  expect('the watch date is readable, and the condition for elevating it is there',
    part('watch')?.lines.some((l) => (l.note ?? '').includes('26 September 2026')) === true &&
      part('watch')?.lines.some((l) => /only if|mechanics|partners|launch path/i.test(l.text)) === true,
    JSON.stringify(part('watch')?.lines));
  expect('what is not yet known is last, and says so plainly',
    part('unconfirmed')?.lines.some((l) => /initiative name|funding|launch date/i.test(l.text)) === true,
    JSON.stringify(part('unconfirmed')?.lines));
  expect('no table name, column name or row id reaches the answer',
    !/research_findings|signal_entities|entity_id|evidence_id|proposal_item|[0-9a-f]{8}-[0-9a-f]{4}-/i.test(rendered),
    rendered.slice(0, 160));
  expect('nothing repeats between sections',
    (() => {
      const lines = (rumesh?.sections ?? []).flatMap((x) => x.lines.map((l) => l.text.toLowerCase().slice(0, 60)));
      return new Set(lines).size === lines.length;
    })(),
    JSON.stringify((rumesh?.sections ?? []).flatMap((x) => x.lines.map((l) => l.text.slice(0, 40)))));
  expect('the first screen stays short: a paragraph and at most three points',
    (rumesh?.lead ?? '').length <= 260 && (part('known')?.lines.length ?? 0) <= 3,
    `${(rumesh?.lead ?? '').length} chars, ${part('known')?.lines.length ?? 0} point(s)`);
  expect('the sources stay traceable under source details',
    (rumesh?.sources.length ?? 0) > 0 && rumesh!.sources.every((x) => x.label.length > 0 && ['Source', 'Research document'].includes(x.kind)),
    JSON.stringify(rumesh?.sources));

  section('16. The live radar shape is trimmed to a decision list, not a database import');
  const beforeLive = await knowledgeCounts(ws);
  const live = await capturing(LIVE_RADAR_NOTE);
  const liveOf = (table: string) => ofTable(live.items, table);
  const liveEntities = liveOf('entities');
  expect('the 11 named actors come down to the 5 subjects the signals are about',
    liveOf('signal_entities').length === 5 &&
      ['Mahmoud Al Jasem Al Mohammad Al Hussein', 'Talah Al Hassan Al Hinide', 'Kim Young-beom', 'Colin Kaepernick'].every((n) => liveEntities.some((i) => i.label === n)) &&
      liveEntities.length === 4,
    `${liveEntities.length} new record(s): ${liveEntities.map((i) => i.label).join(' | ')}`);
  expect('  and a subject already in memory is linked, not created a second time',
    !liveEntities.some((i) => i.label === 'Rumesh Tharanga') && liveOf('signal_entities').some((i) => i.label.includes('Rumesh Tharanga')),
    liveOf('signal_entities').map((i) => i.label.slice(-40)).join(' | '));
  expect('publishers, imprints, platforms, agencies and governing bodies create no records',
    !['World Taekwondo', 'Kaepernick Publishing', 'Legacy Lit', 'Audible', 'CAA', 'OCA'].some((n) => live.items.some((i) => i.label === n)),
    live.items.filter((i) => i.target_table === 'entities').map((i) => i.label).join(' | '));
  expect('signals of equal priority keep the order the document gave them',
    liveOf('signals')[0]!.label.startsWith('Rumesh Tharanga') && liveOf('signals')[1]!.label.startsWith('OCA Refugee Team'),
    liveOf('signals').map((i) => i.label.slice(0, 28)).join(' | '));
  expect('at most four signals and four watch dates', liveOf('signals').length === 4 && liveOf('actions').length === 4,
    `${liveOf('signals').length} signals, ${liveOf('actions').length} watch dates`);
  expect('the lowest-ranked signal and the latest date stay in the document',
    !live.items.some((i) => i.label.includes('fifth signal')) && !live.items.some((i) => i.label.includes('fifth date')));
  const liveDocEarly = await withService((db) =>
    db.oneOrFail<{ source_only: { label: string }[] }>(
      `select output->'document'->'source_only' as source_only from public.run_stages s
         join public.captures c on c.run_id = s.run_id where c.id = $1 and s.stage = 'extract'`,
      [live.capture.id],
    ),
  );
  const liveGaps = liveOf('research_findings').filter((i) => valuesOf(i).finding_type === 'gap');
  const liveRisks = liveOf('research_findings').filter((i) => valuesOf(i).finding_type === 'risk');
  expect('two gaps and one risk, not six unknowns', liveGaps.length === 2 && liveRisks.length === 1,
    `${liveGaps.length} gaps, ${liveRisks.length} risks`);
  expect('one optional hypothesis, not two, and it follows the strongest signal',
    liveOf('opportunities').length === 1 && liveOf('opportunities')[0]!.label.includes('athlete-access platform'),
    liveOf('opportunities').map((i) => i.label).join(' | '));
  expect('  the weaker idea stays in the document instead', liveDocEarly.source_only.some((x) => x.label.includes('Kim Young-beom')),
    liveDocEarly.source_only.map((x) => x.label).join(' | '));

  expect('the whole proposal is a decision list: about 25 items, not 40', live.items.length <= 26 && live.items.length >= 20, `${live.items.length} items`);
  const liveDoc = await withService((db) =>
    db.oneOrFail<{ source_only: { label: string }[]; recommendations: { subject: string }[] }>(
      `select output->'document'->'source_only' as source_only, output->'document'->'research_recommendations' as recommendations
         from public.run_stages s join public.captures c on c.run_id = s.run_id
        where c.id = $1 and s.stage = 'extract'`,
      [live.capture.id],
    ),
  );
  expect('everything trimmed is explicitly kept as source only, never silently dropped',
    ['World Taekwondo', 'Audible', 'CAA', 'Legacy Lit', 'Kaepernick Publishing', 'OCA'].every((n) => liveDoc.source_only.some((x) => x.label === n)) &&
      liveDoc.source_only.some((x) => x.label.includes('fifth signal')) &&
      liveDoc.source_only.some((x) => x.label.includes('fifth date')),
    liveDoc.source_only.map((x) => x.label).join(' | '));
  expect('two research suggestions are kept: one per signal, in the document\'s order',
    liveDoc.recommendations.length === 2 &&
      liveDoc.recommendations[0]!.subject === 'Rumesh Tharanga' &&
      liveDoc.recommendations[1]!.subject === 'OCA Refugee Team',
    liveDoc.recommendations.map((r) => r.subject).join(' | '));
  expect('  a second suggestion about the same story is set aside, not stacked',
    !liveDoc.recommendations.some((r) => r.subject.includes('Mahmoud') || r.subject.includes('Talah')),
    liveDoc.recommendations.map((r) => r.subject).join(' | '));
  expect('and nothing was written by any of it', sameCounts(await knowledgeCounts(ws), beforeLive));

  section('17. Markdown formatting never becomes part of a memory record');
  const formatted = documentProposalFromExtraction({
    extraction: {
      artifact: {
        title: '*A Radar*', artifact_type: 'radar_brief', summary: 'A *formatted* summary.',
        document_date: '2026-09-29', coverage: null, external_use: null, source_urls: [],
      },
      signals: [{
        title: '*The Sideline* gains a new signal', signal_type: 'creative_ip',
        what_changed: 'The project *The Sideline* was named.', why_it_matters: 'It is worth watching.',
        decision_question: null, recommended_next_step: null, promotion_trigger: null,
        priority: 'high', confidence: 'high', original_claim: '*The Sideline* was named.',
        source_facts: [{ statement: '*The Sideline* received funding approval.', about: '*The Sideline*', confidence: 'high' }],
        subjects: [{ name: '*The Sideline*', kind: 'project', role: 'subject' }], source_urls: [],
      }],
      watch_items: [], hypotheses: [], unknowns: [], research_recommendations: [], source_only: [],
    } satisfies DocumentExtraction,
    resolutions: [{ name: '*The Sideline*', kind: 'project', status: 'new', best: null, candidates: [], rationale: 'New name.' }],
    source: { captureId: '00000000-0000-0000-0000-000000000000', kind: 'file', filename: 'radar.md', sourceUrl: null, capturedOn: '2026-09-29' },
    excerpt: '# *A Radar*',
  });
  const formattedEntity = formatted.changes.find((item) => item.target_table === 'entities');
  const formattedFact = formatted.changes.find((item) => item.target_table === 'research_findings');
  expect('project names, record labels and fact titles are plain text',
    formattedEntity?.label === 'The Sideline' &&
      formattedEntity?.fields.find((f) => f.name === 'display_name')?.value === 'The Sideline' &&
      formattedFact?.label.startsWith('The Sideline: The Sideline received funding approval.') === true,
    `${formattedEntity?.label} | ${formattedFact?.label}`);

  section('18. A subject check recovers important names the first draft missed');
  const auditedExtraction = addAuditedSubjects({
    artifact: {
      title: 'Funding radar', artifact_type: 'radar_brief', summary: 'A funding decision.',
      document_date: '2026-09-29', coverage: null, external_use: null, source_urls: [],
    },
    signals: [{
      title: 'The Sideline receives funding approval', signal_type: 'creative_ip',
      what_changed: 'A funder approved a project.', why_it_matters: 'The team should track it.',
      decision_question: null, recommended_next_step: null, promotion_trigger: null,
      priority: 'high', confidence: 'high', original_claim: null, source_facts: [],
      subjects: [{ name: 'The Sideline', kind: 'project', role: 'subject' }], source_urls: [],
    }],
    watch_items: [], hypotheses: [], unknowns: [], research_recommendations: [], source_only: [],
  } satisfies DocumentExtraction, {
    signal_subjects: [
      {
        signal_title: 'The Sideline receives funding approval',
        subjects: [
          { name: 'NFVF', kind: 'organization', role: 'subject', why_relevant: 'It made the funding decision.' },
          { name: 'Ava Director', kind: 'person', role: 'subject', why_relevant: 'She is the named director.' },
        ],
      },
      {
        signal_title: 'A signal that does not exist',
        subjects: [{ name: 'Unrelated name', kind: 'person', role: 'subject', why_relevant: 'Must not be attached.' }],
      },
    ],
  });
  const auditedProposal = documentProposalFromExtraction({
    extraction: auditedExtraction,
    resolutions: [
      { name: 'The Sideline', kind: 'project', status: 'new', best: null, candidates: [], rationale: 'New project.' },
      { name: 'NFVF', kind: 'organization', status: 'new', best: null, candidates: [], rationale: 'New organisation.' },
      { name: 'Ava Director', kind: 'person', status: 'new', best: null, candidates: [], rationale: 'New person.' },
    ],
    source: { captureId: '00000000-0000-0000-0000-000000000001', kind: 'file', filename: 'radar.md', sourceUrl: null, capturedOn: '2026-09-29' },
    excerpt: 'Funding radar',
  });
  const auditedEntities = auditedProposal.changes.filter((item) => item.target_table === 'entities').map((item) => item.label);
  const auditedLinks = auditedProposal.changes.filter((item) => item.target_table === 'signal_entities').map((item) => item.label);
  expect('the audit adds a funder and named talent as records linked to the existing signal',
    ['The Sideline', 'NFVF', 'Ava Director'].every((name) => auditedEntities.includes(name)) &&
      auditedLinks.some((label) => label.includes('NFVF')) && auditedLinks.some((label) => label.includes('Ava Director')),
    `${auditedEntities.join(' | ')} / ${auditedLinks.join(' | ')}`);
  expect('the audit cannot invent a signal or attach a name to one',
    !auditedEntities.includes('Unrelated name'), auditedEntities.join(' | '));

  const balancedSubjects = applyDocumentBudget({
    artifact: {
      title: 'Balanced radar', artifact_type: 'radar_brief', summary: 'Three decision signals.',
      document_date: '2026-09-29', coverage: null, external_use: null, source_urls: [],
    },
    signals: [
      {
        title: 'A funding slate', signal_type: 'creative_ip', what_changed: 'A slate was funded.', why_it_matters: 'Track it.',
        decision_question: null, recommended_next_step: null, promotion_trigger: null, priority: 'high', confidence: 'high',
        original_claim: null, source_facts: [], source_urls: [],
        subjects: [
          { name: 'First Project', kind: 'project', role: 'subject' },
          { name: 'Second Project', kind: 'project', role: 'subject' },
          { name: 'Generic Programme', kind: 'other', role: 'subject' },
        ],
      },
      {
        title: 'A filmmaker signal', signal_type: 'creative_ip', what_changed: 'A filmmaker advanced.', why_it_matters: 'Track them.',
        decision_question: null, recommended_next_step: null, promotion_trigger: null, priority: 'high', confidence: 'high',
        original_claim: null, source_facts: [], source_urls: [],
        subjects: [{ name: 'Later Filmmaker', kind: 'person', role: 'subject' }],
      },
      {
        title: 'A film signal', signal_type: 'creative_ip', what_changed: 'A film advanced.', why_it_matters: 'Track it.',
        decision_question: null, recommended_next_step: null, promotion_trigger: null, priority: 'high', confidence: 'high',
        original_claim: null, source_facts: [], source_urls: [],
        subjects: [{ name: 'Later Film', kind: 'project', role: 'subject' }],
      },
    ],
    watch_items: [], hypotheses: [], unknowns: [], research_recommendations: [], source_only: [],
  } satisfies DocumentExtraction, { signals: 3, watchItems: 0, coreSubjects: 4, gaps: 0, risks: 0, hypotheses: 0, researchRecommendations: 0 });
  const balancedNames = balancedSubjects.extraction.signals.flatMap((signal) => signal.subjects.map((subject) => subject.name));
  expect('every kept signal retains a representative subject before one early slate fills the limit',
    ['First Project', 'Later Filmmaker', 'Later Film'].every((name) => balancedNames.includes(name)) && !balancedNames.includes('Generic Programme'),
    balancedNames.join(' | '));

  const failed = checks.filter((c) => !c.passed);
  console.log(`\n\x1b[1mSummary\x1b[0m\n  ${checks.length - failed.length}/${checks.length} checks passed`);
  for (const c of failed) console.log(`  - ${c.name}`);
  exitCode = failed.length > 0 ? 1 : 0;
} catch (error) {
  console.error(error);
} finally {
  await closePool();
}
process.exit(exitCode);
