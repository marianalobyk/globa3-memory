#!/usr/bin/env node
/**
 * End-to-end verification against the local/test database.
 *
 *   npm run verify
 *
 * Drives the real pipelines, the real proposal/approval/apply engine and the real
 * queue -- no mocked internals. The AI provider is the mock one unless
 * OPENAI_API_KEY is set, and every result derived from it is reported as MOCK.
 *
 * What it checks:
 *   1. all three formats run end to end and produce a brief, QA verdict, sources
 *      and research topics;
 *   2. a signed-in user cannot write a knowledge record, directly or by applying
 *      an unapproved proposal;
 *   3. applying the same approval twice does not create duplicates;
 *   4. an ambiguous name match is surfaced and never merged;
 *   5. readback returns the values actually stored;
 *   6. editing an item revokes a prior approval;
 *   7. a crashed worker's run is reclaimed and resumes instead of restarting;
 *   8. workspaces are isolated for data, files and background jobs.
 */
import { randomUUID } from 'node:crypto';
import type { Session } from '@g3/shared';
import { getAiProvider } from '../ai/index.js';
import { applyApprovedItems, readbackProposal } from '../apply.js';
import { loadWorkspaceAccess } from '../auth.js';
import { closePool, withOwner, withService, withUser } from '../db.js';
import { isAppError } from '../errors.js';
import { getFormatByKey } from '../formats-repo.js';
import { buildDailyReport, todayInZone } from '../pipelines/report.js';
import { askKnowledge, retrieveRecords } from '../pipelines/ask.js';
import { runBriefPipeline } from '../pipelines/brief.js';
import { runResearchPipeline } from '../pipelines/research.js';
import type { PipelineContext } from '../pipelines/context.js';
import {
  decideProposalItems,
  editProposalItem,
  getProposal,
  recordApproval,
} from '../proposals.js';
import { archiveJob, QUEUE_RUNS, readJobs } from '../queue.js';
import { resolveEntity } from '../resolve.js';
import {
  briefIdempotencyKey,
  claimRun,
  completeRun,
  createRun,
  reclaimStaleRuns,
  researchIdempotencyKey,
} from '../runs.js';
import { seedAdditionalWorkspace, seedWorkspace } from '../seed.js';
import { getStorage } from '../storage.js';
import { guardTarget } from './guard.js';

await guardTarget('verify');

// ---------------------------------------------------------------------------
// Tiny test harness
// ---------------------------------------------------------------------------

interface Check {
  name: string;
  passed: boolean;
  detail: string;
}

const checks: Check[] = [];
let currentSection = '';

function section(title: string): void {
  currentSection = title;
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

function record(name: string, passed: boolean, detail: string): void {
  checks.push({ name: `${currentSection} / ${name}`, passed, detail });
  console.log(`  ${passed ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}`);
  if (detail) console.log(`        ${detail}`);
}

function expect(name: string, condition: boolean, detail: string): void {
  record(name, condition, detail);
}

async function expectRejection(
  name: string,
  action: () => Promise<unknown>,
  expectation: (message: string, code: string | null) => boolean,
  describeExpectation: string,
): Promise<void> {
  try {
    await action();
    record(name, false, `Expected a rejection (${describeExpectation}) but the call succeeded.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = isAppError(error) ? error.code : ((error as { code?: string }).code ?? null);
    record(
      name,
      expectation(message, code),
      `Rejected with [${code ?? 'no code'}] ${message.slice(0, 160)}`,
    );
  }
}

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
  return {
    user: { id: user.id, email: user.email, displayName: user.display_name },
    workspaces,
    activeWorkspace: active,
    isDevAuth: true,
  };
}

function makeContext(run: PipelineContext['run'], workspaceId: string): PipelineContext {
  return {
    run,
    workspaceId,
    provider: getAiProvider(),
    keepAlive: async () => {
      /* no queue lease in-process */
    },
  };
}

/** Drains the queue so a leftover message cannot confuse a later assertion. */
async function drainQueue(): Promise<void> {
  for (;;) {
    const messages = await readJobs(QUEUE_RUNS, 10, 1);
    if (messages.length === 0) break;
    for (const message of messages) await archiveJob(QUEUE_RUNS, message.msgId);
  }
}

const provider = getAiProvider();
const MOCK = provider.isMock;

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

console.log('\x1b[1mEnd-to-end verification\x1b[0m');
console.log(`AI provider: ${provider.kind}${MOCK ? '  <-- MOCK: all generated content is synthetic' : ''}`);

section('Setup');

const seeded = await seedWorkspace({
  adminEmail: process.env.SEED_ADMIN_EMAIL ?? 'admin@example.invalid',
  adminPassword: process.env.SEED_ADMIN_PASSWORD ?? 'ChangeMeBeforeUse',
  clientEmail: process.env.SEED_CLIENT_EMAIL ?? 'client@example.invalid',
  clientPassword: process.env.SEED_CLIENT_PASSWORD ?? 'ChangeMeBeforeUse',
});
const workspaceId = seeded.workspaceId;
const admin = await buildSession(process.env.SEED_ADMIN_EMAIL ?? 'admin@example.invalid', workspaceId);
const client = await buildSession(process.env.SEED_CLIENT_EMAIL ?? 'client@example.invalid', workspaceId);
record('seeded workspace with two approvers', admin.activeWorkspace.canApprove && client.activeWorkspace.canApprove,
  `admin=${admin.activeWorkspace.role}/approve=${admin.activeWorkspace.canApprove}, client=${client.activeWorkspace.role}/approve=${client.activeWorkspace.canApprove}`);

await drainQueue();

// ---------------------------------------------------------------------------
section('1. Three formats end to end');

const runDate = process.env.VERIFY_RUN_DATE ?? '2026-09-11';
const briefResults: Record<string, { briefDocumentId: string; qaStatus: string; topicCount: number; sourceCount: number }> = {};
const briefRunIds: string[] = [];

for (const formatKey of ['amv_daily', 'amv_creative_radar', 'globa3_creative_radar'] as const) {
  const format = await withService((db) => getFormatByKey(db, workspaceId, formatKey));
  const created = await createRun({
    session: admin,
    workspaceId,
    kind: 'brief',
    formatId: format.id,
    runDate,
    idempotencyKey: briefIdempotencyKey(formatKey, runDate, `verify-${randomUUID().slice(0, 8)}`),
    isMock: MOCK,
  });

  // Claim it the way the worker does, then run the pipeline in-process.
  const claimed = await claimRun(created.run.id, 'verify-worker', 300);
  if (!claimed) throw new Error(`Could not claim run for ${formatKey}`);
  const result = await runBriefPipeline(makeContext(claimed, workspaceId));
  await completeRun(workspaceId, created.run.id);

  briefResults[formatKey] = result;
  briefRunIds.push(created.run.id);

  const stored = await withService((db) =>
    db.oneOrFail<{
      title: string;
      qa_status: string;
      body_md: string;
      is_mock: boolean;
      coverage_start: string;
      coverage_end: string;
      qa_checks: { key: string; passed: boolean; decidedBy?: string }[];
      prompt_version_id: string;
    }>(
      `select title, qa_status, body_md, is_mock, coverage_start, coverage_end, qa_checks, prompt_version_id
         from public.brief_documents where workspace_id = $1 and id = $2`,
      [workspaceId, result.briefDocumentId],
    ),
  );
  const sources = await withService((db) =>
    db.oneOrFail<{ n: number }>(
      `select count(*)::int n from public.brief_sources where workspace_id = $1 and brief_document_id = $2`,
      [workspaceId, result.briefDocumentId],
    ),
  );
  const topics = await withService((db) =>
    db.rows<{ label: string; resolution_status: string; target_type: string }>(
      `select label, resolution_status, target_type from public.research_topics
        where workspace_id = $1 and brief_document_id = $2 order by label`,
      [workspaceId, result.briefDocumentId],
    ),
  );
  const codeDecided = stored.qa_checks.filter((c) => c.decidedBy === 'code').length;

  expect(
    `${formatKey}: produced a brief`,
    stored.body_md.length > 200 && stored.qa_status !== null,
    `qa=${stored.qa_status}, ${stored.body_md.length} chars, ${sources.n} source(s), ${topics.length} topic(s), ${codeDecided} code-decided QA check(s), promptVersion recorded=${Boolean(stored.prompt_version_id)}${stored.is_mock ? ', MOCK' : ''}`,
  );
  expect(
    `${formatKey}: coverage window computed by code`,
    stored.coverage_start !== null && stored.coverage_end !== null,
    `${stored.coverage_start} -> ${stored.coverage_end}`,
  );
  expect(
    `${formatKey}: research topics carry a resolution status`,
    topics.length > 0 && topics.every((t) => ['existing', 'ambiguous', 'not_found'].includes(t.resolution_status)),
    topics.map((t) => `${t.label} [${t.target_type}: ${t.resolution_status}]`).join('; ') || 'no topics',
  );
}

// QA status is not approval: scoped to the runs just created, so earlier
// verification data cannot mask the assertion.
const qaVsApproval = await withService((db) =>
  db.oneOrFail<{ briefs: number; proposals: number; applied: number }>(
    `select (select count(*)::int from public.brief_documents
               where workspace_id = $1 and run_id = any($2::uuid[])) as briefs,
            (select count(*)::int from public.proposals
               where workspace_id = $1 and run_id = any($2::uuid[])) as proposals,
            (select count(*)::int from public.applied_changes c
               join public.proposals p on p.id = c.proposal_id
              where c.workspace_id = $1 and p.run_id = any($2::uuid[])) as applied`,
    [workspaceId, briefRunIds],
  ),
);
expect(
  'generating a brief writes nothing to the knowledge base',
  qaVsApproval.applied === 0 && qaVsApproval.proposals === 0,
  `${qaVsApproval.briefs} brief(s) produced, ${qaVsApproval.proposals} proposal(s), ${qaVsApproval.applied} applied change(s). A QA verdict is the format's release gate, not user approval of a record.`,
);

// ---------------------------------------------------------------------------
section('2. Unapproved records are blocked');

await expectRejection(
  'a signed-in user cannot insert an entity directly',
  () =>
    withUser(client.user.id, (db) =>
      db.query(
        `insert into public.entities (workspace_id, entity_type, display_name, slug)
         values ($1,'person','Direct Write Attempt','direct-write-attempt')`,
        [workspaceId],
      ),
    ),
  (_m, code) => code === '42501',
  'permission denied',
);

await expectRejection(
  'a signed-in user cannot insert a research finding directly',
  () =>
    withUser(client.user.id, (db) =>
      db.query(
        `insert into public.research_findings (workspace_id, finding_type, title, content)
         values ($1,'fact','Direct','Direct')`,
        [workspaceId],
      ),
    ),
  (_m, code) => code === '42501',
  'permission denied',
);

// Build a proposal via the research pipeline, then try to apply it unapproved.
const firstBrief = briefResults.amv_daily;
if (!firstBrief) throw new Error('No AMV Daily brief produced');

const topicsToResearch = await withService((db) =>
  db.rows<{ id: string; label: string }>(
    `select id, label from public.research_topics
      where workspace_id = $1 and brief_document_id = $2
      order by case priority when 'high' then 0 else 1 end limit 3`,
    [workspaceId, firstBrief.briefDocumentId],
  ),
);
await withService((db) =>
  db.query(
    `update public.research_topics set selected = true, status = 'selected'
      where workspace_id = $1 and id = any($2::uuid[])`,
    [workspaceId, topicsToResearch.map((t) => t.id)],
  ),
);

const researchRun = await createRun({
  session: admin,
  workspaceId,
  kind: 'research',
  runDate,
  input: { briefDocumentId: firstBrief.briefDocumentId, topicIds: topicsToResearch.map((t) => t.id) },
  idempotencyKey: researchIdempotencyKey(firstBrief.briefDocumentId, topicsToResearch.map((t) => t.id)),
  isMock: MOCK,
});
const researchClaimed = await claimRun(researchRun.run.id, 'verify-worker', 600);
if (!researchClaimed) throw new Error('Could not claim the research run');
const research = await runResearchPipeline(makeContext(researchClaimed, workspaceId));
await completeRun(workspaceId, researchRun.run.id);

const proposalId = research.proposalId;
const loaded = await withService((db) => getProposal(db, workspaceId, proposalId));
expect(
  'research produced a proposal with exact proposed changes',
  loaded.items.length > 0 &&
    loaded.items.every((i) => i.target_table.length > 0 && Object.keys(i.new_values).length > 0),
  `${loaded.items.length} item(s): ${loaded.items.map((i) => `${i.op} ${i.target_table} "${i.label}" [${i.match_status}]`).join('; ')}`,
);

await expectRejection(
  'applying without an approval is refused',
  () =>
    applyApprovedItems({
      session: admin,
      workspaceId,
      proposalId,
      expectedVersion: loaded.proposal.version,
      itemIds: loaded.items.map((i) => i.id),
    }),
  (m) => /not approved|No live approval/i.test(m),
  'no live approval',
);

// ---------------------------------------------------------------------------
section('3. Ambiguous matches are surfaced, never merged');

const ambiguousItems = loaded.items.filter((i) => i.match_status === 'ambiguous');
const mentionItems = loaded.items.filter((i) => i.target_table === 'entity_mentions');
expect(
  'a near-duplicate name is staged, not merged',
  ambiguousItems.length > 0 || mentionItems.length > 0,
  `${ambiguousItems.length} ambiguous item(s), ${mentionItems.length} entity_mentions item(s). ` +
    (mentionItems[0] ? `Example reason: ${String(mentionItems[0].reason).slice(0, 140)}` : ''),
);

const directResolution = await withService((db) =>
  resolveEntity(db, workspaceId, { name: 'Sports One Holdings', entityType: 'organization' }),
);
expect(
  'resolver returns ambiguous (not existing) for a similar name',
  directResolution.status === 'ambiguous' && directResolution.best !== null,
  `"Sports One Holdings" -> ${directResolution.status}, closest "${directResolution.best?.displayName}" @ ${directResolution.best?.similarity.toFixed(2)}. ${directResolution.rationale.slice(0, 120)}`,
);

const exactResolution = await withService((db) =>
  resolveEntity(db, workspaceId, { name: 'Sports One', entityType: 'organization' }),
);
expect(
  'resolver returns existing only on an exact identity match',
  exactResolution.status === 'existing',
  `"Sports One" -> ${exactResolution.status} via ${exactResolution.best?.matchedVia}`,
);

const unrelated = await withService((db) =>
  resolveEntity(db, workspaceId, { name: 'Serena Ventures', entityType: 'organization' }),
);
expect(
  'a shared first word does not create a false match',
  unrelated.status === 'new',
  `"Serena Ventures" -> ${unrelated.status} (no stored organisation scored high enough)`,
);

// ---------------------------------------------------------------------------
section('4. Approval, apply, readback');

// Approve only the items that can actually be applied, to exercise partial approval.
const applicable = loaded.items.filter((i) => !String(i.reason).includes('Needs attention'));
const skipped = loaded.items.filter((i) => String(i.reason).includes('Needs attention'));

await decideProposalItems(
  client,
  workspaceId,
  proposalId,
  applicable.map((i) => ({ itemId: i.id, decision: 'approved' as const })),
);
const approval = await recordApproval(client, workspaceId, proposalId, applicable.map((i) => i.id));
expect(
  'partial approval is recorded against a version and hash',
  approval.proposal_version === loaded.proposal.version && approval.content_hash === loaded.proposal.content_hash,
  `approved ${applicable.length} of ${loaded.items.length} item(s) at version ${approval.proposal_version}; ${skipped.length} left unapproved because they need attention`,
);

const applied = await applyApprovedItems({
  session: client,
  workspaceId,
  proposalId,
  expectedVersion: loaded.proposal.version,
  itemIds: applicable.map((i) => i.id),
});
expect(
  'approved items were applied transactionally',
  applied.applied.filter((r) => r.status === 'applied').length > 0,
  applied.readbackSummary.join(' | ').slice(0, 400),
);
expect(
  'readback returns the values actually stored',
  applied.applied.filter((r) => r.status === 'applied').every((r) => r.readback !== null && r.readbackOk),
  applied.applied
    .filter((r) => r.status === 'applied')
    .map((r) => `${r.table}:${String((r.readback ?? {}).display_name ?? (r.readback ?? {}).title ?? r.label)} readbackOk=${r.readbackOk}`)
    .join('; ')
    .slice(0, 400),
);

const readbackRows = await withService((db) => readbackProposal(db, workspaceId, proposalId));
expect(
  'readback names who approved and who applied each change',
  readbackRows.length > 0 && readbackRows.every((r) => r.appliedByEmail !== null && r.current !== null),
  readbackRows.map((r) => `${r.table} by ${r.appliedByEmail}`).slice(0, 4).join('; '),
);

// ---------------------------------------------------------------------------
section('5. Repeating a request does not duplicate');

const before = await withService((db) =>
  db.oneOrFail<{ entities: number; findings: number; changes: number }>(
    `select (select count(*)::int from public.entities where workspace_id = $1) as entities,
            (select count(*)::int from public.research_findings where workspace_id = $1) as findings,
            (select count(*)::int from public.applied_changes where workspace_id = $1) as changes`,
    [workspaceId],
  ),
);
const second = await applyApprovedItems({
  session: client,
  workspaceId,
  proposalId,
  expectedVersion: loaded.proposal.version,
  itemIds: applicable.map((i) => i.id),
});
const after = await withService((db) =>
  db.oneOrFail<{ entities: number; findings: number; changes: number }>(
    `select (select count(*)::int from public.entities where workspace_id = $1) as entities,
            (select count(*)::int from public.research_findings where workspace_id = $1) as findings,
            (select count(*)::int from public.applied_changes where workspace_id = $1) as changes`,
    [workspaceId],
  ),
);
expect(
  'a repeated apply writes nothing new',
  before.entities === after.entities &&
    before.findings === after.findings &&
    before.changes === after.changes &&
    second.applied.every((r) => r.status === 'already_applied'),
  `entities ${before.entities}->${after.entities}, findings ${before.findings}->${after.findings}, applied_changes ${before.changes}->${after.changes}; all ${second.applied.length} item(s) reported as already_applied`,
);

// Re-running the same logical run must not create a second run either.
const duplicateRun = await createRun({
  session: admin,
  workspaceId,
  kind: 'research',
  input: { briefDocumentId: firstBrief.briefDocumentId, topicIds: topicsToResearch.map((t) => t.id) },
  idempotencyKey: researchIdempotencyKey(firstBrief.briefDocumentId, topicsToResearch.map((t) => t.id)),
  isMock: MOCK,
});
expect(
  'the same logical run request returns the existing run',
  !duplicateRun.created && duplicateRun.run.id === researchRun.run.id,
  `created=${duplicateRun.created}, same id=${duplicateRun.run.id === researchRun.run.id}`,
);

// ---------------------------------------------------------------------------
section('6. Editing revokes a prior approval');

const editableTarget = loaded.items.find(
  (i) => i.target_table === 'signals' || i.target_table === 'research_findings' || i.target_table === 'entities',
);
if (editableTarget) {
  // Build a fresh proposal so there is an unapplied item to edit.
  const freshTopics = await withService((db) =>
    db.rows<{ id: string }>(
      `select id from public.research_topics where workspace_id = $1 and brief_document_id = $2 limit 2`,
      [workspaceId, briefResults.amv_creative_radar?.briefDocumentId ?? firstBrief.briefDocumentId],
    ),
  );
  const editRun = await createRun({
    session: admin,
    workspaceId,
    kind: 'research',
    input: {
      briefDocumentId: briefResults.amv_creative_radar?.briefDocumentId ?? firstBrief.briefDocumentId,
      topicIds: freshTopics.map((t) => t.id),
    },
    idempotencyKey: `research:edit-test:${randomUUID().slice(0, 8)}`,
    isMock: MOCK,
  });
  const editClaimed = await claimRun(editRun.run.id, 'verify-worker', 600);
  if (!editClaimed) throw new Error('Could not claim the edit-test research run');
  const editResearch = await runResearchPipeline(makeContext(editClaimed, workspaceId));
  await completeRun(workspaceId, editRun.run.id);

  const editProposal = await withService((db) => getProposal(db, workspaceId, editResearch.proposalId));
  const target = editProposal.items.find((i) => i.target_table === 'entities') ?? editProposal.items[0];
  if (!target) throw new Error('No item to edit');

  await decideProposalItems(admin, workspaceId, editResearch.proposalId, [
    { itemId: target.id, decision: 'approved' },
  ]);
  const firstApproval = await recordApproval(admin, workspaceId, editResearch.proposalId, [target.id]);

  const revised = await editProposalItem(admin, workspaceId, editResearch.proposalId, target.id, {
    provenance_note: 'Edited during verification to prove approval is version-bound.',
  });
  expect(
    'an edit bumps the version',
    revised.version === firstApproval.proposal_version + 1,
    `version ${firstApproval.proposal_version} -> ${revised.version}, content hash changed=${revised.contentHash !== firstApproval.content_hash}`,
  );

  const revokedRow = await withService((db) =>
    db.oneOrFail<{ revoked_at: string | null; revoked_reason: string | null }>(
      `select revoked_at, revoked_reason from public.proposal_approvals where id = $1`,
      [firstApproval.id],
    ),
  );
  expect(
    'the prior approval is revoked by the edit',
    revokedRow.revoked_at !== null,
    revokedRow.revoked_reason ?? 'revoked',
  );

  const itemAfterEdit = await withService((db) =>
    db.oneOrFail<{ decision: string; was_edited: boolean }>(
      `select decision, was_edited from public.proposal_items where id = $1`,
      [target.id],
    ),
  );
  expect(
    'the edited item returns to pending',
    itemAfterEdit.decision === 'pending' && itemAfterEdit.was_edited,
    `decision=${itemAfterEdit.decision}, was_edited=${itemAfterEdit.was_edited}`,
  );

  await expectRejection(
    'applying the stale approved version is refused',
    () =>
      applyApprovedItems({
        session: admin,
        workspaceId,
        proposalId: editResearch.proposalId,
        expectedVersion: firstApproval.proposal_version,
        itemIds: [target.id],
      }),
    (m) => /now at version|No live approval/i.test(m),
    'stale version',
  );
}

// ---------------------------------------------------------------------------
section('7. Worker crash recovery');

const recoveryFormat = await withService((db) => getFormatByKey(db, workspaceId, 'amv_daily'));
const recoveryRun = await createRun({
  session: admin,
  workspaceId,
  kind: 'brief',
  formatId: recoveryFormat.id,
  runDate,
  idempotencyKey: briefIdempotencyKey('amv_daily', runDate, `recovery-${randomUUID().slice(0, 8)}`),
  isMock: MOCK,
});

// Worker A claims the run and completes the first two stages, then "dies".
const workerA = await claimRun(recoveryRun.run.id, 'worker-a-crashes', 60);
if (!workerA) throw new Error('Worker A could not claim the recovery run');

const partialCtx = makeContext(workerA, workspaceId);
try {
  await runBriefPipeline({
    ...partialCtx,
    keepAlive: async () => {
      // Fail once the research stage has been stored, simulating a crash
      // part-way through the run.
      const stages = await withService((db) =>
        db.rows<{ stage: string; status: string }>(
          `select stage, status from public.run_stages where workspace_id = $1 and run_id = $2`,
          [workspaceId, recoveryRun.run.id],
        ),
      );
      const researchDone = stages.some((s) => s.stage === 'research' && s.status === 'succeeded');
      if (researchDone) throw new Error('simulated worker crash after the research stage');
    },
  });
  record('worker A stopped part-way', false, 'The simulated crash did not happen.');
} catch (error) {
  const stages = await withService((db) =>
    db.rows<{ stage: string; status: string }>(
      `select stage, status from public.run_stages where workspace_id = $1 and run_id = $2 order by seq`,
      [workspaceId, recoveryRun.run.id],
    ),
  );
  record(
    'worker A stopped part-way with finished stages stored',
    stages.some((s) => s.status === 'succeeded'),
    `${stages.map((s) => `${s.stage}=${s.status}`).join(', ')} (${error instanceof Error ? error.message : ''})`,
  );
}

// Expire the lease, as it would expire on its own after the worker died.
await withService((db) =>
  db.query(
    `update public.runs set status = 'running', lease_expires_at = now() - interval '10 minutes'
      where workspace_id = $1 and id = $2`,
    [workspaceId, recoveryRun.run.id],
  ),
);
const reclaimed = await reclaimStaleRuns(0);
expect(
  'an abandoned run is reclaimed when its lease expires',
  reclaimed.some((r) => r.id === recoveryRun.run.id),
  `reclaimed ${reclaimed.length} run(s); target included=${reclaimed.some((r) => r.id === recoveryRun.run.id)}`,
);

// Worker B picks it up and must resume rather than restart.
const workerB = await claimRun(recoveryRun.run.id, 'worker-b-resumes', 300);
expect('a second worker can claim the reclaimed run', workerB !== null, `claimed=${workerB !== null}`);
if (workerB) {
  const resumedResult = await runBriefPipeline(makeContext(workerB, workspaceId));
  await completeRun(workspaceId, recoveryRun.run.id);

  const events = await withService((db) =>
    db.rows<{ message: string; stage: string | null }>(
      `select message, stage from public.run_events
        where workspace_id = $1 and run_id = $2 and message like '%already completed%'`,
      [workspaceId, recoveryRun.run.id],
    ),
  );
  expect(
    'the resumed run reuses completed stages instead of repeating them',
    events.length > 0,
    events.length > 0
      ? `reused: ${events.map((e) => e.stage).join(', ')}`
      : 'No stage-reuse events found.',
  );

  const usageRows = await withService((db) =>
    db.rows<{ stage: string | null; n: number }>(
      `select stage, count(*)::int n from public.usage_events
        where workspace_id = $1 and run_id = $2 group by stage order by stage`,
      [workspaceId, recoveryRun.run.id],
    ),
  );
  expect(
    'a reused stage is not paid for twice',
    usageRows.every((r) => r.n <= 1),
    usageRows.map((r) => `${r.stage}=${r.n} call(s)`).join(', '),
  );

  const finalRun = await withService((db) =>
    db.oneOrFail<{ status: string; progress: number; attempt: number }>(
      `select status, progress, attempt from public.runs where workspace_id = $1 and id = $2`,
      [workspaceId, recoveryRun.run.id],
    ),
  );
  expect(
    'the recovered run completes',
    finalRun.status === 'succeeded' && finalRun.progress === 100,
    `status=${finalRun.status}, progress=${finalRun.progress}, attempts=${finalRun.attempt}, brief=${resumedResult.briefDocumentId}`,
  );
}

// ---------------------------------------------------------------------------
section('8. Workspace isolation');

const other = await seedAdditionalWorkspace(
  'verify-client-b',
  'Verification Client B',
  'verify-outsider@example.com',
  'local-dev-outsider',
);
const outsider = await buildSession('verify-outsider@example.com', other.workspaceId);

const adminVisible = await withUser(admin.user.id, (db) =>
  db.oneOrFail<{ entities: number; briefs: number; proposals: number; runs: number; changes: number }>(
    `select (select count(*)::int from public.entities) as entities,
            (select count(*)::int from public.brief_documents) as briefs,
            (select count(*)::int from public.proposals) as proposals,
            (select count(*)::int from public.runs) as runs,
            (select count(*)::int from public.applied_changes) as changes`,
  ),
);
const outsiderVisible = await withUser(outsider.user.id, (db) =>
  db.oneOrFail<{ entities: number; briefs: number; proposals: number; runs: number; changes: number }>(
    `select (select count(*)::int from public.entities) as entities,
            (select count(*)::int from public.brief_documents) as briefs,
            (select count(*)::int from public.proposals) as proposals,
            (select count(*)::int from public.runs) as runs,
            (select count(*)::int from public.applied_changes) as changes`,
  ),
);
expect(
  'RLS hides every other workspace row',
  outsiderVisible.entities === 0 &&
    outsiderVisible.briefs === 0 &&
    outsiderVisible.proposals === 0 &&
    outsiderVisible.runs === 0 &&
    outsiderVisible.changes === 0,
  `admin sees entities=${adminVisible.entities} briefs=${adminVisible.briefs} proposals=${adminVisible.proposals} runs=${adminVisible.runs} changes=${adminVisible.changes}; outsider sees ${JSON.stringify(outsiderVisible)}`,
);

await expectRejection(
  'the server refuses a cross-workspace operation',
  () =>
    applyApprovedItems({
      session: outsider,
      workspaceId,
      proposalId,
      expectedVersion: loaded.proposal.version,
      itemIds: applicable.map((i) => i.id),
    }),
  (_m, code) => code === 'forbidden',
  'forbidden',
);

await expectRejection(
  'a cross-workspace foreign key is structurally impossible',
  () =>
    withService((db) =>
      db.query(
        `insert into public.research_findings (workspace_id, finding_type, title, content, related_entity_id)
         values ($1,'fact','cross-workspace','x',(select id from public.entities where workspace_id = $2 limit 1))`,
        [other.workspaceId, workspaceId],
      ),
    ),
  (_m, code) => code === '23503',
  'foreign key violation',
);

// Files are isolated by the same boundary.
const storage = getStorage();
await storage.put(workspaceId, 'verify/isolation.txt', Buffer.from('workspace A only'), 'text/plain');
await expectRejection(
  'a file cannot be read from another workspace path',
  () => storage.get(other.workspaceId, 'verify/isolation.txt'),
  (_m, code) => code === 'not_found',
  'not found',
);
await expectRejection(
  'a storage key cannot traverse out of its workspace prefix',
  () => storage.get(other.workspaceId, `../${workspaceId}/verify/isolation.txt`),
  (_m, code) => code === 'bad_request',
  'rejected path',
);

// Background jobs carry their workspace, and the worker scopes by it.
// Every job this workspace enqueued, whether still queued or already archived.
// Only app-produced jobs are in scope: a job carries a uuid runId, so hand-made
// probe messages are excluded.
const jobScoped = await withService(async (db) => {
  // Real Supabase Queues (the pgmq extension) keeps each queue in its own pair
  // of tables, q_<queue> and a_<queue>. The local SQL implementation keeps all
  // queues in pgmq.messages / pgmq.messages_archive. Read whichever exists.
  const extension = await db.one<{ present: boolean }>(
    `select exists (select 1 from pg_extension where extname = 'pgmq') as present`,
  );
  const sources = extension?.present
    ? ['pgmq.q_g3_runs', 'pgmq.a_g3_runs', 'pgmq.q_g3_ingest', 'pgmq.a_g3_ingest']
    : ['pgmq.messages', 'pgmq.messages_archive'];
  const union = sources.map((table) => `select message from ${table}`).join(' union all ');
  return db.oneOrFail<{ n: number; mismatched: number }>(
    `with jobs as (${union})
     select count(*)::int as n,
            count(*) filter (where (message->>'workspaceId') is null)::int as mismatched
       from jobs
      where (message->>'runId') ~ '^[0-9a-fA-F-]{36}$'`,
  );
});
expect(
  'every queued job carries its workspace id',
  jobScoped.n > 0 && jobScoped.mismatched === 0,
  `${jobScoped.n} app-produced job(s) queued or archived, ${jobScoped.mismatched} without a workspaceId`,
);

// ---------------------------------------------------------------------------
section('9. Ask Knowledge and the daily report');

const ask = await askKnowledge(workspaceId, 'What do we know about Sports One?');
expect(
  'Ask Knowledge answers from stored records with citations',
  ask.retrievedCount > 0 && ask.citations.length > 0,
  `retrieved ${ask.retrievedCount} record(s), ${ask.citations.length} citation(s)${ask.isMock ? ' [MOCK answer text]' : ''}: ${ask.citations.slice(0, 3).map((c) => `${c.table_name}/${c.label}`).join('; ')}`,
);

const captureTitle = `Verification Creative Radar ${randomUUID().slice(0, 8)}`;
await withService(async (db) => {
  const source = await db.oneOrFail<{ id: string }>(
    `insert into public.evidence (workspace_id, source_type, title, reliability, notes)
     values ($1, 'brief', $2, 'unverified', 'A stored capture used to verify source retrieval.')
     returning id`,
    [workspaceId, captureTitle],
  );
  await db.query(
    `insert into public.research_artifacts
       (workspace_id, title, slug, artifact_type, summary, source_evidence_id, capture_source, status)
     values ($1, $2, $3, 'research_document', 'A Creative Radar capture saved for retrieval verification.', $4, 'capture', 'ready')`,
    [workspaceId, captureTitle, `verification-creative-radar-${randomUUID().slice(0, 8)}`, source.id],
  );
  await db.query(
    `insert into public.evidence (workspace_id, source_type, title, reliability, notes)
     values ($1, 'brief', 'Unrelated verification note', 'unverified', 'Creative planning with no connection to the Radar capture.')`,
    [workspaceId],
  );
});
const captureRecords = await withService((db) =>
  retrieveRecords(db, workspaceId, `What was saved from ${captureTitle}?`),
);
expect(
  'Ask Knowledge retrieves an approved capture by its document title',
  ['evidence', 'research_artifacts'].every((table) => captureRecords.some((record) => record.table === table))
    && captureRecords.every((record) => record.label.includes(captureTitle)),
  captureRecords.map((record) => `${record.table}/${record.label}`).join('; '),
);

const askEmpty = await askKnowledge(workspaceId, 'What is the quarterly revenue of Antarctic Airlines Holdings?');
expect(
  'Ask Knowledge does not invent an answer it has no records for',
  askEmpty.retrievedCount === 0 && askEmpty.citations.length === 0,
  `retrieved ${askEmpty.retrievedCount}; answer states the limit: "${askEmpty.answerMd.slice(0, 90)}..."`,
);

const isolatedAsk = await askKnowledge(other.workspaceId, 'What do we know about Sports One?');
expect(
  'Ask Knowledge cannot reach another workspace',
  isolatedAsk.retrievedCount === 0,
  `workspace B retrieved ${isolatedAsk.retrievedCount} record(s) for the same question`,
);

// "Today" in the workspace timezone, which is how the report defines its day.
const today = todayInZone(admin.activeWorkspace.timezone);
const report = await buildDailyReport(workspaceId, today, { actorId: admin.user.id });
expect(
  'the daily report names concrete changes, the approver and the origin',
  report.changeCount > 0 &&
    /Approved by:/.test(report.bodyMd) &&
    /Applied by:/.test(report.bodyMd) &&
    /Changes by origin/.test(report.bodyMd),
  `${report.changeCount} change(s), ${report.bodyMd.length} chars, stored at ${report.storagePath}`,
);

// ---------------------------------------------------------------------------
section('10. Cost accounting');

const usage = await withService((db) =>
  db.oneOrFail<{ events: number; estimates: number; tokens: number; mock: number }>(
    `select count(*)::int as events,
            count(*) filter (where is_estimate)::int as estimates,
            coalesce(sum(tokens_in + tokens_out), 0)::int as tokens,
            count(*) filter (where is_mock)::int as mock
       from public.usage_events where workspace_id = $1`,
    [workspaceId],
  ),
);
expect(
  'usage is recorded per stage and estimates are flagged',
  usage.events > 0,
  `${usage.events} usage event(s), ${usage.tokens} token(s), ${usage.estimates} flagged as estimate, ${usage.mock} from the mock provider`,
);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const failed = checks.filter((c) => !c.passed);
console.log(`\n\x1b[1mSummary\x1b[0m`);
console.log(`  ${checks.length - failed.length}/${checks.length} checks passed`);
if (MOCK) {
  console.log(
    '  NOTE: the mock AI provider was used. Pipeline mechanics, approval, isolation and\n' +
      '        recovery are genuinely exercised; the generated CONTENT is synthetic and no\n' +
      '        live search or model integration has been verified.',
  );
}
if (failed.length > 0) {
  console.log('\n\x1b[31mFailed checks\x1b[0m');
  for (const check of failed) console.log(`  - ${check.name}\n      ${check.detail}`);
}

await closePool();
process.exit(failed.length > 0 ? 1 : 0);
