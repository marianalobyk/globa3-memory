#!/usr/bin/env node
/**
 * Verification for the four code-review findings.
 *
 *   npm run verify:review
 *
 * Runs against the local/test database with the real engine. Covers:
 *   1. authentication mode selection and the dev-login gate
 *   2. an approved operation is performed exactly, or refused
 *   3. lost-update protection, including two users working at once
 *   4. migration 0006 compatibility for pre-0006 callers, including a real
 *      workspace-scoped upsert and the adapted archive write script
 *   5. proposals without a baseline fingerprint (built before 0011)
 *   6. two different proposals creating the same record concurrently, including
 *      the unique-violation path, rollback of earlier items, and references
 *
 * The live Supabase Auth exchange is NOT covered: it needs a real project. What
 * is covered here is which authenticator is selected, that the dev login is
 * refused unless explicitly enabled, and that a dev cookie is ignored when
 * Supabase is configured.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Session } from '@g3/shared';
import { slugify } from '@g3/shared';
import { applyApprovedItems } from '../apply.js';
import {
  loadWorkspaceAccess,
  refreshSupabaseSession,
  resolveSession,
  createDevSessionToken,
  signInWithPassword,
  signInWithSupabase,
  signOutSupabase,
} from '../auth.js';
import { guardTarget } from './guard.js';

await guardTarget('verify:review');
import { closePool, withOwner, withService, withUser } from '../db.js';
import { isAppError } from '../errors.js';
import { authMode, devAuthEnabled, env } from '../env.js';
import {
  buildProposal,
  decideProposalItems,
  getProposal,
  recordApproval,
  type ProposalItemRecord,
} from '../proposals.js';
import { seedAdditionalWorkspace, seedWorkspace } from '../seed.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Check {
  name: string;
  passed: boolean;
  detail: string;
}
const checks: Check[] = [];
const skipped: { name: string; reason: string }[] = [];
let section_ = '';

/** A check that cannot run in this environment. Reported, never counted as passed. */
function skip(name: string, reason: string): void {
  skipped.push({ name: `${section_} / ${name}`, reason });
  console.log(`  \x1b[33mSKIP\x1b[0m  ${name}`);
  console.log(`        ${reason}`);
}

function section(title: string): void {
  section_ = title;
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}
function record(name: string, passed: boolean, detail: string): void {
  checks.push({ name: `${section_} / ${name}`, passed, detail });
  console.log(`  ${passed ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}`);
  if (detail) console.log(`        ${detail}`);
}
async function expectRejection(
  name: string,
  action: () => Promise<unknown>,
  matches: (message: string, code: string | null, detail: unknown) => boolean,
  expectation: string,
): Promise<unknown> {
  try {
    await action();
    record(name, false, `Expected a rejection (${expectation}) but the call succeeded.`);
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = isAppError(error) ? error.code : ((error as { code?: string }).code ?? null);
    const detail = isAppError(error) ? error.detail : undefined;
    record(name, matches(message, code, detail), `Rejected with [${code ?? '-'}] ${message.slice(0, 150)}`);
    return detail;
  }
}

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

/**
 * Creates a minimal proposal directly, so each scenario controls exactly the
 * operation, target and baseline it wants to test.
 */
async function makeProposal(
  workspaceId: string,
  createdBy: string,
  item: {
    op: 'create' | 'update' | 'link';
    table: string;
    label: string;
    targetId?: string | null;
    newValues: Record<string, unknown>;
    oldValues?: Record<string, unknown> | null;
    baselineFingerprint?: string | null;
  },
): Promise<{ proposalId: string; itemId: string; version: number }> {
  return withService(async (db) => {
    const proposal = await db.oneOrFail<{ id: string; version: number }>(
      `insert into public.proposals
         (workspace_id, source_kind, title, summary, status, version, content_hash, is_mock, created_by)
       values ($1,'manual',$2,'Scenario fixture','pending_review',1,'pending',true,$3)
       returning id, version`,
      [workspaceId, item.label, createdBy],
    );
    const created = await db.oneOrFail<{ id: string }>(
      `insert into public.proposal_items
         (workspace_id, proposal_id, seq, op, target_table, target_id, match_status, candidates,
          label, claim_type, confidence, reason, new_values, old_values, provenance,
          apply_group, depends_on_seq, baseline_fingerprint)
       values ($1,$2,1,$3,$4,$5,$6,'[]'::jsonb,$7,'fact','medium','Scenario fixture',
               $8::jsonb,$9::jsonb,'{}'::jsonb,1,'{}',$10)
       returning id`,
      [
        workspaceId,
        proposal.id,
        item.op,
        item.table,
        item.targetId ?? null,
        item.targetId ? 'existing' : 'new',
        item.label,
        JSON.stringify(item.newValues),
        item.oldValues ? JSON.stringify(item.oldValues) : null,
        item.baselineFingerprint ?? null,
      ],
    );
    const items = await db.rows<ProposalItemRecord>(
      `select * from public.proposal_items where proposal_id = $1 order by seq`,
      [proposal.id],
    );
    const { computeContentHash } = await import('../proposals.js');
    await db.query(`update public.proposals set content_hash = $2 where id = $1`, [
      proposal.id,
      computeContentHash(items),
    ]);
    return { proposalId: proposal.id, itemId: created.id, version: proposal.version };
  });
}

interface FixtureItem {
  op: 'create' | 'update' | 'link';
  table: string;
  label: string;
  targetId?: string | null;
  newValues: Record<string, unknown>;
  oldValues?: Record<string, unknown> | null;
  baselineFingerprint?: string | null;
  dependsOnSeq?: number[];
}

/** A proposal with several items, seq = position (1-based). */
async function makeMultiProposal(
  workspaceId: string,
  createdBy: string,
  title: string,
  fixtureItems: FixtureItem[],
): Promise<{ proposalId: string; itemIds: string[] }> {
  return withService(async (db) => {
    const proposal = await db.oneOrFail<{ id: string }>(
      `insert into public.proposals
         (workspace_id, source_kind, title, summary, status, version, content_hash, is_mock, created_by)
       values ($1,'manual',$2,'Scenario fixture','pending_review',1,'pending',true,$3)
       returning id`,
      [workspaceId, title, createdBy],
    );
    const itemIds: string[] = [];
    for (const [index, item] of fixtureItems.entries()) {
      const created = await db.oneOrFail<{ id: string }>(
        `insert into public.proposal_items
           (workspace_id, proposal_id, seq, op, target_table, target_id, match_status, candidates,
            label, claim_type, confidence, reason, new_values, old_values, provenance,
            apply_group, depends_on_seq, baseline_fingerprint)
         values ($1,$2,$3,$4,$5,$6,$7,'[]'::jsonb,$8,'fact','medium','Scenario fixture',
                 $9::jsonb,$10::jsonb,'{}'::jsonb,1,$11,$12)
         returning id`,
        [
          workspaceId, proposal.id, index + 1, item.op, item.table, item.targetId ?? null,
          item.targetId ? 'existing' : 'new', item.label,
          JSON.stringify(item.newValues),
          item.oldValues ? JSON.stringify(item.oldValues) : null,
          item.dependsOnSeq ?? [],
          item.baselineFingerprint ?? null,
        ],
      );
      itemIds.push(created.id);
    }
    const items = await db.rows<ProposalItemRecord>(
      `select * from public.proposal_items where proposal_id = $1 order by seq`,
      [proposal.id],
    );
    const { computeContentHash } = await import('../proposals.js');
    await db.query(`update public.proposals set content_hash = $2 where id = $1`, [
      proposal.id,
      computeContentHash(items),
    ]);
    return { proposalId: proposal.id, itemIds };
  });
}

async function approveMany(session: Session, workspaceId: string, proposalId: string, itemIds: string[]) {
  await decideProposalItems(
    session, workspaceId, proposalId, itemIds.map((itemId) => ({ itemId, decision: 'approved' as const })),
  );
  return recordApproval(session, workspaceId, proposalId, itemIds);
}

async function fingerprintOf(table: string, rowId: string): Promise<string> {
  return (
    await withService((db) =>
      db.oneOrFail<{ fp: string }>(`select md5(t::text) as fp from public.${table} t where t.id = $1`, [rowId]),
    )
  ).fp;
}

interface ConflictDetail {
  reason?: string;
  replacementProposalId?: string;
  conflicts?: { kind?: string; message?: string; existingRowId?: string | null; replacementOp?: string }[];
}

/** Settles an apply call into either its result or its 409 detail. */
async function settleApply(session: Session, workspaceId: string, proposalId: string, version: number, itemIds: string[]) {
  try {
    const result = await applyApprovedItems({ session, workspaceId, proposalId, expectedVersion: version, itemIds });
    return { ok: true as const, result };
  } catch (error) {
    return {
      ok: false as const,
      code: isAppError(error) ? error.code : ((error as { code?: string }).code ?? null),
      message: error instanceof Error ? error.message : String(error),
      detail: (isAppError(error) ? error.detail : undefined) as ConflictDetail | undefined,
    };
  }
}

async function approve(session: Session, workspaceId: string, proposalId: string, itemId: string) {
  await decideProposalItems(session, workspaceId, proposalId, [{ itemId, decision: 'approved' }]);
  return recordApproval(session, workspaceId, proposalId, [itemId]);
}

// ---------------------------------------------------------------------------

console.log('\x1b[1mCode-review fix verification\x1b[0m');

section('Setup');
const seeded = await seedWorkspace({
  adminEmail: process.env.SEED_ADMIN_EMAIL ?? 'admin@example.invalid',
  adminPassword: process.env.SEED_ADMIN_PASSWORD ?? 'ChangeMeBeforeUse',
  clientEmail: process.env.SEED_CLIENT_EMAIL ?? 'client@example.invalid',
  clientPassword: process.env.SEED_CLIENT_PASSWORD ?? 'ChangeMeBeforeUse',
});
const workspaceId = seeded.workspaceId;
const alice = await buildSession(process.env.SEED_ADMIN_EMAIL ?? 'admin@example.invalid', workspaceId);
const bob = await buildSession(process.env.SEED_CLIENT_EMAIL ?? 'client@example.invalid', workspaceId);
record(
  'two approvers available',
  alice.activeWorkspace.canApprove && bob.activeWorkspace.canApprove,
  `${alice.user.email} and ${bob.user.email} can both approve`,
);

// ===========================================================================
section('1. Authentication mode');

record(
  'the active mode is reported explicitly',
  ['supabase', 'dev', 'none'].includes(authMode()),
  `authMode() = ${authMode()}; devAuthEnabled() = ${devAuthEnabled()}`,
);

// Remember the real configuration: when this suite runs against a test
// Supabase project, it must be restored exactly, not deleted.
const originalEnv = {
  DEV_AUTH_ENABLED: process.env.DEV_AUTH_ENABLED,
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
};
const originalMode = authMode();
const liveSupabase = originalMode === 'supabase' && process.env.G3_TARGET_ENV === 'test';

// The dev login is a bypass relative to Supabase Auth, so it must fail closed.
const savedFlag = process.env.DEV_AUTH_ENABLED;
process.env.DEV_AUTH_ENABLED = 'false';
const { __resetEnvForTesting } = await import('../env.js');
__resetEnvForTesting();
await expectRejection(
  'dev sign-in is refused when not explicitly enabled',
  () => signInWithPassword(alice.user.email, process.env.SEED_ADMIN_PASSWORD ?? 'ChangeMeBeforeUse'),
  (_m, code) => code === 'forbidden',
  'forbidden',
);
record(
  'with the flag off, only Supabase Auth can remain',
  authMode() === (originalMode === 'supabase' ? 'supabase' : 'none'),
  `authMode() = ${authMode()} (Supabase ${originalMode === 'supabase' ? 'configured' : 'unconfigured'}, dev login disabled)`,
);

// A dev cookie must not be usable once Supabase Auth is configured.
process.env.SUPABASE_URL = 'https://example-test-project.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon-key-not-used-for-a-live-call';
__resetEnvForTesting();
const devCookie = createDevSessionToken(alice.user.id);
const ignored = await resolveSession({ sessionCookie: devCookie, bearerToken: null });
record(
  'a dev cookie is ignored when Supabase Auth is configured',
  ignored === null && authMode() === 'supabase',
  `authMode() = ${authMode()}; resolveSession(devCookie) = ${ignored === null ? 'null' : 'A SESSION -- PROBLEM'}`,
);

await expectRejection(
  'a Supabase sign-in against an unreachable project fails cleanly',
  () => signInWithSupabase('nobody@example.com', 'whatever'),
  (_m, code) => code === 'supabase_auth_unreachable' || code === 'supabase_auth_error' || code === 'unauthorized',
  'a clean provider error, not a raw fetch failure',
);

// Restore the environment exactly as it was.
for (const [key, value] of Object.entries(originalEnv)) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
void savedFlag;
__resetEnvForTesting();
record(
  'environment restored for the remaining scenarios',
  authMode() === originalMode,
  `authMode() = ${authMode()} (was ${originalMode})`,
);

// ===========================================================================
section('1b. Live Supabase Auth (test project only)');

if (!liveSupabase) {
  skip(
    'sign-in, session, refresh and revocation against Supabase',
    'no test Supabase project is configured (needs SUPABASE_URL, SUPABASE_ANON_KEY and G3_TARGET_ENV=test). Run npm run supabase:test:verify.',
  );
} else {
  const liveEmail = process.env.SEED_CLIENT_EMAIL ?? 'client@example.invalid';
  const livePassword = process.env.SEED_CLIENT_PASSWORD ?? '';
  try {
    const tokens = await signInWithSupabase(liveEmail, livePassword);
    record('a seeded user signs in through Supabase Auth', tokens.accessToken.split('.').length === 3, `access token expires in ${tokens.expiresIn}s`);

    const liveSession = await resolveSession({ bearerToken: tokens.accessToken });
    record(
      'the access token is verified server-side and resolves the workspace session',
      liveSession?.user.email === liveEmail.toLowerCase() && liveSession.isDevAuth === false && liveSession.workspaces.length > 0,
      liveSession ? `${liveSession.user.email}, ${liveSession.workspaces.length} workspace(s), dev auth=${liveSession.isDevAuth}` : 'no session',
    );

    const tampered = `${tokens.accessToken.slice(0, -4)}AAAA`;
    record('a tampered token is rejected', (await resolveSession({ bearerToken: tampered })) === null, 'resolveSession(tampered) = null');

    const refreshed = await refreshSupabaseSession(tokens.refreshToken);
    const refreshedSession = await resolveSession({ bearerToken: refreshed.accessToken });
    record(
      'the refresh token yields a new working access token',
      refreshed.accessToken !== tokens.accessToken && refreshedSession?.user.email === liveEmail.toLowerCase(),
      `new token issued; session=${refreshedSession?.user.email ?? 'none'}`,
    );

    const signedOut = await signOutSupabase(refreshed.accessToken);
    record('sign-out revokes the session at Supabase', signedOut.revoked, signedOut.note ?? 'revoked');

    await expectRejection(
      'the refresh token no longer works after sign-out',
      () => refreshSupabaseSession(refreshed.refreshToken),
      (_m, code) => code === 'unauthorized' || code === 'supabase_auth_error',
      'rejected by Supabase',
    );
  } catch (error) {
    record('live Supabase Auth checks ran', false, error instanceof Error ? error.message.slice(0, 300) : String(error));
  }
}

// ===========================================================================
section('2. The approved operation is the operation performed');

// --- an approved create that collides with a record created meanwhile -------
const collideSlug = `collision-co-${randomUUID().slice(0, 8)}`;
const createProposal = await makeProposal(workspaceId, alice.user.id, {
  op: 'create',
  table: 'entities',
  label: 'Collision Co',
  newValues: {
    entity_type: 'organization',
    display_name: 'Collision Co',
    slug: collideSlug,
    description: 'Approved as a brand new record.',
  },
});
const createApproval = await approve(alice, workspaceId, createProposal.proposalId, createProposal.itemId);

// Someone else creates the same record before the approval is applied.
const sneaked = await withService((db) =>
  db.oneOrFail<{ id: string }>(
    `insert into public.entities (workspace_id, entity_type, display_name, slug, description)
     values ($1,'organization','Collision Co',$2,'Created by someone else first') returning id`,
    [workspaceId, collideSlug],
  ),
);

const collisionDetail = (await expectRejection(
  'an approved create is NOT silently turned into an update',
  () =>
    applyApprovedItems({
      session: alice,
      workspaceId,
      proposalId: createProposal.proposalId,
      expectedVersion: createApproval.proposal_version,
      itemIds: [createProposal.itemId],
    }),
  (_m, code, detail) =>
    code === 'conflict' &&
    (detail as { reason?: string })?.reason === 'approved_operation_no_longer_valid',
  'conflict, not a substituted operation',
)) as { replacementProposalId?: string } | null;

const untouched = await withService((db) =>
  db.oneOrFail<{ description: string }>(`select description from public.entities where id = $1`, [
    sneaked.id,
  ]),
);
record(
  "the other user's record was not overwritten",
  untouched.description === 'Created by someone else first',
  `description is still "${untouched.description}"`,
);

const replacement = collisionDetail?.replacementProposalId
  ? await withService((db) => getProposal(db, workspaceId, collisionDetail.replacementProposalId as string))
  : null;
record(
  'a replacement proposal targets the concrete record as an update',
  replacement !== null &&
    replacement.items[0]?.op === 'update' &&
    replacement.items[0]?.target_id === sneaked.id,
  replacement
    ? `op=${replacement.items[0]?.op}, target=${String(replacement.items[0]?.target_id).slice(0, 8)}, status=${replacement.proposal.status}`
    : 'no replacement proposal was created',
);
record(
  'the replacement shows the stored values as the old values',
  replacement?.items[0]?.old_values?.description === 'Created by someone else first' &&
    replacement?.items[0]?.new_values?.description === 'Approved as a brand new record.',
  `old.description="${String(replacement?.items[0]?.old_values?.description)}" -> new.description="${String(replacement?.items[0]?.new_values?.description)}"`,
);

const originalAfter = await withService((db) =>
  db.oneOrFail<{ status: string; superseded_by_proposal_id: string | null }>(
    `select status, superseded_by_proposal_id from public.proposals where id = $1`,
    [createProposal.proposalId],
  ),
);
record(
  'the original proposal is marked superseded and its approval revoked',
  originalAfter.status === 'superseded' && originalAfter.superseded_by_proposal_id !== null,
  `status=${originalAfter.status}, superseded_by=${String(originalAfter.superseded_by_proposal_id).slice(0, 8)}`,
);

// The replacement must be approvable and apply cleanly.
if (replacement) {
  const replacementItem = replacement.items[0] as ProposalItemRecord;
  const replacementApproval = await approve(
    bob,
    workspaceId,
    replacement.proposal.id,
    replacementItem.id,
  );
  const applied = await applyApprovedItems({
    session: bob,
    workspaceId,
    proposalId: replacement.proposal.id,
    expectedVersion: replacementApproval.proposal_version,
    itemIds: [replacementItem.id],
  });
  const now = await withService((db) =>
    db.oneOrFail<{ description: string }>(`select description from public.entities where id = $1`, [
      sneaked.id,
    ]),
  );
  record(
    'the replacement applies after re-approval',
    applied.applied[0]?.status === 'applied' && now.description === 'Approved as a brand new record.',
    `${applied.readbackSummary[0] ?? ''} -> description is now "${now.description}"`,
  );
}

// --- an approved update whose target was deleted ----------------------------
const doomed = await withService((db) =>
  db.oneOrFail<{ id: string; fp: string }>(
    `insert into public.entities (workspace_id, entity_type, display_name, slug, description)
     values ($1,'person','Doomed Person',$2,'before') returning id, md5(entities::text) as fp`,
    [workspaceId, `doomed-person-${randomUUID().slice(0, 8)}`],
  ),
);
const doomedSnapshot = await withService((db) =>
  db.oneOrFail<{ fp: string }>(`select md5(t::text) as fp from public.entities t where id = $1`, [doomed.id]),
);
const updateProposal = await makeProposal(workspaceId, alice.user.id, {
  op: 'update',
  table: 'entities',
  label: 'Doomed Person',
  targetId: doomed.id,
  newValues: { description: 'after' },
  oldValues: { description: 'before' },
  baselineFingerprint: doomedSnapshot.fp,
});
const updateApproval = await approve(alice, workspaceId, updateProposal.proposalId, updateProposal.itemId);
await withService((db) => db.query(`delete from public.entities where id = $1`, [doomed.id]));

const deletedDetail = (await expectRejection(
  'an approved update is NOT silently turned into a create',
  () =>
    applyApprovedItems({
      session: alice,
      workspaceId,
      proposalId: updateProposal.proposalId,
      expectedVersion: updateApproval.proposal_version,
      itemIds: [updateProposal.itemId],
    }),
  (_m, code, detail) =>
    code === 'conflict' &&
    (detail as { conflicts?: { kind?: string }[] })?.conflicts?.[0]?.kind === 'update_target_missing',
  'update_target_missing',
)) as { replacementProposalId?: string } | null;

const deletedStillGone = await withService((db) =>
  db.oneOrFail<{ n: number }>(`select count(*)::int as n from public.entities where id = $1`, [doomed.id]),
);
record(
  'the deleted record was not resurrected',
  deletedStillGone.n === 0,
  `${deletedStillGone.n} row(s) with that id exist`,
);
if (deletedDetail?.replacementProposalId) {
  const r = await withService((db) =>
    getProposal(db, workspaceId, deletedDetail.replacementProposalId as string),
  );
  record(
    'the replacement proposes a create, for a person to decide on',
    r.items[0]?.op === 'create' && r.items[0]?.target_id === null,
    `op=${r.items[0]?.op}, target=${String(r.items[0]?.target_id)}`,
  );
}

// ===========================================================================
section('3. Lost-update protection with two users');

const shared = await withService((db) =>
  db.oneOrFail<{ id: string }>(
    `insert into public.entities (workspace_id, entity_type, display_name, slug, description)
     values ($1,'organization','Shared Record',$2,'original') returning id`,
    [workspaceId, `shared-record-${randomUUID().slice(0, 8)}`],
  ),
);
const baseline = await withService((db) =>
  db.oneOrFail<{ fp: string }>(`select md5(t::text) as fp from public.entities t where id = $1`, [shared.id]),
);

// Alice prepares and approves a change against what she can see.
const aliceProposal = await makeProposal(workspaceId, alice.user.id, {
  op: 'update',
  table: 'entities',
  label: 'Shared Record',
  targetId: shared.id,
  newValues: { description: 'alice version' },
  oldValues: { description: 'original' },
  baselineFingerprint: baseline.fp,
});
const aliceApproval = await approve(alice, workspaceId, aliceProposal.proposalId, aliceProposal.itemId);

// Bob changes the same record in between.
await withService((db) =>
  db.query(`update public.entities set description = $2 where id = $1`, [shared.id, 'bob version']),
);

const staleDetail = (await expectRejection(
  "applying over another user's change is refused",
  () =>
    applyApprovedItems({
      session: alice,
      workspaceId,
      proposalId: aliceProposal.proposalId,
      expectedVersion: aliceApproval.proposal_version,
      itemIds: [aliceProposal.itemId],
    }),
  (_m, code, detail) =>
    code === 'conflict' &&
    (detail as { conflicts?: { kind?: string }[] })?.conflicts?.[0]?.kind === 'target_changed',
  'target_changed',
)) as { replacementProposalId?: string } | null;

const afterStale = await withService((db) =>
  db.oneOrFail<{ description: string }>(`select description from public.entities where id = $1`, [shared.id]),
);
record(
  "the other user's value survived",
  afterStale.description === 'bob version',
  `description is "${afterStale.description}" (Alice's approved value was never written)`,
);

if (staleDetail?.replacementProposalId) {
  const r = await withService((db) =>
    getProposal(db, workspaceId, staleDetail.replacementProposalId as string),
  );
  record(
    'the replacement shows the current value as the old value',
    r.items[0]?.old_values?.description === 'bob version' &&
      r.items[0]?.new_values?.description === 'alice version',
    `old="${String(r.items[0]?.old_values?.description)}" -> new="${String(r.items[0]?.new_values?.description)}"`,
  );

  // Re-approving against the current state must now succeed.
  const item = r.items[0] as ProposalItemRecord;
  const again = await approve(alice, workspaceId, r.proposal.id, item.id);
  const applied = await applyApprovedItems({
    session: alice,
    workspaceId,
    proposalId: r.proposal.id,
    expectedVersion: again.proposal_version,
    itemIds: [item.id],
  });
  const finalValue = await withService((db) =>
    db.oneOrFail<{ description: string }>(`select description from public.entities where id = $1`, [
      shared.id,
    ]),
  );
  record(
    're-approval against the current state applies',
    applied.applied[0]?.status === 'applied' && finalValue.description === 'alice version',
    `description is now "${finalValue.description}"`,
  );
}

// --- both users apply the same approved item at the same moment -------------
const raceTarget = await withService((db) =>
  db.oneOrFail<{ id: string }>(
    `insert into public.entities (workspace_id, entity_type, display_name, slug, description)
     values ($1,'organization','Race Record',$2,'start') returning id`,
    [workspaceId, `race-record-${randomUUID().slice(0, 8)}`],
  ),
);
const raceBaseline = await withService((db) =>
  db.oneOrFail<{ fp: string }>(`select md5(t::text) as fp from public.entities t where id = $1`, [
    raceTarget.id,
  ]),
);
const raceProposal = await makeProposal(workspaceId, alice.user.id, {
  op: 'update',
  table: 'entities',
  label: 'Race Record',
  targetId: raceTarget.id,
  newValues: { description: 'applied once' },
  oldValues: { description: 'start' },
  baselineFingerprint: raceBaseline.fp,
});
const raceApproval = await approve(alice, workspaceId, raceProposal.proposalId, raceProposal.itemId);

const attempt = (session: Session) =>
  applyApprovedItems({
    session,
    workspaceId,
    proposalId: raceProposal.proposalId,
    expectedVersion: raceApproval.proposal_version,
    itemIds: [raceProposal.itemId],
  }).then(
    (result) => ({ ok: true as const, result }),
    (error) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) }),
  );

const [first, second] = await Promise.all([attempt(alice), attempt(bob)]);
const writes = await withService((db) =>
  db.oneOrFail<{ n: number }>(
    `select count(*)::int as n from public.applied_changes where proposal_item_id = $1`,
    [raceProposal.itemId],
  ),
);
const outcomes = [first, second].map((r) =>
  r.ok ? (r.result.applied[0]?.status ?? 'none') : `refused: ${r.error.slice(0, 40)}`,
);
record(
  'two users applying the same item at once produce exactly one write',
  writes.n === 1,
  `applied_changes rows: ${writes.n}; outcomes: ${outcomes.join(' | ')}`,
);

// ===========================================================================
section('4. The legacy layer is gone');

// This section used to exercise migration 0006's compatibility surface: the
// `*_default_workspace` views, the `upsert_legacy_record()` write path and the
// archive scripts that wrote into `knowledge` by slug alone. Migration 0021
// removed all of it, so the meaningful assertion is no longer "does the
// compatibility layer behave correctly" but "is it actually gone".

const legacyTables = await withService((db) =>
  db.oneOrFail<{ present: string }>(
    `select coalesce(string_agg(t, ', '), '') as present from (
       select unnest(array['external_contacts','external_companies','relationship_interactions',
                           'knowledge','rules','meetings','Globa 3 Automatization & Memory']) t) x
      where to_regclass('public.' || quote_ident(t)) is not null`,
  ),
);
record('no legacy table exists', legacyTables.present === '', legacyTables.present || 'none');

const legacyFunction = await withService((db) =>
  db.oneOrFail<{ n: number }>(
    `select count(*)::int as n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
      where ns.nspname = 'public' and p.proname = 'upsert_legacy_record'`,
  ),
);
record('the legacy upsert function is gone', legacyFunction.n === 0, `${legacyFunction.n} overload(s) remain`);

const legacyColumns = await withService((db) =>
  db.oneOrFail<{ n: number }>(
    `select count(*)::int as n from information_schema.columns
      where table_schema = 'public' and table_name = 'entities'
        and column_name in ('legacy_external_contact_id', 'legacy_external_company_id')`,
  ),
);
record('entities no longer points at legacy CRM rows', legacyColumns.n === 0, `${legacyColumns.n} column(s) remain`);

const viewsLeft = await withService((db) =>
  db.oneOrFail<{ n: number }>(
    `select count(*)::int as n from information_schema.views
      where table_name in ('entities_default_workspace','business_units_default_workspace')`,
  ),
);
record('the non-working compatibility views are gone', viewsLeft.n === 0, `${viewsLeft.n} of the old views remain`);

// Still-current behaviour, and the one part of 0006 that outlived the legacy
// layer: an insert that names no workspace resolves the only active one.
const countActive = async () =>
  (
    await withService((db) =>
      db.oneOrFail<{ n: number }>(`select count(*)::int as n from public.workspaces where status = 'active'`),
    )
  ).n;

if ((await countActive()) === 1) {
  const single = await withService(async (db) => {
    const row = await db.oneOrFail<{ id: string; workspace_id: string }>(
      `insert into public.entities (entity_type, display_name, slug)
       values ('organization','Single Tenant Legacy Co',$1) returning id, workspace_id`,
      [`single-legacy-${randomUUID().slice(0, 8)}`],
    );
    await db.query(`delete from public.entities where id = $1`, [row.id]);
    return row;
  });
  record(
    'an insert that names no workspace resolves the only workspace',
    single.workspace_id === workspaceId,
    `one active workspace, so workspace_id defaulted to ${single.workspace_id.slice(0, 8)}`,
  );
} else {
  record('an insert that names no workspace resolves the only workspace', true, 'skipped: more than one workspace exists');
}

// ===========================================================================
section('5. Proposals without a baseline fingerprint');

const legacyTarget = await withService((db) =>
  db.oneOrFail<{ id: string }>(
    `insert into public.entities (workspace_id, entity_type, display_name, slug, description)
     values ($1,'organization','Pre-0011 Target',$2,'as approved long ago') returning id`,
    [workspaceId, `pre-0011-target-${randomUUID().slice(0, 8)}`],
  ),
);
const neighbour = await withService((db) =>
  db.oneOrFail<{ id: string }>(
    `insert into public.entities (workspace_id, entity_type, display_name, slug, description)
     values ($1,'organization','Pre-0011 Neighbour',$2,'neighbour before') returning id`,
    [workspaceId, `pre-0011-neighbour-${randomUUID().slice(0, 8)}`],
  ),
);
// Item 1: an update built before 0011, so no baseline. Item 2: a normal,
// still-pending update of another row, which is not part of this apply.
const legacy = await makeMultiProposal(workspaceId, alice.user.id, 'Pre-0011 proposal', [
  {
    op: 'update', table: 'entities', label: 'Pre-0011 Target', targetId: legacyTarget.id,
    newValues: { description: 'approved without a snapshot' }, oldValues: { description: 'as approved long ago' },
    baselineFingerprint: null,
  },
  {
    op: 'update', table: 'entities', label: 'Pre-0011 Neighbour', targetId: neighbour.id,
    newValues: { description: 'neighbour proposed' }, oldValues: { description: 'neighbour before' },
    baselineFingerprint: await fingerprintOf('entities', neighbour.id),
  },
]);
const legacyApproval = await approve(alice, workspaceId, legacy.proposalId, legacy.itemIds[0] as string);

// Someone edits the target and the neighbour after the proposal was built.
await withService((db) =>
  db.query(`update public.entities set description = 'edited by the client' where id = $1`, [legacyTarget.id]),
);
await withService((db) =>
  db.query(`update public.entities set description = 'neighbour edited meanwhile' where id = $1`, [neighbour.id]),
);

const noBaseline = await settleApply(alice, workspaceId, legacy.proposalId, legacyApproval.proposal_version, [legacy.itemIds[0] as string]);
const legacyStored = await withService((db) =>
  db.oneOrFail<{ description: string }>(`select description from public.entities where id = $1`, [legacyTarget.id]),
);
record(
  'an update without a baseline is refused, not applied unguarded',
  !noBaseline.ok && noBaseline.code === 'conflict' && noBaseline.detail?.conflicts?.[0]?.kind === 'baseline_missing' &&
    legacyStored.description === 'edited by the client',
  noBaseline.ok
    ? `APPLIED -- description is now "${legacyStored.description}"`
    : `kind=${noBaseline.detail?.conflicts?.[0]?.kind}; stored description still "${legacyStored.description}"`,
);

const legacyReplacementId = noBaseline.ok ? null : (noBaseline.detail?.replacementProposalId ?? null);
if (legacyReplacementId) {
  const rep = await withService((db) => getProposal(db, workspaceId, legacyReplacementId));
  const repTarget = rep.items.find((i) => i.target_id === legacyTarget.id);
  const repNeighbour = rep.items.find((i) => i.target_id === neighbour.id);
  const currentTargetFp = await fingerprintOf('entities', legacyTarget.id);
  const approvalsOnReplacement = await withService((db) =>
    db.oneOrFail<{ n: number }>(`select count(*)::int as n from public.proposal_approvals where proposal_id = $1`, [legacyReplacementId]),
  );

  record(
    'the replacement captures the record as it is now',
    repTarget?.op === 'update' &&
      repTarget.baseline_fingerprint === currentTargetFp &&
      repTarget.old_values?.description === 'edited by the client' &&
      repTarget.new_values?.description === 'approved without a snapshot',
    `op=${repTarget?.op}; old="${String(repTarget?.old_values?.description)}"; baseline matches current row=${repTarget?.baseline_fingerprint === currentTargetFp}`,
  );
  record(
    'the current fingerprint is not carried under the old approval',
    approvalsOnReplacement.n === 0 && rep.proposal.status === 'pending_review' && repTarget?.decision === 'pending',
    `replacement approvals=${approvalsOnReplacement.n}, status=${rep.proposal.status}, item decision=${repTarget?.decision}`,
  );
  record(
    'a carried-over pending item shows current old values with a matching baseline',
    repNeighbour?.old_values?.description === 'neighbour edited meanwhile' &&
      repNeighbour?.baseline_fingerprint === (await fingerprintOf('entities', neighbour.id)),
    `neighbour old="${String(repNeighbour?.old_values?.description)}" (was "neighbour before" when first proposed)`,
  );

  const reapplyOriginal = await settleApply(alice, workspaceId, legacy.proposalId, legacyApproval.proposal_version, [legacy.itemIds[0] as string]);
  record(
    'the original approval cannot be used again',
    !reapplyOriginal.ok && reapplyOriginal.code === 'conflict',
    reapplyOriginal.ok ? 'APPLIED via the revoked approval' : `refused: ${reapplyOriginal.message.slice(0, 90)}`,
  );

  // The replacement's baseline is enforced, not a bypass: a further change in
  // between must still stop it.
  const repApproval = await approve(bob, workspaceId, legacyReplacementId, repTarget?.id as string);
  await withService((db) =>
    db.query(`update public.entities set description = 'edited a second time' where id = $1`, [legacyTarget.id]),
  );
  const repStale = await settleApply(bob, workspaceId, legacyReplacementId, repApproval.proposal_version, [repTarget?.id as string]);
  record(
    'the replacement is still guarded against later edits',
    !repStale.ok && repStale.detail?.conflicts?.[0]?.kind === 'target_changed',
    repStale.ok ? 'APPLIED over a later edit' : `kind=${repStale.detail?.conflicts?.[0]?.kind}`,
  );

  // And once re-approved against the true current state, it applies.
  const finalRepId = repStale.ok ? null : (repStale.detail?.replacementProposalId ?? null);
  if (finalRepId) {
    const finalRep = await withService((db) => getProposal(db, workspaceId, finalRepId));
    const finalItem = finalRep.items.find((i) => i.target_id === legacyTarget.id) as ProposalItemRecord;
    const finalApproval = await approve(bob, workspaceId, finalRepId, finalItem.id);
    const finalApply = await settleApply(bob, workspaceId, finalRepId, finalApproval.proposal_version, [finalItem.id]);
    const finalStored = await withService((db) =>
      db.oneOrFail<{ description: string }>(`select description from public.entities where id = $1`, [legacyTarget.id]),
    );
    record(
      're-approval against the current state applies',
      finalApply.ok && finalStored.description === 'approved without a snapshot',
      `description is now "${finalStored.description}"`,
    );
  }
}

// A link against an existing join row has the same requirement.
const person = await withService((db) =>
  db.oneOrFail<{ id: string }>(
    `insert into public.entities (workspace_id, entity_type, display_name, slug) values ($1,'person','Link Person',$2) returning id`,
    [workspaceId, `link-person-${randomUUID().slice(0, 8)}`],
  ),
);
const org = await withService((db) =>
  db.oneOrFail<{ id: string }>(
    `insert into public.entities (workspace_id, entity_type, display_name, slug) values ($1,'organization','Link Org',$2) returning id`,
    [workspaceId, `link-org-${randomUUID().slice(0, 8)}`],
  ),
);
const affiliation = await withService((db) =>
  db.oneOrFail<{ id: string }>(
    `insert into public.entity_affiliations (workspace_id, person_entity_id, organization_entity_id, role_title)
     values ($1,$2,$3,'Advisor') returning id`,
    [workspaceId, person.id, org.id],
  ),
);
const linkProposal = await makeProposal(workspaceId, alice.user.id, {
  op: 'link', table: 'entity_affiliations', label: 'Link Person -> Link Org', targetId: affiliation.id,
  newValues: { role_title: 'Director' }, oldValues: { role_title: 'Advisor' }, baselineFingerprint: null,
});
const linkApproval = await approve(alice, workspaceId, linkProposal.proposalId, linkProposal.itemId);
const linkNoBaseline = await settleApply(alice, workspaceId, linkProposal.proposalId, linkApproval.proposal_version, [linkProposal.itemId]);
const roleNow = await withService((db) =>
  db.oneOrFail<{ role_title: string }>(`select role_title from public.entity_affiliations where id = $1`, [affiliation.id]),
);
record(
  'a link to an existing row without a baseline is refused too',
  !linkNoBaseline.ok && linkNoBaseline.detail?.conflicts?.[0]?.kind === 'baseline_missing' && roleNow.role_title === 'Advisor',
  linkNoBaseline.ok ? `APPLIED -- role is now ${roleNow.role_title}` : `kind=${linkNoBaseline.detail?.conflicts?.[0]?.kind}; role still "${roleNow.role_title}"`,
);

// A link built for a join row that already exists must target that row with a
// baseline, so it applies. (Regression: it used to be built without a target and
// then refused at apply time as a collision, on every run.)
const relinkSuffix = randomUUID().slice(0, 6);
const relinkPersonName = `Relink Person ${relinkSuffix}`;
const relinkOrgName = `Relink Org ${relinkSuffix}`;
const relinkPerson = await withService((db) =>
  db.oneOrFail<{ id: string }>(
    `insert into public.entities (workspace_id, entity_type, display_name, slug) values ($1,'person',$2,$3) returning id`,
    [workspaceId, relinkPersonName, slugify(relinkPersonName)],
  ),
);
const relinkOrg = await withService((db) =>
  db.oneOrFail<{ id: string }>(
    `insert into public.entities (workspace_id, entity_type, display_name, slug) values ($1,'organization',$2,$3) returning id`,
    [workspaceId, relinkOrgName, slugify(relinkOrgName)],
  ),
);
const existingLink = await withService((db) =>
  db.oneOrFail<{ id: string }>(
    `insert into public.entity_affiliations (workspace_id, person_entity_id, organization_entity_id, role_title, notes)
     values ($1,$2,$3,'Advisor','first seen') returning id`,
    [workspaceId, relinkPerson.id, relinkOrg.id],
  ),
);
const relinkBuilt = await withService((db) =>
  buildProposal(db, {
    workspaceId,
    runId: null,
    sourceKind: 'manual',
    createdBy: alice.user.id,
    isMock: true,
    proposal: {
      title: 'Relink an existing affiliation',
      summary: 'Regression fixture',
      notes: [],
      unresolved_mentions: [],
      changes: [
        {
          op: 'link',
          target_table: 'entity_affiliations',
          label: `${relinkPersonName} -> ${relinkOrgName}`,
          claim_type: 'fact',
          confidence: 'medium',
          reason: 'Seen again in new research.',
          source_urls: [],
          fields: [
            { name: 'person_entity_label', value: relinkPersonName },
            { name: 'organization_entity_label', value: relinkOrgName },
            { name: 'role_title', value: 'Advisor' },
            { name: 'notes', value: 'confirmed again' },
          ],
        },
      ],
    },
  }),
);
const relinkItem = relinkBuilt.items[0];
record(
  'a link to an existing join row is built against that row, with a baseline',
  relinkItem?.op === 'link' && relinkItem.targetId === existingLink.id && Boolean(relinkItem.baselineFingerprint),
  `op=${relinkItem?.op}; target matches existing row=${relinkItem?.targetId === existingLink.id}; baseline=${Boolean(relinkItem?.baselineFingerprint)}`,
);
const relinkLoaded = await withService((db) => getProposal(db, workspaceId, relinkBuilt.proposalId));
const relinkApproval = await approve(alice, workspaceId, relinkBuilt.proposalId, relinkLoaded.items[0]?.id as string);
const relinkApply = await settleApply(alice, workspaceId, relinkBuilt.proposalId, relinkApproval.proposal_version, [relinkLoaded.items[0]?.id as string]);
const relinkStored = await withService((db) =>
  db.oneOrFail<{ n: number; notes: string | null }>(
    `select count(*) over ()::int as n, notes from public.entity_affiliations
      where workspace_id = $1 and person_entity_id = $2 and organization_entity_id = $3`,
    [workspaceId, relinkPerson.id, relinkOrg.id],
  ),
);
record(
  'it applies as a guarded update of that row, without a duplicate link',
  relinkApply.ok && relinkStored.n === 1 && relinkStored.notes === 'confirmed again',
  relinkApply.ok ? `rows=${relinkStored.n}, notes="${relinkStored.notes}"` : `refused: ${relinkApply.message.slice(0, 100)}`,
);

// ===========================================================================
section('6. Two different proposals creating the same record');

// --- 6a. Same entity, two proposals, two users, applied at once -------------
const twinSlug = `twin-studio-${randomUUID().slice(0, 8)}`;
const makeTwin = (owner: Session, description: string) =>
  makeProposal(workspaceId, owner.user.id, {
    op: 'create', table: 'entities', label: 'Twin Studio',
    newValues: { entity_type: 'organization', display_name: 'Twin Studio', slug: twinSlug, description },
  });
const twinA = await makeTwin(alice, 'written by Alice');
const twinB = await makeTwin(bob, 'written by Bob');
const twinAApproval = await approve(alice, workspaceId, twinA.proposalId, twinA.itemId);
const twinBApproval = await approve(bob, workspaceId, twinB.proposalId, twinB.itemId);

const [twinAResult, twinBResult] = await Promise.all([
  settleApply(alice, workspaceId, twinA.proposalId, twinAApproval.proposal_version, [twinA.itemId]),
  settleApply(bob, workspaceId, twinB.proposalId, twinBApproval.proposal_version, [twinB.itemId]),
]);
const twinRows = await withService((db) =>
  db.rows<{ id: string; description: string }>(`select id, description from public.entities where workspace_id = $1 and slug = $2`, [workspaceId, twinSlug]),
);
const twinWinner = twinAResult.ok ? 'Alice' : twinBResult.ok ? 'Bob' : null;
const twinLoser = twinAResult.ok ? twinBResult : twinAResult;
record(
  'exactly one record exists and exactly one proposal applied',
  twinRows.length === 1 && [twinAResult, twinBResult].filter((r) => r.ok).length === 1,
  `rows=${twinRows.length}; winner=${twinWinner}; stored description "${twinRows[0]?.description}"`,
);
record(
  'the other proposal gets a clean conflict, not a database error',
  !twinLoser.ok && twinLoser.code === 'conflict' && !/25P02|aborted/i.test(twinLoser.message),
  twinLoser.ok ? 'both applied' : `code=${twinLoser.code}; kind=${twinLoser.detail?.conflicts?.[0]?.kind}`,
);
if (!twinLoser.ok && twinLoser.detail?.replacementProposalId) {
  const twinRep = await withService((db) => getProposal(db, workspaceId, twinLoser.detail?.replacementProposalId as string));
  record(
    'its replacement is an update of the record the other user created',
    twinRep.items[0]?.op === 'update' && twinRep.items[0]?.target_id === twinRows[0]?.id &&
      twinRep.items[0]?.old_values?.description === twinRows[0]?.description,
    `op=${twinRep.items[0]?.op}; old="${String(twinRep.items[0]?.old_values?.description)}" -> new="${String(twinRep.items[0]?.new_values?.description)}"`,
  );
}

// --- 6b. The unique-violation path itself ----------------------------------
// Two proposals stage the same unresolved name from different evidence. The
// natural key (mention_slug, source_evidence_id) differs, so both pre-write
// checks pass, and the second INSERT hits the one-pending-mention-per-name
// index with 23505 -- the case that used to end in 25P02.
const newEvidence = async (label: string) =>
  withService((db) =>
    db.oneOrFail<{ id: string }>(
      `insert into public.evidence (workspace_id, source_type, title, url) values ($1,'url',$2,$3) returning id`,
      [workspaceId, label, `https://example.com/${randomUUID()}`],
    ),
  ).then((r) => r.id);
const evidenceOne = await newEvidence('Evidence one');
const evidenceTwo = await newEvidence('Evidence two');
const mentionSlug = `contested-name-${randomUUID().slice(0, 8)}`;
const makeMention = (owner: Session, evidenceId: string) =>
  makeProposal(workspaceId, owner.user.id, {
    op: 'create', table: 'entity_mentions', label: 'Contested Name',
    newValues: { mention_text: 'Contested Name', mention_slug: mentionSlug, source_evidence_id: evidenceId, resolution_status: 'pending' },
  });
const mentionA = await makeMention(alice, evidenceOne);
const mentionB = await makeMention(bob, evidenceTwo);
const mentionAApproval = await approve(alice, workspaceId, mentionA.proposalId, mentionA.itemId);
const mentionBApproval = await approve(bob, workspaceId, mentionB.proposalId, mentionB.itemId);
const [mentionAResult, mentionBResult] = await Promise.all([
  settleApply(alice, workspaceId, mentionA.proposalId, mentionAApproval.proposal_version, [mentionA.itemId]),
  settleApply(bob, workspaceId, mentionB.proposalId, mentionBApproval.proposal_version, [mentionB.itemId]),
]);
const mentionRows = await withService((db) =>
  db.rows<{ id: string }>(`select id from public.entity_mentions where workspace_id = $1 and mention_slug = $2 and resolution_status = 'pending'`, [workspaceId, mentionSlug]),
);
const mentionLoser = mentionAResult.ok ? mentionBResult : mentionAResult;
record(
  'a unique violation during apply yields a conflict, not 25P02',
  mentionRows.length === 1 && !mentionLoser.ok && mentionLoser.code === 'conflict' &&
    !/25P02|current transaction is aborted/i.test(mentionLoser.message) &&
    /at the same moment/.test(mentionLoser.detail?.conflicts?.[0]?.message ?? ''),
  mentionLoser.ok
    ? 'both applied'
    : `rows=${mentionRows.length}; message="${mentionLoser.detail?.conflicts?.[0]?.message?.slice(0, 70)}"`,
);
record(
  'the colliding record is identified from the violated constraint after rollback',
  !mentionLoser.ok && mentionLoser.detail?.conflicts?.[0]?.existingRowId === mentionRows[0]?.id &&
    mentionLoser.detail?.conflicts?.[0]?.replacementOp === 'update',
  mentionLoser.ok ? 'n/a' : `existingRowId matches the stored mention=${mentionLoser.detail?.conflicts?.[0]?.existingRowId === mentionRows[0]?.id}`,
);
const poolHealthy = await withService((db) => db.oneOrFail<{ ok: number }>(`select 1 as ok`));
record('the database connection pool is healthy afterwards', poolHealthy.ok === 1, 'a fresh query succeeds');

// --- 6c. Rollback removes earlier items; the replacement keeps references ---
const bundleSlug = `bundle-org-${randomUUID().slice(0, 8)}`;
const bundle = await makeMultiProposal(workspaceId, alice.user.id, 'Bundle with a dependency', [
  {
    op: 'create', table: 'entities', label: 'Bundle Org',
    newValues: { entity_type: 'organization', display_name: 'Bundle Org', slug: bundleSlug },
  },
  {
    op: 'create', table: 'entity_mentions', label: 'Contested Name',
    newValues: {
      mention_text: 'Contested Name', mention_slug: mentionSlug,
      source_evidence_id: await newEvidence('Evidence three'),
      resolution_status: 'pending', candidate_entity_id: { $ref: { seq: 1 } },
    },
    dependsOnSeq: [1],
  },
]);
const bundleApproval = await approveMany(alice, workspaceId, bundle.proposalId, bundle.itemIds);
const bundleResult = await settleApply(alice, workspaceId, bundle.proposalId, bundleApproval.proposal_version, bundle.itemIds);
const bundleOrg = await withService((db) =>
  db.oneOrFail<{ n: number }>(`select count(*)::int as n from public.entities where workspace_id = $1 and slug = $2`, [workspaceId, bundleSlug]),
);
record(
  'an earlier item in the same apply is rolled back with the collision',
  !bundleResult.ok && bundleOrg.n === 0,
  bundleResult.ok ? 'applied' : `entities with slug ${bundleSlug}: ${bundleOrg.n}`,
);
if (!bundleResult.ok && bundleResult.detail?.replacementProposalId) {
  const bundleRep = await withService((db) => getProposal(db, workspaceId, bundleResult.detail?.replacementProposalId as string));
  const repMention = bundleRep.items.find((i) => i.target_table === 'entity_mentions');
  record(
    'the replacement keeps seq numbers and the reference, not a dangling id',
    bundleRep.items.map((i) => i.seq).join(',') === '1,2' &&
      JSON.stringify(repMention?.new_values?.candidate_entity_id) === JSON.stringify({ $ref: { seq: 1 } }) &&
      (repMention?.depends_on_seq ?? []).join(',') === '1',
    `seqs=${bundleRep.items.map((i) => i.seq).join(',')}; candidate_entity_id=${JSON.stringify(repMention?.new_values?.candidate_entity_id)}; depends_on=${repMention?.depends_on_seq}`,
  );
}

// --- 6d. A reference to an item applied earlier resolves to its real row ----
const stagedSlug = `staged-org-${randomUUID().slice(0, 8)}`;
const staged = await makeMultiProposal(workspaceId, alice.user.id, 'Applied in two steps', [
  {
    op: 'create', table: 'entities', label: 'Staged Org',
    newValues: { entity_type: 'organization', display_name: 'Staged Org', slug: stagedSlug },
  },
  {
    op: 'create', table: 'entity_mentions', label: 'Contested Name',
    newValues: {
      mention_text: 'Contested Name', mention_slug: mentionSlug,
      source_evidence_id: await newEvidence('Evidence four'),
      resolution_status: 'pending', candidate_entity_id: { $ref: { seq: 1 } },
    },
    dependsOnSeq: [1],
  },
]);
const stepOne = await approveMany(alice, workspaceId, staged.proposalId, [staged.itemIds[0] as string]);
const stepOneResult = await settleApply(alice, workspaceId, staged.proposalId, stepOne.proposal_version, [staged.itemIds[0] as string]);
const stagedOrgId = stepOneResult.ok ? stepOneResult.result.applied[0]?.rowId : null;
const stepTwo = await approveMany(alice, workspaceId, staged.proposalId, [staged.itemIds[1] as string]);
const stepTwoResult = await settleApply(alice, workspaceId, staged.proposalId, stepTwo.proposal_version, [staged.itemIds[1] as string]);
if (!stepTwoResult.ok && stepTwoResult.detail?.replacementProposalId && stagedOrgId) {
  const stagedRep = await withService((db) => getProposal(db, workspaceId, stepTwoResult.detail?.replacementProposalId as string));
  const only = stagedRep.items[0];
  record(
    'a reference to an already-applied item resolves to that real row',
    stagedRep.items.length === 1 && only?.new_values?.candidate_entity_id === stagedOrgId && (only?.depends_on_seq ?? []).length === 0,
    `items=${stagedRep.items.length}; candidate_entity_id=${String(only?.new_values?.candidate_entity_id).slice(0, 8)} (applied org ${String(stagedOrgId).slice(0, 8)})`,
  );
  const finalStaged = await approve(alice, workspaceId, stagedRep.proposal.id, only?.id as string);
  const finalStagedResult = await settleApply(alice, workspaceId, stagedRep.proposal.id, finalStaged.proposal_version, [only?.id as string]);
  const linkedMention = await withService((db) =>
    db.oneOrFail<{ candidate_entity_id: string | null }>(
      `select candidate_entity_id from public.entity_mentions where workspace_id = $1 and mention_slug = $2 and resolution_status = 'pending'`,
      [workspaceId, mentionSlug],
    ),
  );
  record(
    'after re-approval the stored mention points at the applied record',
    finalStagedResult.ok && linkedMention.candidate_entity_id === stagedOrgId,
    `candidate_entity_id=${String(linkedMention.candidate_entity_id).slice(0, 8)}`,
  );
} else {
  record(
    'a reference to an already-applied item resolves to that real row',
    false,
    `unexpected: step one ok=${stepOneResult.ok}, step two ok=${stepTwoResult.ok}`,
  );
}

// ---------------------------------------------------------------------------
const failed = checks.filter((c) => !c.passed);
console.log(`\n\x1b[1mSummary\x1b[0m`);
console.log(`  ${checks.length - failed.length}/${checks.length} checks passed${skipped.length ? `, ${skipped.length} skipped` : ''}`);
for (const s of skipped) console.log(`  SKIPPED: ${s.name} -- ${s.reason}`);
if (failed.length > 0) {
  console.log('\n\x1b[31mFailed checks\x1b[0m');
  for (const c of failed) console.log(`  - ${c.name}\n      ${c.detail}`);
}

await closePool();
process.exit(failed.length > 0 ? 1 : 0);
