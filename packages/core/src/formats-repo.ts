/**
 * Reading and writing format definitions and prompt versions.
 *
 * A format's machine-readable rules live in brief_formats.config; the run prompt
 * text lives in prompt_versions.body with its [PLACEHOLDERS] intact. Every run
 * records which prompt version produced it, so a brief can always be traced back
 * to the exact prompt and rules that were in force.
 */
import { createHash } from 'node:crypto';
import { FORMAT_CONFIGS, type FormatConfig, type FormatKey } from '@g3/shared';
import { assertScope, type Queryable } from './db.js';
import { notFound } from './errors.js';

export interface FormatRow {
  id: string;
  workspace_id: string;
  key: string;
  name: string;
  product_line: string | null;
  description: string | null;
  config: FormatConfig;
  default_model: string | null;
  research_model: string | null;
  active_prompt_version_id: string | null;
  status: string;
}

export interface PromptVersionRow {
  id: string;
  format_id: string;
  version: number;
  body: string;
  attachments: { path: string; title: string; body: string }[];
  structured: Record<string, unknown>;
  checksum: string;
  note: string | null;
  created_at: string;
}

export function promptChecksum(body: string, attachments: { path: string; body: string }[]): string {
  const hash = createHash('sha256').update(body);
  for (const attachment of [...attachments].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(' ').update(attachment.path).update(' ').update(attachment.body);
  }
  return hash.digest('hex').slice(0, 32);
}

export async function listFormats(db: Queryable, workspaceId: string): Promise<FormatRow[]> {
  assertScope(workspaceId, 'listFormats');
  return db.rows<FormatRow>(
    `select * from public.brief_formats where workspace_id = $1 and status = 'active' order by name`,
    [workspaceId],
  );
}

export async function getFormat(
  db: Queryable,
  workspaceId: string,
  formatId: string,
): Promise<FormatRow> {
  assertScope(workspaceId, 'getFormat');
  const row = await db.one<FormatRow>(
    `select * from public.brief_formats where workspace_id = $1 and id = $2`,
    [workspaceId, formatId],
  );
  if (!row) throw notFound('Format not found');
  return row;
}

export async function getFormatByKey(
  db: Queryable,
  workspaceId: string,
  key: string,
): Promise<FormatRow> {
  assertScope(workspaceId, 'getFormatByKey');
  const row = await db.one<FormatRow>(
    `select * from public.brief_formats where workspace_id = $1 and key = $2`,
    [workspaceId, key],
  );
  if (!row) throw notFound(`Format "${key}" is not configured in this workspace`);
  return row;
}

export async function getActivePromptVersion(
  db: Queryable,
  workspaceId: string,
  formatId: string,
): Promise<PromptVersionRow> {
  assertScope(workspaceId, 'getActivePromptVersion');
  const row = await db.one<PromptVersionRow>(
    `select pv.* from public.prompt_versions pv
       join public.brief_formats f
         on f.active_prompt_version_id = pv.id and f.id = pv.format_id
      where pv.workspace_id = $1 and pv.format_id = $2`,
    [workspaceId, formatId],
  );
  if (row) return row;
  // Fall back to the newest version when no active pointer is set.
  const latest = await db.one<PromptVersionRow>(
    `select * from public.prompt_versions
      where workspace_id = $1 and format_id = $2 order by version desc limit 1`,
    [workspaceId, formatId],
  );
  if (!latest) throw notFound('No prompt version exists for this format');
  return latest;
}

export async function listPromptVersions(
  db: Queryable,
  workspaceId: string,
  formatId: string,
): Promise<Omit<PromptVersionRow, 'body' | 'attachments'>[]> {
  assertScope(workspaceId, 'listPromptVersions');
  return db.rows(
    `select id, format_id, version, structured, checksum, note, created_at
       from public.prompt_versions
      where workspace_id = $1 and format_id = $2 order by version desc`,
    [workspaceId, formatId],
  );
}

export interface CreatePromptVersionInput {
  workspaceId: string;
  formatId: string;
  body: string;
  attachments?: { path: string; title: string; body: string }[];
  structured?: Record<string, unknown>;
  note?: string | null;
  createdBy?: string | null;
  makeActive?: boolean;
}

export async function createPromptVersion(
  db: Queryable,
  input: CreatePromptVersionInput,
): Promise<PromptVersionRow> {
  const workspaceId = assertScope(input.workspaceId, 'createPromptVersion');
  const attachments = input.attachments ?? [];
  const checksum = promptChecksum(input.body, attachments);

  // An identical prompt does not need a new version.
  const identical = await db.one<PromptVersionRow>(
    `select * from public.prompt_versions
      where workspace_id = $1 and format_id = $2 and checksum = $3
      order by version desc limit 1`,
    [workspaceId, input.formatId, checksum],
  );
  if (identical) {
    if (input.makeActive !== false) {
      await db.query(
        `update public.brief_formats set active_prompt_version_id = $3, updated_at = now()
          where workspace_id = $1 and id = $2`,
        [workspaceId, input.formatId, identical.id],
      );
    }
    return identical;
  }

  const next = await db.oneOrFail<{ version: number }>(
    `select coalesce(max(version), 0) + 1 as version from public.prompt_versions
      where workspace_id = $1 and format_id = $2`,
    [workspaceId, input.formatId],
  );

  const created = await db.oneOrFail<PromptVersionRow>(
    `insert into public.prompt_versions
       (workspace_id, format_id, version, body, attachments, structured, checksum, note, created_by)
     values ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9)
     returning *`,
    [
      workspaceId,
      input.formatId,
      next.version,
      input.body,
      JSON.stringify(attachments),
      JSON.stringify(input.structured ?? {}),
      checksum,
      input.note ?? null,
      input.createdBy ?? null,
    ],
  );

  if (input.makeActive !== false) {
    await db.query(
      `update public.brief_formats set active_prompt_version_id = $3, updated_at = now()
        where workspace_id = $1 and id = $2`,
      [workspaceId, input.formatId, created.id],
    );
  }
  return created;
}

export async function upsertFormat(
  db: Queryable,
  workspaceId: string,
  key: FormatKey,
  overrides?: Partial<Pick<FormatRow, 'default_model' | 'research_model'>>,
): Promise<FormatRow> {
  assertScope(workspaceId, 'upsertFormat');
  const config = FORMAT_CONFIGS[key];
  return db.oneOrFail<FormatRow>(
    `insert into public.brief_formats
       (workspace_id, key, name, product_line, description, config, default_model, research_model)
     values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)
     on conflict (workspace_id, key) do update set
       name = excluded.name,
       product_line = excluded.product_line,
       description = excluded.description,
       config = excluded.config,
       default_model = coalesce(excluded.default_model, public.brief_formats.default_model),
       research_model = coalesce(excluded.research_model, public.brief_formats.research_model),
       updated_at = now()
     returning *`,
    [
      workspaceId,
      key,
      config.name,
      config.productLine,
      config.description,
      JSON.stringify(config),
      overrides?.default_model ?? null,
      overrides?.research_model ?? null,
    ],
  );
}

/** Replaces a format's structured rules, e.g. from the Settings screen. */
export async function updateFormatConfig(
  db: Queryable,
  workspaceId: string,
  formatId: string,
  config: FormatConfig,
  models?: { defaultModel?: string | null; researchModel?: string | null },
): Promise<FormatRow> {
  assertScope(workspaceId, 'updateFormatConfig');
  return db.oneOrFail<FormatRow>(
    `update public.brief_formats
        set config = $3::jsonb,
            default_model = coalesce($4, default_model),
            research_model = coalesce($5, research_model),
            updated_at = now()
      where workspace_id = $1 and id = $2
      returning *`,
    [workspaceId, formatId, JSON.stringify(config), models?.defaultModel ?? null, models?.researchModel ?? null],
  );
}
