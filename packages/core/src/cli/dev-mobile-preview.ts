/**
 * Local-only scenario for previewing the mobile Capture review.
 *
 *   tsx packages/core/src/cli/dev-mobile-preview.ts capture   # submit the Anna note and analyse it
 *   tsx packages/core/src/cli/dev-mobile-preview.ts process   # run queued identity/research steps
 *
 * Talks to a LOCAL web server (MOBILE_API_URL) over the same HTTP API as the app,
 * and runs the analysis in-process with a scripted model: no OpenAI call, no
 * network search, and guardTarget() refuses anything but a local database.
 * Writes the preview session (a local dev token) to PREVIEW_TOKEN_FILE so the
 * mobile web preview can use it; it is never printed.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { CaptureExtraction, ContactIdentity, ContactProfile } from '@g3/shared';
import type { z } from 'zod';
import type { AiProvider, GenerateOptions, StructuredResult } from '../ai/index.js';
import { MockProvider } from '../ai/mock.js';
import { runContactIdentifyPipeline, runContactResearchPipeline } from '../contact-research.js';
import { closePool, withService } from '../db.js';
import { runCapturePipeline } from '../pipelines/capture.js';
import type { PipelineContext } from '../pipelines/context.js';
import { claimRun, completeRun } from '../runs.js';
import { guardTarget } from './guard.js';

export const ANNA_NOTE = 'I met Anna Smith, Head of Drama at Horizon Studios, at Cannes.';

function annaDraft(): CaptureExtraction {
  return {
    title: 'Met Anna Smith at Cannes',
    summary: 'You met Anna Smith, Head of Drama at Horizon Studios, at Cannes.',
    mentions: [
      { name: 'Anna Smith', kind: 'person', context: 'Head of Drama at Horizon Studios' },
      { name: 'Horizon Studios', kind: 'organization', context: null },
      { name: 'Cannes', kind: 'event', context: 'where the writer met Anna Smith' },
    ],
    contacts: [
      { name: 'Anna Smith', how: 'met', organization: 'Horizon Studios', role: 'Head of Drama', email: null, phone: null, linkedin: null, why_it_matters: null },
    ],
    facts: [{ statement: 'Anna Smith is Head of Drama at Horizon Studios.', about: ['Anna Smith', 'Horizon Studios'], confidence: 'high' }],
    inferences: [],
    recommendations: [],
    interactions: [
      { subject: 'Met Anna Smith', summary: 'You met Anna Smith, Head of Drama at Horizon Studios, at Cannes.', interaction_type: 'encounter', occurred_on: null, with_names: ['Anna Smith'] },
    ],
    actions: [],
    relationships: [],
    opportunities: [],
    gaps: [],
  };
}

/**
 * A real radar brief, read from disk for the document scenario. The scripted
 * "model" answers from the document's own structure: no model call is made.
 */
const RADAR_PATH = process.env.RADAR_FILE ?? '';

function radarClassification() {
  return {
    material: 'research_document' as const,
    document_kind: 'radar_brief' as const,
    confidence: 'high' as const,
    description: 'A daily radar brief with 4 signals, 4 watch dates and an exclusions section.',
    reason: 'It is dated, sectioned by signal type, lists forward-watch items and cites sources.',
  };
}

function radarExtraction() {
  return {
    artifact: {
      title: 'AMV Creative Radar — 23 September 2026',
      artifact_type: 'radar_brief' as const,
      summary: 'A daily radar of athlete, story, media and IP signals across North America, the Gulf, Africa and Europe, with a forward-watch window to 23 October 2026.',
      document_date: '2026-09-23',
      coverage: '22–23 September 2026, forward watch to 23 October 2026',
      external_use: 'Internal Only',
      source_urls: ['https://example.test/radar/1', 'https://example.test/radar/2', 'https://example.test/radar/4', 'https://example.test/radar/6'],
    },
    signals: [
      {
        title: 'Rumesh Tharanga turns equipment loss into a wider athlete-support proposition',
        signal_type: 'creative_ip' as const,
        what_changed: 'He declined public financial offers after five javelins were damaged in transit, and asked that support reach other Sri Lankan athletes instead.',
        why_it_matters: 'A competitive moment could become an athlete-led platform with durable national relevance.',
        decision_question: 'Can a competitive moment become an athlete-led platform?',
        recommended_next_step: 'Prepare an Athlete Venture Blueprint hypothesis after his Asian Games campaign.',
        promotion_trigger: 'Concrete mechanics, partners or a launch path.',
        priority: 'medium' as const,
        confidence: 'medium' as const,
        original_claim: 'He asked that the support instead reach other Sri Lankan athletes who struggle to fund essential equipment.',
        subjects: [{ name: 'Rumesh Tharanga', kind: 'person' as const, role: 'subject' as const }],
        source_urls: ['https://example.test/radar/1'],
      },
      {
        title: 'The OCA Refugee Team creates a specific Azraq-to-Asian-Games story world',
        signal_type: 'story' as const,
        what_changed: 'The OCA formally presented two Syrian taekwondo athletes as its first Asian Games refugee team.',
        why_it_matters: 'Two athletes, one camp and a shared discipline make a contained human narrative with international resonance.',
        decision_question: 'Who controls access, and what media commitments already exist?',
        recommended_next_step: 'Conduct deeper story research; no outreach implied.',
        promotion_trigger: null,
        priority: 'medium' as const,
        confidence: 'medium' as const,
        original_claim: 'No documentary, publishing, archive, life-story, likeness or access rights are disclosed.',
        subjects: [
          { name: 'OCA Refugee Team', kind: 'organization' as const, role: 'subject' as const },
          { name: 'Olympic Council of Asia', kind: 'organization' as const, role: 'organisation' as const },
          { name: 'World Taekwondo', kind: 'organization' as const, role: 'mentioned' as const },
        ],
        source_urls: ['https://example.test/radar/2'],
      },
      {
        title: 'Kim Young-beom breaks the Asian Games 50m freestyle record twice in one day',
        signal_type: 'athlete_momentum' as const,
        what_changed: 'He lowered the record to 21.71 in the heats, then 21.66 in the final to win gold.',
        why_it_matters: 'The trajectory shift is real, though no distinctive media or IP proposition is established yet.',
        decision_question: null,
        recommended_next_step: 'Add to the athlete radar and monitor the post-event cycle.',
        promotion_trigger: 'A distinctive media or IP proposition.',
        priority: 'low' as const,
        confidence: 'high' as const,
        original_claim: 'The current evidence does not yet establish a distinctive media or IP proposition.',
        subjects: [{ name: 'Kim Young-beom', kind: 'person' as const, role: 'subject' as const }],
        source_urls: ['https://example.test/radar/4'],
      },
      {
        title: 'Colin Kaepernick’s memoir arrives as an integrated owned-media asset',
        signal_type: 'creative_ip' as const,
        what_changed: 'His own imprint announced the book, Legacy Lit holds publication rights, and he narrates the Audible edition.',
        why_it_matters: 'It shows how a book, an imprint and audio extend one owned-media system.',
        decision_question: null,
        recommended_next_step: 'Track how the tour and audio format extend the wider system.',
        promotion_trigger: null,
        priority: 'low' as const,
        confidence: 'high' as const,
        original_claim: 'Legacy Lit holds publication rights and he narrates the Audible edition.',
        subjects: [
          { name: 'Colin Kaepernick', kind: 'person' as const, role: 'subject' as const },
          { name: 'The Perilous Fight', kind: 'project' as const, role: 'mentioned' as const },
          { name: 'Kaepernick Publishing', kind: 'organization' as const, role: 'organisation' as const },
          { name: 'Legacy Lit', kind: 'organization' as const, role: 'organisation' as const },
          { name: 'Audible', kind: 'organization' as const, role: 'mentioned' as const },
          { name: 'CAA', kind: 'organization' as const, role: 'mentioned' as const },
        ],
        source_urls: ['https://example.test/radar/6'],
      },
    ],
    watch_items: [
      { title: 'A fifth date the budget keeps in the document', trigger_date: '2026-10-20', why_it_matters: 'Later than the window.', promotion_condition: null, about: null, priority: 'low' as const },
      { title: 'Rumesh Tharanga / Asian Games javelin', trigger_date: '2026-09-26', why_it_matters: 'Performance and interviews may clarify whether the proposed initiative has durable intent.', promotion_condition: 'Concrete mechanics, partners or a launch path.', about: 'Rumesh Tharanga', priority: 'medium' as const },
      { title: 'Mick Fanning / All Heart', trigger_date: '2026-09-29', why_it_matters: 'A memoir joining elite performance, bereavement and entrepreneurship in one athlete-authored asset.', promotion_condition: 'New source material, owned extensions or adaptation intent.', about: null, priority: 'low' as const },
      { title: 'The Match / Haifa International Film Festival', trigger_date: '2026-09-26', why_it_matters: 'Rare archive and testimony connecting the 1986 match with the Falklands/Malvinas conflict.', promotion_condition: 'A new distribution, sales or rights signal; selection alone is insufficient.', about: null, priority: 'low' as const },
      { title: 'SPORTFILM Liberec', trigger_date: '2026-09-30', why_it_matters: 'A concentrated European discovery point for sports films and creators.', promotion_condition: 'A specific athlete, project or creator with verified credits.', about: null, priority: 'low' as const },
    ],
    hypotheses: [
      {
        title: "Test Kim Young-beom's high-performance and personality narrative",
        description: 'A personality-led format could follow the record.',
        about: 'Kim Young-beom',
        from_signal: 'Kim Young-beom breaks the Asian Games 50m freestyle record twice in one day',
      },
      {
        title: 'Convert a performance peak into a national athlete-access platform',
        description: 'An athlete-led equipment and access platform could follow his Asian Games campaign.',
        about: 'Rumesh Tharanga',
        from_signal: 'Rumesh Tharanga turns equipment loss into a wider athlete-support proposition',
      },
    ],
    unknowns: [
      { kind: 'gap' as const, statement: 'No initiative name, entity, funding model, sponsor, format, ownership or launch date is confirmed', why_it_matters: 'Without mechanics there is nothing to attach a decision to.', about: 'Rumesh Tharanga' },
      { kind: 'risk' as const, statement: 'Athlete safeguarding, consent and trauma-informed development require verification', why_it_matters: 'Refugee athletes need care before any approach or development work.', about: 'OCA Refugee Team' },
      { kind: 'gap' as const, statement: 'Rights availability, representation and existing media commitments are unconfirmed', why_it_matters: 'Nothing can be developed without knowing who holds the rights.', about: 'OCA Refugee Team' },
      { kind: 'risk' as const, statement: 'Delivery capacity, partners and governance for the proposed initiative are unproven', why_it_matters: 'Acting early could expose us reputationally.', about: 'Rumesh Tharanga' },
      { kind: 'gap' as const, statement: "For Colin Kaepernick's memoir, adaptation rights are unconfirmed", why_it_matters: 'Rights are unknown.', about: 'Colin Kaepernick' },
    ],
    research_recommendations: [
      { subject: 'Rumesh Tharanga', kind: 'person' as const, why: 'To learn whether the proposed initiative has mechanics, partners or governance behind it.' },
      { subject: 'OCA Refugee Team', kind: 'organization' as const, why: 'To find who controls access and what media commitments already exist.' },
      { subject: 'Kim Young-beom', kind: 'person' as const, why: 'Background.' },
      { subject: 'Colin Kaepernick', kind: 'person' as const, why: 'Background.' },
    ],
    source_only: [
      { label: 'Routine heat results and standings', why: 'Nothing here changes a decision.' },
      { label: 'Material exclusions listed by the radar', why: 'The document already excluded them.' },
      { label: 'Festival programmes without a named subject', why: 'Kept as context; the dates are on the watch list.' },
    ],
  };
}

export const MEMBER_NOTE = 'Spoke to Natan Bogin today about the Q4 plan.';
export const UNKNOWN_NOTE = 'I met Priya Raman at the airport today.';

function simpleDraft(name: string, how: 'met' | 'spoke', title: string, summary: string, type: 'encounter' | 'conversation'): CaptureExtraction {
  return {
    title,
    summary,
    mentions: [{ name, kind: 'person', context: null }],
    contacts: [{ name, how, organization: null, role: null, email: null, phone: null, linkedin: null, why_it_matters: null }],
    facts: [],
    inferences: [],
    recommendations: [],
    interactions: [{ subject: title, summary, interaction_type: type, occurred_on: null, with_names: [name] }],
    actions: [],
    relationships: [],
    opportunities: [],
    gaps: [],
  };
}

export const TOM_NOTE = 'Met Tom Reyes, Head of Acquisitions at Blue Harbour Films, at MIPCOM. He wants the New Foundation deck by Friday.';

function tomDraft(): CaptureExtraction {
  return {
    title: 'Met Tom Reyes at MIPCOM',
    summary: 'You met Tom Reyes, Head of Acquisitions at Blue Harbour Films, at MIPCOM.',
    mentions: [
      { name: 'Tom Reyes', kind: 'person', context: 'Head of Acquisitions at Blue Harbour Films' },
      { name: 'Blue Harbour Films', kind: 'organization', context: null },
      { name: 'MIPCOM', kind: 'event', context: null },
      { name: 'New Foundation', kind: 'project', context: null },
    ],
    contacts: [
      { name: 'Tom Reyes', how: 'met', organization: 'Blue Harbour Films', role: 'Head of Acquisitions', email: null, phone: null, linkedin: null, why_it_matters: 'Wants the New Foundation deck.' },
    ],
    facts: [{ statement: 'Tom Reyes wants the New Foundation deck by Friday.', about: ['Tom Reyes', 'New Foundation'], confidence: 'high' }],
    inferences: [],
    recommendations: [],
    interactions: [
      { subject: 'Met Tom Reyes', summary: 'You met Tom Reyes, Head of Acquisitions at Blue Harbour Films, at MIPCOM.', interaction_type: 'encounter', occurred_on: null, with_names: ['Tom Reyes'] },
    ],
    actions: [{ title: 'Send the New Foundation deck to Tom Reyes', description: 'He asked for it by Friday.', due_on: null, related_names: ['Tom Reyes', 'New Foundation'] }],
    relationships: [
      { person: 'Tom Reyes', organization: 'Blue Harbour Films', role: 'Head of Acquisitions', statement: 'Tom Reyes is Head of Acquisitions at Blue Harbour Films.', claim: 'fact' },
    ],
    opportunities: [],
    gaps: [],
  };
}

const src = (url: string, title: string | null = null) => ({ url, title });

function identity(): ContactIdentity {
  return {
    candidates: [
      {
        name: 'Anna Smith',
        organization: 'Horizon Studios',
        role: 'Head of Drama',
        location: 'London',
        explanation: 'Listed as Head of Drama on the Horizon Studios team page, and among Cannes market attendees.',
        matches_clues: ['Horizon Studios', 'Head of Drama', 'Cannes'],
        conflicts_with_clues: [],
        confidence: 'high',
        sources: [src('https://example.test/horizon/team', 'Horizon Studios — Team')],
      },
      {
        name: 'Anna Smith',
        organization: 'Smith & Co Accountants',
        role: 'Partner',
        location: 'Leeds',
        explanation: 'Shares only the name.',
        matches_clues: [],
        conflicts_with_clues: ['Not at Horizon Studios'],
        confidence: 'low',
        sources: [src('https://example.test/smith-co')],
      },
    ],
    reliable_match_found: true,
    note: 'Searched with the organisation, role and event you kept.',
  };
}

function profile(): ContactProfile {
  return {
    facts: [
      { statement: 'Anna Smith has led drama development at Horizon Studios since 2024.', sources: [src('https://example.test/horizon/team')] },
      { statement: 'Horizon Studios announced two European co-productions in 2026.', sources: [src('https://example.test/horizon/news')] },
    ],
    inferences: [
      { statement: 'Anna Smith is likely looking for European co-production partners.', based_on: 'the 2026 co-production announcements', sources: [src('https://example.test/horizon/news')] },
    ],
    recommendations: [{ statement: 'Mention your European co-production experience when you follow up.', rationale: 'It matches what Horizon Studios is doing now.' }],
    gaps: [],
    affiliations: [{ organization: 'Horizon Studios', role: 'Head of Drama', current: true, claim: 'fact', sources: [src('https://example.test/horizon/team')] }],
    public_profiles: [{ kind: 'linkedin', url: 'https://www.linkedin.com/in/anna-smith-example' }],
  };
}

/** The mock provider, with scripted answers for this one scenario. */
class ScriptedProvider extends MockProvider {
  override async generateStructured<T>(options: GenerateOptions & { schema: z.ZodType<T>; schemaName: string }): Promise<StructuredResult<T>> {
    const value =
      options.schemaName === 'capture_classification'
        ? options.input.includes('Creative Radar')
          ? radarClassification()
          : { material: 'relationship_note', document_kind: null, confidence: 'high', description: 'A note about someone you were in contact with.', reason: 'It describes a personal contact.' }
        : options.schemaName === 'document_extraction'
          ? radarExtraction()
          : options.schemaName === 'capture_extraction' && options.input.includes('Anna Smith, Head of Drama at Horizon Studios')
        ? annaDraft()
        : options.schemaName === 'capture_extraction' && options.input.includes(MEMBER_NOTE)
          ? simpleDraft('Natan Bogin', 'spoke', 'Spoke to Natan Bogin', 'You spoke to Natan Bogin about the Q4 plan.', 'conversation')
          : options.schemaName === 'capture_extraction' && options.input.includes(UNKNOWN_NOTE)
            ? simpleDraft('Priya Raman', 'met', 'Met Priya Raman', 'You met Priya Raman at the airport today.', 'encounter')
          : options.schemaName === 'capture_extraction' && options.input.includes(TOM_NOTE)
          ? tomDraft()
        : options.schemaName === 'contact_identity'
          ? options.input.includes('Priya Raman')
            ? { candidates: [], reliable_match_found: false, note: 'The note gives only a name, so nobody can be matched with confidence.' }
            : identity()
          : options.schemaName === 'contact_profile'
            ? profile()
            : null;
    if (value === null) return super.generateStructured(options);
    return {
      value: options.schema.parse(value),
      usage: { model: 'scripted-preview', tokensIn: 1, tokensOut: 1, reasoningTokens: 0, cachedTokens: 0, webSearches: 0, durationMs: 1, usageIsEstimated: true },
      sources: [],
      raw: { scripted: true },
    };
  }
}

const provider: AiProvider = new ScriptedProvider();
const api = process.env.MOBILE_API_URL ?? 'http://127.0.0.1:3100';

async function post(path: string, init: { token?: string; json?: unknown; form?: FormData }) {
  const response = await fetch(`${api}${path}`, {
    method: 'POST',
    headers: {
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      ...(init.json !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: init.form ?? (init.json !== undefined ? JSON.stringify(init.json) : undefined),
  });
  const body = (await response.json().catch(() => null)) as any;
  if (!response.ok) throw new Error(`${path} -> ${response.status} ${body?.error ?? ''}`);
  return body;
}

async function run(runId: string, workspaceId: string, step: (ctx: PipelineContext) => Promise<unknown>) {
  const claimed = await claimRun(runId, 'mobile-preview', 120);
  if (!claimed) return;
  await step({ run: claimed, workspaceId, provider, keepAlive: async () => undefined });
  await completeRun(workspaceId, runId);
}

async function capture(note: string) {
  const session = await post('/api/mobile/session', {
    json: { email: process.env.SEED_ADMIN_EMAIL, password: process.env.SEED_ADMIN_PASSWORD },
  });
  if (process.env.PREVIEW_TOKEN_FILE) writeFileSync(process.env.PREVIEW_TOKEN_FILE, session.accessToken, { mode: 0o600 });
  const form = new FormData();
  form.append('text', note);
  const created = await post('/api/captures', { token: session.accessToken, form });
  const row = await withService((db) =>
    db.oneOrFail<{ run_id: string; workspace_id: string }>(`select run_id, workspace_id from public.captures where id = $1`, [created.captureId]),
  );
  await run(row.run_id, row.workspace_id, runCapturePipeline);
  const proposal = await withService((db) =>
    db.oneOrFail<{ proposal_id: string }>(`select proposal_id from public.captures where id = $1`, [created.captureId]),
  );
  console.log(`Capture analysed. Proposal ${proposal.proposal_id}`);
}

async function processResearch() {
  const queued = await withService((db) =>
    db.rows<{ id: string; kind: string; workspace_id: string }>(
      `select id, kind, workspace_id from public.runs where status = 'queued' and kind in ('contact_identify', 'contact_research') order by created_at`,
    ),
  );
  for (const job of queued) {
    await run(job.id, job.workspace_id, job.kind === 'contact_identify' ? runContactIdentifyPipeline : runContactResearchPipeline);
  }
  console.log(`Processed ${queued.length} research step(s).`);
}

const target = await guardTarget('dev-mobile-preview');
if (target.kind !== 'local') throw new Error('The mobile preview scenario runs against a local database only.');
try {
  const command = process.argv[2];
  if (command === 'radar') {
    if (!RADAR_PATH) throw new Error('Set RADAR_FILE to the radar document to capture.');
    await capture(`${readFileSync(RADAR_PATH, 'utf8').slice(0, 40_000)}${process.env.RADAR_SUFFIX ? `\n\n<!-- ${process.env.RADAR_SUFFIX} -->` : ''}`);
  } else if (command === 'member') {
    await withService((db) =>
      db.query(
        `insert into public.members (workspace_id, full_name, slug, role_title, status)
         select w.id, 'Natan Bogin', 'natan-bogin', 'Founder & CEO', 'active' from public.workspaces w
          where not exists (select 1 from public.members m where m.workspace_id = w.id and m.slug = 'natan-bogin')`,
      ),
    );
    await capture(MEMBER_NOTE);
  } else if (command === 'capture')
    await capture(
      process.argv[3] === 'tom'
        ? TOM_NOTE
        : process.argv[3] === 'unknown'
          ? UNKNOWN_NOTE
          : process.argv[3] === 'again'
            ? `${ANNA_NOTE} (second example)`
            : ANNA_NOTE,
    );
  else if (command === 'process') await processResearch();
  else throw new Error('Use "capture" or "process"');
} finally {
  await closePool();
}
