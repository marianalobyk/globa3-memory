# Table retention manifest — the 43 tables after release

Release-gate review, 29 September 2026. Every claim below was measured against
the rehearsed database (a PostgreSQL 17 restore of the verified production
backup with all 22 migrations applied), and every "runtime code path" was found
by searching for `public.<table>` in application code, excluding migrations,
verify suites and this audit directory.

**Classes**

- **Memory** — permanent domain record. Deleted only by an explicit human
  decision. Growth is the point.
- **Operational** — the trace of a piece of work. Should be disposable once the
  work is finished and its result is in memory.
- **Audit** — a permanent record of who changed what. Deliberately never
  deleted; deleting it would destroy provenance.
- **Infrastructure** — configuration or bookkeeping. Bounded by definition.

---

## 1. Memory — 16 tables

Permanent by design. Every one is workspace-scoped with RLS.

| Table | Rows | Runtime code path | Purpose to the user | Why it is not clutter |
| --- | ---: | --- | --- | --- |
| `entities` | 250 | `briefing.ts`, `resolve.ts`, `pipelines/ask.ts`, `memory-context.ts`, +8 | Every person, company, project, event | The canonical identity layer |
| `entity_aliases` | 3 | `briefing.ts`, `resolve.ts`, `memory-context.ts`, +1 | "Also known as" | Stops a second record being created for a known name |
| `entity_affiliations` | 84 | `briefing.ts`, `pipelines/ask.ts`, `pipelines/capture.ts`, +2 | Who works where, and film/format role credits | 84 live relationships |
| `entity_mentions` | 10 | `pipelines/ask.ts`, `resolve.ts`, `apply.ts`, +1 | Names seen but not yet identified | See §5 — bounded, each carries a rationale |
| `business_units` | 10 | `pipelines/ask.ts`, `resolve.ts`, `page-data.ts`, +3 | The internal Globa 3 structure | The context every signal and finding hangs off |
| `members` | 4 | `resolve.ts`, `dev-mobile-preview.ts`, review pages, +1 | Colleagues | Distinguishes a colleague from an external contact at capture |
| `member_business_units` | 5 | **none** (listed in `bootstrap-imported.ts` only) | Which colleague works on which unit | **See §6 — the one table with no reader** |
| `evidence` | 293 | `briefing.ts`, `pipelines/ask.ts`, review pages, +2 | The source behind every claim | Provenance; 21/21 proofs require every finding to cite one |
| `research_artifacts` | 7 | `briefing.ts`, review pages | A research output as an object | Groups a document's findings |
| `research_findings` | 319 | `briefing.ts`, `pipelines/ask.ts`, `memory-context.ts`, +3 | Facts, inferences, gaps, risks, recommendations | The largest memory table; what Knowledge answers from |
| `signals` | 27 | `briefing.ts`, `pipelines/ask.ts`, review pages, +1 | What to watch | Drives the radar |
| `signal_entities` | 143 | `briefing.ts` (plus the apply engine, dynamically) | What a signal is about | 143 links; no signal is subject-less |
| `interactions` | 7 | `briefing.ts`, `pipelines/ask.ts`, `memory-context.ts`, +1 | Meetings, calls, introductions | Real relationship history |
| `actions` | 24 | `briefing.ts`, `pipelines/ask.ts`, `prompt.ts`, +2 | What to do or watch next | All 24 have a target |
| `opportunities` | 0 | `briefing.ts`, `pipelines/document-capture.ts` | A justified commercial possibility | Written by document capture when a hypothesis is selected |
| `outcomes` | 0 | via the apply engine (`PROPOSAL_TARGET_TABLES`) | A result that actually happened | A valid proposal target; written dynamically, not by literal SQL |

**Lifecycle:** none of these is auto-deleted. That is correct — this is the
memory the product exists to hold.

---

## 2. Operational — 14 tables

The trace of work in progress. **This is where the retention question bites;
see §4.**

| Table | Runtime code path | Purpose | Intended lifecycle |
| --- | --- | --- | --- |
| `captures` | `capture.ts`, `pipelines/capture.ts`, `contact-research.ts`, +7 | A thing you sent in, before it is memory | Should end at `done` and be disposable once its proposal is applied |
| `uploads` | `capture.ts`, `pipelines/ingest.ts`, `storage.ts`, +4 | The stored file behind a capture | Tied to its capture; the blob also lives in Storage |
| `upload_documents` | `pipelines/ingest.ts`, `api/uploads/route.ts` | Extracted text of an upload | Derivable again from the file |
| `runs` | `capture.ts`, `runs.ts`, `pipelines/report.ts`, +7 | One pipeline execution | Disposable once finished |
| `run_stages` | `runs.ts`, `contact-research.ts`, `api/runs/[id]` | Per-stage progress | Disposable with its run |
| `run_events` | `runs.ts`, `pipelines/research.ts`, `api/runs/[id]` | The live progress log | Disposable with its run; the noisiest table |
| `proposals` | `apply.ts`, `proposals.ts`, `capture.ts`, +10 | The reviewable draft | Disposable once applied, discarded or superseded |
| `proposal_items` | `apply.ts`, `proposals.ts`, `contact-research.ts`, +7 | One proposed record | Disposable with its proposal |
| `contact_research` | `contact-research.ts`, `runs.ts` | An identity-research request and its consent record | Keep while the consent matters |
| `research_topics` | `research-request.ts`, `pipelines/research.ts`, `pipelines/brief.ts`, +4 | Topics queued for research | Should close when researched |
| `ask_threads` | `api/ask/route.ts` | A Knowledge conversation | Disposable; answers come from memory, not from the thread |
| `ask_messages` | `api/ask/route.ts` | Questions and answers in a thread | Disposable |
| `usage_events` | `costs.ts`, `page-data.ts` | One model call's tokens and cost | Should roll up and expire |
| `daily_reports` | `pipelines/report.ts`, `page-data.ts`, `api/files` | A generated daily brief | See §3 — the briefs subsystem |

---

## 3. Audit and infrastructure — 13 tables

| Table | Class | Scope | Runtime code path | Why it stays |
| --- | --- | --- | --- | --- |
| `applied_changes` | **Audit** | workspace | `apply.ts`, `pipelines/report.ts`, `page-data.ts` | The record of which proposal item became which row. Deleting it breaks "why does this record exist" |
| `proposal_approvals` | **Audit** | workspace | `apply.ts`, `proposals.ts`, `pipelines/report.ts` | Who approved what, and when |
| `activity_log` | **Audit** | workspace | `activity.ts` | The Activity screen; the user-facing history |
| `workspaces` | Infra | **global** | `auth.ts`, `capture.ts`, `seed.ts`, +5 | The tenant itself. Cannot be workspace-scoped |
| `app_users` | Infra | **global** | `auth.ts`, `apply.ts`, `activity.ts`, +4 | Identity. A person may belong to more than one workspace |
| `workspace_members` | Infra | workspace | `auth.ts`, `page-data.ts`, `bootstrap-imported.ts`, +3 | Membership; the thing every RLS policy checks |
| `schema_migrations` | Infra | **global** | `migrate.mjs`, `supabase-test/preflight.mjs` | Migration bookkeeping. No RLS and no client grants — see §5 |
| `budgets` | Infra | workspace | `costs.ts`, `page-data.ts`, `bootstrap-imported.ts` | The spend cap. One row per workspace |
| `context_items` | Infra | workspace | `prompt.ts`, `bootstrap-imported.ts` | Workspace context fed to the model. Bounded, hand-curated |
| `prompt_versions` | Infra | workspace | `formats-repo.ts`, `bootstrap-imported.ts`, briefs page | Versioned prompts. Append-only but tiny |
| `brief_formats` | Infra | workspace | `formats-repo.ts`, `pipelines/report.ts`, +3 | Output format definitions |
| `brief_documents` | Operational | workspace | `pipelines/brief.ts`, `pipelines/research.ts`, +6 | A generated brief |
| `brief_sources` | Operational | workspace | `pipelines/brief.ts`, briefs page, `page-data.ts` | Sources cited by a brief |

### The briefs subsystem — a product decision, not a technical one

`daily_reports`, `brief_documents`, `brief_formats`, `brief_sources` and
`research_topics` serve the briefs and research features. Those features are
**unreachable in the UI**: `apps/web/next.config.mjs` redirects `/briefs`,
`/briefs/*`, `/research` and `/research/*` to `/capture` (307), and the
navigation lists only Today, Capture, Review, Knowledge, Activity and Settings.

They are **not dead code**, though: `/api/runs` still accepts
`kind: 'brief'` and `kind: 'research'`, `/api/reports` and `/api/research`
exist, and the worker pipelines run. `brief_formats` and `prompt_versions` are
also created by `bootstrap-imported`, which the release uses.

Applying the removal test from the review brief — *no active runtime use **and**
no integrity purpose **and** no planned user-facing workflow* — these tables
fail the first leg: the runtime paths execute. **So they are not removed in this
release.**

But they are the right thing to question. Retiring them properly means removing
the API routes, the two pipelines, the format/prompt bootstrap and five tables
together. That is a coherent change, and it is not one to bundle into a data
migration. **Recommendation: decide briefs' future as a separate change.** If
the answer is "gone for good", that is roughly a day's work and removes five
tables, two pipelines and three API routes.

---

## 4. The retention gap — the one real finding

**There is no cleanup lifecycle for operational data, and I cannot confirm that
these tables will not become permanent archives.** A search for
`delete from public.<operational table>` across all application code returns
nothing. The only deletes in the repository are in RLS tests, asserting that
deletes are *refused*.

So `captures`, `runs`, `run_stages`, `run_events`, `proposals`,
`proposal_items`, `uploads`, `upload_documents`, `ask_threads`, `ask_messages`
and `usage_events` grow without bound.

**Why this does not block the release:** all eleven tables are created empty by
this migration. Production has zero rows in every one of them today, so there is
nothing to clean up at release time, and no existing data is at risk.

**Why it must not be ignored:** `run_events` writes several rows per pipeline
stage. At a realistic capture rate this is the table that grows fastest, and
nothing removes a row of it ever.

**What the fix should look like, and what it must not touch:**

| Keep forever | Expire |
| --- | --- |
| `applied_changes`, `proposal_approvals`, `activity_log` — the audit trail of what was approved and why | `run_events`, `run_stages` once the run is finished |
| Anything in §1 | `runs`, `captures`, `proposals`, `proposal_items` once the proposal is applied, discarded or superseded, and its `applied_changes` rows exist |
| | `ask_threads` / `ask_messages` after a period — answers come from memory, not from the thread |
| | `usage_events` after roll-up into a monthly total |
| | `upload_documents` — re-derivable from the stored file |

A naive "delete old operational rows" job would be wrong: `applied_changes` and
`proposal_approvals` look operational and are not. This needs designing, with
its own tests, as its own change.

---

## 5. Workspace scoping — a correction

An earlier report of mine said every table carries `workspace_id`. **That was
wrong.** Measured: **40 of 43** are workspace-scoped, all 40 with RLS enabled
and every row populated. Three are global, each legitimately:

| Table | Why it is global | Protection |
| --- | --- | --- |
| `workspaces` | It *is* the tenant table | RLS on, 1 policy: a row is visible only to its members |
| `app_users` | Identity spans workspaces; one person can be a member of several | RLS on, 1 policy |
| `schema_migrations` | Migration bookkeeping. Forcing a workspace onto it would be an incorrect relationship | **No RLS, and no grants at all** to `anon`, `authenticated` or `service_role` — unreachable by any client. Verified |

Client privileges, verified on the rehearsed database: `anon` can select from
**0** tables; `authenticated` holds **0** INSERT/UPDATE/DELETE grants. Writes go
only through the server's service role.

---

## 6. `member_business_units` — the one table with no reader

Five production rows mapping colleagues to business units. **No runtime code
path reads or writes it**; it appears only in `bootstrap-imported.ts`'s list of
imported tables to leave alone.

It is kept, for three reasons: it holds real data that exists nowhere else, it
has genuine foreign-key integrity to `members` and `business_units`, and at five
rows it is not clutter by any measure. It is listed here so the decision is
visible rather than silent. If internal-member context is never built out, it is
a clean one-line drop later.

---

## 7. What changed as a result of this review

| Finding | Action |
| --- | --- |
| `knowledge` and `rules` were still listed as valid proposal targets in `PROPOSAL_TARGET_TABLES`, the `ProposedChange` zod enum and `proposal-schema.ts` | **Fixed.** A proposal can no longer target a dropped table, which would have failed at apply time |
| Upload copy promised "capture into knowledge is coming next" | **Fixed.** Now "Capture it to read it into memory" |
| The claim that every table is workspace-scoped | **Corrected** — §5 |
| No retention lifecycle | **Documented** — §4. Not blocking; nothing to clean up yet |
| Briefs subsystem is UI-unreachable but API-live | **Documented** — §3. A product decision, deliberately not bundled here |
| `member_business_units` has no reader | **Documented** — §6 |
