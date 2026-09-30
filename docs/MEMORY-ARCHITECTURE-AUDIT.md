# Globa 3 production memory — architecture audit

Read-only audit of the production Supabase project `dlwircxhmaffntlxmyje`,
taken on **28 September 2026**. Every figure below was measured against
production over a session opened with `default_transaction_read_only = on`, so
the server itself refused any write for the duration (verified: a probe
`CREATE TABLE` was rejected).

Nothing in production was changed to produce this document.

- Evidence: `scripts/prod-audit/out-*.json`
- Backup taken before anything else: `~/globa3-backups/prod-2026-09-28T21-09-54/`
  (23 tables, 1183 rows, row-for-row equal to production — see §9)

---

## 1. The headline

Production is **not a messy version of the application's database. It is an
earlier database that the application has never run against.**

| | Production today | What the app requires |
| --- | --- | --- |
| Memory tables | 16 of 16 present | 16 |
| Legacy tables | 7 present | 0 |
| Application platform tables | **0 of 27** | 27 |
| `workspace_id` on data tables | **absent everywhere** | on all 23 |
| Row-level security | **off on every table** | on, with policies |
| RLS policies | **0** | ~60 |
| Migration history (`schema_migrations`) | **absent** | present |

So this job is not primarily "drop some legacy tables". It is: **bring a
pre-multi-tenant, unsecured, 1183-row business memory onto the current
application schema without losing a record or a relationship, and then remove
the legacy layer.**

The good news, established in §7: the gap on every shared table is almost
entirely a single missing column (`workspace_id`), and migration
`0006_workspace_scoping.sql` was written for exactly this database — it names
all 23 production tables and backfills them into one default workspace.

---

## 2. Schema map — every table in production

23 base tables, no views, no materialised views, 1 function, 11 triggers, 51
foreign keys, 0 RLS policies. Extensions: `pgcrypto`, `uuid-ossp`,
`pg_stat_statements`, `plpgsql`, `supabase_vault`.

### 2.1 Identity and relationships

| Table | Rows | Purpose | Decision |
| --- | ---: | --- | --- |
| `entities` | 250 | The canonical record for every person, organisation, project, event, institution and internal unit. | **Retain** |
| `entity_aliases` | 3 | Alternative names pointing at one canonical entity. | **Retain** |
| `entity_affiliations` | 84 | Person → organisation **and person → project** role credits. | **Retain** (see §5.3) |
| `entity_mentions` | 10 | Names seen in a source that were never resolved to an entity. | **Retain**, after triage (§5.5) |
| `business_units` | 10 | The internal Globa 3 structure (brand → divisions → ventures). | **Retain** |
| `members` | 4 | Internal Globa 3 people. | **Retain** |
| `member_business_units` | 5 | Which member works on which unit. | **Retain** |

### 2.2 Evidence and intelligence

| Table | Rows | Purpose | Decision |
| --- | ---: | --- | --- |
| `evidence` | 162 | The source behind a claim: a URL, a file, a note, a legacy row. | **Retain** |
| `research_artifacts` | 7 | A research output as an object (dossier, radar, run). | **Retain** |
| `research_findings` | 178 | What a source established: fact, inference, gap, risk, recommendation. | **Retain** |
| `signals` | 27 | A decision-relevant development worth watching. | **Retain** |
| `signal_entities` | 143 | Which entities a signal is about. | **Retain** |

### 2.3 Real work and decisions

| Table | Rows | Purpose | Decision |
| --- | ---: | --- | --- |
| `interactions` | 7 | A real meeting, call, message or introduction. | **Retain** |
| `actions` | 24 | Something to do or watch, with a target. | **Retain**, after triage (§5.4) |
| `opportunities` | 0 | A justified commercial possibility. | **Retain** (empty, used by capture) |
| `outcomes` | 0 | A result that actually happened. | **Retain** (empty, used by review) |

### 2.4 Legacy — all seven to be removed

| Table | Rows | What it is | Decision |
| --- | ---: | --- | --- |
| `external_contacts` | 52 | Pre-canonical CRM contacts. All 52 already mirrored into `entities`. | **Drop** after §5.1 |
| `external_companies` | 54 | Pre-canonical CRM companies. All 54 already mirrored. | **Drop** after §5.1 |
| `relationship_interactions` | 6 | Pre-canonical interactions. All 6 already mirrored into `interactions`. | **Drop** after §5.2 |
| `knowledge` | 82 | Free-text business context, 20 ad-hoc `type` values. **Still read at runtime** by the Ask pipeline. | **Migrate then drop** (§5.6) |
| `rules` | 59 | Writing/structure/process rules for brief generation. | **Migrate then drop** (§5.6) |
| `meetings` | 1 | One meeting transcript. Already mirrored as an interaction + artifact. | **Drop** after §5.2 |
| `Globa 3 Automatization & Memory` | 15 | Free-text system-logic notes. `type` values carry leading whitespace. | **Migrate then drop** (§5.6) |

---

## 3. Record counts

| Table | Rows | | Table | Rows |
| --- | ---: | --- | --- | ---: |
| `entities` | 250 | | `external_companies` | 54 |
| `research_findings` | 178 | | `external_contacts` | 52 |
| `evidence` | 162 | | `actions` | 24 |
| `signal_entities` | 143 | | `Globa 3 Automatization & Memory` | 15 |
| `entity_affiliations` | 84 | | `business_units` | 10 |
| `knowledge` | 82 | | `entity_mentions` | 10 |
| `rules` | 59 | | `interactions` | 7 |
| `signals` | 27 | | `research_artifacts` | 7 |
| `relationship_interactions` | 6 | | `member_business_units` | 5 |
| `members` | 4 | | `entity_aliases` | 3 |
| `meetings` | 1 | | `opportunities`, `outcomes` | 0 |

**Total: 1183 rows.**

### 3.1 Relationship counts

| Relationship | Count | Health |
| --- | ---: | --- |
| Signal → entity (`signal_entities`) | 143 | 0 dangling; **every one of the 27 signals has ≥1 entity** |
| Signal → evidence | 27 / 27 | **every signal has evidence** |
| Finding → provenance (evidence or artifact) | 178 / 178 | **no finding lacks provenance** |
| Finding → entity | 94 / 178 | the other 84 are scoped to a business unit instead — none is unscoped |
| Person → organisation/project (`entity_affiliations`) | 84 | 0 person-side type errors |
| Affiliation → evidence | 32 / 84 | 52 carry no evidence (legacy-mirrored) |
| Interaction → entity | 6 / 7 | 1 exception, see §4.4 |
| Action → target | 24 / 24 | **no action is disconnected** |
| Entity → evidence | 134 / 250 | 116 are legacy-mirrored, see §4.2 |
| Alias → entity | 3 → 2 entities | every alias resolves to exactly one entity |
| Legacy contact → entity | 52 / 52 | complete |
| Legacy company → entity | 54 / 54 | complete |

---

## 4. Duplicate, orphan and integrity checks

### 4.1 Duplicate canonical identity — none
Grouping active entities by normalised `display_name` + `entity_type` returns
**zero** groups with more than one row. There is no duplicate person,
organisation or project to merge.

### 4.2 Entities without direct provenance — 116, all explained
116 of 250 entities have no `source_evidence_id`. Every single one carries a
legacy link instead (`legacy_external_contact_id`, `legacy_external_company_id`
or `legacy_business_unit_id`): the count of entities with **neither** evidence
nor a legacy link is **0**.

These are mirrors of pre-canonical CRM rows. Their provenance is "imported from
the Globa 3 CRM", which is true and traceable. **No evidence record will be
invented for them.** Dropping `external_contacts` / `external_companies`
therefore requires preserving that provenance as a statement on the entity, not
as a fabricated source (see §5.1).

### 4.3 Unattached evidence — 10
Ten `evidence` rows (all `source_type = 'url'`) are referenced by nothing: no
entity, finding, signal, interaction, action, artifact, affiliation or mention.
They are cited URLs captured during September research that never got wired to
the claim they support — e.g. *"AP — NBA penalties in Clippers Kawhi Leonard
case"*, *"Sports Illustrated — Unrivaled business model context"*.

Decision in the plan: attempt to attach each to the finding or signal that cites
it; remove only those that cannot be attached. They are listed individually in
`out-details.json` under `orphan_evidence`.

### 4.4 One interaction with no subject
`Call#1 - Globa3 Memory System` (13 April 2026) has no entity, no business unit
and no owner — only evidence. It is an internal meeting about building this
system. It is real, not junk; it needs an internal subject (a business unit),
not deletion.

### 4.5 Affiliations pointing at non-organisations — 16, and they are correct
16 `entity_affiliations` rows have an `organization_entity_id` whose entity is a
**project**, not an organisation — for example *Olive Nwosu → Lady (Director /
screenwriter)*, *Niyitegeka Gratien → What a Day (Director / actor)*.

This is not corruption. `entity_affiliations` is the table holding **role
credits**, and a credit on a film is as real as a job at a company. The final
model must state that a person affiliates to an organisation **or a project**.
These 16 rows are retained unchanged; the constraint and the label wording are
what need to catch up.

---

## 5. Legacy → final mapping

### 5.1 `external_contacts` (52) and `external_companies` (54) → `entities`
Already done, by `entities.legacy_external_contact_id` /
`legacy_external_company_id`. Coverage is 52/52 and 54/54. The full row-by-row
map is in `out-details.json` (`legacy_contact_to_entity_map`).

Fields on the legacy rows not yet on the entity — `email`, `phone`,
`mobile_phone`, `linkedin_url`, `notes`, `role_title`, `website_url`, `region`,
`country`, `primary_owner_member_id` — must be checked for information that
would be lost, and carried over before the drop.

### 5.2 `relationship_interactions` (6) and `meetings` (1) → `interactions`
Already done. All 6 legacy interactions appear in `interactions` with identical
subjects and dates (Anton Konkov / Victor Schoucair / Deauville ×3 / Patrice
Caillet), and the one meeting appears as both an interaction and a
`research_artifacts` row (*"Legacy meeting import: Call#1"*). These three tables
can be dropped once the field-level check in §5.1 is repeated for them.

### 5.3 `entity_affiliations` — retained as is
See §4.5.

### 5.4 The 24 `proposed` actions
All 24 have a meaningful target (entity + business unit + evidence); **none is a
disconnected generic task**. They split cleanly:

| Group | Count | Nature |
| --- | ---: | --- |
| `follow_up` tied to a real interaction | 6 | Next steps from the Deauville / Paris / EIH meetings, created 2 Sep |
| `research_follow_up` and friends, no date | 15 | Research to do, created 3 Sep and 14 Sep |
| Dated watch items | 3 | Due 17 Sep 2026, 1 Oct 2026, 30 Dec 2026 |

**Two are already overdue** as of 29 September 2026: *"Refresh Arab Media Summit
outputs after 2026-09-17"* and (imminently) *"Watch HollyShorts MENA regular
deadline on 2026-10-02"*.

No action is stale by structure. Staleness here is a **business judgement** —
whether a September research follow-up is still wanted — and is the one item in
this audit that is genuinely the owner's call, not an engineering one. The plan
proposes a transparent, reversible rule rather than guessing (§ plan).

### 5.5 The 10 pending entity mentions
All 10 are `resolution_status = 'pending'`, all have a rationale and a source
evidence row, and **none has a candidate entity**: Denis Iriniga, Alain Gomis,
Andrew Yaffe, Dude Perfect, KAVA, Zulumoke Oyibo, Daniel Sol, Theo Dumont, Jeff
Pryor, Steven Adams.

They are genuine unresolved identities from September research, carrying real
rationale — not junk. Each needs matching against the 250 canonical entities; a
mention that matches becomes a link, one that does not stays pending.

### 5.6 `knowledge` (82), `rules` (59), `Globa 3 Automatization & Memory` (15)
156 rows of free text, across 20 + 12 + 3 ad-hoc `type` values. This is the only
legacy content **not** already mirrored anywhere, and `knowledge` is **still
read at runtime** — `packages/core/src/pipelines/ask.ts:307` queries
`public.knowledge` as one of nine retrieval sources for the Knowledge answer.

Dropping these tables is therefore the only part of this job that can lose
information, and the only part that requires an application change.

---

## 6. Active versus obsolete code paths

Measured by SQL-context references (`from`/`into`/`update`/`join`) in
application code, excluding migrations and this audit.

| Legacy table | Runtime reads | Test/verify only | Verdict |
| --- | --- | --- | --- |
| `knowledge` | **1** — `pipelines/ask.ts:307` | verify-review, test-migration-integrity | **done**: the read is gone, the tests are rewritten |
| `rules` | 0 | (import tests, now removed) | code-free |
| `meetings` | 0 | (import tests, now removed) | code-free |
| `external_contacts` | 0 | verify-capture (asserts capture never writes there), verify-import | code-free |
| `external_companies` | 0 | verify-capture | code-free |
| `relationship_interactions` | 0 | — | code-free |
| `Globa 3 Automatization & Memory` | 0 | seed.ts (counts) | **done**: the count now reads `entities` |

Earlier grep counts of "59 references to knowledge" and "27 to rules" were
inflated by the English words — `AskKnowledge`, `/knowledge`,
`loadKnowledgeData`, prose about "rules". The real surface was one query, and it
has been removed.

The application also references **22 tables that do not exist in production**,
led by `runs` (66 references), `proposals` (44), `captures` (34), `workspaces`
(27), `uploads` (20), `proposal_items` (15) and `app_users` (13). Until those
tables exist, production cannot serve capture, review, approval or readback at
all.

---

## 7. The exact gap to the target schema

Built empirically: a throwaway database was created, every repository migration
(`0000`–`0019`) was replayed onto it, and its `public` schema was compared with
production's.

### 7.1 Tables production is missing — 27
`activity_log`, `app_users`, `applied_changes`, `ask_messages`, `ask_threads`,
`brief_documents`, `brief_formats`, `brief_sources`, `budgets`, `captures`,
`contact_research`, `context_items`, `daily_reports`, `prompt_versions`,
`proposal_approvals`, `proposal_items`, `proposals`, `research_topics`,
`run_events`, `run_stages`, `runs`, `schema_migrations`, `upload_documents`,
`uploads`, `usage_events`, `workspace_members`, `workspaces`.

### 7.2 Tables production has that the app does not know about — 0
There is no unknown table. Every production table is accounted for.

### 7.3 Column differences on the 23 shared tables
**All 23 differ, and 14 of them differ by `workspace_id` and nothing else**:
`actions`, `entities`, `entity_affiliations`, `entity_aliases`,
`entity_mentions`, `evidence`, `external_companies`, `external_contacts`,
`interactions`, `opportunities`, `outcomes`, `research_artifacts`,
`research_findings`, `signal_entities`, `signals`.

The remaining differences are small and confined to tables that are either
legacy or internal:

| Table | Also missing in production |
| --- | --- |
| `members` | `role_title`, `notes` |
| `member_business_units` | `role` |
| `meetings` | `business_unit_id`, `meeting_date`, `slug`, `status`, `updated_at` |
| `relationship_interactions` | `business_unit_id`, `company_id`, `contact_id`, `interest_level`, `next_step`, `source` |
| `rules` | `source` |
| `business_units`, `knowledge`, `rules`, `members`, `meetings`, `member_business_units`, `Globa 3 Automatization & Memory` | `created_at`/`updated_at` are `timestamp` in production and `timestamptz` in the app |

No table needs structural surgery. No column needs to be dropped or retyped
destructively on a retained table.

---

## 8. Target schema

After migration, production holds **43 tables**: the 16 memory tables it already
has, plus the 27 platform tables, minus the 7 legacy tables.

**Permanent memory (16)** — `entities`, `entity_aliases`,
`entity_affiliations`, `entity_mentions`, `business_units`, `members`,
`member_business_units`, `evidence`, `research_artifacts`, `research_findings`,
`signals`, `signal_entities`, `interactions`, `actions`, `opportunities`,
`outcomes`.

**Operational flow, temporary by design** — `workspaces`, `app_users`,
`workspace_members`, `uploads`, `upload_documents`, `captures`, `runs`,
`run_stages`, `run_events`, `proposals`, `proposal_items`,
`proposal_approvals`, `applied_changes`, `activity_log`, `contact_research`,
`research_topics`, `ask_threads`, `ask_messages`, `usage_events`, `budgets`,
`context_items`, `prompt_versions`, `daily_reports`, `brief_formats`,
`brief_documents`, `brief_sources`, `schema_migrations`.

Every one carries `workspace_id`, has RLS enabled, and is reachable only through
a workspace membership.

---

## 9. Backup

Taken before any other step, with `pg_dump` 18.4 against PostgreSQL 17.6, to
`~/globa3-backups/prod-2026-09-28T21-09-54/` — outside the repository, so it
cannot be committed.

| File | Size | Contents |
| --- | ---: | --- |
| `public.dump` | 274 KB | `public` schema + data, custom format, restorable |
| `all.dump` | 547 KB | every schema, custom format |
| `public-schema.sql` | 53 KB | readable DDL |
| `public-data.sql` | 948 KB | readable `INSERT`s |
| `MANIFEST.json` | — | target, timestamp, tool versions, restore command |

**Verified**: the dump contains all 23 tables and **1183 rows, matching
production table-for-table and row-for-row**. `pg_restore --list` reads both
custom dumps end to end (627 entries).

One caveat found while rehearsing and worth recording: `public-data.sql` is
ordered alphabetically, so loading it into a database whose foreign keys already
exist silently drops every row whose parent has not been inserted yet (973 of
1183 survived the naive load). Restores must use `public.dump` with
`pg_restore`, section by section — `pre-data`, then `data`, then `post-data`.

---

## 10. What this audit does not decide

1. **Which September research follow-ups are still wanted** (§5.4). A structural
   rule cannot tell a live research task from an abandoned one.
2. **Who owns production.** `bootstrap-imported` needs a real admin account and
   password for a remote target and has no defaults. That account becomes the
   first human able to log in.
3. **Whether anything else writes to this database today.** RLS is off and there
   are no policies, so any current integration is writing with unrestricted
   access. After `0007` and `0018`, client roles lose write privileges and RLS
   enforces workspace membership. Anything not going through the application
   will stop working.


---

## 11. Outcome

The migration designed from this audit was rehearsed end to end on a PostgreSQL
17 restore of the verified backup, following the release runbook command for
command. Result: **21 of 21 integrity proofs passed**, 43 tables, 250 entities
unchanged, no legacy table and no legacy code path remaining.

Full detail: `MEMORY-MIGRATION-PLAN.md` §10 and `PRODUCTION-RELEASE-RUNBOOK.md`.
