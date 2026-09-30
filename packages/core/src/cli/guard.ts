/**
 * Target guard for the CLIs that write to a database (seed, verify).
 *
 * Uses the same implementation as scripts/migrate.mjs (scripts/lib/target.mjs),
 * loaded at runtime so there is exactly one copy of the rules: never a
 * production project ref, and never a remote target that is not explicitly
 * declared as a test project.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { env } from '../env.js';

type AssertSafeTarget = (options: { databaseUrl?: string; supabaseUrl?: string }) => {
  kind: 'local' | 'supabase-test';
  ref: string | null;
};

export async function guardTarget(tool: string): Promise<{ kind: 'local' | 'supabase-test'; ref: string | null }> {
  const path = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../scripts/lib/target.mjs');
  const { assertSafeTarget } = (await import(pathToFileURL(path).href)) as { assertSafeTarget: AssertSafeTarget };
  const e = env();
  try {
    const target = assertSafeTarget({ databaseUrl: e.DATABASE_URL, supabaseUrl: e.SUPABASE_URL });
    console.log(`[${tool}] target: ${target.kind}${target.ref ? ` (${target.ref})` : ''}`);
    return target;
  } catch (error) {
    console.error(`[${tool}] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
