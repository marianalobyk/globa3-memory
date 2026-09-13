# Build report

**Date:** 2026-09-14 · **Status:** working local version · **Verification:** 46/46 automated checks pass

---

## 1. What the materials contained

**`main_briefs_renaming_patch_PURE_SAFE_2026-06-25.zip`** — 19 production run
prompts, eight brief desks, and 45 days of real outputs. Three prompts are in
scope:

| File | Lines |
| --- | --- |
| `run_amv_daily_briefing.md` | 831 |
| `run_amv_creative_radar.md` | 696 |
| `run_globa3_creative_radar.md` | 1 106 |
| `briefs/creative_radar/*.md` (desk files) | 5 243 |

**`Supabase Connection 2.zip`** — the workflow specification
(`globa3-supabase-memory/SKILL.md`, `table-map.md`, `research-workflow.md`), two
real migrations, the schema-gap analysis, and the `.mjs` scripts from the manual
runs.

### Findings that shaped the build

1. **The Phase 1 / 1.1 schema already exists and is good.** `entities`,
   `entity_aliases`, `entity_mentions`, `entity_affiliations`, `evidence`,
   `research_artifacts`, `research_findings`, `interactions`, `actions`,
   `signals`, `signal_entities`, `opportunities`, `outcomes`. It is reused as-is,
   not duplicated.
2. **`business_units` links are load-bearing.** It is referenced by
   `research_findings`, `interactions`, `actions`, `signals`, `entity_mentions`,
   `opportunities` and `outcomes`, and mirrored into `entities` via
   `legacy_business_unit_id`. All preserved; proposed records resolve to existing
   units rather than creating a parallel structure.
3. **Two genuine gaps:** no `workspace_id` anywhere, and **no RLS at all**. Both
   added.
4. **The prompts assume an orchestrator** that injects run metadata and computes
   coverage windows. The documents attribute this to n8n; per your instruction I
   treated that as an unimplemented placeholder. The Next.js server and the
   worker now perform that role.

---

## 2. Two blockers, and how they were resolved

| Blocker | Resolution |
| --- | --- |
| **The Supabase project does not resolve.** `dlwircxhmaffntlxmyje.supabase.co` returns NXDOMAIN — paused or deleted. The live schema could not be read, and Auth/Storage/Queues could not be exercised. | Built a local database instead, and reconstructed the legacy tables from the authoritative column references in the archive's own migration. |
| **No Docker, Postgres or Supabase CLI** on this machine. | The local database is **PGlite** — real PostgreSQL 18 compiled to WebAssembly — exposed on the Postgres wire protocol. RLS, `plpgsql`, triggers, roles, transactions and `auth.uid()` all behave as on Supabase, so the guarantees are genuinely testable. The same migrations and SQL run unchanged against Supabase. |

---

## 3. What was built

**Stack as specified:** Next.js 15 · React 19 · TypeScript · Tailwind ·
shadcn/ui · Lucide · Supabase Postgres · Supabase Auth · private Supabase Storage
· a separate Node/TypeScript worker on Supabase Queues (pgmq) · OpenAI Responses
API. One repository, shared types. No Python, no n8n.

### Database — 11 migrations, 48 tables

| Migration | Purpose |
| --- | --- |
| `0000` | Compatibility bootstrap: roles, `auth.uid()`, guarded extensions. |
| `0001` | Legacy tables, reconstructed additively. |
| `0002`–`0003` | Phase 1 and 1.1, taken verbatim from the archive. |
| `0004` | Legacy → entities backfill, idempotent. |
| `0005` | Application layer: workspaces, formats, prompt versions, runs, stages, uploads, proposals, approvals, applied changes, costs, budgets, activity. |
| `0006` | `workspace_id` everywhere + **75 composite foreign keys**. |
| `0007` | RLS: 47 tables, 62 policies. |
| `0008` | Queue: real pgmq, or a SQL-compatible implementation. |
| `0009`–`0010` | Two fixes found during testing (see §5). |

### Pipelines

- **Brief** — preflight → research → draft → qa → extract → persist
- **Research** — plan → deep_research (background, polled) → synthesize → propose
- **Ingest** — expand → parse → persist (Markdown, PDF, ZIP)
- **Ask / Report** — inline, no model needed for the report

### The five sections

Briefs · Research · Review · Knowledge · Activity, plus Settings. Mobile, empty,
loading and error states throughout.

---

## 4. What was verified

`npm run verify` — 46 checks, all passing, against a clean database using only
the documented commands.

| Area | Result |
| --- | --- |
| Three formats end to end | Each produces a brief, QA verdict, sources and resolved research topics, with the prompt version recorded |
| Unapproved records blocked | A signed-in user cannot insert an entity or a finding (`42501`); applying without a live approval is refused |
| Duplicates | Re-applying writes nothing (`already_applied`); the same logical run returns the existing run |
| Ambiguous matches | `Sports One Holdings` → ambiguous @ 0.79, staged as a mention, never merged. `Serena Ventures` ≠ `Serena Williams` (0.50). Exact slug → existing |
| Readback | Every applied row re-read from the database; approver and applier recorded |
| Edit revokes approval | Version 1 → 2, hash changes, approval revoked, stale apply refused |
| Worker recovery | Worker killed after the research stage; lease expired; second worker resumed, **reused preflight + research**, and did not pay twice |
| Workspace isolation | Outsider sees 0 rows across all tables; cross-workspace FK blocked structurally; file traversal rejected; every job carries its workspace id |
| Ask Knowledge | Cites records; declines to answer what it has no records for |
| Costs | Recorded per stage; estimates flagged |

**Also verified by hand:** the full HTTP path (API → queue → worker → six stages
→ brief); the approve-and-save flow through the real UI (7 records written,
readback all matching); all six sections in the browser; **zero horizontal
overflow at 375 px** on every route; a production build.

---

## 5. Bugs found and fixed during testing

These were found by the verification harness and by using the UI, not predicted:

1. **Apply mutated `proposal_items.op`**, which changed the content hash, so a
   *second* apply failed the hash check instead of reporting "already applied".
   The proposal now records what was *proposed*; `applied_changes` records what
   happened.
2. **The daily report used the wrong day boundaries.** It resolved `::date` in
   whatever timezone the database session had (`Etc/GMT-2` here) while "today"
   came from UTC, so evening changes landed in the wrong day's report. Boundaries
   are now computed in the workspace timezone and passed as explicit timestamps.
3. **Entity mentions duplicated on every run** — `on conflict do nothing` had no
   matching constraint, so each brief re-staged the same unresolved name (27 rows
   for 3 names). Now one pending row per name, plus a unique index (`0010`).
4. **Name similarity was wrong in both directions**: it scored
   `Serena Ventures` ≈ `Serena Williams` at 0.82 while *missing*
   `Sara Johnson` ≈ `Sarah Johnson` entirely — the dangerous direction, since it
   would silently create a duplicate person. Replaced with token alignment.
5. **A storage-traversal rejection was masked as "not found"**, hiding why a path
   was refused.
6. **False ambiguity on typed references.** A finding pointing at an existing
   entity was flagged ambiguous because no entity type could be inferred from the
   referencing table. An unknown type is now a wildcard.
7. **Ask Knowledge answered over loosely-related records** — one shared common
   word ("holdings") pulled in an unrelated entity. Retrieval now ranks by term
   overlap and drops thin matches.
8. **Mobile: 59 px of horizontal overflow** from a long unbreakable timestamp and
   a nowrap select label in grid items with `min-width: auto`.
9. **Two React copies** broke the production build; pinned to one.
10. **`npm run db:seed` pointed at a nonexistent file** — the documented quick
    start was broken.

---

## 6. Access still needed

Nothing below blocks local use. Each one gates a specific claim I cannot yet
make.

| Needed | Unblocks |
| --- | --- |
| **A working Supabase project** (the current ref does not resolve) — URL, anon key, service-role key | Reading the real schema and data; Supabase Auth; private Storage; real Queues. Until then the legacy tables are a reconstruction, faithful to the archive but unconfirmed against production. |
| **`OPENAI_API_KEY`** | Any live claim about research quality. The OpenAI path is implemented against the current Responses API — `{type:"web_search"}`, `include: web_search_call.action.sources`, `o3-deep-research` with `background: true` and polling — but **has not been exercised against the live service**. |
| **Model prices** in `config/model-prices.json` | Real spend figures. Token and search counts are already real; money is shown as "price not configured" rather than invented. |
| **A decision on production migrations** | `0006` re-scopes global unique slugs to `(workspace_id, slug)` and moves existing rows into a default workspace. It needs your approval and a backup. |
| **The client's email address** | Their workspace account. A placeholder is seeded now. |

---

## 7. Honest limits

- **No live integration is verified.** With no API key, all generated content is
  produced by a mock provider. It is labelled `is_mock` in the database and shown
  as "Mock" in the UI everywhere it can appear. Pipeline mechanics, approval,
  isolation and recovery are genuinely exercised; **the content is not research**.
- **Runs are manual.** No scheduler in this version, as specified.
- **Scanned PDFs are skipped** with a stated reason; no OCR.
- **Nested archives** are listed, not expanded.
- **Entity resolution scans in TypeScript.** Correct at this size and identical
  across environments; past ~5 000 entities per workspace it should move to a
  `pg_trgm` index on Supabase.
- **The legacy table definitions are inferred** from the archive's own migration
  and scripts, since production was unreachable. They are additive, so they
  cannot damage the real tables, but they should be diffed against production
  before you rely on them.
