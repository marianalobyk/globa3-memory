-- Row counts for every table that exists, for the release runbook's
-- before/after comparison. Read-only.
select 'entities', count(*) from public.entities
union all select 'evidence', count(*) from public.evidence
union all select 'research_findings', count(*) from public.research_findings
union all select 'knowledge', count(*) from public.knowledge
union all select 'rules', count(*) from public.rules
union all select 'external_companies', count(*) from public.external_companies
union all select 'external_contacts', count(*) from public.external_contacts
union all select 'relationship_interactions', count(*) from public.relationship_interactions
union all select 'meetings', count(*) from public.meetings
union all select 'Globa 3 Automatization & Memory', count(*) from public."Globa 3 Automatization & Memory"
union all select 'signal_entities', count(*) from public.signal_entities
union all select 'entity_affiliations', count(*) from public.entity_affiliations
union all select 'signals', count(*) from public.signals
union all select 'actions', count(*) from public.actions
union all select 'entity_mentions', count(*) from public.entity_mentions
union all select 'business_units', count(*) from public.business_units
union all select 'interactions', count(*) from public.interactions
union all select 'research_artifacts', count(*) from public.research_artifacts
union all select 'member_business_units', count(*) from public.member_business_units
union all select 'members', count(*) from public.members
union all select 'entity_aliases', count(*) from public.entity_aliases
union all select 'opportunities', count(*) from public.opportunities
union all select 'outcomes', count(*) from public.outcomes
order by 2 desc, 1;
