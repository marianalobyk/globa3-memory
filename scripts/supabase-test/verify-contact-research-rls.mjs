#!/usr/bin/env node
/**
 * contact_research: RLS, grants and workspace isolation against the TEST project.
 *
 *   node scripts/supabase-test/run.mjs node scripts/supabase-test/verify-contact-research-rls.mjs
 *
 * Leaves the database exactly as it found it. Part 1 reads the catalog. Part 2
 * runs inside ONE transaction that is always rolled back: it adds a synthetic
 * capture, proposal and contact_research row (placeholder text, no run, no
 * queue job, no model call) to the imported workspace and to a temporary second
 * workspace, then reads and writes as real roles (anon, authenticated with a
 * real member's id, authenticated with an id that belongs to no workspace,
 * service_role). Supabase Auth is not touched. Output names no user, email, id
 * or content.
 */
import { randomUUID, createHash } from 'node:crypto';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(2);
}
const local = /@(127\.0\.0\.1|localhost)[:/]/.test(url);
const client = new pg.Client({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false } });
let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const hash = (s) => createHash('sha256').update(s).digest('hex');
const count = async (sql) => Number((await client.query(sql)).rows[0].count);

await client.connect();
const before = {
  research: await count(`select count(*) from public.contact_research`),
  captures: await count(`select count(*) from public.captures`),
  proposals: await count(`select count(*) from public.proposals`),
};
try {
  console.log('1. Catalog');
  const rls = (await client.query(`select relrowsecurity from pg_class where oid = 'public.contact_research'::regclass`)).rows[0];
  check('row level security is enabled on contact_research', rls?.relrowsecurity === true);
  const policies = (await client.query(`select policyname, cmd, roles::text, qual from pg_policies where schemaname='public' and tablename='contact_research'`)).rows;
  check(
    'the only policy is a member SELECT for authenticated',
    policies.length === 1 && policies[0].cmd === 'SELECT' && policies[0].roles.includes('authenticated') && policies[0].qual.includes('is_workspace_member'),
    policies.map((p) => `${p.policyname}:${p.cmd}`).join(','),
  );
  const grantsFor = async (role) =>
    (await client.query(
      `select coalesce(string_agg(privilege_type, ',' order by privilege_type), '') as p from information_schema.role_table_grants
        where table_schema='public' and table_name='contact_research' and grantee=$1`,
      [role],
    )).rows[0].p;
  const anonGrants = await grantsFor('anon');
  const authGrants = await grantsFor('authenticated');
  const serviceGrants = await grantsFor('service_role');
  check('anon holds no privilege', anonGrants === '', `granted: ${anonGrants || 'none'}`);
  check('authenticated holds only SELECT', authGrants === 'SELECT', `granted: ${authGrants}`);
  check('service_role (the server) may read and write', ['SELECT', 'INSERT', 'UPDATE', 'DELETE'].every((p) => serviceGrants.includes(p)), `granted: ${serviceGrants}`);
  const constraints = (await client.query(`select conname from pg_constraint where conrelid = 'public.contact_research'::regclass`)).rows.map((r) => r.conname);
  check(
    'workspace-composite foreign keys exist (capture, proposal, entity, runs)',
    ['contact_research_capture_ws_fk', 'contact_research_proposal_ws_fk', 'contact_research_entity_ws_fk', 'contact_research_identify_run_ws_fk', 'contact_research_research_run_ws_fk'].every((c) => constraints.includes(c)),
  );
  check(
    'one research session per contact per capture; at most 3 candidates; disclosure required before search',
    ['contact_research_capture_contact_key', 'contact_research_candidates_max', 'contact_research_disclosed_before_search', 'contact_research_search_clues_is_array'].every((c) => constraints.includes(c)),
  );
  const kinds = (await client.query(`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'runs_kind_check'`)).rows[0]?.def ?? '';
  check("runs accept 'contact_identify' and 'contact_research' (and still 'capture')", ["'contact_identify'", "'contact_research'", "'capture'"].every((k) => kinds.includes(k)));

  console.log('\n2. Behaviour, in a transaction that is rolled back');
  await client.query('begin');
  const ws = (await client.query(`select id from public.workspaces where slug = 'globa3'`)).rows[0]?.id;
  const member = (await client.query(`select user_id from public.workspace_members where workspace_id = $1 order by role limit 1`, [ws])).rows[0]?.user_id;
  check('the imported workspace and a real member exist', Boolean(ws && member));
  const other = (await client.query(
    `insert into public.workspaces (slug, name, timezone) values ($1, 'RLS check (rolled back)', 'UTC') returning id`,
    [`rls-check-${randomUUID().slice(0, 8)}`],
  )).rows[0].id;

  const seedAsService = async (workspaceId, label) => {
    await client.query('set local role service_role');
    const proposal = (await client.query(
      `insert into public.proposals (workspace_id, source_kind, title, status, version, content_hash, is_mock)
       values ($1, 'manual', $2, 'pending_review', 1, 'rls-check', true) returning id`,
      [workspaceId, `RLS check placeholder ${label}`],
    )).rows[0].id;
    const capture = (await client.query(
      `insert into public.captures (workspace_id, kind, body_text, content_hash, source_hash, proposal_id)
       values ($1, 'text', $2, $3, $3, $4) returning id`,
      [workspaceId, `RLS check placeholder ${label}`, hash(`${label}-${randomUUID()}`), proposal],
    )).rows[0].id;
    const row = (await client.query(
      `insert into public.contact_research (workspace_id, capture_id, proposal_id, contact_key, contact_name, status, search_clues, disclosure_acknowledged_at)
       values ($1, $2, $3, 'placeholder', 'Placeholder', 'identifying', '[{"id":"name","value":"Placeholder"}]'::jsonb, now()) returning id`,
      [workspaceId, capture, proposal],
    )).rows[0].id;
    await client.query('reset role');
    return { proposal, capture, row };
  };
  const own = await seedAsService(ws, 'own');
  const foreign = await seedAsService(other, 'foreign');
  check('the server role can insert (as the research request does)', Boolean(own.row && foreign.row));

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
  const visible = (ids) => client.query(`select id from public.contact_research where id = any($1::uuid[])`, [ids]).then((r) => r.rows.map((x) => x.id));

  await asUser(member, async () => {
    const seen = await visible([own.row, foreign.row]);
    check('a member sees research state in their own workspace', seen.includes(own.row));
    check('a member does not see research state in another workspace', !seen.includes(foreign.row));
    const ins = await refused(
      `insert into public.contact_research (workspace_id, capture_id, proposal_id, contact_key, contact_name) values ($1,$2,$3,'x','X')`,
      [ws, own.capture, own.proposal],
    );
    check('a member cannot insert research state directly', ins.refused && ins.code === '42501', ins.code ?? `inserted ${ins.rows}`);
    const upd = await refused(`update public.contact_research set status = 'researching', confirmed_candidate = '{}'::jsonb where id = $1`, [own.row]);
    check('a member cannot confirm an identity by writing directly', (upd.refused && upd.code === '42501') || upd.rows === 0, upd.code ?? `updated ${upd.rows}`);
    const clues = await refused(`update public.contact_research set search_clues = '[{"value":"x@example.com"}]'::jsonb where id = $1`, [own.row]);
    check('a member cannot change which clues are sent to search', (clues.refused && clues.code === '42501') || clues.rows === 0, clues.code ?? `updated ${clues.rows}`);
    const del = await refused(`delete from public.contact_research where id = $1`, [own.row]);
    check('a member cannot delete research state directly', (del.refused && del.code === '42501') || del.rows === 0, del.code ?? `deleted ${del.rows}`);
  });

  await asUser(randomUUID(), async () => {
    const seen = await visible([own.row, foreign.row]);
    check('a signed-in user of no workspace sees no research state', seen.length === 0);
  });

  await client.query('savepoint anon');
  await client.query('set local role anon');
  const anon = await refused(`select id from public.contact_research limit 1`, []);
  await client.query('rollback to savepoint anon');
  await client.query('reset role');
  check('anon cannot read research state', anon.refused && anon.code === '42501', anon.code ?? 'read allowed');

  await client.query('set local role service_role');
  const crossFk = await refused(
    `insert into public.contact_research (workspace_id, capture_id, proposal_id, contact_key, contact_name) values ($1,$2,$3,'cross','Cross')`,
    [ws, foreign.capture, foreign.proposal],
  );
  const noDisclosure = await refused(
    `insert into public.contact_research (workspace_id, capture_id, proposal_id, contact_key, contact_name, status) values ($1,$2,$3,'undisclosed','Undisclosed','identifying')`,
    [ws, own.capture, own.proposal],
  );
  const duplicate = await refused(
    `insert into public.contact_research (workspace_id, capture_id, proposal_id, contact_key, contact_name) values ($1,$2,$3,'placeholder','Placeholder')`,
    [ws, own.capture, own.proposal],
  );
  const tooMany = await refused(`update public.contact_research set candidates = '[{},{},{},{}]'::jsonb where id = $1`, [own.row]);
  await client.query('reset role');
  check('research state cannot point at a capture in another workspace', crossFk.refused && crossFk.code === '23503', crossFk.code ?? 'accepted');
  check('research cannot be in progress without a recorded disclosure confirmation', noDisclosure.refused && noDisclosure.code === '23514', noDisclosure.code ?? 'accepted');
  check('a second research session for the same contact and capture is refused', duplicate.refused && duplicate.code === '23505', duplicate.code ?? 'accepted');
  check('more than three candidates are refused', tooMany.refused && tooMany.code === '23514', tooMany.code ?? 'accepted');
} catch (error) {
  failures += 1;
  console.error('Unexpected error:', error.code ?? '', error.message);
} finally {
  await client.query('rollback').catch(() => undefined);
  const after = {
    research: await count(`select count(*) from public.contact_research`),
    captures: await count(`select count(*) from public.captures`),
    proposals: await count(`select count(*) from public.proposals`),
  };
  const temp = await count(`select count(*) from public.workspaces where slug like 'rls-check-%'`);
  check(
    '\n  after rollback: row counts are exactly as before and no temporary workspace remains',
    JSON.stringify(after) === JSON.stringify(before) && temp === 0,
    `contact_research ${before.research}->${after.research}, captures ${before.captures}->${after.captures}, proposals ${before.proposals}->${after.proposals}, temporary workspaces ${temp}`,
  );
  await client.end();
}
console.log(`\n${failures === 0 ? 'All contact_research RLS checks passed.' : `${failures} check(s) failed.`}`);
process.exit(failures === 0 ? 0 : 1);
