/**
 * Navigation read-path profile and query-count regression check.
 *
 *   npm run verify:perf                                   # throwaway local DB: counts must stay within budget
 *   npm run supabase:test:perf -- --email <user email>    # test project: real latency, read-only
 *
 * For each main screen it runs exactly the server-side data path of one
 * navigation: session resolution, then the shared layout (header) and the page
 * concurrently, as Next.js renders them. Everything goes through the real
 * loaders (apps/web/src/lib/page-data.ts) and the real session code, and is
 * observed through onDbTrace(), so the counts are the ones the app produces.
 *
 * Read-only: page loaders run in READ ONLY transactions, and session resolution
 * writes only when the user's app_users row is missing or its email changed,
 * which is not the case for an existing, signed-in user.
 *
 * Latency excludes Next.js rendering and the browser; measure those in the
 * browser. With --assert, exits 1 when a screen exceeds its query budget.
 */
import { performance } from 'node:perf_hooks';

const core = await import('@g3/core');
const data = await import('../../apps/web/src/lib/page-data.ts');

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const email = flag('--email') ?? process.env.PERF_EMAIL;
const rounds = Number(flag('--rounds') ?? 5);
const assertBudgets = args.includes('--assert');
if (!email) {
  console.error('usage: nav-profile.mts --email <signed-in user> [--rounds 5] [--assert]');
  process.exit(2);
}

/**
 * Upper bounds per navigation (session + header + page). Statements include the
 * single session query. Round trips count one
 * per statement plus one transaction set-up; a read-only commit is not awaited.
 * Raise a budget only with a reason: each extra statement is ~100 ms against the
 * Supabase pooler.
 */
const BUDGETS: Record<string, { transactions: number; statements: number; roundTrips: number }> = {
  '/': { transactions: 5, statements: 8, roundTrips: 13 },
  '/briefs': { transactions: 5, statements: 7, roundTrips: 12 },
  '/research': { transactions: 5, statements: 7, roundTrips: 12 },
  '/review': { transactions: 4, statements: 5, roundTrips: 9 },
  '/knowledge': { transactions: 6, statements: 10, roundTrips: 16 },
  '/settings': { transactions: 6, statements: 9, roundTrips: 15 },
  '/activity': { transactions: 5, statements: 9, roundTrips: 14 },
};

const users = await core.adminQuery<{ id: string; email: string; display_name: string | null }>(
  'select id, email, display_name from public.app_users where lower(email) = lower($1)',
  [email],
);
const user = users[0];
if (!user) {
  console.error('user not found in app_users');
  process.exit(2);
}

const pages: Record<string, (s: any) => Promise<unknown>> = {
  '/': (s) => data.loadTodayData(s),
  '/briefs': (s) => data.loadBriefsData(s),
  '/research': (s) => data.loadResearchData(s),
  '/review': (s) => data.loadReviewData(s),
  '/knowledge': (s) => data.loadKnowledgeData(s, ''),
  '/settings': (s) => data.loadSettingsData(s),
  '/activity': (s) => data.loadActivityData(s),
};

const events: import('@g3/core').DbTraceEvent[] = [];
core.onDbTrace((event) => events.push(event));

async function navigate(path: string) {
  events.length = 0;
  const t0 = performance.now();
  const session = await core.loadSessionForUser({
    userId: user.id,
    email: user.email,
    displayName: user.display_name,
    requestedWorkspaceId: null,
  });
  if (!session) throw new Error('no session for this user (no active workspace membership?)');
  const sessionMs = performance.now() - t0;
  await Promise.all([data.loadLayoutData(session), pages[path]!(session)]);
  const totalMs = performance.now() - t0;
  const transactions = events.filter((e) => e.kind === 'transaction');
  const singles = events.filter((e) => e.kind === 'query');
  const statements = events.reduce((n, e) => n + e.statements.length, 0);
  const roundTrips = events.reduce(
    (n, e) => n + e.statements.length + (e.kind === 'transaction' ? 1 + (e.readOnly ? 0 : 1) : 0),
    0,
  );
  return {
    totalMs,
    sessionMs,
    transactions: transactions.length,
    singleQueries: singles.length,
    statements,
    roundTrips,
    writes: transactions.filter((e) => !e.readOnly).length,
    newConnections: events.filter((e) => e.newConnection).length,
    longestTxMs: Math.max(0, ...transactions.map((e) => e.totalMs)),
  };
}

const order = Object.keys(pages);
for (const path of order) await navigate(path); // warm-up: connections, JIT, JWKS-free paths

const samples: Record<string, Awaited<ReturnType<typeof navigate>>[]> = {};
for (let round = 0; round < rounds; round++) {
  for (const path of order) (samples[path] ??= []).push(await navigate(path));
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
console.log(`\nWarm navigation data path, median of ${rounds} (Next.js rendering and browser excluded)\n`);
console.log('screen       total  session  longest-tx  tx  single  stmts  round-trips  non-read-only');
let failed = 0;
for (const path of order) {
  const s = samples[path]!;
  const last = s[s.length - 1]!;
  const budget = BUDGETS[path]!;
  const over =
    last.transactions > budget.transactions || last.statements > budget.statements || last.roundTrips > budget.roundTrips || last.writes > 0;
  if (over) failed += 1;
  console.log(
    `${path.padEnd(11)} ${String(Math.round(median(s.map((x) => x.totalMs)))).padStart(5)}ms ` +
      `${String(Math.round(median(s.map((x) => x.sessionMs)))).padStart(6)}ms ` +
      `${String(Math.round(median(s.map((x) => x.longestTxMs)))).padStart(9)}ms ` +
      `${String(last.transactions).padStart(4)} ${String(last.singleQueries).padStart(6)} ${String(last.statements).padStart(6)} ` +
      `${String(last.roundTrips).padStart(11)} ${String(last.writes).padStart(14)}` +
      (over ? `   OVER BUDGET (max tx ${budget.transactions}, stmts ${budget.statements}, rt ${budget.roundTrips}, writes 0)` : ''),
  );
}
await core.closePool();
if (assertBudgets && failed > 0) {
  console.error(`\n${failed} screen(s) exceed their query budget.`);
  process.exit(1);
}
if (assertBudgets) console.log('\nAll screens within their query budget.');
