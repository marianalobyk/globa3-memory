/** Which tables does the application's own code actually read or write? */
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
const prod = Object.keys(JSON.parse(readFileSync('scripts/prod-audit/out-counts.json','utf8')));
const platform = ['workspaces','app_users','workspace_members','memberships','runs','run_steps','proposals','proposal_items','uploads','captures','activity_log','schema_migrations','applied_changes','ai_calls','costs','threads','messages','research_topics','research_runs','contact_research','desk_files','output_formats','context_items','prompt_versions','jobs'];
const all = [...new Set([...prod, ...platform])];
const files = execSync(`grep -rl "" --include=*.ts --include=*.tsx --include=*.mjs --include=*.sql packages apps scripts supabase 2>/dev/null | grep -v node_modules || true`, {encoding:'utf8'}).trim().split('\n').filter(Boolean);
const corpus = files.map((f) => { try { return { f, t: readFileSync(f,'utf8') }; } catch { return null; } }).filter(Boolean);
const appCode = corpus.filter((c) => !c.f.startsWith('supabase/migrations') && !c.f.startsWith('scripts/prod-audit'));
console.log('table'.padEnd(34), 'prod?', 'appRefs', 'migrRefs', ' example app files');
for (const t of all.sort()) {
  const pattern = new RegExp(`\\b(public\\.)?"?${t.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}"?\\b`);
  const hits = appCode.filter((c) => pattern.test(c.t));
  const mig = corpus.filter((c) => c.f.startsWith('supabase/migrations') && pattern.test(c.t));
  const inProd = prod.includes(t);
  if (hits.length === 0 && !inProd) continue;
  console.log(
    t.padEnd(34),
    (inProd ? ' yes ' : ' NO  '),
    String(hits.length).padStart(6),
    String(mig.length).padStart(8),
    '  ' + hits.slice(0,3).map(h=>h.f.replace('packages/core/src/','core:').replace('apps/web/src/','web:')).join(', ') + (hits.length>3?` +${hits.length-3}`:''),
  );
}
