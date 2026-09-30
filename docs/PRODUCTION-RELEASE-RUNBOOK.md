# Production release runbook — Globa 3 memory

For Mariana, to run by hand against the production Supabase project
`dlwircxhmaffntlxmyje`.

Everything below has been rehearsed end to end on a PostgreSQL 17 restore of the
28 September 2026 production backup. The rehearsal applied every stage in order
and finished with **21 of 21 integrity proofs passing**.

**No secret appears in this document.** Every command reads the connection
string from `.env.local`, which you already have.

## Stage 0 — Rotate the production database password (do this first)

The production **database** password was pasted into a chat and must be treated
as compromised. Rotate it before anything else in this runbook.

1. Open <https://supabase.com/dashboard/project/dlwircxhmaffntlxmyje>
2. **Project Settings → Database → Database password → Reset database password**
3. Generate a new password and copy it.
4. Update `DATABASE_URL` in `.env.local` with the new password. Edit the file
   directly; do not echo it, do not paste it into a chat, and do not commit it
   (`.env.local` is already git-ignored).
5. Update the same value anywhere else it is configured (the worker's
   environment, any deployment target).

Confirm the new password works, without printing it:

```bash
set -a; source .env.local; set +a
/opt/homebrew/opt/postgresql@17/bin/psql "$DATABASE_URL" -Atc "select current_database()"
```

Expected: `postgres`. If this fails, the rest of the runbook cannot run.

**Separately**: the Globa 3 application password for
`maryana.lobyk.lm@gmail.com` is created fresh in stage 6a. It is a different
credential from the database password, it has never existed before, and it must
never be typed into a chat, written into the repository, or stored in any file
here.

---

## Before you start

- The repository's production guard (`scripts/lib/target.mjs`) refuses to let
  any repository tool write to production, and it stays that way. That is why
  this runbook uses `psql` directly: **you** are the authorisation, not a flag.
  Do not edit the guard and do not remove the project from
  `supabase/environments.json`.
- Expect the app to be unusable between stages 4 and 8. Production has never
  served this application, so there is no live traffic to interrupt.
- Nothing else writes to this database (confirmed: no Make, Zapier, n8n or
  script integration), so enabling RLS in stage 5 cannot break an integration.

Set up your shell once, in the repository root:

```bash
set -a; source .env.local; set +a
export PSQL=/opt/homebrew/opt/postgresql@17/bin/psql
export PGD=/opt/homebrew/opt/postgresql@17/bin/pg_dump
```

Confirm you are pointed at production without printing the URL:

```bash
$PSQL "$DATABASE_URL" -Atc "select current_database(), version()"
```

Expected: `postgres|PostgreSQL 17.6 …`

---

## Stage 1 — Fresh backup

Even though a verified backup from 28 September exists, take another
immediately before you change anything.

```bash
STAMP=$(date -u +%Y-%m-%dT%H-%M-%S) && mkdir -p ~/globa3-backups/prod-$STAMP && \
$PGD "$DATABASE_URL" --schema public --format custom --compress 9 --no-owner --no-privileges \
  --file ~/globa3-backups/prod-$STAMP/public.dump && \
echo "backup written to ~/globa3-backups/prod-$STAMP"
```

**Check** — the dump lists all 23 tables:

```bash
/opt/homebrew/opt/postgresql@17/bin/pg_restore --list ~/globa3-backups/prod-$STAMP/public.dump | grep -c "TABLE DATA"
```

Expected: `23`. **Do not continue if this is not 23.**

---

## Stage 2 — Record the "before" numbers

```bash
$PSQL "$DATABASE_URL" -At -F'|' -f scripts/prod-audit/release-counts.sql
```

Expected (matching the audit):

| | |
| --- | ---: |
| entities | 250 |
| evidence | 162 |
| research_findings | 178 |
| signal_entities | 143 |
| entity_affiliations | 84 |
| knowledge | 82 |
| rules | 59 |
| external_companies | 54 |
| external_contacts | 52 |
| signals | 27 |
| actions | 24 |
| Globa 3 Automatization & Memory | 15 |
| business_units | 10 |
| entity_mentions | 10 |
| interactions | 7 |
| research_artifacts | 7 |
| relationship_interactions | 6 |
| member_business_units | 5 |
| members | 4 |
| entity_aliases | 3 |
| meetings | 1 |
| opportunities, outcomes | 0 |
| **total** | **1183** |

Save the output. Stage 9 compares against it.

---

## Stage 3 — Baseline and alignment

Production has no migration history, and its legacy tables were built from an
earlier dialect than `0001_baseline_legacy.sql` writes. Two things follow:
`0001`–`0004` must be **recorded, not run**, and the legacy tables must be
aligned before the platform migrations touch them.

First record `0001`–`0004` as applied, computing the same checksum
`scripts/migrate.mjs` uses (sha256, first 16 characters):

```bash
$PSQL "$DATABASE_URL" -q -c "create table if not exists public.schema_migrations (version text primary key, checksum text not null, applied_at timestamptz not null default now())"

for f in 0001_baseline_legacy 0002_phase1_intelligence 0003_phase1_1_signals_staging 0004_legacy_backfill_to_entities; do
  CK=$(shasum -a 256 "supabase/migrations/$f.sql" | cut -c1-16)
  $PSQL "$DATABASE_URL" -q -v ON_ERROR_STOP=1 \
    -c "insert into public.schema_migrations (version, checksum) values ('$f.sql','$CK') on conflict (version) do nothing"
  echo "  stamped $f.sql ($CK)"
done
```

Then align the legacy tables, in one transaction:

```bash
$PSQL "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/prod-audit/production-baseline-align.sql
```

**Check** — four migrations recorded, and the column `0006` needs now exists:

```bash
$PSQL "$DATABASE_URL" -At \
  -c "select count(*) from public.schema_migrations" \
  -c "select count(*) from information_schema.columns where table_schema='public' and table_name='meetings' and column_name='slug'"
```

Expected: `4` then `1`.

Why `0001`–`0004` are stamped rather than run: production already holds their
data (250 entities, 162 evidence rows, the legacy tables). Re-running `0001`
fails outright — it would create `relationship_interactions(contact_id,
company_id, business_unit_id)` while production has `(external_contact_id,
external_company_id, internal_business_unit_id)`, so the index that follows
errors with `column "business_unit_id" does not exist`. This was reproduced in
the rehearsal.

---

## Stage 4 — Dry run the platform migrations

This is the safety net. It applies **every** remaining migration inside a single
transaction against real production data and then rolls it back. Nothing is
committed.

```bash
$PSQL "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction \
  -c "\\set QUIET on" \
  -f supabase/migrations/0000_compat_bootstrap.sql \
  -f supabase/migrations/0005_app_platform.sql \
  -f supabase/migrations/0006_workspace_scoping.sql \
  -f supabase/migrations/0007_rls.sql \
  -f supabase/migrations/0008_queue.sql \
  -f supabase/migrations/0009_slug_unique_non_partial.sql \
  -f supabase/migrations/0010_entity_mention_dedupe.sql \
  -f supabase/migrations/0011_apply_integrity_and_legacy_compat.sql \
  -f supabase/migrations/0012_workspace_aware_legacy_backfill.sql \
  -f supabase/migrations/0013_legacy_upsert_function.sql \
  -f supabase/migrations/0014_upsert_requires_explicit_workspace.sql \
  -f supabase/migrations/0015_drop_random_business_unit_defaults.sql \
  -f supabase/migrations/0016_import_column_compat.sql \
  -f supabase/migrations/0017_capture_inbox.sql \
  -f supabase/migrations/0018_revoke_client_write_privileges.sql \
  -f supabase/migrations/0019_contact_research.sql \
  -c "rollback"
```

**Check** — the last line printed is `ROLLBACK` and there is no `ERROR:`
anywhere in the output. If anything errored, **stop**: nothing was changed, and
the same error would have happened for real.

Confirm production is untouched:

```bash
$PSQL "$DATABASE_URL" -Atc "select to_regclass('public.workspaces') is null"
```

Expected: `t` (no workspaces table yet — the rollback worked).

---

## Stage 5 — Apply the platform migrations

Same list, committed this time. Each migration runs in its own transaction and
records its checksum; the loop stops at the first error.

```bash
for f in 0000_compat_bootstrap 0005_app_platform 0006_workspace_scoping 0007_rls \
         0008_queue 0009_slug_unique_non_partial 0010_entity_mention_dedupe \
         0011_apply_integrity_and_legacy_compat 0012_workspace_aware_legacy_backfill \
         0013_legacy_upsert_function 0014_upsert_requires_explicit_workspace \
         0015_drop_random_business_unit_defaults 0016_import_column_compat \
         0017_capture_inbox 0018_revoke_client_write_privileges 0019_contact_research; do
  CK=$(shasum -a 256 "supabase/migrations/$f.sql" | cut -c1-16)
  if $PSQL "$DATABASE_URL" -q -v ON_ERROR_STOP=1 --single-transaction \
       -f "supabase/migrations/$f.sql" \
       -c "insert into public.schema_migrations (version, checksum) values ('$f.sql','$CK')"; then
    echo "  ok    $f"
  else
    echo "  FAILED $f -- stop here"; break
  fi
done
```

**Checks**:

```bash
$PSQL "$DATABASE_URL" -At \
  -c "select count(*) from public.schema_migrations" \
  -c "select slug, name from public.workspaces" \
  -c "select count(*) from pg_policies where schemaname='public'" \
  -c "select count(*) from public.entities"
```

Expected: `20` · `globa3|Globa 3` · a policy count in the high fifties · `250`.

(The final migration count after Stage 8 is **23**, not 20: `0020`, `0021` and
`0022` are applied there.)

Then confirm no row lost its workspace (40 of the 43 tables are scoped;
`workspaces`, `app_users` and `schema_migrations` are legitimately global --
see `TABLE-RETENTION-MANIFEST.md` §5):

```bash
$PSQL "$DATABASE_URL" -Atc "
select coalesce(string_agg(t.table_name||'='||t.n, ', '),'all scoped') from (
  select col.table_name, (xpath('/row/c/text()', query_to_xml(
    format('select count(*) c from public.%I where workspace_id is null', col.table_name), false, true, '')))[1]::text::int n
  from information_schema.columns col
  where col.table_schema='public' and col.column_name='workspace_id') t where t.n > 0"
```

Expected: `all scoped`.

---

## Stage 6 — Create the production administrator

**This is the point at which `maryana.lobyk.lm@gmail.com` becomes the admin.**

### 6a. Supabase Dashboard

1. Open <https://supabase.com/dashboard/project/dlwircxhmaffntlxmyje>
2. **Authentication → Users → Add user → Create new user**
3. Email: `maryana.lobyk.lm@gmail.com`
4. Set the password yourself in that dialog. **Tick "Auto Confirm User"** so no
   confirmation email is needed.
5. Click **Create user**, then copy the new user's **UID**.

This is a **newly created application password**, and it is a different
credential from the database password rotated in stage 0. It must never be
typed into a chat, written into the repository, or stored in any file here —
put it straight into your password manager from the Supabase dialog.

### 6b. Link the account to the workspace

Replace `<UID>` with the UID you copied:

```bash
$PSQL "$DATABASE_URL" -v ON_ERROR_STOP=1 -v uid="<UID>" \
  -v email="maryana.lobyk.lm@gmail.com" -f scripts/prod-audit/create-admin.sql
```

`app_users.id` has a foreign key to `auth.users(id)`, so step 6b fails with
`violates foreign key constraint "app_users_id_fkey"` if the dashboard user was
not created first. That is the intended ordering, not a problem.

**Check**:

```bash
$PSQL "$DATABASE_URL" -At -F'|' -c "
select u.email, m.role, m.can_approve, w.slug
  from public.app_users u
  join public.workspace_members m on m.user_id = u.id
  join public.workspaces w on w.id = m.workspace_id
 where u.email = 'maryana.lobyk.lm@gmail.com'"
```

Expected: `maryana.lobyk.lm@gmail.com|admin|t|globa3`

---

## Stage 7 — The gate before anything is dropped

`0021` deletes tables. Nothing runs it until every proof below passes. They are
bundled into one script that exits non-zero on any failure:

```bash
node scripts/prod-audit/pre-drop-gate.mjs "$DATABASE_URL"
```

It is strictly read-only (the session is opened with
`default_transaction_read_only = on`, so the server refuses writes regardless).
It checks five things:

| # | Proof | What must hold |
| --- | --- | --- |
| 1 | **Row counts** | All 14 retained memory tables still hold exactly what production held on 28 September 2026 |
| 2 | **Coverage** | Every legacy row already exists in the final model: 52/52 contacts, 54/54 companies, 82/82 knowledge, 59/59 rules, 6/6 interactions, 1/1 meeting, and 15 system notes in `docs/LEGACY-SYSTEM-NOTES.md` |
| 3 | **Foreign keys** | All 153 single-column foreign keys resolve; no dangling reference anywhere |
| 4 | **RLS and privileges** | Every workspace-scoped table enforces RLS, no row is missing its workspace, and `anon`/`authenticated` hold zero write grants |
| 5 | **Application queries** | No code path in `packages`, `apps` or `scripts` still names a legacy table |

Expected last line: **`26/26 gate checks passed`**.

If anything fails it prints `DO NOT RUN 0021` and lists what to fix. Stop there;
nothing has been dropped, and the database is still fully usable.

Note the ordering: proof 2 can only pass **after** `0020` has copied `knowledge`
and `rules` across. Stage 8 applies `0020`, then runs this gate, then applies
`0021`.

## Stage 8 — Migrate legacy content, then drop the legacy layer

Apply `0020` first — it copies `knowledge` and `rules` into the final model:

```bash
f=0020_legacy_memory_into_final_model
CK=$(shasum -a 256 "supabase/migrations/$f.sql" | cut -c1-16)
$PSQL "$DATABASE_URL" -q -v ON_ERROR_STOP=1 --single-transaction \
  -f "supabase/migrations/$f.sql" \
  -c "insert into public.schema_migrations (version, checksum) values ('$f.sql','$CK')"
```

Now run the full stage 7 gate. **It must print `26/26 gate checks passed`**:

```bash
node scripts/prod-audit/pre-drop-gate.mjs "$DATABASE_URL"
```

Only if the gate passes, apply `0021`:

```bash
f=0021_drop_legacy_tables
CK=$(shasum -a 256 "supabase/migrations/$f.sql" | cut -c1-16)
$PSQL "$DATABASE_URL" -q -v ON_ERROR_STOP=1 --single-transaction \
  -f "supabase/migrations/$f.sql" \
  -c "insert into public.schema_migrations (version, checksum) values ('$f.sql','$CK')"
```

Two `NOTICE: function … does not exist, skipping` lines are expected: `0021`
drops three possible overloads of `upsert_legacy_record` and only one exists.

Finally apply `0022`, which lets a finding cite more than one source:

```bash
f=0022_research_finding_evidence
CK=$(shasum -a 256 "supabase/migrations/$f.sql" | cut -c1-16)
$PSQL "$DATABASE_URL" -q -v ON_ERROR_STOP=1 --single-transaction \
  -f "supabase/migrations/$f.sql" \
  -c "insert into public.schema_migrations (version, checksum) values ('$f.sql','$CK')"
```

It is additive: it creates `research_finding_evidence`, copies each finding's
existing source in as its `primary` citation, and changes no existing column or
row. **Check** — one citation for every finding that names a source:

```bash
$PSQL "$DATABASE_URL" -At \
  -c "select count(*) from public.research_findings where evidence_id is not null" \
  -c "select count(*) from public.research_finding_evidence where role = 'primary'"
```

Both numbers must be **318**, and equal to each other.

### `0023_research_proposal_parent.sql` — not yet applied to production

Prepared and rehearsed, **not released**. It adds a nullable
`proposals.parent_proposal_id` so a research result can point back at the
capture that asked the question. Additive: no column dropped or retyped, no row
changed, no privilege widened, and every existing proposal keeps a null parent.

When you are ready:

```bash
f=0023_research_proposal_parent
CK=$(shasum -a 256 "supabase/migrations/$f.sql" | cut -c1-16)
$PSQL "$DATABASE_URL" -q -v ON_ERROR_STOP=1 --single-transaction \
  -f "supabase/migrations/$f.sql" \
  -c "insert into public.schema_migrations (version, checksum) values ('$f.sql','$CK')"
```

**Verification** — the column exists, every existing proposal is untouched, and
both guards are in place:

```bash
$PSQL "$DATABASE_URL" -At -F'|' \
  -c "select 'column', count(*) from information_schema.columns where table_schema='public' and table_name='proposals' and column_name='parent_proposal_id'" \
  -c "select 'orphaned', count(*) from public.proposals where parent_proposal_id is not null" \
  -c "select 'guards', count(*) from pg_constraint where conrelid='public.proposals'::regclass and conname in ('proposals_parent_workspace_fkey','proposals_parent_not_self')" \
  -c "select 'index', count(*) from pg_indexes where schemaname='public' and indexname='proposals_parent_idx'"
```

Expected: `column|1` · `orphaned|0` · `guards|2` · `index|1`.

Rehearsed on a production-shaped copy: 250 entities, 319 findings and 293
evidence rows unchanged; a self-parent is refused by
`proposals_parent_not_self`; a parent in another workspace is refused by
`proposals_parent_workspace_fkey`; a same-workspace parent is accepted.

**Checks**:

```bash
$PSQL "$DATABASE_URL" -At \
  -c "select count(*) from public.evidence" \
  -c "select count(*) from public.research_findings" \
  -c "select coalesce(string_agg(t,', '),'NONE') from (select unnest(array['external_contacts','external_companies','relationship_interactions','knowledge','rules','meetings','Globa 3 Automatization & Memory']) t) x where to_regclass('public.'||quote_ident(t)) is not null"
```

Expected: `293` · `319` · `NONE`.

After `0022` the database holds **44** tables (the 43 above plus
`research_finding_evidence`).

---

## Stage 9 — Verify

```bash
node scripts/prod-audit/integrity-proofs.mjs "$DATABASE_URL"
```

Expected: **`21/21 proofs passed`**, and this counts table:

| Table | After |
| --- | ---: |
| entities | 250 |
| research_findings | 319 |
| evidence | 293 |
| signal_entities | 143 |
| entity_affiliations | 84 |
| signals | 27 |
| actions | 24 |
| entity_mentions | 10 |
| business_units | 10 |
| interactions | 7 |
| research_artifacts | 7 |
| members | 4 |
| entity_aliases | 3 |
| opportunities, outcomes | 0 |

### Before and after

| | Before | After | Why |
| --- | ---: | ---: | --- |
| Tables in `public` | 23 | **44** | 27 platform tables added, 7 legacy dropped, 1 citation join added |
| Total rows | 1183 | 1206 | see below |
| entities | 250 | 250 | unchanged |
| evidence | 162 | 293 | +141 migrated from knowledge and rules, −10 unattached removed |
| research_findings | 178 | 319 | +141 from knowledge (82) and rules (59) |
| legacy rows | 269 | **0** | 7 tables removed |

### Relationship counts

| Relationship | Before | After |
| --- | ---: | ---: |
| signal → entity | 143 | 143 |
| signals with evidence | 27 | 27 |
| findings with provenance | 178 | 319 |
| findings with a business unit | 94 | 319 |
| affiliations | 84 | 84 |
| affiliations with evidence | 32 | 32 |
| aliases | 3 | 3 |
| actions with an entity | 24 | 24 |
| actions tied to an interaction | 6 | 6 |
| interactions with a subject | 6 of 7 | **7 of 7** |
| entities with provenance | 134 evidence + 116 legacy links | 134 evidence + 240 provenance notes |
| member → business unit | 5 | 5 |
| pending mentions | 10 | 10 |

---

## Stage 10 — Application readiness

```bash
npm run typecheck
npm run verify:capture
npm run verify:mobile-api
npm run verify:readback-fallback
npm run --workspace @g3/web build
```

These run against isolated local databases, never production.

Then point the app at production and sign in as
`maryana.lobyk.lm@gmail.com`.

---

## Rollback

At any stage, production can be returned to exactly its pre-release state.

**Before stage 5** — nothing has been committed except the baseline stamp and
the additive column alignment from stage 3. Both are harmless, but to be exact:

```bash
$PSQL "$DATABASE_URL" -c "drop table if exists public.schema_migrations"
```

The columns added in stage 3 are additive and empty-by-default; leaving them
costs nothing.

**After stage 5 or later** — restore the backup. This replaces the `public`
schema wholesale:

```bash
$PSQL "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "drop schema public cascade" -c "create schema public"
/opt/homebrew/opt/postgresql@17/bin/pg_restore --dbname "$DATABASE_URL" --no-owner --no-privileges \
  ~/globa3-backups/prod-<STAMP>/public.dump
```

**Check after rollback**:

```bash
$PSQL "$DATABASE_URL" -Atc "select count(*) from public.entities"
```

Expected: `250`.

Restore in three passes if the single pass reports foreign-key errors —
`--section=pre-data`, then `--section=data`, then `--section=post-data`. Loading
rows into a schema that already has its foreign keys drops every row whose
parent has not been inserted yet; that cost 210 of 1183 rows during the
rehearsal before the section-by-section order was adopted.
