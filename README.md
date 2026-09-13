# Globa 3 Intelligence Platform

Business briefs, deep research, and an approval-gated knowledge base.

Generate a brief for a configured format → review its sources and gaps → choose
what deserves deep research → review the exact proposed changes → edit, approve
or reject each one → the server saves them, reads them back, and reports what
actually changed.

Nothing reaches the knowledge base without a person approving it. That is
enforced in the database, not only in the UI: a signed-in user has no `INSERT`
privilege on any knowledge table.

---

## Contents

- [Quick start](#quick-start)
- [How it fits together](#how-it-fits-together)
- [The three formats](#the-three-formats)
- [Approval and data integrity](#approval-and-data-integrity)
- [Workspace isolation](#workspace-isolation)
- [Running against Supabase](#running-against-supabase)
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
`mariana@erizos.tv` / `local-dev-admin`).

### What each command does

| Command | Purpose |
| --- | --- |
| `npm run db:local` | Starts the local database and **keeps running**. |
| `npm run db:migrate` | Applies `supabase/migrations` in order, once each. |
| `npm run db:seed` | Creates the workspace, both users, the three formats and their prompts. |
| `npm run worker` | Background worker. Briefs and research run here, not in the web request. |
| `npm run dev` | Next.js app on port 3000. |
| `npm run verify` | End-to-end verification (see [Verification](#verification)). |
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
Browser
   │
   ▼
Next.js server  ──── checks access, validates, enqueues, and applies approvals
   │                 (the ONLY writer to knowledge tables)
   ▼
Supabase Queues (pgmq) ── durable jobs with visibility timeouts
   │
   ▼
Worker (separate Node process)
   │  brief:    preflight → research → draft → qa → extract → persist
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

## Approval and data integrity

### Nothing is written without approval

Migration `0007_rls.sql` grants signed-in users `SELECT` only on every knowledge
table. There is no client-side path to insert an entity, a finding, an
interaction or a signal — those writes exist solely in the server apply step
running as `service_role`.

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

Files follow the same boundary: every storage key is prefixed with the workspace
id, traversal is rejected, and background jobs carry their workspace id.

---

## Running against Supabase

Production needs a separate decision and is **not** applied by this repository.

1. Create a **private** Storage bucket (default name `workspace-files`).
2. Set `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
   `SUPABASE_SERVICE_ROLE_KEY` in your environment.
3. Review the migrations, then apply them:
   ```bash
   DATABASE_URL='postgresql://…' npm run db:migrate -- --status   # dry run
   DATABASE_URL='postgresql://…' npm run db:migrate
   ```

Notes before you do:

- `0001_baseline_legacy.sql` is a reconstruction of the existing legacy tables so
  a local copy can be built from zero. Against production it is additive only —
  `if not exists` on every table and column.
- `0006_workspace_scoping.sql` adds `workspace_id` to existing tables, moves
  current rows into one default workspace, and **re-scopes the global unique
  slugs** to `(workspace_id, slug)`. Take a backup first.
- `0008_queue.sql` uses the `pgmq` extension where available (Supabase Queues)
  and installs a SQL-compatible implementation where it is not.
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

## Verification

```bash
npm run verify
```

Drives the real pipelines, the real proposal/approval/apply engine and the real
queue. 46 checks across ten areas:

1. all three formats end to end, producing a brief, QA verdict, sources and
   resolved research topics
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

---

## Repository layout

```
apps/
  web/                 Next.js 15 · React · TypeScript · Tailwind · shadcn/ui · Lucide
  worker/              Background worker: queue polling, leases, retries, recovery
packages/
  shared/              Types, zod contracts, format rules, timezone-correct windows
  core/                DB, auth, storage, queue, AI providers, pipelines, apply engine
supabase/migrations/   0000–0010, applied in order
seed/prompts/          The three run prompts and the Creative Radar desk files
config/                model-prices.json (empty by design)
scripts/               local-db.mjs, migrate.mjs
```

### The five sections

| Section | Purpose |
| --- | --- |
| **Briefs** | Generate a brief; upload Markdown/PDF/ZIP with per-file status. |
| **Research** | Choose targets, run deep research in the background. |
| **Review** | Exact proposed changes with old/new values; edit, approve, reject. |
| **Knowledge** | Ask Knowledge (cited, closed-book) and browse what is stored. |
| **Activity** | Runs, applied changes, costs, audit log, daily Markdown reports. |
| **Settings** | Format rules, prompt history, run context, budgets, integration status. |

---

## Known limits

- **Runs are started manually.** There is no scheduler in this version.
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
