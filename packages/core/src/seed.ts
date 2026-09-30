/**
 * Seeds a workspace so the application is usable immediately after migration.
 *
 * Idempotent: every insert is an upsert, so running it twice changes nothing.
 *
 * For a CLEAN local demo database only. It upserts business units, overwriting
 * their type and summary, so it must never run against a database holding
 * imported Globa 3 data: use bootstrapImportedWorkspace (bootstrap-imported.ts)
 * there. The CLI refuses when it detects that case.
 *
 * What it creates:
 *   - the first workspace, with both users and their approval capability;
 *   - the three formats, with their structured rules and a prompt version built
 *     from the run prompts in seed/prompts;
 *   - business units, so proposed records can link to the existing structure;
 *   - run context (priorities, targets, watch items, geographies) taken from the
 *     example context in the AMV Daily run prompt, as a starting point to edit;
 *   - a small number of knowledge records that exist in the real database, so
 *     entity resolution has something to match against and the duplicate and
 *     ambiguity paths are exercisable;
 *   - a soft monthly budget.
 */
import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { FORMAT_KEYS, FORMAT_PROMPT_SOURCES, slugify, type FormatKey } from '@g3/shared';
import { ensureUser, grantMembership } from './auth.js';
import { withService, type Queryable } from './db.js';
import { createPromptVersion, upsertFormat } from './formats-repo.js';
import { logActivity } from './activity.js';
import { AppError } from './errors.js';

export interface SeedOptions {
  workspaceSlug?: string;
  workspaceName?: string;
  adminEmail: string;
  adminPassword: string;
  clientEmail: string;
  clientPassword: string;
  promptRoot?: string;
  /**
   * Seed even though the workspace looks like imported data. Only the local CLI
   * sets this, and only on explicit request (SEED_OVERWRITE_BUSINESS_UNITS=1).
   */
  allowImportedData?: boolean;
}

export interface SeedResult {
  workspaceId: string;
  adminUserId: string;
  clientUserId: string;
  formats: { key: string; id: string; promptVersion: number; attachments: number }[];
  businessUnits: number;
  contextItems: number;
  entities: number;
}

export function findPromptRoot(explicit?: string): string {
  const candidates = [
    explicit,
    resolve(process.cwd(), 'seed/prompts'),
    resolve(process.cwd(), '../seed/prompts'),
    resolve(process.cwd(), '../../seed/prompts'),
  ].filter((c): c is string => Boolean(c));
  for (const candidate of candidates) {
    if (existsSync(resolve(candidate, 'run_prompts'))) return candidate;
  }
  throw new Error(
    `Could not find seed/prompts. Looked in: ${candidates.join(', ')}. Run the seed from the repository root.`,
  );
}

/** The run prompt and desk files for a format, exactly as shipped in seed/prompts. */
export function readFormatPrompt(
  promptRoot: string,
  key: FormatKey,
): {
  body: string;
  attachments: { path: string; title: string; body: string }[];
  structured: Record<string, unknown>;
  note: string;
} {
  const source = FORMAT_PROMPT_SOURCES[key];
  return {
    body: readFileSync(resolve(promptRoot, 'run_prompts', source.runPrompt), 'utf8'),
    attachments: source.deskFiles.map((path) => ({
      path,
      title: path.split('/').pop() ?? path,
      body: readFileSync(resolve(promptRoot, path), 'utf8'),
    })),
    structured: { source: source.runPrompt, deskFiles: source.deskFiles },
    note: `Seeded verbatim from ${source.runPrompt} in main_briefs_renaming_patch_PURE_SAFE_2026-06-25.`,
  };
}

export const BUSINESS_UNITS: { name: string; type: string; summary: string }[] = [
  {
    name: 'AMV',
    type: 'venture',
    summary:
      'Athlete Media & Ventures. Builds the business layer around elite athletes: owned media, original IP, repeatable franchises, athlete-led venture platforms, sponsor architecture and distribution. Strategic frame: from endorsement to ownership. Delivery frame: Blueprint, Build, Operate, Scale.',
  },
  {
    name: 'Globa 3 Studios',
    type: 'division',
    summary: 'Production and original content development.',
  },
  {
    name: 'Globa 3 Advisory',
    type: 'division',
    summary: 'Strategic advisory for media, rights and market-entry work.',
  },
  {
    name: 'Globa 3 Ventures',
    type: 'division',
    summary: 'Venture building and investment activity.',
  },
  {
    name: 'Creative Radar',
    type: 'product',
    summary:
      'Daily creative-intelligence and scouting desk for talent, projects, story worlds, festival and market validation, labs, grants and regional IP. Gulf, Africa and diaspora first.',
  },
  {
    name: 'AFC',
    type: 'venture',
    summary: 'Africa-focused media platform and insight products.',
  },
  {
    name: 'Parenthood Nigeria',
    type: 'project',
    summary: 'Original format and growth project under AFC.',
  },
  {
    name: 'Unseen Arabia',
    type: 'project',
    summary: 'Regional properties and cultural IP project.',
  },
];

/**
 * Context taken from the example values in the AMV Daily run prompt. Seeded as
 * editable rows rather than left inside the prompt text, because the prompts
 * themselves warn against treating stale example values as live watch items.
 */
export const CONTEXT_ITEMS: { kind: string; label: string; detail: string | null; formatKey?: FormatKey }[] = [
  { kind: 'priority', label: 'Athlete-owned media platforms', detail: null },
  { kind: 'priority', label: 'Sponsor-funded IP franchises', detail: null },
  { kind: 'priority', label: 'Gulf market expansion', detail: null },
  { kind: 'target', label: 'Serena Ventures', detail: null },
  { kind: 'target', label: 'Omaha Productions', detail: null },
  { kind: 'target', label: 'Unrivaled', detail: null },
  { kind: 'target', label: 'WNBPA licensing developments', detail: null },
  {
    kind: 'open_watch_item',
    label: 'WNBPA individual NIL and group licensing dispute',
    detail: 'Rights-and-licensing thread to refresh on every run.',
  },
  {
    kind: 'open_watch_item',
    label: "Athlete-led women's sports media launches",
    detail: null,
  },
  { kind: 'priority_geography', label: 'North America', detail: null },
  { kind: 'priority_geography', label: 'UAE, Saudi Arabia, Qatar and wider Gulf', detail: null },
  { kind: 'priority_geography', label: 'Nigeria and wider Africa', detail: null },
  { kind: 'priority_geography', label: 'United Kingdom, France and wider Europe', detail: null },
  { kind: 'priority_sport', label: 'All elite sports', detail: null },
  {
    kind: 'priority_geography',
    label: 'Gulf, Africa and diaspora first',
    detail:
      'Global items qualify only when tied to those markets, to diaspora talent or IP, or to Globa 3 relationship value.',
    formatKey: 'globa3_creative_radar',
  },
];

/**
 * A few records that exist in the real database, so resolution has something to
 * match. "Sports One" and "Paul Misir" are real rows from the 2026-09-03 research
 * run; the mock provider deliberately references them, plus a near-duplicate, to
 * exercise the existing / ambiguous / new paths.
 */
const SEED_ENTITIES: {
  type: string;
  name: string;
  description: string;
  researchStatus: string;
  relationshipStatus: string;
}[] = [
  {
    type: 'organization',
    name: 'Sports One',
    description:
      'Athlete and franchise value infrastructure. Captured from brief research; research-only, with no Globa 3 relationship confirmed.',
    researchStatus: 'research_only',
    relationshipStatus: 'none',
  },
  {
    type: 'person',
    name: 'Paul Misir',
    description:
      'Connected to Sports One leadership. Captured from brief research; research-only, no relationship confirmed.',
    researchStatus: 'research_only',
    relationshipStatus: 'none',
  },
];

export async function seedWorkspace(options: SeedOptions): Promise<SeedResult> {
  const promptRoot = findPromptRoot(options.promptRoot);
  const slug = options.workspaceSlug ?? 'globa3';
  const name = options.workspaceName ?? 'Globa 3';

  // Refuse before creating anything. The verify suites call this too, so they
  // refuse on an imported database as well instead of writing demo data into it.
  if (!options.allowImportedData) {
    const signals = await importedDataSignals(slug);
    if (signals.length > 0) {
      throw new AppError(
        `Refusing to run the demo seed: workspace "${slug}" holds imported data (${signals.join('; ')}). ` +
          'It would overwrite business units and add demo records. Use the import-safe bootstrap: npm run db:bootstrap:imported -- --workspace ' +
          slug,
        409,
        'imported_data_present',
      );
    }
  }

  // Users are created through the auth module: via the Supabase Admin API when
  // Supabase Auth is configured, otherwise in the local development table.
  const adminUserId = await ensureUser(options.adminEmail, options.adminPassword, 'Mariana');
  const clientUserId = await ensureUser(options.clientEmail, options.clientPassword, 'Client');

  return withService(async (db: Queryable) => {
    const workspace = await db.oneOrFail<{ id: string }>(
      `insert into public.workspaces (slug, name, timezone)
       values ($1, $2, 'Europe/Paris')
       on conflict (slug) do update set name = excluded.name, updated_at = now()
       returning id`,
      [slug, name],
    );
    const workspaceId = workspace.id;

    // Both users can approve records; only the admin administers the workspace.
    await grantMembership(db, workspaceId, adminUserId, 'admin', true);
    await grantMembership(db, workspaceId, clientUserId, 'editor', true);

    // --- business units ---------------------------------------------------
    for (const unit of BUSINESS_UNITS) {
      await db.query(
        `insert into public.business_units (workspace_id, name, slug, type, summary, status)
         values ($1,$2,$3,$4,$5,'active')
         on conflict (workspace_id, slug) do update set
           type = excluded.type, summary = excluded.summary, updated_at = now()`,
        [workspaceId, unit.name, slugify(unit.name), unit.type, unit.summary],
      );
    }

    // --- formats and prompt versions --------------------------------------
    const formats: SeedResult['formats'] = [];
    for (const key of FORMAT_KEYS) {
      const format = await upsertFormat(db, workspaceId, key);
      const prompt = readFormatPrompt(promptRoot, key);

      const version = await createPromptVersion(db, {
        workspaceId,
        formatId: format.id,
        ...prompt,
        createdBy: adminUserId,
        makeActive: true,
      });
      formats.push({
        key,
        id: format.id,
        promptVersion: version.version,
        attachments: prompt.attachments.length,
      });
    }

    // --- run context ------------------------------------------------------
    let contextItems = 0;
    for (const item of CONTEXT_ITEMS) {
      const formatId = item.formatKey
        ? (
            await db.one<{ id: string }>(
              `select id from public.brief_formats where workspace_id = $1 and key = $2`,
              [workspaceId, item.formatKey],
            )
          )?.id ?? null
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
         values ($1,$2,$3,$4,$5)`,
        [workspaceId, formatId, item.kind, item.label, item.detail],
      );
      contextItems += 1;
    }

    // --- entities to resolve against --------------------------------------
    let entities = 0;
    for (const entity of SEED_ENTITIES) {
      const result = await db.query(
        `insert into public.entities
           (workspace_id, entity_type, display_name, slug, description,
            research_status, relationship_status, status, visibility,
            external_use_status, provenance_note)
         values ($1,$2,$3,$4,$5,$6,$7,'active','internal','not_cleared',$8)
         on conflict (workspace_id, slug) do nothing`,
        [
          workspaceId,
          entity.type,
          entity.name,
          slugify(entity.name),
          entity.description,
          entity.researchStatus,
          entity.relationshipStatus,
          'Seeded from the 2026-09-03 brief research run recorded in the Supabase Connection package.',
        ],
      );
      entities += result.rowCount ?? 0;
    }

    // --- a soft monthly budget -------------------------------------------
    await db.query(
      `insert into public.budgets (workspace_id, period, limit_usd, hard_stop)
       values ($1, 'month', 200.00, false)
       on conflict (workspace_id, period) do nothing`,
      [workspaceId],
    );

    await logActivity(db, {
      workspaceId,
      actorId: adminUserId,
      actorKind: 'system',
      action: 'workspace.seeded',
      summary: `Seeded ${formats.length} format(s), ${BUSINESS_UNITS.length} business unit(s) and ${contextItems} context item(s).`,
      data: { formats: formats.map((f) => f.key) },
    });

    return {
      workspaceId,
      adminUserId,
      clientUserId,
      formats,
      businessUnits: BUSINESS_UNITS.length,
      contextItems,
      entities,
    };
  });
}

/**
 * Creates a second workspace with no shared data. Used by the isolation test and
 * available for onboarding a future client.
 */
export async function seedAdditionalWorkspace(
  slug: string,
  name: string,
  ownerEmail: string,
  ownerPassword: string,
): Promise<{ workspaceId: string; userId: string }> {
  const userId = await ensureUser(ownerEmail, ownerPassword, name);
  return withService(async (db) => {
    const workspace = await db.oneOrFail<{ id: string }>(
      `insert into public.workspaces (slug, name, timezone)
       values ($1,$2,'Europe/Paris')
       on conflict (slug) do update set name = excluded.name
       returning id`,
      [slug, name],
    );
    await grantMembership(db, workspace.id, userId, 'admin', true);
    for (const key of FORMAT_KEYS) await upsertFormat(db, workspace.id, key);
    return { workspaceId: workspace.id, userId };
  });
}

/**
 * The business units that seedWorkspace would overwrite in an existing database:
 * rows with a seeded slug whose type or summary differ from the seed values.
 *
 * An empty list means seeding cannot change any existing business unit. A
 * non-empty list is what imported data looks like, and the seed CLI refuses.
 */
export async function businessUnitsSeedWouldOverwrite(
  workspaceSlug = 'globa3',
): Promise<{ slug: string; fields: string[] }[]> {
  return withService(async (db) => {
    const workspace = await db.one<{ id: string }>(`select id from public.workspaces where slug = $1`, [
      workspaceSlug,
    ]);
    if (!workspace) return [];
    const existing = await db.rows<{ slug: string; type: string | null; summary: string | null }>(
      `select slug, type, summary from public.business_units
        where workspace_id = $1 and slug = any($2::text[])`,
      [workspace.id, BUSINESS_UNITS.map((unit) => slugify(unit.name))],
    );
    const changes: { slug: string; fields: string[] }[] = [];
    for (const row of existing) {
      const unit = BUSINESS_UNITS.find((u) => slugify(u.name) === row.slug);
      if (!unit) continue;
      const fields = [
        ...(row.type !== unit.type ? ['type'] : []),
        ...(row.summary !== unit.summary ? ['summary'] : []),
      ];
      if (fields.length > 0) changes.push({ slug: row.slug, fields });
    }
    return changes;
  });
}

/**
 * Signs that a workspace holds imported Globa 3 data rather than a demo seed.
 *
 *   - the seed would overwrite an existing business unit's type or summary;
 *   - `members` or "Globa 3 Automatization & Memory" hold rows: no application
 *     code, seed or test writes to either, only the import does.
 */
export async function importedDataSignals(workspaceSlug = 'globa3'): Promise<string[]> {
  const signals: string[] = [];
  const overwrites = await businessUnitsSeedWouldOverwrite(workspaceSlug);
  if (overwrites.length > 0) {
    signals.push(
      `would overwrite business unit(s) ${overwrites.map((o) => `${o.slug} (${o.fields.join(', ')})`).join(', ')}`,
    );
  }
  const counts = await withService((db) =>
    db.one<{ members: number; entities: number }>(
      `select (select count(*)::int from public.members m where m.workspace_id = w.id) as members,
              (select count(*)::int from public.entities e where e.workspace_id = w.id) as entities
         from public.workspaces w where w.slug = $1`,
      [workspaceSlug],
    ),
  );
  if (counts?.members) signals.push(`${counts.members} member row(s)`);
  if (counts?.entities) signals.push(`${counts.entities} entity row(s)`);
  return signals;
}
