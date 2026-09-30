/**
 * The main screens' server data paths against the TEST project, read-only.
 *
 *   node scripts/supabase-test/run.mjs node_modules/.bin/tsx scripts/supabase-test/verify-screens.mts
 *
 * For Today, Capture, Review, Knowledge and Activity it runs exactly what a
 * navigation runs on the server -- session resolution for a real member of the
 * imported workspace, the shared layout (header, menu counts), and the page's
 * own loader -- through the same code, under the same RLS. It fails if any
 * loader throws or if anything is written. It prints counts only: no names,
 * emails, ids or content.
 *
 * Not covered: Next.js rendering and the browser (a signed-in HTTP request
 * needs a real sign-in), and the capture/proposal detail views (no capture
 * exists on the test project).
 */
import { performance } from 'node:perf_hooks';

const core = await import('@g3/core');
const data = await import('../../apps/web/src/lib/page-data.ts');

const members = await core.adminQuery<{ id: string; email: string; display_name: string | null; role: string }>(
  `select u.id, u.email, u.display_name, m.role
     from public.workspace_members m
     join public.workspaces w on w.id = m.workspace_id and w.slug = 'globa3'
     join public.app_users u on u.id = m.user_id
    order by case m.role when 'admin' then 0 when 'editor' then 1 else 2 end
    limit 1`,
);
const member = members[0];
if (!member) {
  console.error('No member of the imported workspace found.');
  process.exit(2);
}

const events: import('@g3/core').DbTraceEvent[] = [];
core.onDbTrace((event) => events.push(event));

const screens: Record<string, (s: any) => Promise<Record<string, number | string>>> = {
  Today: async (s) => {
    const d = await data.loadTodayData(s);
    return { awaitingProposals: d.awaiting.proposals, awaitingChanges: d.awaiting.changes, analysing: d.runs.length, savedToday: d.saved.length, recentlySaved: d.recent.length };
  },
  Capture: async (s) => {
    // The capture page reads its list through the server role, scoped to the
    // session's workspace, exactly like this.
    const list = await core.withServiceRead((db) => core.listCaptures(db, s.activeWorkspace.workspaceId, 15));
    return { captures: list.length };
  },
  Review: async (s) => {
    const d: any = await data.loadReviewData(s);
    return { proposals: Array.isArray(d) ? d.length : 0 };
  },
  Knowledge: async (s) => {
    const d: any = await data.loadKnowledgeData(s, '');
    return { entities: d.entities?.length ?? 0, businessUnits: d.units?.length ?? 0, entitiesTotal: d.counts?.entities ?? 0, findingsTotal: d.counts?.findings ?? 0 };
  },
  Activity: async (s) => {
    const d: any = await data.loadActivityData(s);
    return Object.fromEntries(Object.entries(d).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, (v as unknown[]).length]));
  },
};

let failures = 0;
console.log(`Member role: ${member.role}\n`);
for (const [name, load] of Object.entries(screens)) {
  events.length = 0;
  const started = performance.now();
  try {
    const session = await core.loadSessionForUser({
      userId: member.id,
      email: member.email,
      displayName: member.display_name,
      requestedWorkspaceId: null,
    });
    if (!session) throw new Error('no session');
    const [layout, summary] = await Promise.all([data.loadLayoutData(session), load(session)]);
    const writes = events.filter((e) => e.kind === 'transaction' && !e.readOnly).length;
    const ms = Math.round(performance.now() - started);
    const ok = writes === 0;
    if (!ok) failures += 1;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(9)} ${String(ms).padStart(5)} ms  writes=${writes}  review badge=${(layout as any).counts.review}  ${JSON.stringify(summary)}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL  ${name.padEnd(9)} ${error instanceof Error ? error.message : String(error)}`);
  }
}
await core.closePool();
console.log(`\n${failures === 0 ? 'All screens loaded, read-only.' : `${failures} screen(s) failed.`}`);
process.exit(failures === 0 ? 0 : 1);
