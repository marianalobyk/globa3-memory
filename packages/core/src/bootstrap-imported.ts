/**
 * Application bootstrap for a database that holds IMPORTED Globa 3 data.
 *
 * The demo seed (seed.ts) is written for an empty database: it upserts business
 * units, overwriting their type and summary, and adds sample entities. Run
 * against an imported copy it would silently replace real records. This module
 * is the import-safe counterpart.
 *
 * It creates only what the application itself needs, and only what is missing:
 *   - the two application users (auth accounts; an existing account is left as
 *     it is, password included) and their workspace membership;
 *   - the three brief formats;
 *   - a prompt version per format, when the format has none;
 *   - run context items that are not there yet;
 *   - the budget setting, when the workspace has none.
 *
 * It never creates the workspace (migration 0006 does), and never inserts,
 * updates or deletes a row in any imported table: business units, members,
 * entities, knowledge, rules, contacts, companies, evidence, research, signals
 * or any other. That is enforced, not just intended: every imported table is
 * fingerprinted before and after the writes inside the same transaction, and a
 * difference rolls the whole bootstrap back.
 *
 * Idempotent: an existing membership, format, prompt version, context item or
 * budget is never modified, so a second run creates nothing and changes nothing,
 * and edits made in Settings afterwards survive re-runs.
 */
import { FORMAT_KEYS, FORMAT_CONFIGS } from '@g3/shared';
import { ensureUser } from './auth.js';
import { withService, type Queryable } from './db.js';
import { AppError } from './errors.js';
import { createPromptVersion } from './formats-repo.js';
import { CONTEXT_ITEMS, findPromptRoot, readFormatPrompt } from './seed.js';

/** Every table that holds imported (pre-application) data. Never written here. */
export const IMPORTED_TABLES = [
  'business_units',
  'members',
  'member_business_units',
  'evidence',
  'external_companies',
  'external_contacts',
  'entities',
  'research_artifacts',
  'entity_aliases',
  'entity_affiliations',
  'entity_mentions',
  'interactions',
  'actions',
  'signals',
  'signal_entities',
  'research_findings',
  'knowledge',
  'rules',
  'meetings',
  'relationship_interactions',
  'Globa 3 Automatization & Memory',
  'opportunities',
  'outcomes',
] as const;

export interface BootstrapImportedOptions {
  workspaceSlug: string;
  adminEmail: string;
  adminPassword: string;
  clientEmail?: string;
  clientPassword?: string;
  promptRoot?: string;
}

export interface BootstrapImportedResult {
  workspaceId: string;
  adminUserId: string;
  clientUserId?: string;
  created: {
    memberships: number;
    formats: number;
    promptVersions: number;
    contextItems: number;
    budgets: number;
  };
  /** Existing memberships whose role or approval right differs from the bootstrap default. Reported, not changed. */
  membershipNotes: string[];
  importedTablesChecked: number;
}

export class ImportedDataChangedError extends AppError {
  constructor(public readonly tables: string[]) {
    super(
      `Bootstrap aborted and rolled back: imported data changed during the bootstrap in ${tables.join(', ')}. Nothing was written.`,
      500,
      'imported_data_changed',
    );
  }
}

/**
 * One fingerprint per imported table: row count plus an md5 over every row's
 * full text, in id order. Any insert, update or delete changes it.
 */
export async function fingerprintImportedTables(db: Queryable): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const table of IMPORTED_TABLES) {
    const exists = await db.one<{ present: boolean }>(
      `select to_regclass(format('public.%I', $1::text)) is not null as present`,
      [table],
    );
    if (!exists?.present) {
      result.set(table, 'absent');
      continue;
    }
    const quoted = `public."${table.replace(/"/g, '""')}"`;
    const row = await db.oneOrFail<{ n: string; digest: string | null }>(
      `select count(*)::text as n,
              md5(coalesce(string_agg(md5(t::text), '' order by t.id::text), '')) as digest
         from ${quoted} t`,
    );
    result.set(table, `${row.n}:${row.digest}`);
  }
  return result;
}

export async function bootstrapImportedWorkspace(
  options: BootstrapImportedOptions,
): Promise<BootstrapImportedResult> {
  const promptRoot = findPromptRoot(options.promptRoot);

  // Check the workspace first, so a wrong slug creates no accounts either.
  const workspace = await withService((db) =>
    db.one<{ id: string; status: string }>(`select id, status from public.workspaces where slug = $1`, [
      options.workspaceSlug,
    ]),
  );
  if (!workspace) {
    throw new AppError(
      `Workspace "${options.workspaceSlug}" does not exist. Apply the migrations first; the bootstrap never creates a workspace.`,
      400,
      'workspace_missing',
    );
  }
  if (workspace.status !== 'active') {
    throw new AppError(`Workspace "${options.workspaceSlug}" is not active.`, 400, 'workspace_inactive');
  }
  const workspaceId = workspace.id;

  // Accounts. An existing account keeps its password.
  const adminUserId = await ensureUser(options.adminEmail, options.adminPassword, 'Mariana', {
    resetPassword: false,
  });
  const clientUserId =
    options.clientEmail && options.clientPassword
      ? await ensureUser(options.clientEmail, options.clientPassword, 'Client', { resetPassword: false })
      : undefined;

  return withService(async (db) => {
    const before = await fingerprintImportedTables(db);
    const created = { memberships: 0, formats: 0, promptVersions: 0, contextItems: 0, budgets: 0 };
    const membershipNotes: string[] = [];

    // --- memberships: every configured user can approve; only the admin administers
    const memberships = [
      [adminUserId, 'admin', options.adminEmail],
      ...(clientUserId && options.clientEmail ? [[clientUserId, 'editor', options.clientEmail] as const] : []),
    ] as const;
    for (const [userId, role, email] of memberships) {
      const inserted = await db.query(
        `insert into public.workspace_members (workspace_id, user_id, role, can_approve)
         values ($1, $2, $3, true)
         on conflict (workspace_id, user_id) do nothing`,
        [workspaceId, userId, role],
      );
      created.memberships += inserted.rowCount ?? 0;
      if (!inserted.rowCount) {
        const existing = await db.oneOrFail<{ role: string; can_approve: boolean }>(
          `select role, can_approve from public.workspace_members where workspace_id = $1 and user_id = $2`,
          [workspaceId, userId],
        );
        if (existing.role !== role || !existing.can_approve) {
          membershipNotes.push(
            `${email}: existing membership kept as role=${existing.role}, can_approve=${existing.can_approve}`,
          );
        }
      }
    }

    // --- formats and their first prompt version ---------------------------
    for (const key of FORMAT_KEYS) {
      const config = FORMAT_CONFIGS[key];
      const inserted = await db.query(
        `insert into public.brief_formats (workspace_id, key, name, product_line, description, config)
         values ($1, $2, $3, $4, $5, $6::jsonb)
         on conflict (workspace_id, key) do nothing`,
        [workspaceId, key, config.name, config.productLine, config.description, JSON.stringify(config)],
      );
      created.formats += inserted.rowCount ?? 0;

      const format = await db.oneOrFail<{ id: string; active_prompt_version_id: string | null }>(
        `select id, active_prompt_version_id from public.brief_formats where workspace_id = $1 and key = $2`,
        [workspaceId, key],
      );
      const versions = await db.oneOrFail<{ n: number }>(
        `select count(*)::int as n from public.prompt_versions where workspace_id = $1 and format_id = $2`,
        [workspaceId, format.id],
      );
      if (versions.n === 0) {
        await createPromptVersion(db, {
          workspaceId,
          formatId: format.id,
          ...readFormatPrompt(promptRoot, key),
          createdBy: adminUserId,
          makeActive: true,
        });
        created.promptVersions += 1;
      }
    }

    // --- run context --------------------------------------------------------
    for (const item of CONTEXT_ITEMS) {
      const formatId = item.formatKey
        ? (
            await db.oneOrFail<{ id: string }>(
              `select id from public.brief_formats where workspace_id = $1 and key = $2`,
              [workspaceId, item.formatKey],
            )
          ).id
        : null;
      const already = await db.one<{ id: string }>(
        `select id from public.context_items
          where workspace_id = $1 and kind = $2 and label = $3
            and coalesce(format_id::text, '') = coalesce($4::text, '')`,
        [workspaceId, item.kind, item.label, formatId],
      );
      if (already) continue;
      await db.query(
        `insert into public.context_items (workspace_id, format_id, kind, label, detail)
         values ($1, $2, $3, $4, $5)`,
        [workspaceId, formatId, item.kind, item.label, item.detail],
      );
      created.contextItems += 1;
    }

    // --- budget -------------------------------------------------------------
    const budget = await db.query(
      `insert into public.budgets (workspace_id, period, limit_usd, hard_stop)
       values ($1, 'month', 200.00, false)
       on conflict (workspace_id, period) do nothing`,
      [workspaceId],
    );
    created.budgets += budget.rowCount ?? 0;

    // --- the guarantee: no imported table changed ---------------------------
    const after = await fingerprintImportedTables(db);
    const changed = [...before.keys()].filter((table) => before.get(table) !== after.get(table));
    if (changed.length > 0) throw new ImportedDataChangedError(changed);

    return {
      workspaceId,
      adminUserId,
      clientUserId,
      created,
      membershipNotes,
      importedTablesChecked: before.size,
    };
  });
}
