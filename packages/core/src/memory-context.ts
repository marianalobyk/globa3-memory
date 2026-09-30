/**
 * A small, scoped slice of what memory holds about specific records.
 *
 * Used to give the capture analysis and contact research the context they need
 * -- without handing a model the workspace. Only the records a capture's names
 * resolved to (exactly, or as possible matches) are included, and for each only:
 *
 *   - canonical name and name aliases (never email or phone aliases);
 *   - current role and organisation;
 *   - up to three recent interactions (subject and date only);
 *   - relationship status;
 *   - up to five sourced facts or inferences (their titles);
 *   - which basic fields are missing.
 *
 * Contact details, notes, source excerpts and anything about other records stay
 * out. The model never decides identity from this: resolution stays in
 * resolve.ts and with the person reviewing.
 */
import { assertScope, type Queryable } from './db.js';

export interface MemoryContextEntry {
  entityId: string;
  name: string;
  kind: string;
  aliases: string[];
  relationshipStatus: string | null;
  roles: { role: string | null; organization: string }[];
  recentInteractions: { subject: string; date: string | null }[];
  facts: { kind: string; statement: string }[];
  missing: string[];
}

const MAX_ENTITIES = 6;

export async function memoryContextFor(
  db: Queryable,
  workspaceId: string,
  entityIds: string[],
): Promise<MemoryContextEntry[]> {
  assertScope(workspaceId, 'memoryContextFor');
  const ids = [...new Set(entityIds)].slice(0, MAX_ENTITIES);
  if (ids.length === 0) return [];

  const entities = await db.rows<{ id: string; display_name: string; entity_type: string; relationship_status: string | null }>(
    `select id, display_name, entity_type, relationship_status
       from public.entities where workspace_id = $1 and id = any($2::uuid[])`,
    [workspaceId, ids],
  );
  const aliases = await db.rows<{ entity_id: string; alias: string; alias_type: string }>(
    `select entity_id, alias, alias_type from public.entity_aliases
      where workspace_id = $1 and entity_id = any($2::uuid[])`,
    [workspaceId, ids],
  );
  const roles = await db.rows<{ person_entity_id: string; organization_entity_id: string; role_title: string | null; person: string; organization: string }>(
    `select a.person_entity_id, a.organization_entity_id, a.role_title, p.display_name as person, o.display_name as organization
       from public.entity_affiliations a
       join public.entities p on p.id = a.person_entity_id
       join public.entities o on o.id = a.organization_entity_id
      where a.workspace_id = $1 and a.is_current
        and (a.person_entity_id = any($2::uuid[]) or a.organization_entity_id = any($2::uuid[]))`,
    [workspaceId, ids],
  );
  const interactions = await db.rows<{ external_entity_id: string; subject: string; occurred_at: string | null }>(
    `select external_entity_id, subject, occurred_at from (
       select i.*, row_number() over (partition by external_entity_id order by occurred_at desc nulls last) as n
         from public.interactions i
        where i.workspace_id = $1 and i.external_entity_id = any($2::uuid[])
     ) ranked where n <= 3`,
    [workspaceId, ids],
  );
  const facts = await db.rows<{ related_entity_id: string; finding_type: string; title: string }>(
    `select related_entity_id, finding_type, title from (
       select f.*, row_number() over (partition by related_entity_id order by created_at desc) as n
         from public.research_findings f
        where f.workspace_id = $1 and f.related_entity_id = any($2::uuid[])
          and f.finding_type in ('fact', 'inference')
     ) ranked where n <= 5`,
    [workspaceId, ids],
  );

  return entities.map((entity) => {
    const own = (rows: { entity_id: string }[]) => rows.filter((r) => r.entity_id === entity.id);
    const entityAliases = own(aliases) as typeof aliases;
    const hasDetails = entityAliases.some((a) => ['email', 'phone', 'linkedin'].includes(a.alias_type));
    const entityRoles = roles
      .filter((r) => r.person_entity_id === entity.id || r.organization_entity_id === entity.id)
      .slice(0, 3)
      .map((r) =>
        r.person_entity_id === entity.id
          ? { role: r.role_title, organization: r.organization }
          : { role: r.role_title ? `${r.role_title} (${r.person})` : r.person, organization: entity.display_name },
      );
    const isPerson = entity.entity_type === 'person';
    const missing = isPerson
      ? [
          entityRoles.length === 0 ? 'organisation' : null,
          entityRoles.every((r) => !r.role) ? 'role' : null,
          !hasDetails ? 'contact details' : null,
        ].filter((m): m is string => m !== null)
      : [];
    return {
      entityId: entity.id,
      name: entity.display_name,
      kind: entity.entity_type,
      // Names only: contact-detail aliases never leave the database here.
      aliases: entityAliases.filter((a) => !['email', 'phone', 'linkedin'].includes(a.alias_type)).slice(0, 5).map((a) => a.alias),
      relationshipStatus: entity.relationship_status,
      roles: entityRoles,
      recentInteractions: interactions
        .filter((i) => i.external_entity_id === entity.id)
        .map((i) => ({ subject: i.subject, date: i.occurred_at ? String(i.occurred_at).slice(0, 10) : null })),
      facts: facts.filter((f) => f.related_entity_id === entity.id).map((f) => ({ kind: f.finding_type, statement: f.title })),
      missing,
    };
  });
}

/** The context as compact text for a model prompt. Data, not instructions. */
export function memoryContextText(entries: MemoryContextEntry[]): string {
  if (entries.length === 0) return 'Memory holds nothing about these names.';
  return entries
    .map((e) =>
      [
        `- ${e.name} (${e.kind}${e.relationshipStatus ? `, relationship: ${e.relationshipStatus}` : ''})`,
        e.aliases.length ? `  also known as: ${e.aliases.join(', ')}` : '',
        e.roles.length ? `  roles: ${e.roles.map((r) => `${r.role ?? 'role unknown'} at ${r.organization}`).join('; ')}` : '',
        e.recentInteractions.length ? `  recent interactions: ${e.recentInteractions.map((i) => `${i.subject}${i.date ? ` (${i.date})` : ''}`).join('; ')}` : '',
        e.facts.length ? `  stored ${e.facts.map((f) => `${f.kind}: ${f.statement}`).join(' | ')}` : '',
        e.missing.length ? `  not yet known: ${e.missing.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n');
}
