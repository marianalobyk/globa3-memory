#!/usr/bin/env node
/**
 * Server-side write paths still work on the TEST project after migration 0018,
 * and the same writes are refused to client roles. Nothing persists.
 *
 *   node scripts/supabase-test/run.mjs node scripts/supabase-test/verify-server-writes.mjs
 *
 * Everything runs inside ONE transaction that is always rolled back. As
 * `service_role` -- the role the web server and worker write with -- it performs
 * one write of each kind the product makes: queue a run (pgmq), record a capture,
 * build a proposal and its items, record a decision and an approval, apply
 * knowledge records with their applied-change rows, log activity and usage
 * (sequence-backed), store an Ask exchange, record an upload. Each write is then
 * attempted as `authenticated` for a real member and must be refused. Placeholder
 * values only; no model call; output names no user, id or content.
 */
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const h = () => createHash('sha256').update(randomUUID()).digest('hex');

await client.connect();
const COUNTS_SQL = `select (select count(*) from public.runs)::int runs, (select count(*) from public.captures)::int captures, (select count(*) from public.proposals)::int proposals, (select count(*) from public.activity_log where action = 'grants.check')::int activity, (select count(*) from public.entities where display_name = 'Grants Check Placeholder')::int entities`;
const baseline = (await client.query(COUNTS_SQL)).rows[0];
const attempt = async (sql, params) => {
  await client.query('savepoint attempt');
  try {
    const res = await client.query(sql, params);
    await client.query('release savepoint attempt');
    return { ok: true, rows: res.rows };
  } catch (error) {
    await client.query('rollback to savepoint attempt');
    return { ok: false, code: error.code, message: error.message };
  }
};
const asService = () => client.query('set local role service_role');
const asMember = async (userId) => {
  await client.query('reset role');
  await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId]);
  await client.query(`select set_config('request.jwt.claim.role', 'authenticated', true)`);
  await client.query('set local role authenticated');
};

try {
  await client.query('begin');
  const ws = (await client.query(`select id from public.workspaces where slug = 'globa3'`)).rows[0].id;
  const member = (await client.query(`select user_id from public.workspace_members where workspace_id = $1 order by role limit 1`, [ws])).rows[0].user_id;

  console.log('1. As service_role (web server and worker)');
  await asService();
  const ids = {};
  const steps = [
    // Parameterised exactly like packages/core/src/queue.ts, so an ambiguous
    // pgmq overload on real Supabase fails here rather than in the app.
    ['queue a job (pgmq.send, as queue.ts calls it)', `select pgmq.send($1::text, $2::jsonb, $3::integer) as id`, ['g3_runs', JSON.stringify({ check: true }), 0], 'msg'],
    ['read the queue (pgmq.read, as the worker does)', `select count(*) from pgmq.read($1::text, $2::integer, $3::integer)`, ['g3_runs', 1, 1]],
    ['extend a lease (pgmq.set_vt)', `select pgmq.set_vt($1::text, $2::bigint, $3::integer)`, () => ['g3_runs', ids.msg, 1]],
    ['archive a job (pgmq.archive)', `select pgmq.archive($1::text, $2::bigint)`, () => ['g3_runs', ids.msg]],
    ['create a capture run', `insert into public.runs (workspace_id, kind, idempotency_key, status, is_mock) values ($1, 'capture', $2, 'queued', true) returning id`, [ws, `grants-check:${randomUUID()}`], 'run'],
    ['record a run event (sequence)', `insert into public.run_events (workspace_id, run_id, message) values ($1, $2, 'check') returning id`, () => [ws, ids.run]],
    ['record a capture', `insert into public.captures (workspace_id, kind, body_text, content_hash, source_hash, run_id) values ($1, 'text', 'placeholder', $2, $2, $3) returning id`, () => [ws, h(), ids.run], 'capture'],
    ['build a proposal', `insert into public.proposals (workspace_id, source_kind, title, content_hash, run_id) values ($1, 'capture', 'placeholder', $2, $3) returning id`, () => [ws, h(), ids.run], 'proposal'],
    ['add a proposal item', `insert into public.proposal_items (workspace_id, proposal_id, seq, op, target_table, label, new_values) values ($1, $2, 1, 'create', 'entities', 'placeholder', '{}'::jsonb) returning id`, () => [ws, ids.proposal], 'item'],
    ['record a decision', `update public.proposal_items set decision = 'approved', decided_by = $2, decided_at = now() where id = $1 returning id`, () => [ids.item, member]],
    ['record an approval', `insert into public.proposal_approvals (workspace_id, proposal_id, proposal_version, content_hash, item_ids, approved_by) values ($1, $2, 1, $3, array[$4::uuid], $5) returning id`, () => [ws, ids.proposal, h(), ids.item, member]],
    ['apply: create a knowledge record', `insert into public.entities (workspace_id, entity_type, display_name, slug) values ($1, 'person', 'Grants Check Placeholder', $2) returning id`, () => [ws, `grants-check-${randomUUID().slice(0, 8)}`], 'entity'],
    ['apply: record the applied change', `insert into public.applied_changes (workspace_id, proposal_id, proposal_item_id, table_name, row_id, op, applied_by) values ($1, $2, $3, 'entities', $4, 'create', $5) returning id`, () => [ws, ids.proposal, ids.item, ids.entity, member]],
    ['apply: mark the item applied', `update public.proposal_items set applied_at = now(), applied_row_id = $2 where id = $1 returning id`, () => [ids.item, ids.entity]],
    ['log activity (sequence)', `insert into public.activity_log (workspace_id, actor_kind, action, summary) values ($1, 'system', 'grants.check', 'check') returning id`, [ws]],
    ['record usage (sequence)', `insert into public.usage_events (workspace_id) values ($1) returning id`, [ws]],
    ['store an Ask thread', `insert into public.ask_threads (workspace_id, title, created_by) values ($1, 'placeholder', $2) returning id`, [ws, member], 'thread'],
    ['store an Ask message', `insert into public.ask_messages (workspace_id, thread_id, role, content) values ($1, $2, 'user', 'placeholder') returning id`, () => [ws, ids.thread]],
    ['record an upload', `insert into public.uploads (workspace_id, filename, kind) values ($1, 'placeholder.md', 'md') returning id`, [ws]],
    ['mark a research topic (retired flow)', `update public.research_topics set updated_at = now() where workspace_id = $1 and false`, [ws]],
  ];
  for (const [name, sql, params, key] of steps) {
    const r = await attempt(sql, typeof params === 'function' ? params() : params);
    if (r.ok && key) ids[key] = r.rows[0].id ?? r.rows[0].msg_id;
    check(name, r.ok, r.ok ? '' : `${r.code} ${r.message.slice(0, 90)}`);
  }

  const untyped = await attempt(`select pgmq.send($1, $2::jsonb, $3)`, ['g3_runs', '{}', 0]);
  check('the previous untyped queue call is ambiguous on this project (the bug fixed in queue.ts)', !untyped.ok && untyped.code === '42725', untyped.code ?? 'accepted');

  console.log('\n2. The same writes as authenticated (a real member) are refused');
  await asMember(member);
  const refusals = [
    ['create a run', `insert into public.runs (workspace_id, kind, idempotency_key) values ($1, 'capture', 'x')`, [ws]],
    ['record a capture', `insert into public.captures (workspace_id, kind, body_text, content_hash, source_hash) values ($1, 'text', 'x', 'x', 'x')`, [ws]],
    ['build a proposal', `insert into public.proposals (workspace_id, source_kind, title, content_hash) values ($1, 'capture', 'x', 'x')`, [ws]],
    ['decide an item (0007 column grant)', `update public.proposal_items set decision = 'approved' where workspace_id = $1`, [ws]],
    ['create a knowledge record', `insert into public.entities (workspace_id, entity_type, display_name, slug) values ($1, 'person', 'x', 'x')`, [ws]],
    ['store an Ask thread (0007 insert grant)', `insert into public.ask_threads (workspace_id) values ($1)`, [ws]],
    ['update a budget (0007 grant)', `update public.budgets set limit_usd = limit_usd where workspace_id = $1`, [ws]],
    ['truncate a table', `truncate public.activity_log`, []],
    ['rewrite migration history', `delete from public.schema_migrations`, []],
    ['advance a sequence (setval)', `select setval('public.activity_log_id_seq', 1)`, []],
    ['call the legacy writer', `select public.upsert_legacy_record('knowledge', '{}'::jsonb, 'skip', $1)`, [ws]],
  ];
  for (const [name, sql, params] of refusals) {
    const r = await attempt(sql, params);
    check(name, !r.ok && r.code === '42501', r.ok ? 'ALLOWED' : r.code);
  }

  console.log('\n3. Reads as authenticated still work under RLS');
  const read = await attempt(`select (select count(*) from public.entities)::int as entities, (select count(*) from public.captures where id = $1)::int as own_capture`, [ids.capture]);
  check('a member reads imported entities and the capture of their workspace', read.ok && read.rows[0].entities > 0 && read.rows[0].own_capture === 1, read.ok ? `entities ${read.rows[0].entities}` : read.code);

  console.log('\n4. Observation: the pgmq schema (Supabase-managed, outside public)');
  await client.query('reset role');
  const q = (await client.query(`select has_schema_privilege('authenticated','pgmq','USAGE') as auth_usage, has_schema_privilege('anon','pgmq','USAGE') as anon_usage,
      has_table_privilege('authenticated','pgmq.q_g3_runs','INSERT') as auth_insert, has_table_privilege('authenticated','pgmq.q_g3_runs','SELECT') as auth_select`)).rows[0];
  console.log(`        authenticated USAGE on pgmq: ${q.auth_usage}; anon: ${q.anon_usage}; authenticated INSERT/SELECT on the runs queue: ${q.auth_insert}/${q.auth_select}`);
} catch (error) {
  failures += 1;
  console.error('Unexpected error:', error.code ?? '', error.message);
} finally {
  await client.query('rollback').catch(() => undefined);
  const left = (await client.query(COUNTS_SQL)).rows[0];
  const queued = await client.query(`select count(*)::int n from pgmq.q_g3_runs`).then((r) => r.rows[0].n).catch(() => 'n/a');
  check('\n  after rollback: counts equal the baseline and the queue is empty', JSON.stringify(left) === JSON.stringify(baseline) && queued === 0, `${JSON.stringify(left)} queue=${queued}`);
  await client.end();
}
console.log(`\n${failures === 0 ? 'All server write checks passed.' : `${failures} check(s) failed.`}`);
process.exit(failures === 0 ? 0 : 1);
