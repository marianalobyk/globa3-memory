/**
 * Building, editing and approving proposals.
 *
 * A proposal is the only route into the knowledge tables. It records, for every
 * change: the operation, the target table, the exact resolved target row, the
 * old and new values, the resolution status with its candidates, the claim type,
 * the provenance and the reason.
 *
 * Version and hash discipline:
 *   - proposal.content_hash is derived from the items' effective values;
 *   - an approval is recorded against a specific (version, content_hash);
 *   - any edit bumps the version, recomputes the hash, revokes outstanding
 *     approvals and resets item decisions to pending.
 * So an approval can never be carried over to content the approver did not see.
 */
import { createHash } from 'node:crypto';
import {
  fieldsToRecord,
  slugify,
  type CaptureProposal,
  type ProposedChange,
  type ResolutionResult,
  type Session,
} from '@g3/shared';
import { requireApproval, requireWorkspace } from './auth.js';
import { assertScope, withService, type Queryable } from './db.js';
import { badRequest, conflict, notFound } from './errors.js';
import { logActivity } from './activity.js';
import { resolveBusinessUnit, resolveEntity, type ResolvableType } from './resolve.js';
import { COLUMN_TYPES, LABEL_REFERENCES, tableSpec } from './proposal-schema.js';

export interface ProposalItemRecord {
  id: string;
  seq: number;
  op: string;
  target_table: string;
  target_id: string | null;
  match_status: string;
  candidates: unknown;
  label: string;
  claim_type: string | null;
  confidence: string | null;
  reason: string | null;
  new_values: Record<string, unknown>;
  old_values: Record<string, unknown> | null;
  edited_values: Record<string, unknown> | null;
  was_edited: boolean;
  provenance: Record<string, unknown>;
  apply_group: number;
  depends_on_seq: number[];
  decision: string;
  applied_at: string | null;
  applied_row_id: string | null;
  apply_error: string | null;
  /**
   * md5(row::text) of the target row when this proposal was built. The apply
   * step puts it in the UPDATE's WHERE clause, so the staleness check and the
   * write are one atomic statement.
   */
  baseline_fingerprint: string | null;
  origin_item_id: string | null;
}

export interface ProposalRecord {
  id: string;
  workspace_id: string;
  run_id: string | null;
  source_kind: string;
  brief_document_id: string | null;
  upload_id: string | null;
  title: string;
  summary: string | null;
  status: string;
  version: number;
  content_hash: string;
  is_mock: boolean;
  created_at: string;
  updated_at: string;
}

/** Values actually written: the edit wins over the original where present. */
export function effectiveValues(item: {
  new_values: Record<string, unknown>;
  edited_values: Record<string, unknown> | null;
}): Record<string, unknown> {
  return { ...item.new_values, ...(item.edited_values ?? {}) };
}

function canonical(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Stable hash over everything an approver is agreeing to. */
export function computeContentHash(
  items: Pick<
    ProposalItemRecord,
    'seq' | 'op' | 'target_table' | 'target_id' | 'new_values' | 'edited_values'
  >[],
): string {
  const payload = items
    .slice()
    .sort((a, b) => a.seq - b.seq)
    .map((i) => ({
      seq: i.seq,
      op: i.op,
      table: i.target_table,
      target: i.target_id,
      values: effectiveValues(i),
    }));
  return createHash('sha256').update(canonical(payload)).digest('hex');
}

function coerce(column: string, value: string | null): unknown {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  switch (COLUMN_TYPES[column]) {
    case 'boolean':
      return /^(true|yes|1)$/i.test(trimmed);
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null;
    case 'timestamptz': {
      const parsed = new Date(trimmed);
      return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
    }
    default:
      return trimmed;
  }
}

const ENTITY_TYPES: ResolvableType[] = [
  'person', 'organization', 'project', 'institution', 'event', 'business_unit', 'artifact', 'source', 'other',
];

function entityTypeOf(value: unknown): ResolvableType {
  return ENTITY_TYPES.includes(value as ResolvableType) ? (value as ResolvableType) : 'other';
}

export interface BuildProposalInput {
  workspaceId: string;
  runId: string | null;
  sourceKind: 'brief' | 'research' | 'upload' | 'manual' | 'capture';
  briefDocumentId?: string | null;
  uploadId?: string | null;
  proposal: CaptureProposal;
  createdBy: string;
  isMock: boolean;
  /** Free-form provenance attached to every item, e.g. the brief it came from. */
  provenance?: Record<string, unknown>;
  /**
   * Add the changes to this existing proposal instead of creating a new one.
   * Items continue its numbering, labels of its not-yet-saved records become
   * dependencies, and the proposal gets a new version and content hash, which
   * revokes any earlier approval: an approval always covers exactly what the
   * approver saw.
   */
  appendTo?: { proposalId: string; reason: string };
  /** A fresh reading of the same source: the proposal it replaces. */
  supersedesProposalId?: string | null;
  /**
   * The capture proposal that asked for this research. Set only on a research
   * result, so a reviewer can be told which capture it came from. The database
   * refuses a parent in another workspace (0023), so this cannot leak across
   * tenants even if a caller passes the wrong id.
   */
  parentProposalId?: string | null;
}

interface PreparedItem {
  seq: number;
  op: string;
  targetTable: string;
  targetId: string | null;
  baselineFingerprint?: string | null;
  originItemId?: string | null;
  matchStatus: 'new' | 'existing' | 'ambiguous';
  candidates: unknown[];
  label: string;
  claimType: string | null;
  confidence: string | null;
  reason: string;
  newValues: Record<string, unknown>;
  oldValues: Record<string, unknown> | null;
  provenance: Record<string, unknown>;
  applyGroup: number;
  dependsOnSeq: number[];
}

/**
 * Turns model-proposed changes into concrete, resolved proposal items.
 *
 * Entity references arrive as labels. Each is resolved against the workspace:
 * an exact match becomes a real foreign key; a reference to another proposed
 * record becomes an ordering dependency; anything else is flagged so the item
 * cannot be applied blindly.
 */
export async function buildProposal(
  db: Queryable,
  input: BuildProposalInput,
): Promise<{ proposalId: string; items: PreparedItem[]; resolutions: ResolutionResult[] }> {
  const workspaceId = assertScope(input.workspaceId, 'buildProposal');
  const changes = input.proposal.changes.filter((c) => c.op !== 'skip');
  const resolutions: ResolutionResult[] = [];

  // Label -> seq of the proposed record that will create it.
  const labelToSeq = new Map<string, number>();
  let seqOffset = 0;
  if (input.appendTo) {
    const existing = await db.rows<{ seq: number; label: string; op: string; applied_at: string | null }>(
      `select seq, label, op, applied_at from public.proposal_items where workspace_id = $1 and proposal_id = $2 order by seq`,
      [workspaceId, input.appendTo.proposalId],
    );
    seqOffset = existing.reduce((max, item) => Math.max(max, item.seq), 0);
    for (const item of existing) {
      // A saved record is found in the database itself; an unsaved one is a dependency.
      if (!item.applied_at && (item.op === 'create' || item.op === 'update')) labelToSeq.set(item.label.toLowerCase(), item.seq);
    }
  }
  changes.forEach((change, index) => {
    if (change.op === 'create') labelToSeq.set(change.label.toLowerCase(), seqOffset + index + 1);
  });

  const prepared: PreparedItem[] = [];

  for (let index = 0; index < changes.length; index += 1) {
    const change = changes[index] as ProposedChange;
    const seq = seqOffset + index + 1;
    const spec = tableSpec(change.target_table);
    const fields = fieldsToRecord(change.fields);

    const newValues: Record<string, unknown> = {};
    const dependsOn = new Set<number>();
    const unresolvedRefs: string[] = [];
    const itemCandidates: unknown[] = [];
    let matchStatus: 'new' | 'existing' | 'ambiguous' = change.op === 'create' ? 'new' : 'existing';
    let targetId: string | null = null;

    // 1. Resolve label references into real foreign keys or dependencies.
    for (const [fieldName, rawValue] of Object.entries(fields)) {
      const reference = LABEL_REFERENCES[fieldName];
      if (!reference) continue;
      if (rawValue === null || rawValue.trim().length === 0) continue;
      const label = rawValue.trim();

      if (reference.kind === 'business_unit') {
        const unit = await resolveBusinessUnit(db, workspaceId, label);
        if (unit) newValues[reference.column] = unit.id;
        else unresolvedRefs.push(`${fieldName}="${label}" (no matching business unit)`);
        continue;
      }

      if (reference.kind === 'entity') {
        const declaredType = entityTypeOf(fields.entity_type ?? fields.proposed_entity_type);
        const guessType: ResolvableType =
          fieldName === 'organization_entity_label'
            ? 'organization'
            : fieldName === 'person_entity_label'
              ? 'person'
              : declaredType;
        const resolution = await resolveEntity(db, workspaceId, { name: label, entityType: guessType });
        resolutions.push(resolution);
        if (resolution.status === 'existing' && resolution.best) {
          newValues[reference.column] = resolution.best.id;
          continue;
        }
        const dependency = labelToSeq.get(label.toLowerCase());
        if (dependency && dependency !== seq) {
          dependsOn.add(dependency);
          // Filled in during apply, once the dependency has a real id.
          newValues[reference.column] = { $ref: { seq: dependency } };
          continue;
        }
        if (resolution.status === 'ambiguous') {
          itemCandidates.push({ field: fieldName, ...resolution });
          unresolvedRefs.push(
            `${fieldName}="${label}" is an ambiguous match (closest: ${resolution.best?.displayName ?? 'none'})`,
          );
        } else {
          unresolvedRefs.push(`${fieldName}="${label}" does not resolve to a stored record`);
        }
        continue;
      }

      // Evidence / artifact / signal / interaction references, by label.
      const dependency = labelToSeq.get(label.toLowerCase());
      if (dependency && dependency !== seq) {
        dependsOn.add(dependency);
        newValues[reference.column] = { $ref: { seq: dependency } };
      } else {
        unresolvedRefs.push(`${fieldName}="${label}" does not match any proposed or stored record`);
      }
    }

    // 2. Copy whitelisted scalar columns.
    for (const [fieldName, rawValue] of Object.entries(fields)) {
      if (LABEL_REFERENCES[fieldName]) continue;
      if (!spec.writable.includes(fieldName)) continue;
      newValues[fieldName] = coerce(fieldName, rawValue);
    }

    // 3. Generate the slug server-side from the label column.
    if (spec.slugColumn && spec.labelColumn) {
      const labelValue = newValues[spec.labelColumn];
      const basis = typeof labelValue === 'string' && labelValue.length > 0 ? labelValue : change.label;
      newValues[spec.slugColumn] = slugify(basis);
    }
    if (change.target_table === 'entity_mentions') {
      const mention = newValues.mention_text;
      newValues.mention_slug = slugify(typeof mention === 'string' ? mention : change.label);
    }

    // 4. For a created entity, check the workspace for an existing record first.
    let oldValues: Record<string, unknown> | null = null;
    let baselineFingerprint: string | null = null;
    if (change.op === 'create' && change.target_table === 'entities') {
      const resolution = await resolveEntity(db, workspaceId, {
        name: String(newValues.display_name ?? change.label),
        entityType: entityTypeOf(newValues.entity_type),
      });
      resolutions.push(resolution);
      itemCandidates.push({ field: 'display_name', ...resolution });
      matchStatus = resolution.status;
      if (resolution.status === 'existing' && resolution.best) {
        // Already stored: propose an update against the real row, not a duplicate.
        targetId = resolution.best.id;
        const snapshot = await loadRowWithFingerprint(db, workspaceId, 'entities', resolution.best.id);
        oldValues = snapshot?.row ?? null;
        baselineFingerprint = snapshot?.fingerprint ?? null;
      }
    }

    if (change.op !== 'create' && change.target_table === 'entities' && !targetId) {
      const resolution = await resolveEntity(db, workspaceId, {
        name: change.label,
        entityType: entityTypeOf(newValues.entity_type),
      });
      resolutions.push(resolution);
      matchStatus = resolution.status;
      if (resolution.best && resolution.status === 'existing') {
        targetId = resolution.best.id;
        const snapshot = await loadRowWithFingerprint(db, workspaceId, 'entities', resolution.best.id);
        oldValues = snapshot?.row ?? null;
        baselineFingerprint = snapshot?.fingerprint ?? null;
      } else {
        itemCandidates.push({ field: 'label', ...resolution });
      }
    }

    // 5. For any other table, a create or link whose natural key already exists
    //    is proposed against that concrete record: a create becomes an update, a
    //    link keeps its operation but gains the target. Either way the approver
    //    sees the real old values and the item carries a baseline, so the apply
    //    step writes exactly what was approved -- or refuses -- and never has to
    //    reinterpret an operation. (Without this, a link to a join row that
    //    already exists could never be applied: apply treats it as a collision.)
    const writesNewRow = change.op === 'create' || change.op === 'link' || change.op === 'attach';
    if (writesNewRow && !targetId && change.target_table !== 'entities') {
      const existing = await findExistingByNaturalKey(db, workspaceId, change.target_table, newValues);
      if (existing) {
        targetId = existing.row.id as string;
        oldValues = existing.row;
        baselineFingerprint = existing.fingerprint;
        matchStatus = 'existing';
      }
    }

    // 6. Missing required column, or an unresolved reference, makes the item
    //    ambiguous: visible, editable, and not applicable as-is.
    const missingRequired = spec.required.filter(
      (column) => newValues[column] === undefined || newValues[column] === null,
    );
    const blockers = [
      ...unresolvedRefs,
      ...missingRequired.map((c) => `required field "${c}" is missing`),
    ];
    if (blockers.length > 0 && matchStatus === 'new') matchStatus = 'ambiguous';

    prepared.push({
      seq,
      op: targetId && change.op === 'create' ? 'update' : change.op,
      targetTable: change.target_table,
      targetId,
      matchStatus,
      candidates: itemCandidates,
      label: change.label,
      claimType: change.claim_type,
      confidence: change.confidence,
      reason:
        blockers.length > 0
          ? `${change.reason} | Needs attention: ${blockers.join('; ')}`
          : change.reason,
      newValues,
      oldValues,
      baselineFingerprint,
      provenance: {
        ...(input.provenance ?? {}),
        source_urls: change.source_urls,
        source_kind: input.sourceKind,
        blockers,
      },
      applyGroup: 1,
      dependsOnSeq: [...dependsOn].sort((a, b) => a - b),
    });
  }

  const contentHash = computeContentHash(
    prepared.map((p) => ({
      seq: p.seq,
      op: p.op,
      target_table: p.targetTable,
      target_id: p.targetId,
      new_values: p.newValues,
      edited_values: null,
    })),
  );

  let proposal: { id: string };
  if (input.appendTo) {
    proposal = { id: input.appendTo.proposalId };
  } else if (input.parentProposalId) {
    // `parent_proposal_id` arrived in migration 0023. Keep ordinary captures
    // and pre-existing research flows runnable until that additive migration is
    // deployed; only capture-originated research requires the parent link.
    proposal = await db.oneOrFail<{ id: string }>(
      `insert into public.proposals
         (workspace_id, run_id, source_kind, brief_document_id, upload_id, title, summary,
          status, version, content_hash, is_mock, created_by, supersedes_proposal_id,
          parent_proposal_id)
       values ($1,$2,$3,$4,$5,$6,$7,'pending_review',1,$8,$9,$10,$11,$12)
       returning id`,
      [
        workspaceId,
        input.runId,
        input.sourceKind,
        input.briefDocumentId ?? null,
        input.uploadId ?? null,
        input.proposal.title,
        input.proposal.summary,
        contentHash,
        input.isMock,
        input.createdBy,
        input.supersedesProposalId ?? null,
        input.parentProposalId,
      ],
    );
  } else {
    proposal = await db.oneOrFail<{ id: string }>(
      `insert into public.proposals
         (workspace_id, run_id, source_kind, brief_document_id, upload_id, title, summary,
          status, version, content_hash, is_mock, created_by, supersedes_proposal_id)
       values ($1,$2,$3,$4,$5,$6,$7,'pending_review',1,$8,$9,$10,$11)
       returning id`,
      [
        workspaceId,
        input.runId,
        input.sourceKind,
        input.briefDocumentId ?? null,
        input.uploadId ?? null,
        input.proposal.title,
        input.proposal.summary,
        contentHash,
        input.isMock,
        input.createdBy,
        input.supersedesProposalId ?? null,
      ],
    );
  }

  for (const item of prepared) {
    await db.query(
      `insert into public.proposal_items
         (workspace_id, proposal_id, seq, op, target_table, target_id, match_status, candidates,
          label, claim_type, confidence, reason, new_values, old_values, provenance,
          apply_group, depends_on_seq, baseline_fingerprint, origin_item_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15::jsonb,$16,$17,$18,$19)`,
      [
        workspaceId,
        proposal.id,
        item.seq,
        item.op,
        item.targetTable,
        item.targetId,
        item.matchStatus,
        JSON.stringify(item.candidates),
        item.label,
        item.claimType,
        item.confidence,
        item.reason,
        JSON.stringify(item.newValues),
        item.oldValues ? JSON.stringify(item.oldValues) : null,
        JSON.stringify(item.provenance),
        item.applyGroup,
        item.dependsOnSeq,
        item.baselineFingerprint ?? null,
        item.originItemId ?? null,
      ],
    );
  }

  if (input.appendTo && prepared.length > 0) {
    await revision(db, workspaceId, proposal.id, input.appendTo.reason);
  }

  return { proposalId: proposal.id, items: prepared, resolutions };
}

export async function loadRow(
  db: Queryable,
  workspaceId: string,
  table: string,
  rowId: string,
): Promise<Record<string, unknown> | null> {
  tableSpec(table);
  const row = await db.one<Record<string, unknown>>(
    `select * from public.${table} where workspace_id = $1 and id = $2`,
    [workspaceId, rowId],
  );
  return row ?? null;
}

/**
 * The row plus the fingerprint of its current contents.
 *
 * The fingerprint is computed by the database over the whole row, so it covers
 * every column without needing an `updated_at` that some of these tables do not
 * have.
 */
function isPendingReference(value: unknown): boolean {
  return typeof value === 'object' && value !== null && '$ref' in value;
}

/**
 * Finds an existing row matching a table's natural key.
 *
 * Used when building a proposal so that a record which already exists is
 * proposed as an update of that concrete record, with its real old values. The
 * apply step then never has to substitute one operation for another -- it either
 * does exactly what was approved, or refuses.
 */
export async function findExistingByNaturalKey(
  db: Queryable,
  workspaceId: string,
  table: string,
  values: Record<string, unknown>,
): Promise<{ row: Record<string, unknown>; fingerprint: string } | null> {
  const spec = tableSpec(table);
  // A key column still holding a { $ref } placeholder points at a record this
  // same proposal has yet to create. A row keyed on something that does not
  // exist yet cannot already be stored, so there is nothing to look up -- and
  // passing the placeholder to SQL as a uuid would fail.
  if (spec.naturalKey.some((column) => isPendingReference(values[column]))) return null;
  const usable = spec.naturalKey.filter(
    (column) => values[column] !== undefined && values[column] !== null,
  );
  if (usable.length === 0) return null;
  const conditions = usable.map((column, i) => `t."${column}" = $${i + 2}`);
  const found = await db.one<Record<string, unknown> & { __fingerprint: string }>(
    `select t.*, md5(t::text) as __fingerprint
       from public.${table} t
      where t.workspace_id = $1 and ${conditions.join(' and ')}
      limit 1`,
    [workspaceId, ...usable.map((column) => values[column])],
  );
  if (!found) return null;
  const { __fingerprint: fingerprint, ...row } = found;
  return { row, fingerprint };
}

export async function loadRowWithFingerprint(
  db: Queryable,
  workspaceId: string,
  table: string,
  rowId: string,
): Promise<{ row: Record<string, unknown>; fingerprint: string } | null> {
  tableSpec(table);
  const found = await db.one<Record<string, unknown> & { __fingerprint: string }>(
    `select t.*, md5(t::text) as __fingerprint
       from public.${table} t where t.workspace_id = $1 and t.id = $2`,
    [workspaceId, rowId],
  );
  if (!found) return null;
  const { __fingerprint: fingerprint, ...row } = found;
  return { row, fingerprint };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function getProposal(
  db: Queryable,
  workspaceId: string,
  proposalId: string,
): Promise<{ proposal: ProposalRecord; items: ProposalItemRecord[] }> {
  assertScope(workspaceId, 'getProposal');
  const proposal = await db.one<ProposalRecord>(
    `select * from public.proposals where workspace_id = $1 and id = $2`,
    [workspaceId, proposalId],
  );
  if (!proposal) throw notFound('Proposal not found');
  const items = await db.rows<ProposalItemRecord>(
    `select * from public.proposal_items where workspace_id = $1 and proposal_id = $2 order by seq`,
    [workspaceId, proposalId],
  );
  return { proposal, items };
}

// ---------------------------------------------------------------------------
// Editing and deciding
// ---------------------------------------------------------------------------

/** Recomputes the hash after a mutation and revokes approvals that no longer apply. */
async function revision(
  db: Queryable,
  workspaceId: string,
  proposalId: string,
  reason: string,
): Promise<{ version: number; contentHash: string }> {
  const items = await db.rows<ProposalItemRecord>(
    `select * from public.proposal_items where workspace_id = $1 and proposal_id = $2 order by seq`,
    [workspaceId, proposalId],
  );
  const contentHash = computeContentHash(items);
  const updated = await db.oneOrFail<{ version: number }>(
    `update public.proposals
        set version = version + 1, content_hash = $3, status = 'pending_review', updated_at = now()
      where workspace_id = $1 and id = $2
      returning version`,
    [workspaceId, proposalId, contentHash],
  );
  await db.query(
    `update public.proposal_approvals
        set revoked_at = now(), revoked_reason = $3
      where workspace_id = $1 and proposal_id = $2 and revoked_at is null`,
    [workspaceId, proposalId, reason],
  );
  return { version: updated.version, contentHash };
}

/**
 * Edits one item's values. This invalidates any prior approval of the proposal
 * and returns every item to pending: an approval always refers to content the
 * approver actually saw.
 */
export async function editProposalItem(
  session: Session,
  workspaceId: string,
  proposalId: string,
  itemId: string,
  edits: Record<string, unknown>,
): Promise<{ version: number; contentHash: string }> {
  requireWorkspace(session, workspaceId);
  return withService(async (db) => {
    const item = await db.one<ProposalItemRecord>(
      `select * from public.proposal_items
        where workspace_id = $1 and proposal_id = $2 and id = $3 for update`,
      [workspaceId, proposalId, itemId],
    );
    if (!item) throw notFound('Proposal item not found');
    if (item.applied_at) throw conflict('This item has already been applied and cannot be edited');

    const spec = tableSpec(item.target_table);
    const sanitized: Record<string, unknown> = {};
    for (const [column, value] of Object.entries(edits)) {
      if (!spec.writable.includes(column)) {
        throw badRequest(`Column "${column}" is not editable on ${item.target_table}`);
      }
      sanitized[column] = typeof value === 'string' ? coerce(column, value) : value;
    }
    if (spec.slugColumn && spec.labelColumn && typeof sanitized[spec.labelColumn] === 'string') {
      sanitized[spec.slugColumn] = slugify(sanitized[spec.labelColumn] as string);
    }

    await db.query(
      `update public.proposal_items
          set edited_values = coalesce(edited_values, '{}'::jsonb) || $4::jsonb,
              was_edited = true,
              decision = 'pending',
              decided_by = null,
              decided_at = null,
              updated_at = now()
        where workspace_id = $1 and proposal_id = $2 and id = $3`,
      [workspaceId, proposalId, itemId, JSON.stringify(sanitized)],
    );
    // Any edit resets the whole proposal, because approval is per version.
    await db.query(
      `update public.proposal_items
          set decision = 'pending', decided_by = null, decided_at = null, updated_at = now()
        where workspace_id = $1 and proposal_id = $2 and applied_at is null`,
      [workspaceId, proposalId],
    );

    const result = await revision(
      db,
      workspaceId,
      proposalId,
      `Item ${item.seq} was edited by ${session.user.email}; prior approval no longer applies.`,
    );
    await logActivity(db, {
      workspaceId,
      actorId: session.user.id,
      action: 'proposal.item_edited',
      subjectTable: 'proposal_items',
      subjectId: itemId,
      summary: `Edited "${item.label}" (${Object.keys(sanitized).join(', ')}); approval revoked.`,
      data: { edits: sanitized, newVersion: result.version },
    });
    return result;
  });
}

export async function decideProposalItems(
  session: Session,
  workspaceId: string,
  proposalId: string,
  decisions: { itemId: string; decision: 'approved' | 'rejected' | 'pending' }[],
): Promise<void> {
  requireApproval(session, workspaceId);
  await withService(async (db) => {
    for (const { itemId, decision } of decisions) {
      const updated = await db.query(
        `update public.proposal_items
            set decision = $4,
                decided_by = case when $4 = 'pending' then null else $5::uuid end,
                decided_at = case when $4 = 'pending' then null else now() end,
                updated_at = now()
          where workspace_id = $1 and proposal_id = $2 and id = $3 and applied_at is null`,
        [workspaceId, proposalId, itemId, decision, session.user.id],
      );
      if (updated.rowCount === 0) {
        throw conflict('Item not found, or it has already been applied');
      }
    }
    await logActivity(db, {
      workspaceId,
      actorId: session.user.id,
      action: 'proposal.items_decided',
      subjectTable: 'proposals',
      subjectId: proposalId,
      summary: `${decisions.filter((d) => d.decision === 'approved').length} approved, ${decisions.filter((d) => d.decision === 'rejected').length} rejected.`,
      data: { decisions },
    });
  });
}

export interface ApprovalRecord {
  id: string;
  proposal_version: number;
  content_hash: string;
  item_ids: string[];
  approved_by: string;
  approved_at: string;
  revoked_at: string | null;
}

/**
 * Records an explicit approval of specific items at the proposal's current
 * version and hash. Partial approval is normal: only the listed items become
 * applicable.
 */
export async function recordApproval(
  session: Session,
  workspaceId: string,
  proposalId: string,
  itemIds: string[],
): Promise<ApprovalRecord> {
  requireApproval(session, workspaceId);
  if (itemIds.length === 0) throw badRequest('Approve at least one item');

  return withService(async (db) => {
    const proposal = await db.one<ProposalRecord>(
      `select * from public.proposals where workspace_id = $1 and id = $2 for update`,
      [workspaceId, proposalId],
    );
    if (!proposal) throw notFound('Proposal not found');

    const items = await db.rows<ProposalItemRecord>(
      `select * from public.proposal_items where workspace_id = $1 and proposal_id = $2 order by seq`,
      [workspaceId, proposalId],
    );

    // The hash must still describe what is in the database right now.
    const currentHash = computeContentHash(items);
    if (currentHash !== proposal.content_hash) {
      throw conflict(
        'This proposal changed since it was loaded. Reload it and review the current values before approving.',
        { expected: proposal.content_hash, actual: currentHash },
      );
    }

    const byId = new Map(items.map((i) => [i.id, i]));
    for (const id of itemIds) {
      const item = byId.get(id);
      if (!item) throw badRequest(`Item ${id} is not part of this proposal`);
      if (item.decision !== 'approved') {
        throw conflict(`Item ${item.seq} ("${item.label}") is not marked approved`);
      }
      // Approving an item requires its dependencies to be approved too, or
      // already applied, otherwise the transactional group cannot succeed.
      for (const dependencySeq of item.depends_on_seq) {
        const dependency = items.find((i) => i.seq === dependencySeq);
        if (!dependency) continue;
        const satisfied =
          dependency.applied_at !== null ||
          (dependency.decision === 'approved' && itemIds.includes(dependency.id));
        if (!satisfied) {
          throw conflict(
            `Item ${item.seq} ("${item.label}") depends on item ${dependencySeq} ("${dependency.label}"), which is not approved. Approve both or neither.`,
          );
        }
      }
    }

    const approval = await db.oneOrFail<ApprovalRecord>(
      `insert into public.proposal_approvals
         (workspace_id, proposal_id, proposal_version, content_hash, item_ids, approved_by)
       values ($1,$2,$3,$4,$5,$6)
       returning id, proposal_version, content_hash, item_ids, approved_by, approved_at, revoked_at`,
      [workspaceId, proposalId, proposal.version, proposal.content_hash, itemIds, session.user.id],
    );

    await logActivity(db, {
      workspaceId,
      actorId: session.user.id,
      action: 'proposal.approved',
      subjectTable: 'proposals',
      subjectId: proposalId,
      summary: `Approved ${itemIds.length} item(s) at version ${proposal.version}.`,
      data: { approvalId: approval.id, version: proposal.version, itemIds },
    });
    return approval;
  });
}

export async function rejectProposal(
  session: Session,
  workspaceId: string,
  proposalId: string,
  reason: string,
): Promise<void> {
  requireApproval(session, workspaceId);
  await withService(async (db) => {
    await db.query(
      `update public.proposal_items
          set decision = 'rejected', decided_by = $3, decided_at = now(), updated_at = now()
        where workspace_id = $1 and proposal_id = $2 and applied_at is null`,
      [workspaceId, proposalId, session.user.id],
    );
    await db.query(
      `update public.proposals set status = 'rejected', updated_at = now()
        where workspace_id = $1 and id = $2`,
      [workspaceId, proposalId],
    );
    await db.query(
      `update public.proposal_approvals set revoked_at = now(), revoked_reason = $3
        where workspace_id = $1 and proposal_id = $2 and revoked_at is null`,
      [workspaceId, proposalId, 'Proposal rejected'],
    );
    await logActivity(db, {
      workspaceId,
      actorId: session.user.id,
      action: 'proposal.rejected',
      subjectTable: 'proposals',
      subjectId: proposalId,
      summary: reason || 'Proposal rejected.',
      data: { reason },
    });
  });
}

// ---------------------------------------------------------------------------
// Superseding a proposal that can no longer be applied as approved
// ---------------------------------------------------------------------------

/**
 * Why an approved item could not be applied exactly as approved.
 *
 * Each of these is a case where the old code quietly changed the operation --
 * turning an approved `create` into an `update`, or an approved `update` into a
 * `create`. That silently writes something the approver never agreed to, so it
 * is now refused and turned into a new proposal instead.
 */
export type ApplyConflictKind =
  | 'create_collides_with_existing'
  | 'update_target_missing'
  | 'target_changed'
  /** Update or link against an existing row, but no baseline was ever captured. */
  | 'baseline_missing';

export interface ApplyConflict {
  itemId: string;
  seq: number;
  label: string;
  table: string;
  approvedOp: string;
  kind: ApplyConflictKind;
  message: string;
  /** The concrete row the replacement item should target, when there is one. */
  existingRowId: string | null;
  /** The row as it looks now, which becomes the replacement's old values. */
  currentValues: Record<string, unknown> | null;
  currentFingerprint: string | null;
  /** The values the approver approved, carried into the replacement unchanged. */
  approvedValues: Record<string, unknown>;
  replacementOp: 'create' | 'update';
}

export interface SupersedeResult {
  proposalId: string;
  itemCount: number;
  conflictCount: number;
}

/**
 * Builds a replacement for a proposal whose approved operations no longer match
 * reality, and marks the original superseded.
 *
 * The replacement carries every item that was still outstanding. Conflicting
 * items are rewritten to the operation that is now correct, pointed at the
 * concrete row, and given that row's current values as their old values -- so
 * the approver sees exactly what would change, against what is actually stored,
 * and approves that.
 *
 * Runs in its own transaction, after the failed apply has rolled back.
 */
export async function supersedeProposal(
  db: Queryable,
  input: {
    workspaceId: string;
    proposalId: string;
    conflicts: ApplyConflict[];
    actorId: string;
  },
): Promise<SupersedeResult> {
  const workspaceId = assertScope(input.workspaceId, 'supersedeProposal');

  const original = await db.one<ProposalRecord>(
    `select * from public.proposals where workspace_id = $1 and id = $2 for update`,
    [workspaceId, input.proposalId],
  );
  if (!original) throw notFound('Proposal not found');

  // If a replacement already exists for this proposal, reuse it rather than
  // stacking a new one on every retry.
  const existing = await db.one<{ id: string }>(
    `select id from public.proposals
      where workspace_id = $1 and supersedes_proposal_id = $2 and status = 'pending_review'
      order by created_at desc limit 1`,
    [workspaceId, input.proposalId],
  );
  if (existing) {
    const count = await db.oneOrFail<{ n: number }>(
      `select count(*)::int as n from public.proposal_items where proposal_id = $1`,
      [existing.id],
    );
    return { proposalId: existing.id, itemCount: count.n, conflictCount: input.conflicts.length };
  }

  // All items, including applied and rejected ones: applied items are needed to
  // resolve references to rows that already exist.
  const allItems = await db.rows<ProposalItemRecord>(
    `select * from public.proposal_items
      where workspace_id = $1 and proposal_id = $2
      order by seq`,
    [workspaceId, input.proposalId],
  );
  const items = allItems.filter((i) => i.applied_at === null && i.decision !== 'rejected');
  const appliedRowBySeq = new Map(
    allItems.filter((i) => i.applied_row_id).map((i) => [i.seq, i.applied_row_id as string]),
  );

  /**
   * Carries values and dependencies into the replacement.
   *
   * Seq numbers are preserved, so every { $ref: { seq } } and depends_on_seq
   * entry still points at the item it meant. A reference to an item that was
   * already applied is resolved to that row's real id, because that item is not
   * carried over and its row genuinely exists. Nothing else is resolved: ids
   * substituted during a failed apply belonged to rows the rollback removed.
   */
  const carry = (values: Record<string, unknown>, dependsOn: number[]) => {
    const out: Record<string, unknown> = {};
    for (const [column, value] of Object.entries(values)) {
      const ref = (value as { $ref?: { seq?: number } } | null)?.$ref;
      if (ref && typeof ref.seq === 'number' && appliedRowBySeq.has(ref.seq)) {
        out[column] = appliedRowBySeq.get(ref.seq);
      } else {
        out[column] = value;
      }
    }
    return { values: out, dependsOn: dependsOn.filter((seq) => !appliedRowBySeq.has(seq)) };
  };

  const conflictByItem = new Map(input.conflicts.map((c) => [c.itemId, c]));

  const replacement = await db.oneOrFail<{ id: string }>(
    `insert into public.proposals
       (workspace_id, run_id, source_kind, brief_document_id, upload_id, title, summary,
        status, version, content_hash, is_mock, created_by, supersedes_proposal_id)
     values ($1,$2,$3,$4,$5,$6,$7,'pending_review',1,'pending',$8,$9,$10)
     returning id`,
    [
      workspaceId,
      original.run_id,
      original.source_kind,
      original.brief_document_id,
      original.upload_id,
      `${original.title} (revised after conflict)`,
      `Replaces an approved proposal that could no longer be applied as approved: ${input.conflicts
        .map((c) => `"${c.label}" ${c.kind.replace(/_/g, ' ')}`)
        .join('; ')}. Review the current values and approve again.`,
      original.is_mock,
      input.actorId,
      original.id,
    ],
  );

  const insertItem = `insert into public.proposal_items
       (workspace_id, proposal_id, seq, op, target_table, target_id, match_status, candidates,
        label, claim_type, confidence, reason, new_values, old_values, provenance,
        apply_group, depends_on_seq, baseline_fingerprint, origin_item_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15::jsonb,$16,$17,$18,$19)`;

  for (const item of items) {
    const clash = conflictByItem.get(item.id);

    if (!clash) {
      // Carried over. If it targets a row, both the old values AND the baseline
      // are taken from the row as it is now, so what the next approver sees and
      // what the guard checks are the same state. (Refreshing only the
      // fingerprint would show stale old values against a fresh baseline.)
      const carried = carry(effectiveValues(item), item.depends_on_seq);
      let oldValues = item.old_values;
      let fingerprint = item.baseline_fingerprint;
      if (item.target_id) {
        const snapshot = await loadRowWithFingerprint(db, workspaceId, item.target_table, item.target_id);
        oldValues = snapshot?.row ?? null;
        fingerprint = snapshot?.fingerprint ?? null;
      }
      await db.query(insertItem, [
        workspaceId, replacement.id, item.seq, item.op, item.target_table, item.target_id,
        item.match_status, JSON.stringify(item.candidates), item.label, item.claim_type,
        item.confidence, item.reason,
        JSON.stringify(carried.values),
        oldValues ? JSON.stringify(oldValues) : null,
        JSON.stringify(item.provenance), item.apply_group, carried.dependsOn,
        fingerprint, item.id,
      ]);
      continue;
    }

    const reason =
      clash.kind === 'create_collides_with_existing'
        ? clash.replacementOp === 'update'
          ? `Approved as a new record, but a matching record already exists. Rewritten as an update of that record so the change is against what is actually stored. ${clash.message}`
          : `Approved as a new record, but it collided with another record while saving. ${clash.message}`
        : clash.kind === 'update_target_missing'
          ? `Approved as an update, but the target record no longer exists. Rewritten as a create. ${clash.message}`
          : clash.kind === 'baseline_missing'
            ? `Approved without a snapshot of the record, so it could not be applied safely. The old values below are the values stored now; approve them explicitly. ${clash.message}`
            : `The target record changed after this was approved. The old values below are the current stored values. ${clash.message}`;

    const carried = carry(clash.approvedValues, item.depends_on_seq);
    await db.query(insertItem, [
      workspaceId,
      replacement.id,
      item.seq,
      clash.replacementOp,
      clash.table,
      clash.existingRowId,
      clash.existingRowId ? 'existing' : 'new',
      JSON.stringify(item.candidates),
      item.label,
      item.claim_type,
      item.confidence,
      reason,
      JSON.stringify(carried.values),
      clash.currentValues ? JSON.stringify(clash.currentValues) : null,
      JSON.stringify({
        ...item.provenance,
        superseded_from_item: item.id,
        conflict_kind: clash.kind,
        conflict_message: clash.message,
      }),
      item.apply_group,
      carried.dependsOn,
      // The fingerprint of the row as it is NOW. It belongs to this new,
      // unapproved proposal; the original approval was revoked and is not
      // transferred.
      clash.currentFingerprint,
      item.id,
    ]);
  }

  // Hash the replacement over what it actually holds.
  const newItems = await db.rows<ProposalItemRecord>(
    `select * from public.proposal_items where workspace_id = $1 and proposal_id = $2 order by seq`,
    [workspaceId, replacement.id],
  );
  await db.query(
    `update public.proposals set content_hash = $3, updated_at = now()
      where workspace_id = $1 and id = $2`,
    [workspaceId, replacement.id, computeContentHash(newItems)],
  );

  // Close the original, and revoke approvals that can never be applied now.
  await db.query(
    `update public.proposals
        set status = 'superseded',
            superseded_by_proposal_id = $3,
            superseded_reason = $4,
            updated_at = now()
      where workspace_id = $1 and id = $2`,
    [
      workspaceId,
      input.proposalId,
      replacement.id,
      `${input.conflicts.length} approved item(s) no longer matched the stored data.`,
    ],
  );
  await db.query(
    `update public.proposal_approvals set revoked_at = now(), revoked_reason = $3
      where workspace_id = $1 and proposal_id = $2 and revoked_at is null`,
    [workspaceId, input.proposalId, 'Superseded: the approved changes no longer matched the stored data.'],
  );

  await logActivity(db, {
    workspaceId,
    actorId: input.actorId,
    action: 'proposal.superseded',
    subjectTable: 'proposals',
    subjectId: input.proposalId,
    summary: `Refused to apply ${input.conflicts.length} approved item(s) that no longer matched the stored data; created a replacement proposal for re-approval.`,
    data: {
      replacementProposalId: replacement.id,
      conflicts: input.conflicts.map((c) => ({
        label: c.label,
        table: c.table,
        approvedOp: c.approvedOp,
        kind: c.kind,
        replacementOp: c.replacementOp,
        existingRowId: c.existingRowId,
      })),
    },
  });

  return { proposalId: replacement.id, itemCount: newItems.length, conflictCount: input.conflicts.length };
}
