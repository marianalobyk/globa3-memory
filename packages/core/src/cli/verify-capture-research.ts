#!/usr/bin/env tsx
/**
 * Capture-originated research: what must be refused, and refused before
 * anything happens.
 *
 *   npm run verify:capture-research
 *
 * Requires an isolated, migrated database in DATABASE_URL. Never production.
 *
 * The property under test is not "does it validate" but "does a rejected
 * request leave the world untouched". Every case below asserts the refusal AND
 * that no run was created, because a validator that throws after queueing work
 * is worse than none: the person sees an error and a search happens anyway.
 */
import { randomUUID } from 'node:crypto';
import { withService } from '../db.js';
import { seedWorkspace, seedAdditionalWorkspace } from '../seed.js';
import { validateCaptureResearchRequest } from '../topic-research.js';
import { buildCaptureResearchContext, renderCaptureResearchContext, CONTEXT_BUDGET } from '../capture-research-context.js';
import { runResearchPipeline } from '../pipelines/research.js';
import { createRun, claimRun, failRun, completeRun } from '../runs.js';
import { requestTopicResearch } from '../topic-research.js';
import { recordApproval, decideProposalItems, getProposal } from '../proposals.js';
import { applyApprovedItems } from '../apply.js';
import { loadWorkspaceAccess } from '../auth.js';
import { withOwner } from '../db.js';
import type { Session } from '@g3/shared';
import type { AiProvider } from '../ai/index.js';
import { closePool } from '../db.js';
import { isAppError } from '../errors.js';

const checks: { name: string; passed: boolean }[] = [];
const expect = (name: string, passed: boolean, detail = '') => {
  checks.push({ name, passed });
  console.log(`  ${passed ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}`);
  if (detail && !passed) console.log(`        ${detail}`);
};
const section = (t: string) => console.log(`\n\x1b[1m${t}\x1b[0m`);

/** Runs a request that must fail, and reports why. */
async function refused(
  name: string,
  request: { workspaceId: string; proposalId: string; topicIds: string[] },
  expectedFragment: string,
  runsBefore: number,
) {
  let message = '(it did NOT throw)';
  let threw = false;
  try {
    await validateCaptureResearchRequest(request);
  } catch (error) {
    threw = true;
    message = isAppError(error) ? error.message : String(error);
  }
  const runsAfter = await countRuns(request.workspaceId);
  expect(name, threw && message.toLowerCase().includes(expectedFragment.toLowerCase()), message);
  expect(`  ...and no run was created`, runsAfter === runsBefore, `${runsBefore} -> ${runsAfter}`);
}

const MEMORY_TABLES = ['entities', 'evidence', 'research_findings', 'signals', 'actions', 'opportunities', 'entity_affiliations', 'research_finding_evidence'] as const;
const memoryCounts = (workspaceId: string) =>
  withService(async (db) => {
    const out: Record<string, number> = {};
    for (const table of MEMORY_TABLES) {
      out[table] = (await db.oneOrFail<{ n: number }>(`select count(*)::int as n from public.${table} where workspace_id = $1`, [workspaceId])).n;
    }
    return out;
  });
const proposalCount = (workspaceId: string) =>
  withService(async (db) =>
    (await db.oneOrFail<{ n: number }>(`select count(*)::int as n from public.proposals where workspace_id = $1`, [workspaceId])).n,
  );

async function buildSession(email: string, workspaceId: string): Promise<Session> {
  const user = await withOwner((db) =>
    db.oneOrFail<{ id: string; email: string; display_name: string | null }>(
      `select id, email, display_name from public.app_users where email = $1`, [email]),
  );
  const workspaces = await loadWorkspaceAccess(user.id);
  const active = workspaces.find((w) => w.workspaceId === workspaceId) ?? workspaces[0]!;
  return { user: { id: user.id, email: user.email, displayName: user.display_name }, workspaces, activeWorkspace: active, isDevAuth: true };
}

const countRuns = (workspaceId: string) =>
  withService(async (db) =>
    (await db.oneOrFail<{ n: number }>(`select count(*)::int as n from public.runs where workspace_id = $1`, [workspaceId])).n,
  );


// ---------------------------------------------------------------------------
// A deterministic research result.
//
// The mock provider returns a profile with no sources at all, so the success
// path -- sources becoming items, citations getting roles, a child proposal
// appearing -- was never exercised by anything. This fixture stands in for the
// model and returns the same result every time: one topic, one matched entity,
// one source-backed fact attributed to a named primary, one labelled
// interpretation, one open gap, and three real-looking pages.
//
// Nothing is invented beyond what is written here. The proposal it returns is
// the shape the pipeline would receive from a model that followed its
// instructions, so what this proves is that the pipeline carries a correct
// result through to a reviewable child proposal without losing or inventing
// anything.
// ---------------------------------------------------------------------------
const SOURCES = [
  { url: 'https://variety.example/rights-report', title: 'Rights report', publisher: 'Variety', role: 'primary' as const },
  { url: 'https://deadline.example/slate-note', title: 'Slate note', publisher: 'Deadline', role: 'supporting' as const },
  { url: 'https://screendaily.example/market-wrap', title: 'Market wrap', publisher: 'Screen Daily', role: 'supporting' as const },
];
const FACT = 'Anna Smith holds worldwide format rights to the series.';
const INTERPRETATION = 'She is likely to want a Gulf co-production partner before the next market.';
const GAP = 'Whether the festival slot is contractually confirmed is not stated anywhere.';

const usage = {
  model: 'scripted', tokensIn: 10, tokensOut: 10, reasoningTokens: 0, cachedTokens: 0,
  webSearches: 3, durationMs: 1, estimated: true,
} as never;

function scriptedResearchProvider(): AiProvider {
  const deepReport = [
    `# ${FACT}`,
    ...SOURCES.map((s) => `- ${s.title} (${s.publisher}): ${s.url}`),
    `Interpretation: ${INTERPRETATION}`,
    `Gap: ${GAP}`,
  ].join('\n');

  return {
    kind: 'mock',
    isMock: false,
    startBackgroundResearch: async () => ({ responseId: 'scripted-1', status: 'completed' as never }),
    pollBackgroundResearch: async () => ({
      status: 'completed' as never,
      text: deepReport,
      usage,
      sources: SOURCES.map((s) => ({ url: s.url, title: s.title })) as never,
      error: null,
    }),
    cancelBackgroundResearch: async () => undefined,
    generateText: async () => ({ text: deepReport, usage, sources: [] }) as never,
    generateStructured: async ({ schemaName }: { schemaName: string }) => {
      if (schemaName === 'deep_research_result') {
        return {
          value: {
            topic_label: 'Who owns the format rights?',
            summary: 'Rights and slate position for Anna Smith.',
            brief_claim_assessment: 'confirmed',
            facts: [{ statement: FACT, as_of_date: '2026-09-01', confidence: 'high', source_urls: SOURCES.map((s) => s.url) }],
            inferences: [{ statement: INTERPRETATION, based_on: 'Her slate note mentions market timing.', confidence: 'low' }],
            recommendations: [],
            risks: [],
            gaps: [{ question: GAP, why_it_matters: 'It decides whether a deal can be structured.' }],
            controller_or_decision_makers: [],
            entities: [],
            sources: SOURCES.map((s) => ({
              url: s.url, title: s.title, publisher: s.publisher,
              source_tier: 'tier2_independent', published_date: '2026-09-01', event_date: null,
            })),
            confidence: 'high',
            depth_standard_met: true,
            depth_note: 'Three independent sources.',
          },
          usage, sources: [], raw: {},
        } as never;
      }
      if (schemaName === 'research_proposal_output') {
        const primary = SOURCES.find((s) => s.role === 'primary')!;
        return {
          value: {
            title: 'Research: format rights',
            summary: 'What public sources say about the format rights.',
            sources: SOURCES.map((s) => ({ url: s.url, title: s.title, publisher: s.publisher, published_date: '2026-09-01' })),
            facts: [{ statement: FACT, source_urls: SOURCES.map((s) => s.url), origin_url: primary.url, confidence: 'high' }],
            interpretations: [{ statement: INTERPRETATION, based_on: 'Her slate note mentions market timing.', confidence: 'low', source_urls: [] }],
            recommendations: [],
            gaps: [{ question: GAP, why_it_matters: 'It decides whether a deal can be structured.' }],
            risks: [],
          },
          usage, sources: [], raw: {},
        } as never;
      }
      throw new Error(`scripted provider has no fixture for "${schemaName}"`);
    },
  } as unknown as AiProvider;
}

console.log('\x1b[1mCapture-originated research: validation\x1b[0m');

const seeded = await seedWorkspace({
  adminEmail: 'cr-admin@example.test',
  adminPassword: 'cr-admin-password',
  clientEmail: 'cr-client@example.test',
  clientPassword: 'cr-client-password',
});
const ws = seeded.workspaceId;
const other = await seedAdditionalWorkspace('cr-other', 'Other', 'cr-other@example.test', 'cr-other-password');

/** A capture proposal with two research questions saved from it. */
async function makeProposal(workspaceId: string, status = 'pending_review') {
  return withService(async (db) => {
    const proposal = await db.oneOrFail<{ id: string }>(
      `insert into public.proposals (workspace_id, source_kind, title, content_hash, status)
       values ($1, 'capture', 'A capture', $2, $3) returning id`,
      [workspaceId, randomUUID(), status],
    );
    const actor = await db.oneOrFail<{ id: string }>(`select id from public.app_users limit 1`);
    const topics: string[] = [];
    let seq = 0;
    for (const label of ['Who owns the format rights?', 'Is the festival slot confirmed?']) {
      seq += 1;
      const topic = await db.oneOrFail<{ id: string }>(
        `insert into public.research_topics (workspace_id, label, research_question, why_useful, target_type, priority, status)
         values ($1, $2, $2, 'It decides whether a deal is possible.', 'topic', 'medium', 'proposed') returning id`,
        [workspaceId, label],
      );
      // The question as the person saw it, and the record of it being saved --
      // the pair the validator uses to prove it came from this capture.
      const item = await db.oneOrFail<{ id: string }>(
        `insert into public.proposal_items (workspace_id, proposal_id, seq, op, target_table, label, new_values)
         values ($1,$2,$3,'create','research_topics',$4,'{}'::jsonb) returning id`,
        [workspaceId, proposal.id, seq, label],
      );
      await db.query(
        `insert into public.applied_changes
           (workspace_id, proposal_id, proposal_item_id, table_name, row_id, op, after_values, readback_values, applied_by)
         values ($1,$2,$3,'research_topics',$4,'create','{}'::jsonb,'{}'::jsonb,$5)`,
        [workspaceId, proposal.id, item.id, topic.id, actor.id],
      );
      topics.push(topic.id);
    }
    // The rest of what a capture proposes, so the context builder has material.
    const extra: [string, string, Record<string, unknown>][] = [
      ['evidence', 'Your captured note', { title: 'Your captured note', source_type: 'note', excerpt: 'Anna Smith holds the format rights and the festival slot is unconfirmed. '.repeat(60) }],
      ['entities', 'Anna Smith', { display_name: 'Anna Smith', entity_type: 'person' }],
      ['entities', 'Unrelated Person', { display_name: 'Unrelated Person', entity_type: 'person' }],
      ['entity_mentions', 'A name nobody placed', { mention_text: 'A name nobody placed', proposed_entity_type: 'person' }],
      ['signals', 'Format rights are moving', { title: 'Format rights are moving', why_it_matters: 'It decides whether a deal is possible.' }],
      ['signals', 'Something about catering', { title: 'Something about catering', why_it_matters: 'Routine.' }],
      ['research_findings', 'The slot is unconfirmed', { title: 'The slot is unconfirmed', finding_type: 'gap' }],
      ['actions', 'Check the festival deadline', { title: 'Check the festival deadline', due_at: '2026-11-01' }],
    ];
    for (const [table, label, values] of extra) {
      seq += 1;
      await db.query(
        `insert into public.proposal_items (workspace_id, proposal_id, seq, op, target_table, label, new_values)
         values ($1,$2,$3,'create',$4,$5,$6::jsonb)`,
        [workspaceId, proposal.id, seq, table, label, JSON.stringify(values)],
      );
    }
    return { proposalId: proposal.id, topics };
  });
}

let exitCode = 1;
try {
  const own = await makeProposal(ws);
  const foreign = await makeProposal(other.workspaceId);
  const before = await countRuns(ws);

  section('1. A request that names nothing');
  await refused('an empty selection is refused', { workspaceId: ws, proposalId: own.proposalId, topicIds: [] }, 'at least one', before);

  section('2. A request that names the same question twice');
  await refused('a duplicated question is refused',
    { workspaceId: ws, proposalId: own.proposalId, topicIds: [own.topics[0]!, own.topics[0]!] }, 'twice', before);

  section('3. A proposal that is not this workspace’s');
  await refused('another workspace’s capture is refused, and not distinguished from one that never existed',
    { workspaceId: ws, proposalId: foreign.proposalId, topicIds: [foreign.topics[0]!] }, 'no longer exists', before);

  section('4. A question that belongs to a different capture');
  await refused('a question from another capture is refused',
    { workspaceId: other.workspaceId, proposalId: foreign.proposalId, topicIds: [own.topics[0]!] }, 'saved from this capture', before);

  section('5. A question that does not exist at all');
  await refused('an unknown id is refused', { workspaceId: ws, proposalId: own.proposalId, topicIds: [randomUUID()] }, 'saved from this capture', before);

  section('6. A capture that has been read again, or discarded');
  const superseded = await makeProposal(ws, 'superseded');
  await refused('a superseded capture is refused',
    { workspaceId: ws, proposalId: superseded.proposalId, topicIds: [superseded.topics[0]!] }, 'read again', before);
  const rejectedProposal = await makeProposal(ws, 'rejected');
  await refused('a discarded capture is refused',
    { workspaceId: ws, proposalId: rejectedProposal.proposalId, topicIds: [rejectedProposal.topics[0]!] }, 'discarded', before);

  section('7. A question that has already been researched');
  const done = await makeProposal(ws);
  await withService((db) =>
    db.query(`update public.research_topics set status = 'researched' where workspace_id = $1 and id = any($2::uuid[])`, [ws, done.topics]),
  );
  await refused('an already-researched question is refused',
    { workspaceId: ws, proposalId: done.proposalId, topicIds: done.topics }, 'already started', before);

  section('8. A valid request passes, and says exactly what it will research');
  const ok = await validateCaptureResearchRequest({ workspaceId: ws, proposalId: own.proposalId, topicIds: own.topics });
  expect('both questions are accepted', ok.questions.length === 2, JSON.stringify(ok.questions.map((q) => q.question)));
  expect('each carries its question and why it matters',
    ok.questions.every((q) => q.question.length > 0 && (q.whyItMatters ?? '').length > 0),
    JSON.stringify(ok.questions.map((q) => ({ q: q.question, why: q.whyItMatters }))));
  expect('and validating still created no run', (await countRuns(ws)) === before);

  section('9. A run already in flight blocks a second');
  const runId = await withService(async (db) =>
    (
      await db.oneOrFail<{ id: string }>(
        `insert into public.runs (workspace_id, kind, status, input, idempotency_key, is_mock)
         values ($1,'research','running',$2::jsonb,$3,true) returning id`,
        [ws, JSON.stringify({ kind: 'capture_proposal', proposalId: own.proposalId, topicIds: own.topics }), `t-${randomUUID()}`],
      )
    ).id,
  );
  const withRun = await countRuns(ws);
  await refused('a repeat request while research is running is refused',
    { workspaceId: ws, proposalId: own.proposalId, topicIds: own.topics }, 'already running', withRun);
  await withService((db) => db.query(`update public.runs set status = 'succeeded' where id = $1`, [runId]));

  section('10. The parent link cannot cross workspaces');
  let crossed = false;
  try {
    await withService((db) =>
      db.query(
        `insert into public.proposals (workspace_id, source_kind, title, content_hash, parent_proposal_id)
         values ($1,'research','Child',$2,$3)`,
        [other.workspaceId, randomUUID(), own.proposalId],
      ),
    );
    crossed = true;
  } catch {
    /* expected */
  }
  expect('a research result cannot name a parent in another workspace', !crossed);

  section('11. The context sent for research is relevant, bounded and scoped');
  {
    const questions = ok.questions.map((q) => ({ id: q.id, question: q.question, whyItMatters: q.whyItMatters, subject: q.subject }));
    const context = await withService((db) => buildCaptureResearchContext(db, ws, own.proposalId, questions));

    expect('it carries the capture, its questions and its source',
      context.title.length > 0 && context.questions.length === 2 && context.source !== null,
      JSON.stringify({ title: context.title, questions: context.questions.length, source: context.source }));
    expect('the question that matters most is ranked first',
      context.signals[0]?.title === 'Format rights are moving',
      JSON.stringify(context.signals.map((x) => x.title)));
    expect('an unresolved name is offered as unresolved, not as a record',
      context.subjects.some((x) => x.name === 'A name nobody placed' && !x.resolved),
      JSON.stringify(context.subjects));
    expect('the capture excerpt is truncated to the budget',
      (context.excerpt?.length ?? 0) === CONTEXT_BUDGET.excerptChars,
      String(context.excerpt?.length));
    expect('and what was left out is stated rather than hidden',
      context.omitted.some((x) => x.includes('characters of the capture')), JSON.stringify(context.omitted));

    // The point of the whole module: another capture's material is unreachable.
    const rendered = renderCaptureResearchContext(context);
    let crossWorkspace = 'it returned a context';
    try {
      await withService((db) => buildCaptureResearchContext(db, ws, foreign.proposalId, questions));
    } catch (error) {
      crossWorkspace = error instanceof Error ? error.message : String(error);
    }
    expect('a capture belonging to another workspace cannot be used as context at all',
      crossWorkspace !== 'it returned a context', crossWorkspace);
    // And the material genuinely came from THIS capture, not a shared pool.
    expect('the context is drawn from this capture and no other',
      context.subjects.some((x) => x.name === 'Anna Smith') && context.signals.some((x) => x.title === 'Format rights are moving'),
      JSON.stringify({ subjects: context.subjects.map((x) => x.name), signals: context.signals.map((x) => x.title) }));
    expect('the rendered brief names no table, column or id',
      !/proposal_items|research_findings|entity_mentions|workspace_id|[0-9a-f]{8}-[0-9a-f]{4}-/i.test(rendered),
      rendered.slice(0, 200));
    expect('every list stays within its cap',
      context.signals.length <= CONTEXT_BUDGET.signals &&
        context.subjects.length <= CONTEXT_BUDGET.subjects &&
        context.findings.length <= CONTEXT_BUDGET.findings,
      JSON.stringify({ signals: context.signals.length, subjects: context.subjects.length, findings: context.findings.length }));
  }

  section('12. A failed research run leaves nothing behind');
  {
    const memoryBefore = await memoryCounts(ws);
    const proposalsBefore = await proposalCount(ws);
    const failing: AiProvider = {
      isMock: false,
      generateStructured: async () => { throw new Error('research provider unavailable'); },
      generateText: async () => { throw new Error('research provider unavailable'); },
    } as unknown as AiProvider;

    const created = await createRun({
      session: await buildSession('cr-admin@example.test', ws),
      workspaceId: ws,
      kind: 'research',
      input: { kind: 'capture_proposal', proposalId: own.proposalId, topicIds: own.topics },
      idempotencyKey: `readiness-fail-${randomUUID()}`,
      isMock: false,
    });
    const claimed = await claimRun(created.run.id, 'readiness-gate', 120);
    let failed = false;
    let message = '';
    try {
      await runResearchPipeline({ run: claimed!, workspaceId: ws, provider: failing, keepAlive: async () => undefined });
    } catch (error) {
      failed = true;
      message = error instanceof Error ? error.message : String(error);
      await failRun(ws, created.run.id, error, claimed!.current_stage);
    }
    expect('the run fails rather than hanging or half-finishing', failed, message);

    const status = await withService((db) =>
      db.oneOrFail<{ status: string; error: string | null }>(
        `select status, error from public.runs where workspace_id = $1 and id = $2`, [ws, created.run.id]),
    );
    expect('it ends in an explicit failed or retrying state, with a diagnostic',
      ['failed', 'queued', 'retrying'].includes(status.status) && Boolean(status.error),
      JSON.stringify(status));
    expect('NO child proposal was left pending', (await proposalCount(ws)) === proposalsBefore,
      `${proposalsBefore} -> ${await proposalCount(ws)}`);
    expect('NO researched record reached memory', JSON.stringify(await memoryCounts(ws)) === JSON.stringify(memoryBefore),
      JSON.stringify({ before: memoryBefore, after: await memoryCounts(ws) }));
    const parentAfter = await withService((db) =>
      db.oneOrFail<{ status: string }>(`select status from public.proposals where workspace_id = $1 and id = $2`, [ws, own.proposalId]),
    );
    expect('and the capture it came from is untouched', parentAfter.status === 'pending_review', parentAfter.status);
  }

  section('13. The success path, end to end');
  {
    const fresh = await makeProposal(ws);
    const memoryBefore = await memoryCounts(ws);
    const session = await buildSession('cr-admin@example.test', ws);

    // 1. One valid request -> one run.
    const started = await requestTopicResearch({
      session, workspaceId: ws, proposalId: fresh.proposalId,
      topicIds: [fresh.topics[0]!], acknowledgeCost: true, acknowledgeExternalSources: true,
    });
    const runsForProposal = async () =>
      withService(async (db) =>
        (await db.oneOrFail<{ n: number }>(
          `select count(*)::int as n from public.runs where workspace_id = $1 and input->>'proposalId' = $2`,
          [ws, fresh.proposalId])).n);
    expect('a confirmed request creates exactly one run', (await runsForProposal()) === 1, String(await runsForProposal()));

    // 11. A double submit cannot create a second active run.
    let second = 'it was allowed';
    try {
      await requestTopicResearch({
        session, workspaceId: ws, proposalId: fresh.proposalId,
        topicIds: [fresh.topics[0]!], acknowledgeCost: true, acknowledgeExternalSources: true,
      });
    } catch (error) { second = isAppError(error) ? error.message : String(error); }
    expect('a double submit is refused while the first is in flight',
      /already running|already started/i.test(second), second);
    expect('  and still only one run exists', (await runsForProposal()) === 1, String(await runsForProposal()));

    // 2. The worker completes it.
    const claimed = await claimRun(started.runId, 'readiness-gate', 300);
    const result = await runResearchPipeline({ run: claimed!, workspaceId: ws, provider: scriptedResearchProvider(), keepAlive: async () => undefined });
    await completeRun(ws, started.runId);
    expect('the worker completes the run', Boolean(result), JSON.stringify(result));

    // 3-4. Exactly one child proposal, linked, pending.
    const children = await withService((db) =>
      db.rows<{ id: string; source_kind: string; status: string; workspace_id: string; run_id: string | null; parent_proposal_id: string | null }>(
        `select id, source_kind, status, workspace_id::text, run_id::text, parent_proposal_id::text
           from public.proposals where workspace_id = $1 and parent_proposal_id = $2`,
        [ws, fresh.proposalId]),
    );
    expect('exactly one child proposal is created', children.length === 1, JSON.stringify(children));
    const child = children[0]!;
    expect('  it is a research result, in this workspace, linked to the capture and its run',
      child.source_kind === 'research' && child.workspace_id === ws &&
      child.parent_proposal_id === fresh.proposalId && child.run_id === started.runId,
      JSON.stringify(child));
    expect('  and it is pending review', child.status === 'pending_review', child.status);

    // 5. Every part of the result is a visible item.
    const items = await withService((db) =>
      db.rows<{ id: string; target_table: string; label: string; new_values: Record<string, unknown>; depends_on_seq: number[] | null; seq: number }>(
        `select id::text, target_table, label, new_values, depends_on_seq, seq
           from public.proposal_items where workspace_id = $1 and proposal_id = $2 order by seq`,
        [ws, child.id]),
    );
    const byTable = (t: string) => items.filter((i) => i.target_table === t);
    expect('every source is its own item', byTable('evidence').length === 3, JSON.stringify(byTable('evidence').map((i) => i.label)));
    expect('the fact, the interpretation and the gap are separate items',
      byTable('research_findings').length === 3 &&
      new Set(byTable('research_findings').map((i) => String(i.new_values.finding_type))).size === 3,
      JSON.stringify(byTable('research_findings').map((i) => `${i.new_values.finding_type}: ${i.label.slice(0, 40)}`)));
    expect('each citation is its own item', byTable('research_finding_evidence').length === 3,
      JSON.stringify(byTable('research_finding_evidence').map((i) => i.label)));

    // 6. The fact depends on its sources.
    const factItem = byTable('research_findings').find((i) => i.new_values.finding_type === 'fact')!;
    const seqOf = new Map(items.map((i) => [i.seq, i]));
    const factDeps = (factItem.depends_on_seq ?? []).map((n) => seqOf.get(n)?.target_table);
    // Dependencies come from label REFERENCES in
    // fields, which is now the only dependency mechanism in the codebase. So the
    // fact depends on the one source it names as its origin, and each citation
    // depends on the fact plus its own source. Together that closure reaches
    // all three sources, which is what assertion 9 below actually proves.
    expect('the fact depends on the source it names as its origin',
      factDeps.filter((t) => t === 'evidence').length === 1, JSON.stringify(factDeps));
    const citationDeps = byTable('research_finding_evidence').map((c) =>
      (c.depends_on_seq ?? []).map((n) => seqOf.get(n)?.target_table).sort().join('+'));
    expect('every citation depends on both the finding and its source',
      citationDeps.every((d) => d === 'evidence+research_findings'), JSON.stringify(citationDeps));

    // 7. Roles.
    const roles = byTable('research_finding_evidence').map((c) => String(c.new_values.role)).sort();
    expect('exactly one primary and two supporting',
      JSON.stringify(roles) === JSON.stringify(['primary', 'supporting', 'supporting']), JSON.stringify(roles));

    // 8. Nothing in memory yet.
    expect('NOTHING is in memory before the child proposal is approved',
      JSON.stringify(await memoryCounts(ws)) === JSON.stringify(memoryBefore),
      JSON.stringify({ before: memoryBefore, after: await memoryCounts(ws) }));

    // 9. Approving writes exactly the visible items.
    const approvedIds = items.map((i) => i.id);
    const expectedDelta: Record<string, number> = {};
    for (const item of items) expectedDelta[item.target_table] = (expectedDelta[item.target_table] ?? 0) + 1;
    await decideProposalItems(session, ws, child.id, approvedIds.map((itemId) => ({ itemId, decision: 'approved' as const })));
    await recordApproval(session, ws, child.id, approvedIds);
    const { proposal: childNow } = await withService((db) => getProposal(db, ws, child.id));
    const applied = await applyApprovedItems({ session, workspaceId: ws, proposalId: child.id, itemIds: approvedIds, expectedVersion: childNow.version });
    const memoryAfter = await memoryCounts(ws);
    const actualDelta = Object.fromEntries(
      Object.keys(memoryAfter).map((t) => [t, memoryAfter[t]! - memoryBefore[t]!]).filter(([, n]) => (n as number) !== 0));
    expect('approving writes exactly the items that were visible, and nothing else',
      JSON.stringify(Object.keys(actualDelta).sort().map((k) => [k, actualDelta[k]])) ===
      JSON.stringify(Object.keys(expectedDelta).sort().map((k) => [k, expectedDelta[k]])),
      JSON.stringify({ expected: expectedDelta, actual: actualDelta, applied: applied.applied.length }));

    // 10. Readback keeps the three kinds apart and cites every source.
    const saved = await withService((db) =>
      db.rows<{ finding_type: string; title: string; sources: string | null; roles: string | null }>(
        `select f.finding_type, f.title,
                string_agg(e.title, ' | ' order by e.title) as sources,
                string_agg(fe.role, ',' order by fe.role) as roles
           from public.research_findings f
           left join public.research_finding_evidence fe on fe.finding_id = f.id
           left join public.evidence e on e.id = fe.evidence_id
          where f.workspace_id = $1 and f.title in ($2, $3, $4)
          group by f.id, f.finding_type, f.title`,
        [ws, FACT, INTERPRETATION, GAP]),
    );
    const factRow = saved.find((r) => r.finding_type === 'fact');
    expect('the source-backed fact, the interpretation and the gap are stored as three different kinds',
      new Set(saved.map((r) => r.finding_type)).size === 3 && saved.length === 3,
      JSON.stringify(saved.map((r) => r.finding_type)));
    expect('the fact cites all three sources by name',
      SOURCES.every((src) => (factRow?.sources ?? '').includes(src.title)), String(factRow?.sources));
    expect('with one primary and two supporting', (factRow?.roles ?? '') === 'primary,supporting,supporting', String(factRow?.roles));
    expect('the interpretation cites no source, because none supports it',
      (saved.find((r) => r.finding_type === 'inference')?.sources ?? null) === null,
      String(saved.find((r) => r.finding_type === 'inference')?.sources));
  }

  exitCode = checks.every((c) => c.passed) ? 0 : 1;
} catch (error) {
  console.error(`\nFAILED: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await closePool();
}

section('Summary');
const failed = checks.filter((c) => !c.passed);
console.log(`${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? exitCode : 1);
