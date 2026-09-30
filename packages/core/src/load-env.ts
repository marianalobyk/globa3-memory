/**
 * Loads the repository-root .env files.
 *
 * The repository keeps ONE .env.local at its root, which is what the README
 * tells you to create. But each tool only looks in its own directory by
 * default: Next.js reads apps/web/.env.local, and a bare Node process reads
 * nothing at all. Without this, every non-default setting in the documented file
 * -- the Supabase keys, the OpenAI key -- is silently ignored, and the app
 * quietly runs on defaults instead.
 *
 * Existing process.env values always win, so a real environment (a container, a
 * CI secret, a `FOO=bar npm run ...` prefix) is never overridden by a file.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';

let loaded = false;

/** Walks up from this file to the repository root (the directory holding package.json with workspaces). */
function repositoryRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(resolve(dir, 'package.json')) && existsSync(resolve(dir, 'supabase/migrations'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export function loadRootEnv(): void {
  if (loaded) return;
  loaded = true;
  // Set by scripts/supabase-test/run.mjs: the test project's environment is
  // complete on its own and must not be topped up from the local files.
  if (process.env.G3_SKIP_ROOT_ENV === '1') return;
  const root = repositoryRoot();
  // Later files do not override earlier ones, and neither overrides the real
  // environment, so this order is "most specific first".
  for (const file of ['.env.local', '.env']) {
    const path = resolve(root, file);
    if (existsSync(path)) loadDotenv({ path, override: false, quiet: true });
  }
}
