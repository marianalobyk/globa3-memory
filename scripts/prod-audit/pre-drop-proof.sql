-- Proof that must pass BEFORE any legacy table is dropped.
--
-- Each row answers: does the content of this legacy table already exist
-- somewhere in the final model? A legacy table is only safe to drop when its
-- "covered" count equals its "total" count.
--
-- Read-only. Rows whose table has already been dropped are skipped, so this is
-- safe to run before or after 0021.
select 'external_contacts -> entities' as proof,
       (select count(*) from public.external_contacts) as total,
       (select count(*) from public.external_contacts c
         where exists (select 1 from public.entities e where e.legacy_external_contact_id = c.id)) as covered
 where to_regclass('public.external_contacts') is not null
union all
select 'external_companies -> entities',
       (select count(*) from public.external_companies),
       (select count(*) from public.external_companies c
         where exists (select 1 from public.entities e where e.legacy_external_company_id = c.id))
 where to_regclass('public.external_companies') is not null
union all
select 'relationship_interactions -> interactions',
       (select count(*) from public.relationship_interactions),
       (select count(*) from public.relationship_interactions r
         where exists (select 1 from public.interactions i
                        where i.subject = coalesce(r.subject, r.summary)
                           or date_trunc('day', i.occurred_at) = date_trunc('day', r.occurred_at)))
 where to_regclass('public.relationship_interactions') is not null
union all
select 'meetings -> interactions + artifacts',
       (select count(*) from public.meetings),
       (select count(*) from public.meetings m
         where exists (select 1 from public.research_artifacts a where a.title ilike '%' || m.title || '%')
            or exists (select 1 from public.interactions i where i.subject ilike '%' || m.title || '%'))
 where to_regclass('public.meetings') is not null
union all
select 'knowledge -> evidence + findings',
       (select count(*) from public.knowledge),
       (select count(*) from public.knowledge k
         where exists (select 1 from public.evidence e where e.id = k.id)
           and exists (select 1 from public.research_findings f where f.evidence_id = k.id))
 where to_regclass('public.knowledge') is not null
union all
select 'rules -> evidence + findings',
       (select count(*) from public.rules),
       (select count(*) from public.rules r
         where exists (select 1 from public.evidence e where e.id = r.id)
           and exists (select 1 from public.research_findings f where f.evidence_id = r.id))
 where to_regclass('public.rules') is not null;
