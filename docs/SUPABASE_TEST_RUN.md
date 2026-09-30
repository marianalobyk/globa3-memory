# Test Supabase run

How to run the application and its verification suites against a **dedicated test
Supabase project**. Production is never a target: every command below refuses a
project ref listed in `supabase/environments.json`, and there is no flag that
overrides that.

Status when this was written: **not yet run.** No test project credentials were
available. Everything below is prepared and locally verified up to the point of
connecting to Supabase.

---

## 0. What you need

- A new Supabase project used only for testing, never production. There are two
  ways to use one, and they need **separate** projects:
  - **Imported copy** (`globa3-test`): receives the row export of the existing
    database. Treat it as holding business data. Follow §4A.
  - **Clean project**: no imported data; the demo seed and the automated suites
    (`supabase:test:verify`) run here. Follow §4B.

  The automated suites write demo data and seed business units, so they refuse a
  database with imported data; and the import loader refuses tables that already
  hold rows. One project cannot serve both.
- In the dashboard: **Queues** enabled (so migration 0008 uses the real `pgmq`
  extension instead of the SQL fallback).
- The project's database password, anon key and service-role key.
- Two real email addresses you control, for the admin and client test users.

## 1. Configure

```bash
cp .env.supabase-test.example .env.supabase-test
```

Fill in every value. `.env.supabase-test` is git-ignored. The three places that
name the project must agree:

- `SUPABASE_TEST_PROJECT_REF`
- the ref in `DATABASE_URL` (host `db.<ref>.supabase.co`, or pooler user `postgres.<ref>`)
- the ref in `SUPABASE_URL`

If the production project ever changes, add its ref to
`supabase/environments.json` **before** anyone puts its credentials in a file.

All `supabase:test:*` commands go through `scripts/supabase-test/run.mjs`, which
loads only `.env.supabase-test`, forces `DEV_AUTH_ENABLED=false`, and refuses a
local or production target.

## 2. Preflight (read-only)

```bash
npm run supabase:test:preflight -- --create-bucket
```

`--create-bucket` is the only write: it creates the storage bucket as **private**
if it is missing. Without the flag, preflight changes nothing.

It checks: Auth and Admin API reachability, JWT verification (JWKS or legacy
secret), the private bucket, the Postgres connection, that the connecting role can
switch to `authenticated` and `service_role`, the `auth` schema, `pgmq`, whether
the database already holds data, migration history, and a **dry run** of every
pending migration in one transaction that is then rolled back.

Every FAIL must be fixed before continuing. Known risk worth watching:

- **Migration 0000 and the `auth` schema.** 0000 runs
  `create schema if not exists auth` and `create table if not exists auth.users`,
  which are no-ops locally but may need `CREATE` privilege on `auth` in Supabase,
  where that schema belongs to Supabase Auth. Preflight reports the privilege, and
  the dry run shows whether it actually fails. If it does, 0000 can still be
  corrected in place **at this point**, because a dry run records nothing. After
  the first real apply to this project, migrations are frozen (see §7).

## 3. Migrate

```bash
npm run supabase:test:migrate:status
npm run supabase:test:migrate
npm run supabase:test:migrate:status     # expect: 0 pending
```

## 4A. Imported copy: import, backfill, verify, bootstrap

Follow **README → "Importing the existing Globa 3 database"** exactly, in this order:

migrations → import exported rows → `backfill_legacy_entities(workspace)` → verify import → bootstrap imported data

Unzip the export outside the repository first, then:

```bash
EXPORT="$HOME/g3-import/SUPABASE COPY"
```

```bash
npm run supabase:test:import:load -- --export-dir "$EXPORT" --workspace globa3 --dry-run
```

```bash
npm run supabase:test:import:load -- --export-dir "$EXPORT" --workspace globa3
```

```bash
npm run supabase:test:import:backfill -- --workspace globa3
```

```bash
npm run supabase:test:import:verify -- --workspace globa3 --export-dir "$EXPORT" --write-snapshot .data/import/globa3-before-bootstrap.json
```

```bash
npm run supabase:test:bootstrap -- --workspace globa3
```

```bash
npm run supabase:test:import:verify -- --workspace globa3 --export-dir "$EXPORT" --compare-snapshot .data/import/globa3-before-bootstrap.json
```

**Never run `supabase:test:seed` or `supabase:test:verify` on this project.** Both
refuse when they detect imported data; do not work around that. Skip §5 and go to
the manual checks in §6.

## 4B. Clean project: seed

```bash
npm run supabase:test:seed
```

Creates the two users **through the Supabase Admin API** (confirmed, with the
passwords from `.env.supabase-test`), mirrors them into `app_users`, and creates the
formats, prompts, demo business units and entities. It never writes to `auth.users`
directly. Re-running resets the seed users' passwords to the configured ones, so
the live sign-in checks are repeatable.

## 5. Verify (clean project only)

```bash
npm run supabase:test:verify
```

Runs `verify` and `verify:review` against the test project. Against Supabase,
`verify:review` also runs section **1b, live Supabase Auth**, which is skipped
locally:

- a seeded user signs in through Supabase Auth
- the access token is verified server-side and resolves the workspace session
- a tampered token is rejected
- the refresh token yields a new working access token
- sign-out revokes the session at Supabase
- the refresh token no longer works after sign-out

`verify:migrations` is not part of this command: it runs against an isolated
local throwaway database by design.

## 6. Manual checks in the running app

```bash
npm run supabase:test:demo
```

Production build + `next start` on :3000 and the worker in one terminal. This is
the configuration to demo and to judge speed with. `supabase:test:dev` and
`supabase:test:worker` (two terminals) are for changing code; do not run both
setups at once, they share the pooler's 15-client limit.

1. Sign in as the client test user. The header must **not** show "Local auth".
2. Let the access token expire (or shorten the JWT expiry in the project) and
   navigate. You should stay signed in: the middleware refreshed the session.
3. Sign out, then check the old session no longer works.
4. Upload a PDF. Confirm in the dashboard that the object is in the private bucket
   under `<workspace-id>/uploads/...`, and that its public URL returns an error.
5. Generate a brief and confirm the worker picks it up. On the imported copy,
   check that entity resolution matches existing imported entities and that
   nothing is written to them without approval. In the SQL editor,
   `select * from pgmq.list_queues();` should list `g3_runs` and `g3_ingest`.
6. As a signed-in user, confirm a direct REST write is refused:
   `POST /rest/v1/entities` with the user's access token must fail.
7. Two sessions (admin and client): both approve two different proposals that
   create the same record, then apply at the same moment. One applies; the other
   returns 409 with a replacement proposal. This is the one case that needs real
   parallelism: the local PGlite server runs transactions one after another.
8. Clean project only (a second workspace must not be created in the imported
   copy). With two workspaces, write the same slug into each through
   (the legacy write-records script was removed with the legacy tables in 0021)
   and confirm each lands in its own workspace; a rerun reports `skipped_existing`.

## 7. After the first real apply: migrations are frozen

Once a migration has been applied to this test project, never edit it. Put every
further change in a new migration. `migrate.mjs` enforces this: a changed file
stops the run before anything is applied.

`supabase/migrations/revisions.json` lists the only in-place revisions that can be
reconciled, all of them made before any shared database existed. Do not add new
entries for migrations that have reached this project.

## 8. Recording the result

Keep the outputs of steps 2, 3, 5 and 6 and note, for each manual check, pass or
fail with the observed behaviour. A check that could not be run is recorded as not
run, not as passed.

## 9. Cleanup

The test project can be paused or deleted from the dashboard. Nothing in this
repository needs to change afterwards; delete `.env.supabase-test` locally.
