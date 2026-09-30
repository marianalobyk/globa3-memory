# Globa 3 Workspace

Institutional memory, captured on a phone in the minutes after a meeting.

**Capture → Analyze → Resolve → Propose → Approve → Remember → Follow up.**
Write, paste or dictate what happened ("I met Anna Smith from Horizon Studios at
Cannes…") → the note is stored as a private, untrusted source → it is analysed
against what Globa 3 already knows, never against the web → people, companies
and projects are matched to memory, and a similar name is shown as a possible
match rather than merged → a compact proposal separates what the source states,
what is inferred, suggested follow-ups and what is still unknown → only the
changes a person approves are saved, read back, and shown on Today, in Knowledge
and in Activity. Research on a person, company or project runs only when someone
explicitly asks for it.

The primary client is the iOS app in [`apps/mobile`](apps/mobile/README.md)
(React Native + Expo). The Next.js app is the companion desktop and admin
interface. Both use the same server API; the phone holds no database, Supabase
or model credentials.

Briefs, brief formats and brief-based research are no longer part of the
product. Their records, migrations and code are kept; their screens redirect to
Capture.

Nothing reaches the knowledge base without a person approving it. That is
enforced in the database, not only in the UI: since migration `0018`, the client
roles (`anon`, `authenticated`) hold no write privilege of any kind on any table
in `public` -- no INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES or TRIGGER -- and
every trusted write is made by the server as `service_role` after its own checks.

---

## Contents

- [Quick start](#quick-start)
- [How it fits together](#how-it-fits-together)
- [The three formats](#the-three-formats)
- [Approval and data integrity](#approval-and-data-integrity)
- [Workspace isolation](#workspace-isolation)
- [Running against Supabase](#running-against-supabase)
- [The legacy import path (removed)](#the-legacy-import-path-removed)
- [Navigation performance](#navigation-performance)
- [Verification](#verification)
- [Repository layout](#repository-layout)
- [Known limits](#known-limits)

---

## Quick start

Requirements: **Node 20.9+** (Node 22 recommended — `.nvmrc` pins 22). No Docker,
Postgres or Supabase CLI needed for local development.

```bash
nvm use          # or any Node >= 20.9
npm install
cp .env.example .env.local
```

Then, in **three terminals**:

```bash
npm run db:local
```

```bash
npm run db:migrate && npm run db:seed && npm run worker
```

```bash
npm run dev
```

Open <http://localhost:3000> and sign in with the seeded credentials
(`SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` from `.env.local`; the defaults are
`admin@example.invalid` / `ChangeMeBeforeUse`).

The local sign-in works only because `.env.example` sets `DEV_AUTH_ENABLED=true`.
See [Authentication](#authentication).

### What each command does

| Command | Purpose |
| --- | --- |
| `npm run db:local` | Starts the local database and **keeps running**. |
| `npm run db:migrate` | Applies `supabase/migrations` in order, once each. |
| `npm run db:seed` | **Clean local demo database only.** Creates both users, the three formats and their prompts, demo business units and entities. Refuses a database with imported data. |
| `npm run db:bootstrap:imported` | Creates memberships, formats, prompt versions and context for a database that already holds Globa 3 data. |
| `npm run worker` | Background worker. Briefs and research run here, not in the web request. |
| `npm run dev` | Next.js app on port 3000. |
| `npm run verify` | End-to-end verification (see [Verification](#verification)). |
| `npm run verify:review` | Checks for the code-review fixes: auth modes, exact operations, lost updates, concurrent creates, migration compatibility, legacy upsert. |
| `npm run verify:migrations` | Migration integrity and the legacy upsert, on an isolated throwaway database. |
| `npm run verify:perf` | Query-count regression check for the six main screens (transactions, statements, round trips, read-only), on an isolated throwaway database. |
| `npm run verify:all` | All four suites. |
| `npm run db:status` | Migration state; fails if an applied migration no longer matches its file. |
| `npm run supabase:test:demo` | **Fastest way to run the UI against the test project**: production build + `next start` on :3000 and the worker, in one terminal. See [Navigation performance](#navigation-performance). |
| `npm run supabase:test:*` | Preflight, migrate, import, bootstrap, seed, verify, perf, dev, worker against the **test** Supabase project. See [docs/SUPABASE_TEST_RUN.md](docs/SUPABASE_TEST_RUN.md). |
| `npm run typecheck` | Typechecks every package. |
| `npm run db:reset` | Deletes the local database and starts over. |

### About the local database

`npm run db:local` runs **PGlite** — real PostgreSQL 18 compiled to WebAssembly —
with a persistent data directory, exposed on the PostgreSQL wire protocol at
`127.0.0.1:54329`. The web app and the worker connect to it with an ordinary `pg`
client and an ordinary `DATABASE_URL`.

This exists because this project's Supabase host does not resolve and the
development machine has no Docker or Postgres. It is not a mock: RLS policies,
`plpgsql` triggers, roles, transactions and `auth.uid()` all behave as they do on
Supabase, which is what makes the isolation and approval guarantees testable
locally. Point `DATABASE_URL` at Supabase and the same migrations and the same
SQL run unchanged.

### Running without an OpenAI key

With no `OPENAI_API_KEY`, the app runs a **mock provider**. The full pipeline
executes — stages, queueing, retries, entity resolution, proposals, approval,
apply, readback — but the generated content is synthetic. Every affected run,
brief, proposal and usage row is flagged `is_mock`, and the UI labels it. Nothing
synthetic can be mistaken for research.

---

## How it fits together

```
iPhone app (Expo)         Browser (companion web app)
   │  bearer token             │  httpOnly cookies
   └────────────┬──────────────┘
                ▼
Next.js server  ──── checks access, validates, enqueues, and applies approvals
   │                 (the ONLY writer to knowledge tables)
   ▼
Supabase Queues (pgmq) ── durable jobs with visibility timeouts
   │
   ▼
Worker (separate Node process)
   │  capture:  load → extract → resolve (match memory) → propose
   │  research: only on explicit request, as its own proposal
   │  brief:    (retired from the product; kept for existing records)
   │  research: plan → deep_research → synthesize → propose
   │  ingest:   expand → parse → persist
   ▼
PostgreSQL (Supabase) ── RLS, workspace-scoped, composite FKs
```

**Long work never depends on a request or a browser tab.** The web server creates
a run row and a queue message, then returns. The worker leases the job, records
progress per stage, and extends the lease while it works. Deep research is
created as a background provider response whose id is stored on the stage row, so
a worker restart resumes polling the same research rather than paying for it
twice.

**Crash recovery.** If the worker dies, its run lease and the queue message's
visibility timeout both lapse. The message is redelivered, the run returns to
`queued`, and a worker picks it up. Because every finished stage stored its
output, the resumed run **skips completed stages** instead of restarting.

---

## The three formats

| Key | Format |
| --- | --- |
| `amv_daily` | AMV by Globa 3 Daily Athlete Ownership & Platform Intelligence Brief |
| `amv_creative_radar` | AMV Creative Radar — Athletes, Stories, Media & IP |
| `globa3_creative_radar` | Globa 3 Creative Radar |

Each keeps its **own** rules, and they are genuinely different — not one prompt
with a changed title:

- search lanes and mandatory scans
- source families, tiers and source-quality rules
- scoring rubric and elevation thresholds
- freshness vocabulary and what may be elevated
- coverage-window shape (24h; AMV Daily adds a 72h backstop; both radars add a
  7-day rolling context and a 30-day forward watch)
- required reader structure and output modes
- QA checklist and release statuses

These live in two halves:

1. **Machine-readable rules** in `packages/shared/src/formats.ts`, stored on
   `brief_formats.config`. Code consumes them: the prompt builder injects them,
   the QA step checks against them, Settings displays them.
2. **The run prompt text** in `seed/prompts/run_prompts/`, stored verbatim as
   `prompt_versions.body`. Every brief records which prompt version produced it.

### Dates are computed by code, never by the model

The prompts are explicit that the orchestrator computes run metadata and the
model must use the injected values exactly. So `packages/shared/src/time.ts`
computes every timestamp and window in `Europe/Paris`, and the prompt builder:

1. rewrites every `[VAR] = …` assignment in the stored prompt with the computed
   value — the prompts warn against treating stale example values as live watch
   items, so the examples are overwritten rather than left in place;
2. prepends an authoritative metadata block;
3. **fails the metadata gate before any research call** if a required variable is
   missing, which the formats define as a FAIL condition.

Watchlists, priorities, targets, open actions and previously accepted/rejected
signals are read from the database and injected the same way.

> **A note on `n8n`.** The archived prompts say n8n validates and injects run
> metadata. That automation was never implemented. The Next.js server and the
> worker perform that role here.

---

## Authentication

One setting decides which authenticator is in force (`authMode()` in
`packages/core/src/env.ts`):

| Mode | When | How it works |
| --- | --- | --- |
| `supabase` | `SUPABASE_URL` and `SUPABASE_ANON_KEY` are set | The login form posts to `/api/auth/login`, which exchanges the password with Supabase **server-side** (`grant_type=password`). Access and refresh tokens are stored as **httpOnly** cookies (`g3_at`, `g3_rt`); the browser never holds a token it can read. `src/middleware.ts` refreshes an expired access token with the refresh token and forwards the fresh one on the same request. Sign-out revokes the session at Supabase (`/auth/v1/logout`) before clearing cookies. Every request verifies the JWT (JWKS, or `SUPABASE_JWT_SECRET` for HS256). |
| `dev` | Supabase not configured **and** `DEV_AUTH_ENABLED=true` **and** not production | Local password table and a signed cookie. Sessions are labelled "Local auth". |
| `none` | Neither | Sign-in is refused with the missing configuration named. |

The dev sign-in fails closed: it is off by default, it is refused whenever
`NODE_ENV=production` regardless of the flag, and a dev cookie is ignored
entirely once Supabase Auth is configured.

> **Not verified live.** The Supabase exchange, refresh and revocation are
> implemented against Supabase's documented auth endpoints but have not been run
> against a real project. See [Supabase test checklist](#supabase-test-checklist).

---

## Approval and data integrity

### Nothing is written without approval

The browser and the mobile app never connect to the database. They call the
Next.js server, which verifies the session, **reads** as `authenticated` with the
user's id bound to the transaction (so RLS decides what is visible), and
**writes** only as `service_role`, after checking membership, approval capability
and the approved proposal version.

The database backs that up on its own, because a Supabase project also exposes
its Data API (PostgREST) to anyone holding the public anon key and a user's token:

| Role | Tables in `public` | Sequences | Functions in `public` |
| --- | --- | --- | --- |
| `anon` | nothing | nothing | nothing |
| `authenticated` | `SELECT` only, and only on tables with RLS enabled | nothing | `EXECUTE` only on the RLS helpers `is_workspace_member` and `can_approve_in_workspace` |
| `service_role` | full DML (the server and worker) | usage | all application functions |

Before `0018_revoke_client_write_privileges.sql` this was **not** true on
Supabase: 0007 granted signed-in users `SELECT`, but Supabase's default
privileges had already given `authenticated` every table privilege, including
`TRUNCATE` (which RLS does not govern), plus `setval` on sequences and `EXECUTE`
on the legacy writer functions. RLS refused the row writes, but the grants were
too broad. 0018 revokes them and changes the default privileges so tables and
sequences created later in `public` give client roles nothing; a new table must
grant `SELECT` to `authenticated` explicitly, as 0017 does.

One limit: PostgreSQL only lets the built-in "PUBLIC may execute new functions"
default be removed instance-wide, so a **new** function in `public` must revoke
`EXECUTE` from `public`, `anon` and `authenticated` in its own migration.
`npm run verify:grants` (locally, against Supabase-style default grants) and
`npm run supabase:test:grants` (the test project, read-only) fail if any client
privilege reappears.

### Approval is bound to an exact version

- `proposals.content_hash` is derived from the items' effective values.
- An approval is recorded against a specific `(version, content_hash)`.
- **Editing any item** bumps the version, recomputes the hash, revokes
  outstanding approvals and returns every item to pending.

So an approval can never carry over to content the approver did not see. The UI
states this plainly next to the approve button, and an edit warns before saving.

### Applying is transactional, idempotent and read back

`packages/core/src/apply.ts`, in order:

1. checks the caller holds approval capability in the workspace;
2. locks the proposal, verifies the version and that the stored hash still
   describes the stored items;
3. requires a live, unrevoked approval covering every requested item;
4. orders items by dependency and applies them in **one transaction**;
5. **re-resolves every create immediately before writing** — if a matching record
   appeared since the proposal was built, it refuses rather than duplicating;
6. **reads each row back** from the database and records the actual values.

`applied_changes` has a unique constraint on `proposal_item_id`, so a repeated
request reports `already_applied` and writes nothing.

### The approved operation is the operation performed

An approved **create** inserts a new record or is refused — it is never turned
into an update of a record the approver did not see. An approved **update**
updates the record it was approved against or is refused — it is never turned
into a create that would resurrect a deleted record.

When the approved operation no longer matches the stored data, the whole apply
rolls back and a **replacement proposal** is generated
(`supersedeProposal` in `proposals.ts`): the conflicting item is rewritten to the
operation that is now correct, pointed at the concrete record, with that record's
**current** values as the old values. The original is marked `superseded`, its
approval is revoked, and the Review screen links the two. The user re-approves
against what is actually stored.

To keep conflicts rare and genuine, the proposal builder already resolves natural
keys: a record that exists when the proposal is built is proposed as an update
from the start.

The replacement keeps each item's original `seq`, so `{ "$ref": { "seq": n } }`
placeholders and `depends_on_seq` still point at the right items. A reference to
an item that was already applied is resolved to that row's real id. Ids produced
during the refused apply are never carried over, because the rollback removed
those rows.

### Two proposals creating the same record

If another proposal creates the same record between this apply's checks and its
INSERT, the INSERT fails with a unique violation (`23505`). That aborts the
transaction, so no further query can run in it (`25P02`). The apply therefore
does not try to recover in place. It lets the whole transaction roll back, then
in a **fresh** transaction identifies the colliding row from the violated
constraint (including partial-index predicates such as one pending mention per
name) and builds the replacement proposal as an update of that row.

A savepoint would also work on real Postgres. It was not used because
`rollback to savepoint` after a failed parameterised query desynchronises the
local PGlite test server, and the post-rollback route behaves the same on both.

### No lost updates

When a proposal targets an existing row it stores that row's fingerprint,
`md5(row::text)`. The apply step puts the fingerprint in the UPDATE's `WHERE`
clause, so the staleness check and the write are **one atomic statement**. If
another user changed the row in between, zero rows match, nothing is
overwritten, and the item becomes a conflict with a replacement proposal showing
the other user's values.

### A similar name is never enough to merge

`packages/core/src/resolve.ts`:

- **Only** an exact canonical slug or a recorded alias counts as "the same
  record".
- Every fuzzy match — however high the score — returns `ambiguous` and is shown
  to a person with its candidates, scores and the reason.
- An unresolved name is **staged** in `entity_mentions`, never silently dropped
  and never silently created. One pending row per name: a name seen again updates
  the existing row instead of stacking duplicates.

Similarity uses token alignment rather than raw string distance, so
`Sara Johnson` ≈ `Sarah Johnson` (0.93, flagged for review) while
`Serena Ventures` ≉ `Serena Williams` (0.50, no match) — a shared first name is
not evidence of the same organisation.

### QA status is not approval

A brief's QA verdict is that format's **release gate**. It says nothing about
whether any record was approved into the knowledge base. The two are separate
everywhere: separate tables, separate badges, separate wording.

---

**A baseline is required, not optional.** An update, or a link to an existing
row, that has no stored fingerprint is refused as `baseline_missing`. This covers
proposals built before migration 0011. It is never applied unguarded, and the
row's current fingerprint is never substituted as if it had been approved. The
replacement proposal captures the row as it is now, both the old values and the
fingerprint, and needs a new approval. That new baseline is enforced in turn: if
the row changes again before re-approval, the replacement is refused as well.
Items carried over unchanged into a replacement get their old values and
fingerprint refreshed together, so what the approver sees always matches what the
guard checks.

## Workspace isolation

The first workspace holds both users; both can approve records, one is admin. The
architecture supports separate workspaces for future clients, enforced at three
levels:

1. **RLS** — every table is scoped by
   `public.is_workspace_member(workspace_id)`.
2. **Composite foreign keys** — 75 constraints of the form
   `(ref_id, workspace_id) → parent(id, workspace_id)`, so a cross-workspace
   reference is *structurally impossible*, not merely disallowed.
3. **Server checks** — membership and approval capability are verified before any
   action, and the workspace id is never taken from a request body.
4. **No client write privilege** — `anon` and `authenticated` cannot write any
   table directly (migration 0018), so these checks cannot be bypassed through
   Supabase's Data API.

Files follow the same boundary: every storage key is prefixed with the workspace
id, traversal is rejected, and background jobs carry their workspace id.

---

## Running against Supabase

Production needs a separate decision and is **not** applied by this repository.

1. Create a **private** Storage bucket (default name `workspace-files`).
2. Set `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
   `SUPABASE_SERVICE_ROLE_KEY` in your environment.
3. For the **test** project, follow [docs/SUPABASE_TEST_RUN.md](docs/SUPABASE_TEST_RUN.md).
   The tooling in this repository refuses production targets; applying to
   production is a separate, deliberate decision outside these scripts.

Notes before you do:

- `0001_baseline_legacy.sql` is a reconstruction of the existing legacy tables so
  a local copy can be built from zero. Against production it is additive only —
  `if not exists` on every table and column.
- `0006_workspace_scoping.sql` adds `workspace_id` to existing tables, moves
  current rows into one default workspace, and **re-scopes the global unique
  slugs** to `(workspace_id, slug)`. Take a backup first.
- `0008_queue.sql` uses the `pgmq` extension where available (Supabase Queues)
  and installs a SQL-compatible implementation where it is not.
- `0011` adds the fingerprint and supersede columns, and gives the pre-0006
  tables a `workspace_id` **default** so callers written before 0006 keep working
  — but only when the answer is unambiguous: an explicit
  `set_config('app.workspace_id', …)` wins, otherwise exactly one active
  workspace is required. With several workspaces the insert fails with
  `not_null_violation` instead of guessing a tenant.
- `0012` adds `public.backfill_legacy_entities(workspace)`. The 0004 backfill
  cannot be re-run after 0006 (its `on conflict (slug)` no longer has a matching
  index, error `42P10`), so legacy rows added later — e.g. by the archive's
  `work/*.mjs` scripts — would never get an `entities` mirror or a
  `legacy_business_unit_id` link. The function is workspace-scoped, idempotent,
  and never runs automatically.
- `0013` adds `public.upsert_legacy_record(table, row, on_conflict, workspace)`:
  one atomic `INSERT … ON CONFLICT (workspace_id, slug)` for the tables whose
  slug 0006 re-scoped. `on_conflict` is `skip` (the old scripts' behaviour) or
  `update`. It rejects unknown and reserved columns rather than dropping them, and
  requires an explicit workspace (see 0014). It is executable by `service_role` only. An earlier
  draft of 0011 created "compatibility views" for `on conflict (slug)`. Those never
  worked (`ON CONFLICT` on a view still needs a matching index on the base table,
  and there is none), so 0013 drops them.
- `0014` removes the last implicit tenant choice from `upsert_legacy_record`: the
  0013 version fell back to `default_workspace_id()`. Now the call must pass
  `p_workspace` or `row.workspace_id`. Without either it fails with `23502`, even
  when only one workspace exists and even when `app.workspace_id` is set. 0013 was
  left untouched; see [Migration integrity](#migration-integrity).
- `0015` removes `default gen_random_uuid()` from `knowledge.business_unit_id` and
  `rules.business_unit_id`, as declared in the existing database. A random UUID in
  a foreign-key column can never reference a business unit. Both columns stay
  nullable; an unscoped record stores `NULL`. The migrations here never declared
  that default, so on a database built only from them 0015 changes nothing.
- `0016` adds the columns the existing database has and `0001` did not reconstruct
  (`business_units.order_index`, `members.role/bio/linkedin_url`,
  `external_contacts.mobile_phone/linkedin_url`, `primary_owner_member_id`,
  `meetings.date`, the `relationship_interactions` columns, and
  `slug/type/source/status/order_index` on "Globa 3 Automatization & Memory"),
  with workspace-scoped foreign keys. Additive and nullable. Without it the row
  export cannot be loaded.

### What 0006 means for the old write paths

There were two real patterns:

1. **`on conflict (slug)`**, used in `0004_legacy_backfill_to_entities.sql`. After
   0006 it fails with `42P10`. Re-runs use `backfill_legacy_entities()` (0012).
   `seed.ts` and `0006` also use `on conflict (slug)`, but only on `workspaces`,
   whose slug is still globally unique, so those are correct.
2. **Lookup by slug, then POST**, in the archive's `work/write_afc_proposal.mjs`
   and `work/write_research_target1_approved.mjs`: `GET /<table>?slug=eq.X`, skip
   if a row comes back, otherwise `POST`. With one workspace the POST still works,
   because the 0011 default fills `workspace_id`. With a second workspace the
   lookup can match **another workspace's** row, and the script silently skips
   the write without any error. The pattern is also not atomic.

Both patterns are gone: the tables they wrote to no longer exist, and
`upsert_legacy_record` was dropped with them. Any archive script still pointed
at this database will fail loudly on a missing table rather than silently
writing to the wrong workspace.

### Migration integrity

`scripts/migrate.mjs` records a checksum for every applied migration. If an
applied migration's file no longer matches, the run **stops before applying
anything**, including unrelated pending migrations, because every later migration
assumes the earlier ones exist exactly as written. Adding a later migration does
not clear the stop: 0013 dropping the draft views does not change the fact that
0011's recorded checksum differs from its file.

There are two ways forward, and neither deletes data:

- **The change was not reviewed:** restore the file to the applied version, and
  put the change in a new migration.
- **The change is a reviewed revision listed in `supabase/migrations/revisions.json`:**
  reconcile it. The only entry is 0011, which was edited after it had been applied
  to local test databases (draft views removed, `min(uuid)` fixed). It was never
  applied to production.

For a database that still has the old 0011, the stop message prints the exact
command:

```bash
npm run db:status
node scripts/migrate.mjs --reconcile 0011_apply_integrity_and_legacy_compat.sql \
  --previous <checksum recorded in that database> \
  --reason "why this database had the old version"
npm run db:migrate
```

Reconciliation runs in one transaction:

1. It requires `--previous` to equal the checksum recorded in that database, and
   a written reason.
2. It re-applies the current, idempotent 0011, plus `revisions/0011_reconcile.sql`,
   which only drops the draft views. Views hold no data.
3. It runs `revisions/0011_assert.sql`: the views are gone, the function body is
   fixed, the columns and defaults exist.
4. It counts every base table in `public` before and after, and rolls back if any
   lost a row.
5. It records the new checksum and an audit row in
   `public.schema_migration_revisions` with the previous checksum, the reason, the
   assertions and both row counts.

Any failure rolls back all of it. A migration not listed in `revisions.json`
cannot be reconciled. `--status` and `--dry-run` never write.

Do not delete the database to get past a checksum stop. That was the workaround
used while developing locally, and it is not a valid path for any database with
data in it.

### Test Supabase run

See **[docs/SUPABASE_TEST_RUN.md](docs/SUPABASE_TEST_RUN.md)**: configuration,
read-only preflight with a migration dry run, migrate, seed through the Admin API,
verification including live Supabase Auth, manual checks, and the rule that
migrations are frozen after the first real apply.

Every migrate, seed and verify command refuses a project ref listed as production
in `supabase/environments.json`, and any non-local target that is not declared with
`G3_TARGET_ENV=test` and a matching `SUPABASE_TEST_PROJECT_REF`.

- Supabase Auth replaces the local sign-in automatically once `SUPABASE_URL` and
  `SUPABASE_ANON_KEY` are set; the app verifies the JWT server-side and binds the
  subject to the transaction so RLS applies.

### Costs

No model prices ship with the repository — a wrong hardcoded price looks
authoritative and is worse than an absent one. Token counts, web-search counts
and durations are always recorded per stage. Money is only claimed once you set
prices in `config/model-prices.json` or `OPENAI_PRICES_JSON`; until then the UI
says "price not configured" and marks figures as estimates.

Budgets are configurable per workspace, per day or month, as a hard stop (refuses
to start new runs) or warn-only.

---

## The legacy import path (removed)

The one-time import of the original Globa 3 database is finished, and the tables
it loaded into -- `external_contacts`, `external_companies`,
`relationship_interactions`, `knowledge`, `rules`, `meetings` and
`Globa 3 Automatization & Memory` -- were removed by
`0021_drop_legacy_tables.sql`.

With them went `scripts/import/`, `scripts/legacy/`, `scripts/test-import.mjs`,
the `db:import:*` and `supabase:test:import:*` commands, `verify:import`, and
the `upsert_legacy_record()` function. There is no compatibility layer and no
second representation of a person or a company anywhere in the schema.

What the import produced is still here: 250 canonical `entities`, their
affiliations, evidence, signals, findings, interactions and actions. The 141
rows that lived only in `knowledge` and `rules` were migrated into `evidence`
plus `research_findings` by `0020_legacy_memory_into_final_model.sql`; the 15
system-design notes are preserved in `docs/LEGACY-SYSTEM-NOTES.md`.

See `docs/MEMORY-ARCHITECTURE-AUDIT.md`, `docs/MEMORY-MIGRATION-PLAN.md` and
`docs/PRODUCTION-RELEASE-RUNBOOK.md`.


## Navigation performance

Against Supabase every SQL statement is a network round trip through the session
pooler (~100 ms from this machine), so what makes a screen slow is **how many
statements run one after another**, not the amount of data.

How the read path is kept short:

- **Session: one query.** `resolveSession` verifies the JWT locally and loads the
  user and every workspace membership in a single statement. The `app_users`
  mirror is written only when it is missing or the email changed. `getSession()`
  is wrapped in React `cache()`, so the layout and the page share one resolution
  per request.
- **Transaction set-up in one round trip.** `begin`, the JWT claims and
  `set local role` are sent as one message instead of four. RLS and the role
  switch are unchanged.
- **Page loads are READ ONLY transactions** (`withUserRead`, `withServiceRead`):
  a write inside one fails in the database, and the response does not wait for
  the COMMIT round trip.
- **Independent reads run concurrently**, in at most three transactions per
  screen plus two for the header (`apps/web/src/lib/page-data.ts`). The Activity
  page reuses the header's spend and budget reads (`cached-data.ts`, per request
  only) instead of repeating them.
- **One connection pool per process** (kept on `globalThis`), idle connections
  kept for 10 minutes (`PG_IDLE_TIMEOUT_MS`) and warmed at server start
  (`G3_WARM_POOL`), because opening a pooler connection costs ~0.7–1 s.
- **`(app)/loading.tsx`** lets a click switch to the next section immediately
  while its data loads.

Nothing is cached across requests or users: no authorization decision, session or
workspace data outlives the request.

**Connection budget.** The Supabase session pooler allows 15 clients for the whole
project. `supabase:test:demo` gives the web server 8 (`PG_POOL_MAX`) and the
worker 3 (`WORKER_PG_POOL_MAX`). Running `supabase:test:dev` and the demo at the
same time can exhaust it (`EMAXCONNSESSION`).

**Measuring.**

```bash
npm run verify:perf
```

```bash
npm run supabase:test:perf -- --email <signed-in user email> --assert
```

The first checks query counts per screen on a throwaway local database. The
second runs the same navigation data path against the test project (read-only)
and prints warm latency, transactions, statements and round trips per screen.
`G3_DB_TIMING=1` on any server logs one line per transaction with per-statement
timings (SQL excerpt only, never parameters).

**For a demo, do not use `next dev`.** It compiles routes on demand and recompiles
on file changes. Use:

```bash
npm run supabase:test:demo
```

---

## Verification

```bash
npm run verify
```

Drives the real pipelines, the real proposal/approval/apply engine and the real
queue. 46 checks across ten areas:

1. all three (retired) brief formats end to end, producing a brief, QA verdict,
   sources and resolved research topics
2. a signed-in user cannot write a knowledge record, directly or by applying an
   unapproved proposal
3. ambiguous matches are surfaced and never merged
4. approval, partial approval, apply and readback
5. repeating a request writes nothing new
6. editing revokes a prior approval, and the stale version is refused
7. a crashed worker's run is reclaimed and **resumes** (and is not paid for twice)
8. workspace isolation for data, files, foreign keys and background jobs
9. Ask Knowledge cites records and declines to answer what it has no records for
10. cost accounting per stage, with estimates flagged

With no `OPENAI_API_KEY` the mechanics are genuinely exercised but the content is
synthetic, and the summary says so.

The capture product has three more suites, each on its own throwaway database:

| Command | What it proves |
| --- | --- |
| `npm run verify:capture` | The capture pipeline in-process: source storage, resolution, ambiguity, approval, readback, retries and resume, permissions, workspace isolation, re-capture without duplicates. |
| `npm run verify:mobile-api` | The same flow over real HTTP through the running Next.js server, exactly as the iOS app calls it: bearer-token sign-in, multipart capture, plain-words processing states, the compact grouped review, approve selected/all, readback on Today/Activity/Knowledge, no duplicates, another workspace refused (capture, proposal, file, approval, research), research only on explicit acknowledged request, briefs redirected. |
| `npm run verify:client-secrets` | Builds the web app and exports the iOS bundle with planted fake secrets (model key, service-role key, JWT secret, database URL, auth secret) and fails if any reaches a file a browser or phone downloads. |
| `npm run verify:grants` | Migrates a throwaway database, recreates Supabase's default grants to `anon`/`authenticated`, re-runs 0018 twice, and proves client roles cannot insert, update, delete, truncate, `setval` or call the legacy writer, while RLS reads and `service_role` writes still work. `npm run supabase:test:grants` runs the same catalog checks read-only against the test project. |

All three use scripted model output: the live OpenAI extraction is not exercised.

---

## Repository layout

```
apps/
  mobile/              iOS app: Expo SDK 57 · React Native 0.86 · expo-router (see its README)
  web/                 Next.js 15 · React · TypeScript · Tailwind · shadcn/ui · Lucide
  worker/              Background worker: queue polling, leases, retries, recovery
packages/
  shared/              Types, zod contracts, format rules, timezone-correct windows
  core/                DB, auth, storage, queue, AI providers, pipelines, apply engine
supabase/migrations/   0000–0018, applied in order (0017: captures; 0018: no client write privileges)
seed/prompts/          The three run prompts and the Creative Radar desk files
config/                model-prices.json (empty by design)
scripts/               local-db.mjs, migrate.mjs, import/ (load, backfill, verify), supabase-test/
```

### The main screens

| Screen | Purpose |
| --- | --- |
| **Today** (`/`) | One dominant action, *Add anything…*; quiet links to what awaits approval, memory search and recent activity; what is being analysed; what was saved today. |
| **Capture** | One field for a note, a pasted link or a file. No record type to choose. Recent captures and their state. |
| **Review** | The capture it came from, then changes grouped as *Stated in the source*, *Our reading, not stated directly*, *Suggested follow-ups* and *Still unknown*; approve selected or all, reject, edit the capture; optional, explicit research. |
| **Knowledge** | Ask about saved memory (cited, closed-book) and browse what is saved. |
| **Activity** | Saved changes, analyses, costs, audit log. |
| **Settings** | Administrators only, apart from the main menu: access, AI budget, integration status. |

The iOS app has Today, Capture, Review and Knowledge, plus Processing and Saved
screens; see [apps/mobile/README.md](apps/mobile/README.md). `/briefs` and
`/research` redirect to Capture.

---

## Known limits

- **The iOS app has not been run on a simulator or a device from this
  repository's checks.** Its JavaScript bundle is exported and scanned, its API
  is tested end to end, and its screens were exercised through Expo's web
  renderer. See apps/mobile/README.md for what remains before TestFlight.
- **No voice recording.** The capture field works with iOS keyboard dictation;
  recording and transcription are a documented v2 extension, not built.
- **Supabase Auth is not verified live.** Mode selection, the dev-login gate and
  cookie handling are tested; the real exchange, refresh and revocation need a
  test project.
- **No live integration is verified.** Without an API key, the OpenAI path —
  including web search and deep research — is implemented against the current
  Responses API but has not been exercised against the live service. The same is
  true of Supabase Auth and Storage while unconfigured.
- **Scanned PDFs are skipped** with an explicit reason; there is no OCR.
- **Nested archives** inside a ZIP are listed and skipped rather than expanded.
- **Entity resolution scans in TypeScript**, which is right at this size and
  keeps behaviour identical across environments. Past roughly 5 000 entities per
  workspace it should move to a `pg_trgm` index on Supabase.
- **Production migrations are not applied.** That needs a separate decision and a
  backup.
