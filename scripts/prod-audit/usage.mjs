import { readdirSync, readFileSync } from 'node:fs';
const root = '/Users/mariana/Desktop/Web App';
const files = [];
const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) {
  if (e.name === 'node_modules' || e.name.startsWith('.') || e.name === 'dist-ios') continue;
  const p = `${d}/${e.name}`;
  if (e.isDirectory()) walk(p); else if (/\.(ts|tsx|mjs)$/.test(e.name)) files.push(p);
} };
for (const d of ['packages/core/src','packages/shared/src','apps/web/src','apps/mobile','apps/worker/src','scripts']) walk(`${root}/${d}`);
const isRuntime = (f) => !/\/cli\/verify|\/scripts\/test-|\/scripts\/prod-audit|\/scripts\/perf|\/cli\/seed|\/seed\.ts/.test(f);
const TABLES = process.argv.slice(2);
console.log('table|runtime_files|test_files|example_runtime');
for (const t of TABLES) {
  const re = new RegExp(`public\\.\\s*"?${t.replace(/[&\s]/g,'.')}"?\\b`);
  const hits = files.filter((f) => { try { return re.test(readFileSync(f,'utf8')); } catch { return false; } });
  const run = hits.filter(isRuntime), tst = hits.filter((f)=>!isRuntime(f));
  console.log([t, run.length, tst.length, run.slice(0,3).map(f=>f.replace(root+'/','')).join(' ')||'—'].join('|'));
}
