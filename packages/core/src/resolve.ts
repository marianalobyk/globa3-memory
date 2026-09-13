/**
 * Entity resolution.
 *
 * The rule this module exists to enforce: only an exact identity match (the
 * canonical slug, or a recorded alias) counts as "this is the same record".
 * Every fuzzy match -- however high the score -- is returned as `ambiguous` and
 * shown to a person. A similar name is never sufficient to merge, and a new or
 * unresolved name is never silently skipped.
 *
 * Scoring runs in TypeScript rather than pg_trgm so behaviour is identical on
 * Supabase and on a local test database, and so the score and the reason can be
 * displayed in the Review screen.
 */
import {
  isPlausibleAcronym,
  nameSimilarity,
  RESOLUTION_THRESHOLDS,
  slugify,
  type EntityCandidate,
  type ResolutionResult,
} from '@g3/shared';
import { assertScope, type Queryable } from './db.js';

/** Beyond this many candidates the prefilter should become a pg_trgm index. */
const MAX_CANDIDATE_SCAN = 5_000;

export type ResolvableType =
  | 'person'
  | 'organization'
  | 'project'
  | 'institution'
  | 'event'
  | 'business_unit'
  | 'artifact'
  | 'source'
  | 'other';

interface EntityRow {
  id: string;
  display_name: string;
  entity_type: string;
  slug: string;
  research_status: string | null;
  relationship_status: string | null;
  description: string | null;
}

export interface ResolveInput {
  name: string;
  /**
   * The expected kind. `'other'` acts as a wildcard: it means the caller could
   * not infer a type, which happens whenever a reference comes from a table that
   * does not carry one (a finding pointing at `related_entity_label`, say). In
   * that case an exact slug or alias match is accepted as-is rather than being
   * reported as a type mismatch, because there is no declared type to conflict
   * with.
   */
  entityType: ResolvableType;
}

export async function resolveEntity(
  db: Queryable,
  workspaceId: string,
  input: ResolveInput,
): Promise<ResolutionResult> {
  assertScope(workspaceId, 'resolveEntity');
  const name = input.name.trim();
  const slug = slugify(name);

  if (name.length === 0) {
    return {
      query: input.name,
      entityType: input.entityType,
      status: 'new',
      best: null,
      candidates: [],
      rationale: 'Empty name; nothing to resolve.',
    };
  }

  // 1. Exact canonical slug. The only path to "existing".
  const exact = await db.one<EntityRow>(
    `select id, display_name, entity_type, slug, research_status, relationship_status, description
       from public.entities
      where workspace_id = $1 and slug = $2
      limit 1`,
    [workspaceId, slug],
  );
  const typeIsWildcard = input.entityType === 'other';

  if (exact) {
    const typeMatches = typeIsWildcard || exact.entity_type === input.entityType;
    const candidate: EntityCandidate = {
      id: exact.id,
      displayName: exact.display_name,
      entityType: exact.entity_type,
      slug: exact.slug,
      similarity: 1,
      matchedVia: 'slug',
      researchStatus: exact.research_status,
      relationshipStatus: exact.relationship_status,
      note: typeMatches ? null : `Stored as ${exact.entity_type}, looked up as ${input.entityType}.`,
    };
    return {
      query: name,
      entityType: input.entityType,
      status: typeMatches ? 'existing' : 'ambiguous',
      best: candidate,
      candidates: [candidate],
      rationale: typeMatches
        ? `Exact slug match on "${slug}"${typeIsWildcard ? ` (stored as ${exact.entity_type}; the reference did not declare a type)` : ''}.`
        : `Exact slug match on "${slug}", but the stored type is ${exact.entity_type} and this reference expects a ${input.entityType}. A person and an organisation can share a name, so this needs confirmation.`,
    };
  }

  // 2. Recorded alias. Also an identity match, because a human recorded it.
  const alias = await db.one<EntityRow & { alias: string }>(
    `select e.id, e.display_name, e.entity_type, e.slug, e.research_status,
            e.relationship_status, e.description, a.alias
       from public.entity_aliases a
       join public.entities e on e.id = a.entity_id
      where a.workspace_id = $1 and a.alias_slug = $2
      limit 1`,
    [workspaceId, slug],
  );
  if (alias) {
    const candidate: EntityCandidate = {
      id: alias.id,
      displayName: alias.display_name,
      entityType: alias.entity_type,
      slug: alias.slug,
      similarity: 1,
      matchedVia: 'alias',
      researchStatus: alias.research_status,
      relationshipStatus: alias.relationship_status,
      note: `Matched the recorded alias "${alias.alias}".`,
    };
    return {
      query: name,
      entityType: input.entityType,
      status: typeIsWildcard || alias.entity_type === input.entityType ? 'existing' : 'ambiguous',
      best: candidate,
      candidates: [candidate],
      rationale: `Recorded alias "${alias.alias}" points at "${alias.display_name}".`,
    };
  }

  // 3. Fuzzy scan over same-type entities in this workspace only.
  const pool = await db.rows<EntityRow>(
    `select id, display_name, entity_type, slug, research_status, relationship_status, description
       from public.entities
      where workspace_id = $1
        and ($2::text is null or entity_type = $2)
        and status <> 'archived'
      limit $3`,
    [workspaceId, typeIsWildcard ? null : input.entityType, MAX_CANDIDATE_SCAN],
  );

  const scored: EntityCandidate[] = [];
  for (const row of pool) {
    const similarity = nameSimilarity(name, row.display_name);
    const acronym =
      isPlausibleAcronym(name, row.display_name) || isPlausibleAcronym(row.display_name, name);
    if (similarity < RESOLUTION_THRESHOLDS.ambiguous && !acronym) continue;
    scored.push({
      id: row.id,
      displayName: row.display_name,
      entityType: row.entity_type,
      slug: row.slug,
      similarity: acronym ? Math.max(similarity, RESOLUTION_THRESHOLDS.ambiguous) : similarity,
      matchedVia: acronym ? 'acronym' : 'name_similarity',
      researchStatus: row.research_status,
      relationshipStatus: row.relationship_status,
      note: acronym ? 'Looks like an initialism of the stored name.' : null,
    });
  }

  // 4. Mentions already staged for this name, so the same uncertainty is not
  //    re-staged every day.
  const mentions = await db.rows<{
    id: string;
    mention_text: string;
    resolution_status: string;
    candidate_entity_id: string | null;
    rationale: string | null;
  }>(
    `select id, mention_text, resolution_status, candidate_entity_id, rationale
       from public.entity_mentions
      where workspace_id = $1 and mention_slug = $2
      order by created_at desc limit 5`,
    [workspaceId, slug],
  );

  scored.sort((a, b) => b.similarity - a.similarity);
  const best = scored[0] ?? null;

  const mentionNote =
    mentions.length > 0
      ? ` A mention of this name is already staged (${mentions[0]?.resolution_status}).`
      : '';

  if (!best) {
    return {
      query: name,
      entityType: input.entityType,
      status: 'new',
      best: null,
      candidates: [],
      rationale:
        `No exact slug or alias match, and no stored ${typeIsWildcard ? 'record' : input.entityType} scored at or above ` +
        `${RESOLUTION_THRESHOLDS.ambiguous}.${mentionNote}`,
    };
  }

  // Deliberately `ambiguous`, never `existing`: a high similarity score is a
  // reason for a person to look, not authority to merge.
  return {
    query: name,
    entityType: input.entityType,
    status: 'ambiguous',
    best,
    candidates: scored.slice(0, 6),
    rationale:
      `Closest stored ${typeIsWildcard ? 'record' : input.entityType} is "${best.displayName}" at ${best.similarity.toFixed(2)} ` +
      `(${best.matchedVia.replace('_', ' ')}). A similar name is not evidence of the same record, ` +
      `so this needs a human decision: link to the existing record, or create a new one.${mentionNote}`,
  };
}

export async function resolveMany(
  db: Queryable,
  workspaceId: string,
  inputs: ResolveInput[],
): Promise<ResolutionResult[]> {
  const results: ResolutionResult[] = [];
  const seen = new Set<string>();
  for (const input of inputs) {
    const key = `${input.entityType}:${slugify(input.name)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(await resolveEntity(db, workspaceId, input));
  }
  return results;
}

/**
 * Finds a business unit by name or slug so proposed records can keep the
 * existing business_units linkage instead of inventing a parallel structure.
 */
export async function resolveBusinessUnit(
  db: Queryable,
  workspaceId: string,
  hint: string | null,
): Promise<{ id: string; name: string } | null> {
  assertScope(workspaceId, 'resolveBusinessUnit');
  if (!hint || hint.trim().length === 0) return null;
  const slug = slugify(hint);
  const direct = await db.one<{ id: string; name: string }>(
    `select id, name from public.business_units
      where workspace_id = $1 and (slug = $2 or lower(name) = lower($3))
      limit 1`,
    [workspaceId, slug, hint.trim()],
  );
  if (direct) return direct;

  const pool = await db.rows<{ id: string; name: string }>(
    `select id, name from public.business_units where workspace_id = $1 limit 500`,
    [workspaceId],
  );
  let best: { id: string; name: string; score: number } | null = null;
  for (const unit of pool) {
    const score = nameSimilarity(hint, unit.name);
    if (score >= RESOLUTION_THRESHOLDS.strong && (!best || score > best.score)) {
      best = { id: unit.id, name: unit.name, score };
    }
  }
  return best ? { id: best.id, name: best.name } : null;
}
