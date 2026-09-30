-- 0020 Legacy memory into the final model.
--
-- Moves the last legacy content that lives nowhere else into the tables the
-- application actually reads, so that 0021 can drop the legacy layer without
-- losing a sentence.
--
-- What moves, and why it moves where it does
-- ------------------------------------------
--   knowledge (82 rows in production)
--     Durable business memory: what a venture is, how it makes money, what a
--     partner looks like, what a market is doing. Many rows are already written
--     as "Fact: ... Inference: ...". Each becomes one `evidence` row recording
--     where the text came from, plus one `research_findings` row carrying the
--     text itself -- `fact` for statements of how things are, `inference` for
--     analysis. That is exactly the distinction the rest of the product relies
--     on, and the Ask pipeline already reads both tables.
--
--   rules (59 rows in production)
--     Not formatting internals: these are operating policy -- brand
--     positioning, tone, visual direction, and compliance/governance controls
--     such as "AMV sponsored content must pass harm review before
--     publication". They become `recommendation` findings, which is how the
--     product represents "what should be done".
--
-- `Globa 3 Automatization & Memory` is deliberately NOT migrated. Its 15 rows
-- describe the architecture of the system being replaced ("knowledge linked by
-- business_unit_id", "use stable identifiers"). They are engineering notes, not
-- business memory, and putting them in `research_findings` would mean the Ask
-- pipeline answering questions about Globa 3 with stale design decisions. They
-- are preserved verbatim in docs/LEGACY-SYSTEM-NOTES.md, in version control,
-- and in the backup.
--
-- Provenance is honest throughout: `source_type = 'database_row'` (already used
-- by 61 production evidence rows) and a provenance note naming the exact legacy
-- table and slug. No external source is invented, and no fact is promoted to a
-- confirmed claim it was not already.
--
-- Idempotent: each evidence row reuses the legacy row's own id as its primary
-- key, so a second run conflicts and does nothing.

-- ---------------------------------------------------------------------------
-- knowledge -> evidence
-- ---------------------------------------------------------------------------
insert into public.evidence (
  id, workspace_id, source_type, title, source_date, reliability, excerpt, notes,
  created_at, updated_at, visibility, external_use_status, sensitivity, provenance_note)
select
  k.id,
  k.workspace_id,
  'database_row',
  k.title,
  k.created_at::date,
  'unverified',
  left(k.content, 2000),
  k.content,
  k.created_at,
  k.updated_at,
  'internal',
  'source_only',
  'standard',
  'Migrated from the legacy knowledge table (slug: ' || k.slug || ', type: ' || k.type || ').'
from public.knowledge k
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- knowledge -> research_findings
--
-- `fact` for statements of what is; `inference` for reading into it. The split
-- follows the legacy `type`, which is the only evidence available about intent.
-- ---------------------------------------------------------------------------
insert into public.research_findings (
  workspace_id, evidence_id, business_unit_id, finding_type, title, content,
  confidence, status, created_at, updated_at,
  visibility, external_use_status, sensitivity, provenance_note)
select
  k.workspace_id,
  k.id,
  k.business_unit_id,
  case
    when k.type in ('insight', 'market_watch', 'market_signal', 'model_watch',
                    'story_ip_watch', 'format_rights_signal', 'incentive_research',
                    'partner_assessment')
      then 'inference'
    else 'fact'
  end,
  k.title,
  k.content,
  'medium',
  'active',
  k.created_at,
  k.updated_at,
  'internal',
  'not_cleared',
  'standard',
  'Migrated from the legacy knowledge table (slug: ' || k.slug || ', type: ' || k.type || ').'
from public.knowledge k
where not exists (select 1 from public.research_findings f where f.evidence_id = k.id);

-- ---------------------------------------------------------------------------
-- rules -> evidence
-- ---------------------------------------------------------------------------
insert into public.evidence (
  id, workspace_id, source_type, title, source_date, reliability, excerpt, notes,
  created_at, updated_at, visibility, external_use_status, sensitivity, provenance_note)
select
  r.id,
  r.workspace_id,
  'database_row',
  r.title,
  r.created_at::date,
  'unverified',
  left(r.content, 2000),
  r.content,
  coalesce(r.created_at, now()),
  coalesce(r.updated_at, now()),
  'internal',
  'source_only',
  'standard',
  'Migrated from the legacy rules table (slug: ' || r.slug || ', type: ' || r.type || ').'
from public.rules r
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- rules -> research_findings, as recommendations
-- ---------------------------------------------------------------------------
insert into public.research_findings (
  workspace_id, evidence_id, business_unit_id, finding_type, title, content,
  confidence, status, created_at, updated_at,
  visibility, external_use_status, sensitivity, provenance_note)
select
  r.workspace_id,
  r.id,
  r.business_unit_id,
  'recommendation',
  r.title,
  r.content,
  'medium',
  'active',
  coalesce(r.created_at, now()),
  coalesce(r.updated_at, now()),
  'internal',
  'not_cleared',
  'standard',
  'Migrated from the legacy rules table (slug: ' || r.slug || ', type: ' || r.type || ').'
from public.rules r
where not exists (select 1 from public.research_findings f where f.evidence_id = r.id);

-- ---------------------------------------------------------------------------
-- Legacy contact and company detail that only exists on the legacy row.
--
-- The canonical entity already exists for all 52 contacts and all 54 companies.
-- What it may not have is the URL, region or country the legacy row carried.
-- Only fill a column that is currently empty: never overwrite a canonical value
-- with a legacy one.
--
-- Email, phone and notes are deliberately NOT copied. `entities` has no column
-- for them, inventing one to hold personal contact details would widen what the
-- product stores about people without anyone asking for it, and the backup
-- keeps them recoverable.
-- ---------------------------------------------------------------------------
update public.entities e
   set primary_url = coalesce(e.primary_url, c.linkedin_url),
       updated_at  = now()
  from public.external_contacts c
 where e.legacy_external_contact_id = c.id
   and e.primary_url is null
   and c.linkedin_url is not null;

update public.entities e
   set primary_url = coalesce(e.primary_url, co.website_url),
       region      = coalesce(e.region, co.region),
       country     = coalesce(e.country, co.country),
       updated_at  = now()
  from public.external_companies co
 where e.legacy_external_company_id = co.id
   and (e.primary_url is null or e.region is null or e.country is null)
   and (co.website_url is not null or co.region is not null or co.country is not null);

-- ---------------------------------------------------------------------------
-- Unresolved mentions: resolve the ones the data already answers.
--
-- A mention whose slug matches a canonical entity, or an approved alias of one,
-- in the same workspace is not genuinely unresolved -- it is a link nobody made.
-- Anything without an exact match stays pending, because a name that memory
-- cannot place is itself worth keeping.
-- ---------------------------------------------------------------------------
update public.entity_mentions m
   set candidate_entity_id = e.id,
       resolution_status   = 'resolved',
       rationale = coalesce(m.rationale, '') ||
         case when coalesce(m.rationale, '') = '' then '' else ' ' end ||
         '[Resolved during the 0020 migration: the mention slug matches the canonical entity "' || e.display_name || '".]',
       updated_at = now()
  from public.entities e
 where m.candidate_entity_id is null
   and m.resolution_status = 'pending'
   and e.workspace_id = m.workspace_id
   and e.status = 'active'
   and e.slug = m.mention_slug;

update public.entity_mentions m
   set candidate_entity_id = a.entity_id,
       resolution_status   = 'resolved',
       rationale = coalesce(m.rationale, '') ||
         case when coalesce(m.rationale, '') = '' then '' else ' ' end ||
         '[Resolved during the 0020 migration: the mention slug matches an approved alias of this entity.]',
       updated_at = now()
  from public.entity_aliases a
 where m.candidate_entity_id is null
   and m.resolution_status = 'pending'
   and a.workspace_id = m.workspace_id
   and a.alias_slug = m.mention_slug;

-- ---------------------------------------------------------------------------
-- An interaction with no subject.
--
-- Production holds one: "Call#1 - Globa3 Memory System" (13 April 2026), an
-- internal meeting about building this system. It has evidence but names no
-- entity and no business unit, so it is unreachable from the graph.
--
-- It is real work, not junk, so it is connected rather than deleted. The rule
-- is general and conservative: an interaction that names nobody is internal by
-- definition, so it belongs to the workspace's root business unit -- the one
-- nothing else is a child of. Nothing is invented: the link asserts only that
-- an internal meeting belongs to the organisation.
-- ---------------------------------------------------------------------------
update public.interactions i
   set internal_business_unit_id = root.id,
       provenance_note = coalesce(
         nullif(i.provenance_note, ''),
         'Linked to the root business unit by migration 0020: an internal interaction that named no external subject.'),
       updated_at = now()
  from (
    select distinct on (b.workspace_id) b.workspace_id, b.id
      from public.business_units b
     where b.parent_id is null and b.status = 'active'
     order by b.workspace_id, b.order_index nulls last, b.created_at
  ) root
 where i.external_entity_id is null
   and i.internal_business_unit_id is null
   and root.workspace_id = i.workspace_id;

-- ---------------------------------------------------------------------------
-- Evidence that supports nothing.
--
-- Production holds ten: cited URLs captured during September research that were
-- never wired to the claim they support ("AP - NBA penalties in Clippers Kawhi
-- Leonard case", "Sports Illustrated - Unrivaled business model context", and
-- eight more). They are reachable from no entity, finding, signal, interaction,
-- action, artifact, affiliation, mention, opportunity or outcome.
--
-- There is no honest way to attach them: `research_findings.evidence_id` is
-- single-valued and every finding already cites its own source, so guessing
-- which finding each URL belongs to would be inventing provenance. A source
-- that supports nothing is not memory, so they are removed. The rows remain in
-- the 28 September 2026 backup if a link is ever identified.
-- ---------------------------------------------------------------------------
delete from public.evidence ev
 where not exists (select 1 from public.entities x where x.source_evidence_id = ev.id)
   and not exists (select 1 from public.research_findings x where x.evidence_id = ev.id)
   and not exists (select 1 from public.signals x where x.evidence_id = ev.id)
   and not exists (select 1 from public.interactions x where x.evidence_id = ev.id)
   and not exists (select 1 from public.actions x where x.evidence_id = ev.id)
   and not exists (select 1 from public.research_artifacts x where x.source_evidence_id = ev.id)
   and not exists (select 1 from public.entity_affiliations x where x.evidence_id = ev.id)
   and not exists (select 1 from public.entity_mentions x where x.source_evidence_id = ev.id)
   and not exists (select 1 from public.opportunities x where x.evidence_id = ev.id)
   and not exists (select 1 from public.outcomes x where x.evidence_id = ev.id);
