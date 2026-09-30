# Globa 3 production memory — migration plan

Companion to `MEMORY-ARCHITECTURE-AUDIT.md`. Every decision below is grounded in
measurements taken from production on 28 September 2026; nothing here is a
guess about what is in the database.

**Status: rehearsed and ready. Production is untouched.** Every stage below has
been executed against a PostgreSQL 17 restore of the verified backup, following
the release runbook command for command, finishing with 21 of 21 integrity
proofs passing. Production itself is written to only by `PRODUCTION-RELEASE-RUNBOOK.md`,
run by hand.

---

## 1. Strategy

Production is at a pre-platform state (see audit §1). The repository already
contains the migration that upgrades exactly this database:
`0006_workspace_scoping.sql` opens with *"The existing schema has no tenant
column at all"* and names all 23 production tables in its backfill list.

So the plan is **not** to invent a bespoke migration. It is to run the existing,
reviewed migration set against production, then do the legacy-content work the
migration set does not cover, then drop the legacy layer.

### 1.1 Baseline: run `0000`, stamp `0001`–`0004`, run the rest

The first attempt stamped `0000`–`0004` and failed at `0005` with `schema "auth"
does not exist`. The second ran everything from `0000` and failed at `0001` with
`column "business_unit_id" does not exist`. Both failures were informative, and
together they fix the baseline exactly:

**`0000` must run.** It says of itself: *"make one migration set runnable
against BOTH a local/test Postgres and a real Supabase project… On Supabase
every object below already exists, so every statement is guarded and additive."*
It is what creates the local stand-ins for `auth.users`, `auth.uid()` and the
`anon` / `authenticated` / `service_role` roles. On Supabase it performs no DDL
in `auth` at all. Stamping it skips the thing later migrations depend on.

**`0001`–`0004` must be stamped.** Production built its legacy tables from an
earlier dialect. `0001` would create `relationship_interactions(contact_id,
company_id, business_unit_id)`; production has `(external_contact_id,
external_company_id, internal_business_unit_id)`. The `create table if not
exists` is skipped, and the index that follows fails. Production already holds
all the data these four would produce, so re-deriving it is both pointless and
impossible.

**`0005`–`0021` run normally.**

### 1.2 One production-specific repair

Stamping `0001` leaves production's legacy tables in their own dialect, and the
platform migrations reference those tables **unguarded** in 0005, 0006, 0007,
0009, 0011, 0015, 0016, 0017, 0018 and 0019. Dropping them first is therefore
not an option.

`scripts/prod-audit/production-baseline-align.sql` closes the gap: it adds the
columns the migration set expects (`meetings.slug`, `relationship_interactions.
business_unit_id` and so on), carries values across where production names the
same thing differently, and touches nothing else. Every statement is additive
and idempotent. Six of the tables it repairs are dropped by `0021` an hour
later; the columns exist only so the intervening migrations can run.

It is deliberately **not** a migration: a database built from `0001` already has
the right shape and must never run it.

## 2. Table-by-table decisions

One decision per table, no "keep for later".

### Retain unchanged (13)
`entities`, `entity_aliases`, `entity_affiliations`, `business_units`,
`members`, `member_business_units`, `evidence`, `research_artifacts`,
`research_findings`, `signals`, `signal_entities`, `interactions`,
`opportunities`, `outcomes`.

Each gains `workspace_id` from `0006` and RLS from `0007`. No data change.

### Retain after triage (2)
| Table | Triage |
| --- | --- |
| `actions` (24) | §5 |
| `entity_mentions` (10) | §6 |

### Migrate, then drop (3)
| Table | Rows | Destination |
| --- | ---: | --- |
| `knowledge` | 82 | `evidence` + `research_findings` (+ `context_items` for the workspace-context subset) |
| `rules` | 59 | `context_items` |
| `Globa 3 Automatization & Memory` | 15 | `context_items` |

### Drop after a field-level check (4)
| Table | Rows | Why it can go |
| --- | ---: | --- |
| `external_contacts` | 52 | 52/52 already mirrored into `entities` |
| `external_companies` | 54 | 54/54 already mirrored |
| `relationship_interactions` | 6 | 6/6 already mirrored into `interactions` |
| `meetings` | 1 | mirrored as an interaction and an artifact |

No table is kept as a compatibility view, mirror or fallback.

---

## 3. Execution order

Each stage is separately verifiable and, except where noted, transactional.

| # | Stage | Reversible? |
| --- | --- | --- |
| 0 | Backup (**done**, verified 1183/1183 rows) | — |
| 1 | `migrate.mjs --status` against production — confirm it reports 20 pending and no drift | read-only |
| 2 | `migrate.mjs --dry-run` — applies all 20 in **one transaction, then rolls back** | yes, by construction |
| 3 | Compare row counts before/after the dry run: they must be identical | read-only |
| 4 | `migrate.mjs` — apply for real | restore from backup |
| 5 | Post-migration integrity checks (§7) | read-only |
| 6 | `0020` legacy content migration (§4) | one transaction |
| 7 | Triage actions (§5) and mentions (§6) | one transaction |
| 8 | Attach or remove the 10 unattached evidence rows (audit §4.3) | one transaction |
| 9 | `0021` drop the 7 legacy tables | restore from backup |
| 10 | Application changes (§8) + full verification | — |
| 11 | `bootstrap-imported` to create the admin login and workspace content | — |

Stage 2 is the real rehearsal. A PGlite copy cannot rehearse this faithfully:
it has no genuine Supabase `auth` schema and no real `anon` / `authenticated` /
`service_role` roles, which are exactly what `0007_rls.sql` and
`0018_revoke_client_write_privileges.sql` act on. `--dry-run` against production
runs against the real schema, the real roles and the real 1183 rows, inside a
transaction that is rolled back. It is both the most faithful and the safest
test available.

---

## 4. Migration `0020` — legacy content into the final model

156 rows of free text across three tables. This is the only part of the job that
can lose information, so it is explicit rather than clever.

### 4.1 `knowledge` (82 rows, 20 `type` values)

Classified by `type`, not by guessing at content:

| `knowledge.type` | n | Becomes |
| --- | ---: | --- |
| `context`, `scope`, `positioning`, `direction`, `roadmap`, `thesis`, `commercial_model` | 45 | `context_items` — durable workspace context the prompt layer already reads |
| `insight`, `market_watch`, `market_signal`, `model_watch`, `story_ip_watch`, `format_rights_signal`, `incentive_research` | 17 | `evidence` (`source_type = 'legacy_note'`) + `research_findings` (`finding_type = 'inference'`) linked to it |
| `decision` (3), `partner_assessment` (2), `partner_context` (3), `relationship_context` (1) | 9 | `evidence` + `research_findings` (`finding_type = 'fact'`), related to the entity named in the row where one resolves |
| `system_logic` | 11 | `context_items` |

Every migrated row keeps `title`, `content`, `created_at` and `business_unit_id`.
Each `evidence` row records its origin in `provenance_note`:
*"Migrated from the legacy knowledge table, row &lt;slug&gt;."* That is a true
statement of where the text came from — it is **not** a fabricated external
source.

One row has `status = ''` rather than `'active'`; it is migrated with the others
and its status normalised.

### 4.2 `rules` (59) and `Globa 3 Automatization & Memory` (15)

Both are instructions to the system, not memory about the world. Both become
`context_items`, keyed by slug, preserving `type`, `title`, `content` and
`business_unit_id`.

The `Globa 3 Automatization & Memory` rows carry leading whitespace in `type`
(`'    system_logic'`); it is trimmed on the way in.

### 4.3 Legacy field carry-over, before the drops

Fields present on a legacy row and absent from its canonical entity must be
carried over or explicitly judged not worth keeping. To check and carry:

- `external_contacts`: `email`, `phone`, `mobile_phone`, `linkedin_url`,
  `role_title`, `notes`, `primary_owner_member_id`
- `external_companies`: `website_url`, `region`, `country`, `notes`,
  `primary_owner_member_id`
- `relationship_interactions`: `next_steps`, `tags`, `source_system`,
  `source_reference`, `review_status`
- `meetings`: `transcript`, `summary`, `source`

`linkedin_url` and `website_url` map to `entities.primary_url`; `region` /
`country` to the matching entity columns; contact details and notes are personal
data and belong on the entity only where the entity is a real contact, so they
are carried with the same `visibility` and `sensitivity` the entity already
carries. Nothing is copied into a public-facing field.

---

## 5. The 24 proposed actions

All 24 have a meaningful target, so none is removed for being disconnected.
The rule, applied transparently and recorded in `provenance_note`:

| Condition | Outcome |
| --- | --- |
| Tied to a real interaction (6 rows) | **Keep**, status `proposed` |
| Has a future `due_at` (1 row: 30 Dec 2026) | **Keep**, status `proposed` |
| Has a `due_at` already past (2 rows: 17 Sep 2026, 1 Oct 2026) | **Keep**, status `proposed`, flagged overdue in the UI — a passed watch date is information, not rubbish |
| Undated `research_follow_up` created ≥ 21 days ago (15 rows) | **Keep**, status `proposed` |

**Net: all 24 retained.** This is deliberate. Nothing in the data distinguishes
an abandoned September research task from a live one, and silently closing
fifteen real follow-ups to make a count look tidy would destroy judgement the
owner has not made. The honest move is to surface them as overdue, not to guess.

If you want them pruned, that is a business decision and a one-line update once
you say which ones — it is the single item this plan deliberately leaves open.

---

## 6. The 10 pending entity mentions

All 10 have a rationale and source evidence; none has a candidate entity.

1. Match each `mention_slug` against `entities.slug` and `entity_aliases.alias_slug`.
2. An exact match → set `candidate_entity_id`, `resolution_status = 'resolved'`,
   and record the match in `rationale`.
3. No match → leave `pending`. A genuinely unresolved name is useful: it is the
   product's record that someone was mentioned and not yet identified.

None is deleted. All ten are recent (3–14 September 2026) and carry real
rationale text.

---

## 7. Verification — the eleven proofs

Run after stage 9, as an addition to `npm run verify:all`:

| # | Proof | Check |
| --- | --- | --- |
| 1 | No orphaned records | every retained table's FKs resolve; no unattached evidence |
| 2 | No legacy table remains | `to_regclass` is null for all 7 |
| 3 | No query references a removed table | grep of app code in SQL context |
| 4 | No duplicate canonical identity | group by normalised name + type, expect 0 |
| 5 | Every interaction has a subject | entity or business unit non-null |
| 6 | Every action has a target | already true (24/24) — assert it stays true |
| 7 | Every signal has ≥1 linked entity | already true (27/27) |
| 8 | Every finding has provenance | already true (178/178) |
| 9 | Migrated records keep relationships | before/after relationship counts equal |
| 10 | Readback traverses correctly | person, organisation, project, signal, action, evidence |
| 11 | New captures write only the final model | existing `verify:capture` §11 already asserts no legacy writes |

Plus: typecheck, `verify:migrations`, `verify:capture`, `verify:mobile-api`,
`verify:readback-fallback`, `verify:review`, `verify:grants`, the web production
build, and the iOS export.

---

## 8. Application changes

| Change | File | Why |
| --- | --- | --- |
| Remove the `knowledge` retrieval source | `packages/core/src/pipelines/ask.ts:307` | the table is going; its content arrives as `context_items`, `evidence` and `research_findings`, which Ask already reads |
| Drop the legacy-count assertions | `packages/core/src/cli/verify-capture.ts:917` | the tables will not exist |
| Drop the legacy-table probes | `scripts/test-import.mjs`, `scripts/import/lib/export-sql.mjs` | same |
| Drop the memory-table count | `packages/core/src/seed.ts:436` | same |
| Remove legacy handling | `scripts/import/lib/common.mjs`, `verify-import.mjs` | the import path that produced these tables is finished |

`entity_affiliations` also needs its documentation corrected: it holds person →
organisation **and person → project** credits (16 of 84 are project credits, and
they are correct). The column name `organization_entity_id` is now misleading;
renaming it is optional and cosmetic, and is **not** part of this migration.

---

## 9. Result of the rehearsal

Run on a PostgreSQL 17.11 cluster holding a section-by-section restore of
`~/globa3-backups/prod-2026-09-28T21-09-54/public.dump` — verified row-for-row
identical to production (23 tables, 1183 rows) before anything was applied.

| Stage | Result |
| --- | --- |
| Restore | 23 tables, 1183 rows, identical to production |
| Stamp `0001`–`0004` | 4 recorded |
| Alignment | applied, `meetings.slug` present |
| Dry run of `0000`+`0005`–`0019` | all 16 ok in one transaction, rolled back |
| Apply `0000`+`0005`–`0019` | 20 recorded, workspace `globa3`, 64 policies, 250 entities |
| Admin link | `maryana.lobyk.lm@gmail.com \| admin \| t \| globa3` |
| `0020` content migration | evidence 162→303, findings 178→319 |
| Pre-drop proof | 52\|52, 54\|54, 6\|6, 1\|1, 82\|82, 59\|59 — every legacy row covered |
| `0021` drops | all 7 legacy tables gone, 43 tables remain |
| Integrity proofs | **21/21 passed** |

PGlite was tried first as the rehearsal host and cannot do this job: it hung
indefinitely (0.1% CPU for 25 minutes) restoring production's foreign keys and
indexes. Real PostgreSQL restores the same dump in 0.1 seconds.

### What the rehearsal does not prove

It is a real PostgreSQL 17 cluster, the same major version as production, but it
is not Supabase. `0000` creates stand-ins for `auth.users`, `auth.uid()` and the
three Supabase roles, so `0007` (RLS) and `0018` (privileges) execute and their
SQL is proven valid — but against stand-ins. Stage 4 of the runbook closes that
gap: it applies every migration inside one transaction against real production
and rolls back.

## 10. Still open

One item, and it is a business judgement rather than an engineering one: **which
of the 15 undated September research follow-ups are still wanted**. All 24
actions are retained (§5). Nothing in the data distinguishes an abandoned task
from a live one, and closing fifteen real follow-ups to tidy a count would
discard a decision that has not been made. Say which ones, and it is a one-line
update.
