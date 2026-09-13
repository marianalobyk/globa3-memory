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
  sourceKind: 'brief' | 'research' | 'upload' | 'manual';
  briefDocumentId?: string | null;
  uploadId?: string | null;
  proposal: CaptureProposal;
  createdBy: string;
  isMock: boolean;
  /** Free-form provenance attached to every item, e.g. the brief it came from. */
  provenance?: Record<string, unknown>;
}

interface PreparedItem {
  seq: number;
  op: string;
  targetTable: string;
  targetId: string | null;
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
  changes.forEach((change, index) => {
    if (change.op === 'create') labelToSeq.set(change.label.toLowerCase(), index + 1);
  });

  const prepared: PreparedItem[] = [];

  for (let index = 0; index < changes.length; index += 1) {
    const change = changes[index] as ProposedChange;
    const seq = index + 1;
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
        oldValues = await loadRow(db, workspaceId, 'entities', resolution.best.id);
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
        oldValues = await loadRow(db, workspaceId, 'entities', resolution.best.id);
      } else {
        itemCandidates.push({ field: 'label', ...resolution });
      }
    }

    // 5. Missing required column, or an unresolved reference, makes the item
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

  const proposal = await db.oneOrFail<{ id: string }>(
    `insert into public.proposals
       (workspace_id, run_id, source_kind, brief_document_id, upload_id, title, summary,
        status, version, content_hash, is_mock, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,'pending_review',1,$8,$9,$10)
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
    ],
  );

  for (const item of prepared) {
    await db.query(
      `insert into public.proposal_items
         (workspace_id, proposal_id, seq, op, target_table, target_id, match_status, candidates,
          label, claim_type, confidence, reason, new_values, old_values, provenance,
          apply_group, depends_on_seq)
       values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15::jsonb,$16,$17)`,
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
      ],
    );
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
