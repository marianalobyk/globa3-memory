/**
 * Decides whether a database / Supabase target is safe for tooling to write to.
 *
 * Rules, checked before any connection is opened:
 *   1. A target whose Supabase project ref is listed as production in
 *      supabase/environments.json is refused, always. There is no override flag.
 *   2. Any non-local target requires G3_TARGET_ENV=test, so pointing an env file
 *      at a remote database is never enough on its own.
 *   3. When G3_TARGET_ENV=test, SUPABASE_TEST_PROJECT_REF must be set and every
 *      ref found in DATABASE_URL and SUPABASE_URL must equal it, so a copy-pasted
 *      connection string for a different project is caught.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function productionRefs() {
  try {
    const parsed = JSON.parse(readFileSync(resolve(root, 'supabase/environments.json'), 'utf8'));
    return parsed?.production?.projectRefs ?? [];
  } catch {
    // Fail closed: without the list, nothing remote is considered safe.
    return null;
  }
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/** Every Supabase project ref that can be read out of a URL. */
export function refsIn(url) {
  if (!url) return [];
  const refs = new Set();
  try {
    const parsed = new URL(url);
    // https://<ref>.supabase.co  |  db.<ref>.supabase.co
    const hostMatch = parsed.hostname.match(/^(?:db\.)?([a-z0-9]{20})\.supabase\.(?:co|com)$/i);
    if (hostMatch) refs.add(hostMatch[1].toLowerCase());
    // pooler: user postgres.<ref>
    const userMatch = decodeURIComponent(parsed.username).match(/^[a-z_]+\.([a-z0-9]{20})$/i);
    if (userMatch) refs.add(userMatch[1].toLowerCase());
  } catch {
    // Unparseable: the raw-string scan below still catches a production ref.
  }
  for (const match of String(url).matchAll(/[a-z0-9]{20}/gi)) refs.add(match[0].toLowerCase());
  return [...refs];
}

export function isLocalDatabase(url) {
  try {
    return LOCAL_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Throws with a plain explanation when the target is not safe.
 * Returns a short description of the target when it is.
 */
export function assertSafeTarget({
  databaseUrl = process.env.DATABASE_URL,
  supabaseUrl = process.env.SUPABASE_URL,
  env = process.env,
} = {}) {
  const denied = productionRefs();
  if (denied === null) {
    throw new Error('supabase/environments.json could not be read, so no remote target can be verified as non-production.');
  }

  const candidates = [...refsIn(databaseUrl), ...refsIn(supabaseUrl)];
  const hit = candidates.find((ref) => denied.includes(ref));
  if (hit) {
    throw new Error(
      `Refusing: the target belongs to production project "${hit}" (listed in supabase/environments.json). This tooling never writes to production.`,
    );
  }

  const local = !databaseUrl || isLocalDatabase(databaseUrl);
  const remoteSupabase = Boolean(supabaseUrl) && !isLocalDatabase(supabaseUrl);
  if (local && !remoteSupabase) return { kind: 'local', ref: null };

  if (env.G3_TARGET_ENV !== 'test') {
    throw new Error(
      'Refusing: the target is not local and G3_TARGET_ENV is not "test". Set G3_TARGET_ENV=test only for a dedicated test project.',
    );
  }
  const expected = (env.SUPABASE_TEST_PROJECT_REF ?? '').toLowerCase();
  if (!/^[a-z0-9]{20}$/.test(expected)) {
    throw new Error('Refusing: SUPABASE_TEST_PROJECT_REF must be set to the 20-character ref of the test project.');
  }
  const structural = [
    ...(local ? [] : refsFromStructure(databaseUrl)),
    ...(remoteSupabase ? refsFromStructure(supabaseUrl) : []),
  ];
  const mismatched = structural.filter((ref) => ref !== expected);
  if (structural.length === 0) {
    throw new Error('Refusing: no Supabase project ref could be read from DATABASE_URL or SUPABASE_URL to confirm the target.');
  }
  if (mismatched.length > 0) {
    throw new Error(
      `Refusing: the URLs point at project(s) ${[...new Set(mismatched)].join(', ')}, but SUPABASE_TEST_PROJECT_REF is ${expected}.`,
    );
  }
  return { kind: 'supabase-test', ref: expected };
}

/** Refs from the host or pooler username only (not the raw-string scan). */
function refsFromStructure(url) {
  const refs = new Set();
  try {
    const parsed = new URL(url);
    const hostMatch = parsed.hostname.match(/^(?:db\.)?([a-z0-9]{20})\.supabase\.(?:co|com)$/i);
    if (hostMatch) refs.add(hostMatch[1].toLowerCase());
    const userMatch = decodeURIComponent(parsed.username).match(/^[a-z_]+\.([a-z0-9]{20})$/i);
    if (userMatch) refs.add(userMatch[1].toLowerCase());
  } catch {
    // ignore
  }
  return [...refs];
}

export function sslFor(url) {
  return /supabase\.(co|com)/i.test(url ?? '') ? { rejectUnauthorized: false } : undefined;
}
