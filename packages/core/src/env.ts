/**
 * Configuration. Secrets are read on the server and in the worker only; nothing
 * here is ever imported into client-side code.
 */
import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.string().default('development'),

  /** Postgres connection. Local PGlite server by default; Supabase in production. */
  DATABASE_URL: z.string().default('postgres://postgres:postgres@127.0.0.1:54329/postgres'),

  /** Supabase, used for Auth and private Storage. Absent locally. */
  SUPABASE_URL: z.string().optional(),
  SUPABASE_ANON_KEY: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SUPABASE_JWT_SECRET: z.string().optional(),
  SUPABASE_STORAGE_BUCKET: z.string().default('workspace-files'),

  /**
   * Dev auth: email + password against the local auth.users table, with a
   * signed cookie. Only usable when Supabase Auth is not configured, and every
   * session it issues is flagged isDevAuth so the UI can say so.
   */
  DEV_AUTH_SECRET: z.string().default('dev-only-change-me'),

  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().optional(),
  /** Drafting/analysis model. */
  OPENAI_MODEL: z.string().default('gpt-5.5'),
  /** Model for web-search-backed brief research. */
  OPENAI_RESEARCH_MODEL: z.string().default('gpt-5.5'),
  /** Long-running deep research, executed as a background response. */
  OPENAI_DEEP_RESEARCH_MODEL: z.string().default('o3-deep-research'),
  /** Cheap model for parsing/classification. */
  OPENAI_FAST_MODEL: z.string().default('gpt-5.5-mini'),

  /** Local private file root when Supabase Storage is not configured. */
  LOCAL_STORAGE_DIR: z.string().default('.data/storage'),

  WORKER_ID: z.string().optional(),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().default(1500),
  /** Queue visibility timeout. A crashed worker's job reappears after this. */
  WORKER_VISIBILITY_TIMEOUT_S: z.coerce.number().default(120),
  WORKER_HEARTBEAT_INTERVAL_MS: z.coerce.number().default(20_000),
  WORKER_MAX_ATTEMPTS: z.coerce.number().default(3),
  WORKER_CONCURRENCY: z.coerce.number().default(1),

  MAX_UPLOAD_BYTES: z.coerce.number().default(25 * 1024 * 1024),
  MAX_ARCHIVE_ENTRIES: z.coerce.number().default(200),
  MAX_ARCHIVE_UNCOMPRESSED_BYTES: z.coerce.number().default(150 * 1024 * 1024),
  MAX_ARCHIVE_COMPRESSION_RATIO: z.coerce.number().default(120),
});

export type AppEnv = z.infer<typeof Env>;

let cached: AppEnv | null = null;

export function env(): AppEnv {
  if (!cached) cached = Env.parse(process.env);
  return cached;
}

/** True when a real OpenAI key is present. Everything else runs in mock mode. */
export function hasOpenAi(): boolean {
  return Boolean(env().OPENAI_API_KEY);
}

export function hasSupabaseAuth(): boolean {
  const e = env();
  return Boolean(e.SUPABASE_URL && e.SUPABASE_ANON_KEY);
}

export function hasSupabaseStorage(): boolean {
  const e = env();
  return Boolean(e.SUPABASE_URL && e.SUPABASE_SERVICE_ROLE_KEY);
}
