#!/usr/bin/env node
/**
 * Captures table: RLS, grants and workspace isolation against the TEST project.
 *
 *   node scripts/supabase-test/run.mjs node scripts/supabase-test/verify-captures-rls.mjs
 *
 * Leaves the database exactly as it found it. Part 1 reads the catalog. Part 2
 * runs inside ONE transaction that is always rolled back: it adds a synthetic
 * capture row (placeholder text, no run, no queue job, no file) to the imported
 * workspace and to a temporary second workspace, then reads and writes as real
 * roles (anon, authenticated with a real member's id, authenticated with an id
 * that belongs to no workspace, service_role). Supabase Auth is not touched.
 * Output names no user, email, id or content.
 */
import { randomUUID, createHash } from 'node:crypto';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(2);
}
const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const hash = (s) => createHash('sha256').update(s).digest('hex');

await client.connect();
try {
  console.log('1. Catalog');
  const rls = (await client.query(`select relrowsecurity from pg_class where oid = 'public.captures'::regclass`)).rows[0];
  check('row level security is enabled on captures', rls?.relrowsecurity === true);
  const policies = (await client.query(`select policyname, cmd, roles::text from pg_policies where schemaname='public' and tablename='captures'`)).rows;
  check('the only policy is a SELECT for authenticated members', policies.length === 1 && policies[0].cmd === 'SELECT' && policies[0].roles.includes('authenticated'), policies.map((p) => `${p.policyname}:${p.cmd}`).join(','));
  const priv = (await client.query(`
    select has_table_privilege('anon','public.captures','select') as anon_select,
           has_table_privilege('anon','public.captures','insert') as anon_insert,
           has_table_privilege('authenticated','public.captures','select') as auth_select,
           has_table_privilege('authenticated','public.captures','insert') as auth_insert,
           has_table_privilege('authenticated','public.captures','update') as auth_update,
           has_table_privilege('authenticated','public.captures','delete') as auth_delete,
           has_table_privilege('service_role','public.captures','insert') as service_insert`)).rows[0];
  check('anon has no access', !priv.anon_select && !priv.anon_insert);
  // Supabase's default privileges grant every new public table to authenticated;
  // RLS (no write policy) is what refuses the writes -- see part 2. The grant
  // itself is reported separately, because TRUNCATE is not subject to RLS.
  const grants = (await client.query(
    `select string_agg(privilege_type, ',' order by privilege_type) as p from information_schema.role_table_grants
      where table_schema='public' and table_name='captures' and grantee='authenticated'`,
  )).rows[0]?.p ?? '';
  check('authenticated holds only the SELECT privilege (defence in depth)', grants === 'SELECT', `granted: ${grants}`);
  check('service_role (the server) may write', priv.service_insert);
  const constraints = (await client.query(`select conname from pg_constraint where conrelid = 'public.captures'::regclass`)).rows.map((r) => r.conname);
  check('workspace-composite foreign keys exist (upload, run, proposal)', ['captures_upload_ws_fk', 'captures_run_ws_fk', 'captures_proposal_ws_fk'].every((c) => constraints.includes(c)));
  const index = (await client.query(`select indexdef from pg_indexes where schemaname='public' and indexname='captures_live_content_unique'`)).rows[0];
  check('duplicate live submissions are prevented per workspace', Boolean(index?.indexdef.includes('(workspace_id, content_hash)')));
  const kinds = (await client.query(`select pg_get_constraintdef(oid) as def from pg_constraint where conname in ('runs_kind_check','proposals_source_kind_check')`)).rows;
  check("runs and proposals accept kind 'capture'", kinds.length === 2 && kinds.every((k) => k.def.includes("'capture'")));
  const existing = Number((await client.query(`select count(*) from public.captures`)).rows[0].count);
  check('no capture exists on the test project', existing === 0, `${existing} rows`);

  console.log('\n2. Behaviour, in a transaction that is rolled back');
  await client.query('begin');
  const ws = (await client.query(`select id from public.workspaces where slug = 'globa3'`)).rows[0]?.id;
  const member = (await client.query(`select user_id from public.workspace_members where workspace_id = $1 order by role limit 1`, [ws])).rows[0]?.user_id;
  check('the imported workspace and a real member exist', Boolean(ws && member));

  const other = (await client.query(
    `insert into public.workspaces (slug, name, timezone) values ($1, 'RLS check (rolled back)', 'UTC') returning id`,
    [`rls-check-${randomUUID().slice(0, 8)}`],
  )).rows[0].id;

  const insertAsService = async (workspaceId, label) => {
    await client.query('set local role service_role');
    const row = (await client.query(
      `insert into public.captures (workspace_id, kind, body_text, content_hash, source_hash)
       values ($1, 'text', $2, $3, $3) returning id`,
      [workspaceId, `RLS check placeholder ${label}`, hash(`${label}-${randomUUID()}`)],
    )).rows[0].id;
    await client.query('reset role');
    return row;
  };
  const own = await insertAsService(ws, 'own');
  const foreign = await insertAsService(other, 'foreign');
  check('the server role can insert (as the capture API does)', Boolean(own && foreign));

  const asUser = async (userId, fn) => {
    await client.query('savepoint as_user');
    try {
      await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId]);
      await client.query(`select set_config('request.jwt.claim.role', 'authenticated', true)`);
      await client.query('set local role authenticated');
      return await fn();
    } finally {
      await client.query('rollback to savepoint as_user');
      await client.query('reset role');
    }
  };
  const visible = (ids) => client.query(`select id from public.captures where id = any($1::uuid[])`, [ids]).then((r) => r.rows.map((x) => x.id));
  const refused = async (sql, params) => {
    try {
      await client.query('savepoint try_write');
      const result = await client.query(sql, params);
      await client.query('release savepoint try_write');
      return { refused: false, rows: result.rowCount };
    } catch (error) {
      await client.query('rollback to savepoint try_write');
      return { refused: true, code: error.code };
    }
  };

  await asUser(member, async () => {
    const seen = await visible([own, foreign]);
    check('a member sees their own workspace capture', seen.includes(own));
    check('a member does not see another workspace capture', !seen.includes(foreign));
    const ins = await refused(`insert into public.captures (workspace_id, kind, body_text, content_hash, source_hash) values ($1,'text','x',$2,$2)`, [ws, hash(randomUUID())]);
    check('a member cannot insert a capture directly', ins.refused && ins.code === '42501', ins.code ?? `inserted ${ins.rows}`);
    const upd = await refused(`update public.captures set status = 'discarded' where id = $1`, [own]);
    check('a member cannot update a capture directly', (upd.refused && upd.code === '42501') || upd.rows === 0, upd.code ?? `updated ${upd.rows}`);
    const del = await refused(`delete from public.captures where id = $1`, [own]);
    check('a member cannot delete a capture directly', (del.refused && del.code === '42501') || del.rows === 0, del.code ?? `deleted ${del.rows}`);
  });

  await asUser(randomUUID(), async () => {
    const seen = await visible([own, foreign]);
    check('a signed-in user of no workspace sees no capture', seen.length === 0);
  });

  await client.query('savepoint anon');
  await client.query('set local role anon');
  const anon = await refused(`select id from public.captures limit 1`, []);
  await client.query('rollback to savepoint anon');
  await client.query('reset role');
  check('anon cannot read captures', anon.refused && anon.code === '42501', anon.code ?? 'read allowed');

  await client.query('set local role service_role');
  const crossFk = await refused(
    `insert into public.captures (workspace_id, kind, body_text, content_hash, source_hash, run_id) values ($1,'text','x',$2,$2,$3)`,
    [ws, hash(randomUUID()), randomUUID()],
  );
  await client.query('reset role');
  check('a capture cannot point at a run outside its workspace', crossFk.refused && crossFk.code === '23503', crossFk.code ?? 'accepted');
} catch (error) {
  failures += 1;
  console.error('Unexpected error:', error.code ?? '', error.message);
} finally {
  await client.query('rollback').catch(() => undefined);
  const after = Number((await client.query(`select count(*) from public.captures`)).rows[0].count);
  const temp = Number((await client.query(`select count(*) from public.workspaces where slug like 'rls-check-%'`)).rows[0].count);
  check('\n  after rollback: no capture and no temporary workspace remain', after === 0 && temp === 0, `${after} captures, ${temp} temporary workspaces`);
  await client.end();
}
console.log(`\n${failures === 0 ? 'All captures RLS checks passed.' : `${failures} check(s) failed.`}`);
process.exit(failures === 0 ? 0 : 1);
