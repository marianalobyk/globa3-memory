/**
 * What, exactly, separates production from the schema the application expects?
 *
 * Builds a throwaway local database, replays every repository migration onto it,
 * then compares its public schema with production's (read-only). The result is
 * the precise gap: tables only the app has, tables only production has, and
 * column-level differences on the tables both share.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { readOnlyClient, rows } from './connect.mjs';

const root = resolve(import.meta.dirname, '..', '..');
const port = 57931;
const dir = mkdtempSync(join(tmpdir(), 'g3-baseline-'));
const localUrl = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;
const children = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SHAPE = `
  select table_name, column_name, data_type, is_nullable
  from information_schema.columns where table_schema='public'
  order by table_name, column_name`;

const db = await new Promise((ok, fail) => {
  const child = spawn(process.execPath, ['scripts/local-db.mjs'], {
    cwd: root, env: { ...process.env, LOCAL_PG_PORT: String(port), LOCAL_PG_DATA: join(dir, 'pgdata') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let out = '';
  const t = setTimeout(() => fail(new Error('db did not start:\n' + out)), 60_000);
  const on = (c) => { out += String(c); if (out.includes('listening')) { clearTimeout(t); ok(child); } };
  child.stdout.on('data', on); child.stderr.on('data', on);
});

try {
  const migrate = spawnSync(process.execPath, ['scripts/migrate.mjs'], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: localUrl, SUPABASE_URL: '', G3_TARGET_ENV: '', SUPABASE_TEST_PROJECT_REF: '', G3_SKIP_ROOT_ENV: '1' },
  });
  if (migrate.status !== 0) throw new Error(`migrate failed:\n${migrate.stdout}\n${migrate.stderr}`);
  console.log(migrate.stdout.trim().split('\n').slice(-3).join('\n'));

  const local = new pg.Client({ connectionString: localUrl });
  await local.connect();
  const localShape = (await local.query(SHAPE)).rows;
  const localTables = (await local.query(`select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by 1`)).rows.map(r=>r.table_name);
  await local.end();

  const prod = await readOnlyClient();
  const prodShape = await rows(prod, SHAPE);
  const prodTables = (await rows(prod, `select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by 1`)).map(r=>r.table_name);
  await prod.end();

  const onlyApp = localTables.filter(t => !prodTables.includes(t));
  const onlyProd = prodTables.filter(t => !localTables.includes(t));
  const shared = localTables.filter(t => prodTables.includes(t));

  const key = (r) => `${r.table_name}.${r.column_name}`;
  const localCols = new Map(localShape.map(r => [key(r), r]));
  const prodCols = new Map(prodShape.map(r => [key(r), r]));
  const colDiff = [];
  for (const t of shared) {
    const ls = localShape.filter(r => r.table_name === t).map(r => r.column_name);
    const ps = prodShape.filter(r => r.table_name === t).map(r => r.column_name);
    const missingInProd = ls.filter(c => !ps.includes(c));
    const extraInProd = ps.filter(c => !ls.includes(c));
    const typeChanged = ls.filter(c => ps.includes(c) && localCols.get(`${t}.${c}`).data_type !== prodCols.get(`${t}.${c}`).data_type)
      .map(c => `${c}: app=${localCols.get(`${t}.${c}`).data_type} prod=${prodCols.get(`${t}.${c}`).data_type}`);
    if (missingInProd.length || extraInProd.length || typeChanged.length) colDiff.push({ table: t, missingInProd, extraInProd, typeChanged });
  }

  console.log(`\n=== TABLES ONLY THE APP HAS (must be created in production): ${onlyApp.length} ===`);
  console.log('  ' + onlyApp.join('\n  '));
  console.log(`\n=== TABLES ONLY PRODUCTION HAS: ${onlyProd.length} ===`);
  console.log('  ' + (onlyProd.join('\n  ') || '(none)'));
  console.log(`\n=== SHARED TABLES WITH COLUMN DIFFERENCES: ${colDiff.length} of ${shared.length} ===`);
  for (const d of colDiff) {
    console.log(`  ${d.table}`);
    if (d.missingInProd.length) console.log(`     missing in prod : ${d.missingInProd.join(', ')}`);
    if (d.extraInProd.length)   console.log(`     extra in prod   : ${d.extraInProd.join(', ')}`);
    if (d.typeChanged.length)   console.log(`     type differs    : ${d.typeChanged.join(' | ')}`);
  }
  const identical = shared.filter(t => !colDiff.some(d => d.table === t));
  console.log(`\n=== SHARED TABLES ALREADY IDENTICAL: ${identical.length} ===\n  ${identical.join(', ')}`);
  writeFileSync('scripts/prod-audit/out-baseline-diff.json', JSON.stringify({ onlyApp, onlyProd, colDiff, identical }, null, 2));
} finally {
  for (const c of children.reverse()) c.kill('SIGTERM');
  await sleep(800);
  rmSync(dir, { recursive: true, force: true });
}
