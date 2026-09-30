/**
 * Applying approved proposal items.
 *
 * This is the only code path that writes to the knowledge tables, and it is
 * server-side only: a signed-in user has no INSERT privilege on those tables at
 * all (see migration 0007), so this is not a convention but an enforced boundary.
 *
 * Guarantees, in order of how they are enforced:
 *
 *   1. Permission -- the caller must hold approval capability in the workspace.
 *   2. Approved version -- a live approval must exist for the proposal's current
 *      (version, content_hash). Any edit revokes approvals, so an approval can
 *      never be applied to content the approver did not see.
 *   3. Idempotency -- applied_changes has a unique constraint on
 *      proposal_item_id, so a repeated request cannot write a second row. An
 *      already-applied item is reported as `already_applied`, not duplicated.
 *   4. Transactional -- all requested items are applied in one transaction in
 *      dependency order. If any one fails or conflicts, nothing is written.
 *   5. The approved operation is the operation performed. An approved `create`
 *      inserts a new record or refuses; it is never turned into an update of a
 *      record the approver never saw. An approved `update` updates the record it
 *      was approved against or refuses; it is never turned into a create that
 *      would resurrect a deleted record. When the approved operation no longer
 *      matches reality, the apply is refused and a replacement proposal is
 *      generated -- targeting the concrete record, carrying its current values as
 *      the old values -- so the change is approved again against what is really
 *      stored.
 *   6. No lost updates -- an update carries the fingerprint its target row had
 *      when the proposal was built, and that fingerprint is part of the UPDATE's
 *      WHERE clause. The check and the write are therefore a single atomic
 *      statement: if another user changed the row in between, zero rows match,
 *      nothing is overwritten, and the item becomes a conflict. The fingerprint
 *      is required: an update or link without one (a proposal built before
 *      migration 0011) is refused as `baseline_missing`, never applied
 *      unguarded, and the current fingerprint is never substituted for it.
 *      A unique violation from a concurrent create aborts the transaction; the
 *      colliding row is identified after the rollback, in a fresh transaction.
 *   7. Readback -- every written row is read back from the database and the
 *      actual stored values are returned and recorded.
 */
import type { Session } from '@g3/shared';
import { requireApproval } from './auth.js';
import { assertScope, isUniqueViolation, withService, type Queryable } from './db.js';
import { conflict, notFound } from './errors.js';
import { logActivity } from './activity.js';
import { resolveEntity, type ResolvableType } from './resolve.js';
import { tableSpec } from './proposal-schema.js';
import {
  computeContentHash,
  effectiveValues,
  loadRowWithFingerprint,
  supersedeProposal,
  type ApplyConflict,
  type ProposalItemRecord,
  type ProposalRecord,
} from './proposals.js';

export interface AppliedItemResult {
  itemId: string;
  seq: number;
  label: string;
  table: string;
  op: string;
  status: 'applied' | 'already_applied' | 'skipped';
  rowId: string | null;
  /** Values read back out of the database after the write. */
  readback: Record<string, unknown> | null;
  readbackOk: boolean;
  note: string | null;
}

export interface ApplyResult {
  proposalId: string;
  proposalVersion: number;
  applied: AppliedItemResult[];
  proposalStatus: string;
  /** Human-readable confirmation of what now exists. */
  readbackSummary: string[];
}

interface RefPlaceholder {
  $ref: { seq: number };
}

function isRef(value: unknown): value is RefPlaceholder {
  return (
    typeof value === 'object' &&
    value !== null &&
    '$ref' in value &&
    typeof (value as RefPlaceholder).$ref?.seq === 'number'
  );
}

/** Orders items so a dependency is always applied before the item needing it. */
function topologicalOrder(items: ProposalItemRecord[]): ProposalItemRecord[] {
  const bySeq = new Map(items.map((i) => [i.seq, i]));
  const ordered: ProposalItemRecord[] = [];
  const state = new Map<number, 'visiting' | 'done'>();

  const visit = (item: ProposalItemRecord, trail: number[]): void => {
    const current = state.get(item.seq);
    if (current === 'done') return;
    if (current === 'visiting') {
      throw conflict(
        `Proposal items form a dependency cycle: ${[...trail, item.seq].join(' -> ')}`,
      );
    }
    state.set(item.seq, 'visiting');
    for (const dependencySeq of item.depends_on_seq ?? []) {
      const dependency = bySeq.get(dependencySeq);
      if (dependency) visit(dependency, [...trail, item.seq]);
    }
    state.set(item.seq, 'done');
    ordered.push(item);
  };

  for (const item of items.slice().sort((a, b) => a.seq - b.seq)) visit(item, []);
  return ordered;
}

const ENTITY_TYPES: ResolvableType[] = [
  'person', 'organization', 'project', 'institution', 'event', 'business_unit', 'artifact', 'source', 'other',
];

async function insertRow(
  db: Queryable,
  workspaceId: string,
  table: string,
  values: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const columns = ['workspace_id', ...Object.keys(values)];
  const params: unknown[] = [workspaceId, ...Object.values(values)];
  const placeholders = columns.map((_, i) => `$${i + 1}`);
  const row = await db.oneOrFail<Record<string, unknown>>(
    `insert into public.${table} (${columns.map((c) => `"${c}"`).join(', ')})
     values (${placeholders.join(', ')})
     returning *`,
    params,
  );
  return row;
}

/**
 * Updates a row, guarded by the fingerprint it had when the proposal was built.
 *
 * The guard lives in the WHERE clause, so the staleness check and the write are
 * a single atomic statement. There is no window between "we checked" and "we
 * wrote" in which another user's change could be lost: if the row moved, zero
 * rows match and nothing is written.
 *
 * Returns null when the guard did not match, so the caller can tell "changed
 * underneath us" apart from "never existed".
 */
async function updateRowGuarded(
  db: Queryable,
  workspaceId: string,
  table: string,
  rowId: string,
  values: Record<string, unknown>,
  baselineFingerprint: string,
): Promise<Record<string, unknown> | null> {
  // There is deliberately no unguarded variant. An empty baseline used to mean
  // "skip the check", which silently re-opened lost updates for every proposal
  // built before migration 0011. Callers must refuse an item without a baseline
  // before they get here.
  if (!baselineFingerprint) {
    throw new Error('updateRowGuarded requires a baseline fingerprint');
  }
  const entries = Object.entries(values);

  if (entries.length === 0) {
    // Nothing to write, but the guard must still hold for the item to count as
    // applied against the row the approver saw.
    const existing = await db.one<Record<string, unknown>>(
      `select t.* from public.${table} t
        where t.workspace_id = $1 and t.id = $2 and md5(t::text) = $3`,
      [workspaceId, rowId, baselineFingerprint],
    );
    return existing ?? null;
  }

  const assignments = entries.map(([column], i) => `"${column}" = $${i + 3}`);
  const row = await db.one<Record<string, unknown>>(
    `update public.${table} t set ${assignments.join(', ')}
      where t.workspace_id = $1 and t.id = $2 and md5(t::text) = $${entries.length + 3}
      returning *`,
    [workspaceId, rowId, ...entries.map(([, value]) => value), baselineFingerprint],
  );
  return row ?? null;
}

/**
 * An approved create that collides with a record that exists now. The
 * replacement targets that concrete record, with its current values as the old
 * values, so the approver decides against what is actually stored.
 *
 * approvedValues is the item's own effective values, with any { $ref }
 * placeholders left intact. The substituted values from the failed apply must
 * not be used: they can hold ids of rows created earlier in the same
 * transaction, which the rollback has just removed.
 */
async function describeCollision(
  db: Queryable,
  workspaceId: string,
  item: ProposalItemRecord,
  existingRowId: string | null,
  message: string,
): Promise<ApplyConflict> {
  const snapshot = existingRowId
    ? await loadRowWithFingerprint(db, workspaceId, item.target_table, existingRowId)
    : null;
  const identified = snapshot !== null;
  return {
    itemId: item.id,
    seq: item.seq,
    label: item.label,
    table: item.target_table,
    approvedOp: item.op,
    kind: 'create_collides_with_existing',
    message: identified
      ? message
      : `${message} The colliding record could not be identified, so the replacement keeps this as a create for you to review.`,
    existingRowId: identified ? existingRowId : null,
    currentValues: snapshot?.row ?? null,
    currentFingerprint: snapshot?.fingerprint ?? null,
    approvedValues: effectiveValues(item),
    replacementOp: identified ? 'update' : 'create',
  };
}

/**
 * An update (or a link to an existing row) that carries no baseline fingerprint.
 *
 * Proposals built before migration 0011 have none. Without it there is no way
 * to know whether the row still looks the way the approver saw it, so the item
 * is refused. The replacement captures the row as it is now -- values and
 * fingerprint -- as a NEW proposal that needs a new approval. The current
 * fingerprint is never slipped under the old approval.
 */
async function describeBaselineMissing(
  db: Queryable,
  workspaceId: string,
  item: ProposalItemRecord,
  targetId: string,
): Promise<ApplyConflict> {
  const snapshot = await loadRowWithFingerprint(db, workspaceId, item.target_table, targetId);
  return {
    itemId: item.id,
    seq: item.seq,
    label: item.label,
    table: item.target_table,
    approvedOp: item.op,
    kind: 'baseline_missing',
    message:
      'This proposal was prepared without a snapshot of the record, so there is no way to tell whether someone changed it since. Nothing was written.',
    existingRowId: targetId,
    currentValues: snapshot?.row ?? null,
    currentFingerprint: snapshot?.fingerprint ?? null,
    approvedValues: effectiveValues(item),
    replacementOp: 'update',
  };
}

/** An approved update whose target moved after the proposal was built. */
async function describeStaleTarget(
  db: Queryable,
  workspaceId: string,
  item: ProposalItemRecord,
  targetId: string,
): Promise<ApplyConflict> {
  const snapshot = await loadRowWithFingerprint(db, workspaceId, item.target_table, targetId);
  return {
    itemId: item.id,
    seq: item.seq,
    label: item.label,
    table: item.target_table,
    approvedOp: item.op,
    kind: 'target_changed',
    message:
      'The record changed after this proposal was built, so applying the approved values would have overwritten someone else\'s edit. Nothing was written.',
    existingRowId: targetId,
    currentValues: snapshot?.row ?? null,
    currentFingerprint: snapshot?.fingerprint ?? null,
    approvedValues: effectiveValues(item),
    replacementOp: 'update',
  };
}

/**
 * Inserts a new row. A unique violation here means a concurrent transaction
 * committed a matching record between our checks and our write.
 *
 * The violation has already aborted this transaction, so no further query can
 * run in it (25P02). Instead of trying to recover in place, the whole apply is
 * aborted and the colliding row is identified afterwards, in a fresh
 * transaction, from the violated constraint. A savepoint would also work on real
 * Postgres, but it is not reliable on the local PGlite test server, and the
 * post-rollback route behaves identically on both.
 */
async function insertOrSignalCollision(
  db: Queryable,
  workspaceId: string,
  item: ProposalItemRecord,
  values: Record<string, unknown>,
  conflicts: ApplyConflict[],
): Promise<Record<string, unknown>> {
  try {
    return await insertRow(db, workspaceId, item.target_table, values);
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const approved = effectiveValues(item);
    const lookupValues = Object.fromEntries(
      Object.entries(values).filter(([column]) => !isRef(approved[column])),
    );
    throw new ConflictingApply(conflicts, {
      item,
      constraint: (error as { constraint?: string }).constraint ?? null,
      lookupValues,
    });
  }
}

/**
 * Finds the row that made an INSERT fail with a unique violation, from the name
 * of the violated constraint.
 *
 * Runs AFTER the failed transaction has rolled back, in a fresh one. The
 * natural-key lookup alone is not enough, because the violated index is not
 * always the natural key (for example the one-pending-mention-per-name index on
 * entity_mentions).
 */
async function findByViolatedConstraint(
  db: Queryable,
  workspaceId: string,
  table: string,
  constraint: string | null,
  values: Record<string, unknown>,
): Promise<string | null> {
  tableSpec(table);
  if (constraint) {
    const columns = await db.rows<{ attname: string; predicate: string | null }>(
      `select a.attname, pg_get_expr(i.indpred, i.indrelid) as predicate
         from pg_index i
         join pg_class ic on ic.oid = i.indexrelid
         join pg_class tc on tc.oid = i.indrelid
         join pg_namespace n on n.oid = tc.relnamespace
         join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
        where n.nspname = 'public' and tc.relname = $1 and ic.relname = $2`,
      [table, constraint],
    );
    if (columns.length > 0) {
      const conditions: string[] = [];
      const params: unknown[] = [];
      let resolvable = true;
      for (const { attname } of columns) {
        const value = attname === 'workspace_id' ? workspaceId : values[attname];
        if (value === undefined || value === null || isRef(value)) {
          resolvable = false;
          break;
        }
        params.push(value);
        conditions.push(`t."${attname}" = $${params.length}`);
      }
      if (resolvable) {
        // The index predicate comes from the system catalog, not from input.
        const predicate = columns[0]?.predicate ? ` and (${columns[0].predicate})` : '';
        const row = await db.one<{ id: string }>(
          `select t.id from public.${table} t where ${conditions.join(' and ')}${predicate} limit 1`,
          params,
        );
        if (row) return row.id;
      }
    }
  }
  const byKey = await findByNaturalKey(db, workspaceId, table, values);
  return (byKey?.id as string | undefined) ?? null;
}

/** Finds an existing row matching the natural key. */
async function findByNaturalKey(
  db: Queryable,
  workspaceId: string,
  table: string,
  values: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const spec = tableSpec(table);
  // Defensive: references are substituted before this is called, but an
  // unsubstituted placeholder must never reach SQL as a uuid.
  if (spec.naturalKey.some((column) => isRef(values[column]))) return null;
  const usable = spec.naturalKey.filter(
    (column) => values[column] !== undefined && values[column] !== null,
  );
  if (usable.length === 0) return null;
  const conditions = usable.map((column, i) => `"${column}" = $${i + 2}`);
  return (
    (await db.one<Record<string, unknown>>(
      `select * from public.${table}
        where workspace_id = $1 and ${conditions.join(' and ')}
        limit 1`,
      [workspaceId, ...usable.map((column) => values[column])],
    )) ?? null
  );
}

/**
 * Internal signal used to abort the apply transaction while carrying the
 * conflicts out with it. Never surfaces to a caller: applyApprovedItems catches
 * it, builds the replacement proposal, and throws a 409 instead.
 */
interface PendingCollision {
  item: ProposalItemRecord;
  constraint: string | null;
  /**
   * Substituted values, minus any column whose approved value was a { $ref }:
   * those ids belonged to rows the rollback has removed, so they cannot identify
   * anything.
   */
  lookupValues: Record<string, unknown>;
}

class ConflictingApply extends Error {
  constructor(
    readonly conflicts: ApplyConflict[],
    readonly pendingCollision: PendingCollision | null = null,
  ) {
    super('Approved changes no longer match the stored data');
    this.name = 'ConflictingApply';
  }
}

export interface ApplyInput {
  session: Session;
  workspaceId: string;
  proposalId: string;
  /**
   * The version the client believes it approved. A mismatch means the proposal
   * changed underneath, and the request is refused rather than guessed at.
   */
  expectedVersion: number;
  itemIds: string[];
  runId?: string | null;
}

export async function applyApprovedItems(input: ApplyInput): Promise<ApplyResult> {
  const workspaceId = assertScope(input.workspaceId, 'applyApprovedItems');
  requireApproval(input.session, workspaceId);

  try {
    return await runApply(input, workspaceId);
  } catch (error) {
    if (!(error instanceof ConflictingApply)) throw error;

    // The apply transaction has rolled back, so nothing was written. Everything
    // from here runs in a fresh transaction: identifying a record that collided
    // on insert, and building the replacement proposal.
    const conflicts = [...error.conflicts];
    const replacement = await withService(async (db) => {
      if (error.pendingCollision) {
        const { item, constraint, lookupValues } = error.pendingCollision;
        const existingId = await findByViolatedConstraint(
          db, workspaceId, item.target_table, constraint, lookupValues,
        );
        conflicts.push(
          await describeCollision(
            db, workspaceId, item, existingId,
            'Another change created a matching record at the same moment.',
          ),
        );
      }
      return supersedeProposal(db, {
        workspaceId,
        proposalId: input.proposalId,
        conflicts,
        actorId: input.session.user.id,
      });
    });
    error.conflicts.splice(0, error.conflicts.length, ...conflicts);

    throw conflict(
      error.conflicts.length === 1
        ? `"${error.conflicts[0]?.label}" could not be saved as approved: ${error.conflicts[0]?.message} Nothing was written. A revised proposal is ready for you to review and approve.`
        : `${error.conflicts.length} approved changes no longer match the stored data, so nothing was written. A revised proposal is ready for you to review and approve.`,
      {
        reason: 'approved_operation_no_longer_valid',
        replacementProposalId: replacement.proposalId,
        conflicts: error.conflicts.map((c) => ({
          label: c.label,
          table: c.table,
          approvedOp: c.approvedOp,
          replacementOp: c.replacementOp,
          kind: c.kind,
          message: c.message,
          existingRowId: c.existingRowId,
        })),
      },
    );
  }
}

async function runApply(input: ApplyInput, workspaceId: string): Promise<ApplyResult> {
  return withService(async (db) => {
    // Serialise concurrent applies of the same proposal.
    const proposal = await db.one<ProposalRecord>(
      `select * from public.proposals where workspace_id = $1 and id = $2 for update`,
      [workspaceId, input.proposalId],
    );
    if (!proposal) throw notFound('Proposal not found');

    if (proposal.version !== input.expectedVersion) {
      throw conflict(
        `This proposal is now at version ${proposal.version}; you approved version ${input.expectedVersion}. Reload and review the current values.`,
        { currentVersion: proposal.version, expectedVersion: input.expectedVersion },
      );
    }

    const allItems = await db.rows<ProposalItemRecord>(
      `select * from public.proposal_items
        where workspace_id = $1 and proposal_id = $2 order by seq`,
      [workspaceId, input.proposalId],
    );

    // The stored hash must still describe the stored items.
    const currentHash = computeContentHash(allItems);
    if (currentHash !== proposal.content_hash) {
      throw conflict(
        'The proposal content no longer matches its recorded hash. Reload the proposal before applying.',
        { recorded: proposal.content_hash, actual: currentHash },
      );
    }

    // A live approval must cover every requested item at this exact version.
    const approval = await db.one<{ id: string; item_ids: string[] }>(
      `select id, item_ids from public.proposal_approvals
        where workspace_id = $1 and proposal_id = $2
          and proposal_version = $3 and content_hash = $4 and revoked_at is null
        order by approved_at desc limit 1`,
      [workspaceId, input.proposalId, proposal.version, proposal.content_hash],
    );
    if (!approval) {
      throw conflict(
        'No live approval exists for the current version of this proposal. Approve the items you want applied first.',
      );
    }
    const approvedSet = new Set(approval.item_ids);
    for (const itemId of input.itemIds) {
      if (!approvedSet.has(itemId)) {
        throw conflict('One or more requested items are not covered by the current approval.');
      }
    }

    const requested = new Set(input.itemIds);
    const selected = allItems.filter((i) => requested.has(i.id));
    if (selected.length === 0) throw conflict('No matching items to apply');

    for (const item of selected) {
      if (item.decision !== 'approved') {
        throw conflict(`Item ${item.seq} ("${item.label}") is not approved`);
      }
    }

    // Dependency ids resolved during this transaction, by seq.
    const resolvedIds = new Map<number, string>();
    for (const item of allItems) {
      if (item.applied_row_id) resolvedIds.set(item.seq, item.applied_row_id);
    }

    const results: AppliedItemResult[] = [];
    // Collected rather than thrown one at a time, so the user sees every item
    // that needs re-approval in a single pass instead of one per retry.
    const conflicts: ApplyConflict[] = [];
    const ordered = topologicalOrder(selected);

    for (const item of ordered) {
      // 3. Idempotency: already applied means report, never rewrite.
      const existingChange = await db.one<{ id: string; row_id: string; readback_values: unknown }>(
        `select id, row_id, readback_values from public.applied_changes
          where workspace_id = $1 and proposal_item_id = $2`,
        [workspaceId, item.id],
      );
      if (existingChange) {
        resolvedIds.set(item.seq, existingChange.row_id);
        results.push({
          itemId: item.id,
          seq: item.seq,
          label: item.label,
          table: item.target_table,
          op: item.op,
          status: 'already_applied',
          rowId: existingChange.row_id,
          readback: (existingChange.readback_values as Record<string, unknown>) ?? null,
          readbackOk: true,
          note: 'Already applied by an earlier request; not written again.',
        });
        continue;
      }

      const spec = tableSpec(item.target_table);
      const values = effectiveValues(item);

      // Substitute dependency references with the ids created in this transaction.
      for (const [column, value] of Object.entries(values)) {
        if (!isRef(value)) continue;
        const dependencyId = resolvedIds.get(value.$ref.seq);
        if (!dependencyId) {
          throw conflict(
            `Item ${item.seq} ("${item.label}") depends on item ${value.$ref.seq}, which was not applied in this request. Approve and apply them together.`,
          );
        }
        values[column] = dependencyId;
      }

      // Required columns are a create-time concern. An update supplies only the
      // columns it changes, and the stored row already carries the rest;
      // demanding them here would make every partial update unapplicable.
      if (item.op === 'create') {
        const missing = spec.required.filter((c) => values[c] === undefined || values[c] === null);
        if (missing.length > 0) {
          throw conflict(
            `Item ${item.seq} ("${item.label}") cannot be applied: missing ${missing.join(', ')}. Edit the item and approve again.`,
          );
        }
      } else if (item.op !== 'skip' && Object.keys(values).length === 0) {
        throw conflict(
          `Item ${item.seq} ("${item.label}") has no values to write.`,
        );
      }

      let before: Record<string, unknown> | null = null;
      let after: Record<string, unknown>;

      if (item.op === 'skip') {
        results.push({
          itemId: item.id,
          seq: item.seq,
          label: item.label,
          table: item.target_table,
          op: item.op,
          status: 'skipped',
          rowId: null,
          readback: null,
          readbackOk: true,
          note: 'Marked as skip; nothing written.',
        });
        continue;
      }

      if (item.op === 'create') {
        // An approved create must insert a new record. If a matching record
        // exists now, the approved operation is no longer the right one -- so it
        // is refused rather than quietly turned into an update of a row the
        // approver never saw.
        if (item.target_table === 'entities') {
          const entityType = ENTITY_TYPES.includes(values.entity_type as ResolvableType)
            ? (values.entity_type as ResolvableType)
            : 'other';
          const recheck = await resolveEntity(db, workspaceId, {
            name: String(values.display_name ?? item.label),
            entityType,
          });
          if (recheck.status === 'existing' && recheck.best) {
            conflicts.push(
              await describeCollision(
                db, workspaceId, item, recheck.best.id,
                `It now matches the stored record "${recheck.best.displayName}".`,
              ),
            );
            continue;
          }
        }

        const duplicate = await findByNaturalKey(db, workspaceId, item.target_table, values);
        if (duplicate) {
          conflicts.push(
            await describeCollision(
              db, workspaceId, item, duplicate.id as string,
              `A record with the same natural key (${tableSpec(item.target_table).naturalKey.join(', ')}) already exists.`,
            ),
          );
          continue;
        }

        after = await insertOrSignalCollision(db, workspaceId, item, values, conflicts);
      } else if (item.op === 'link' || item.op === 'attach') {
        // A link either writes to the join row it was approved against, or
        // creates one. An existing row gets exactly the same protection as an
        // update: it needs the baseline the approver saw. The current
        // fingerprint is never substituted for a missing one -- that would be
        // approving, on the user's behalf, a row state nobody reviewed.
        if (item.target_id) {
          const snapshot = await loadRowWithFingerprint(db, workspaceId, item.target_table, item.target_id);
          if (!snapshot) {
            conflicts.push({
              itemId: item.id, seq: item.seq, label: item.label, table: item.target_table,
              approvedOp: item.op, kind: 'update_target_missing',
              message: `Linked record ${item.target_id} no longer exists.`,
              existingRowId: null, currentValues: null, currentFingerprint: null,
              approvedValues: effectiveValues(item), replacementOp: 'create',
            });
            continue;
          }
          if (!item.baseline_fingerprint) {
            conflicts.push(await describeBaselineMissing(db, workspaceId, item, item.target_id));
            continue;
          }
          const updated = await updateRowGuarded(
            db, workspaceId, item.target_table, item.target_id, values, item.baseline_fingerprint,
          );
          if (!updated) {
            conflicts.push(await describeStaleTarget(db, workspaceId, item, item.target_id));
            continue;
          }
          before = snapshot.row;
          after = updated;
        } else {
          // Approved as a new link. If the identical link appeared since, that is
          // a collision like any other create: refused, and re-proposed against
          // the concrete row.
          const match = await findByNaturalKey(db, workspaceId, item.target_table, values);
          if (match) {
            conflicts.push(
              await describeCollision(
                db, workspaceId, item, match.id as string,
                'An identical link already exists.',
              ),
            );
            continue;
          }
          after = await insertOrSignalCollision(db, workspaceId, item, values, conflicts);
        }
      } else {
        // An approved update must update the record it was approved against.
        const targetId = item.target_id;
        if (!targetId) {
          conflicts.push({
            itemId: item.id, seq: item.seq, label: item.label, table: item.target_table,
            approvedOp: item.op, kind: 'update_target_missing',
            message: 'This was approved as an update but carries no target record.',
            existingRowId: null, currentValues: null, currentFingerprint: null,
            approvedValues: effectiveValues(item), replacementOp: 'create',
          });
          continue;
        }

        const snapshot = await loadRowWithFingerprint(db, workspaceId, item.target_table, targetId);
        if (!snapshot) {
          // Gone since approval. Turning this into a create would resurrect a
          // record someone deliberately removed, so it is refused.
          conflicts.push({
            itemId: item.id, seq: item.seq, label: item.label, table: item.target_table,
            approvedOp: item.op, kind: 'update_target_missing',
            message: `Record ${targetId} no longer exists; it was deleted after this was approved.`,
            existingRowId: null, currentValues: null, currentFingerprint: null,
            approvedValues: effectiveValues(item), replacementOp: 'create',
          });
          continue;
        }

        if (!item.baseline_fingerprint) {
          // Typically a proposal built before migration 0011. Refused, never
          // applied unguarded.
          conflicts.push(await describeBaselineMissing(db, workspaceId, item, targetId));
          continue;
        }

        const updated = await updateRowGuarded(
          db, workspaceId, item.target_table, targetId, values, item.baseline_fingerprint,
        );
        if (!updated) {
          // The guard did not match: someone changed the row after the proposal
          // was built. Nothing was written.
          conflicts.push(await describeStaleTarget(db, workspaceId, item, targetId));
          continue;
        }
        before = snapshot.row;
        after = updated;
      }

      const rowId = after.id as string;
      resolvedIds.set(item.seq, rowId);

      // 6. Readback: re-read the row rather than trusting the RETURNING clause.
      const readback =
        (await db.one<Record<string, unknown>>(
          `select * from public.${item.target_table} where workspace_id = $1 and id = $2`,
          [workspaceId, rowId],
        )) ?? null;

      const readbackOk =
        readback !== null &&
        Object.entries(values)
          .filter(([column]) => typeof values[column] !== 'object')
          .every(([column, expected]) => {
            const actual = readback[column];
            if (expected === null) return actual === null;
            return String(actual) === String(expected);
          });

      await db.query(
        `insert into public.applied_changes
           (workspace_id, proposal_id, proposal_item_id, approval_id, table_name, row_id, op,
            before_values, after_values, readback_values, readback_ok, readback_note, applied_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12,$13)`,
        [
          workspaceId,
          input.proposalId,
          item.id,
          approval.id,
          item.target_table,
          rowId,
          item.op,
          before ? JSON.stringify(before) : null,
          JSON.stringify(after),
          readback ? JSON.stringify(readback) : null,
          readbackOk,
          readbackOk ? null : 'Stored values differ from the approved values; inspect before relying on this record.',
          input.session.user.id,
        ],
      );

      // `op` is deliberately NOT updated here. It is part of the content hash the
      // approver agreed to, so mutating it would invalidate the proposal and make
      // a second apply fail the hash check instead of reporting "already
      // applied". What actually happened is recorded on applied_changes.op.
      await db.query(
        `update public.proposal_items
            set applied_at = now(), applied_row_id = $4, apply_error = null, updated_at = now()
          where workspace_id = $1 and proposal_id = $2 and id = $3`,
        [workspaceId, input.proposalId, item.id, rowId],
      );

      results.push({
        itemId: item.id,
        seq: item.seq,
        label: item.label,
        table: item.target_table,
        op: item.op,
        status: 'applied',
        rowId,
        readback,
        readbackOk,
        note: null,
      });
    }

    // Any conflict aborts the whole apply. Rolling back is the point: an
    // approved set is applied in full or not at all, so a partial write cannot
    // leave the knowledge base in a state nobody approved.
    if (conflicts.length > 0) {
      throw new ConflictingApply(conflicts);
    }

    // Proposal status reflects whether anything is still outstanding.
    const remaining = await db.oneOrFail<{ pending: number }>(
      `select count(*)::int as pending from public.proposal_items
        where workspace_id = $1 and proposal_id = $2 and applied_at is null and decision <> 'rejected'`,
      [workspaceId, input.proposalId],
    );
    const status = remaining.pending === 0 ? 'applied' : 'partially_applied';
    await db.query(
      `update public.proposals set status = $3, updated_at = now()
        where workspace_id = $1 and id = $2`,
      [workspaceId, input.proposalId, status],
    );

    const pastTense: Record<string, string> = {
      create: 'created',
      update: 'updated',
      link: 'linked',
      attach: 'attached',
      skip: 'skipped',
    };
    const readbackSummary = results.map((r) => {
      if (r.status === 'already_applied') return `${r.table}: "${r.label}" was already saved (${r.rowId}).`;
      if (r.status === 'skipped') return `${r.table}: "${r.label}" skipped.`;
      const flag = r.readbackOk ? '' : ' [readback mismatch]';
      return `${r.table}: "${r.label}" ${pastTense[r.op] ?? r.op} as ${r.rowId}${flag}.`;
    });

    await logActivity(db, {
      workspaceId,
      actorId: input.session.user.id,
      action: 'proposal.applied',
      subjectTable: 'proposals',
      subjectId: input.proposalId,
      summary: `Applied ${results.filter((r) => r.status === 'applied').length} of ${selected.length} approved item(s).`,
      data: {
        approvalId: approval.id,
        version: proposal.version,
        results: results.map((r) => ({
          table: r.table,
          label: r.label,
          op: r.op,
          rowId: r.rowId,
          status: r.status,
          readbackOk: r.readbackOk,
        })),
      },
    });

    return {
      proposalId: input.proposalId,
      proposalVersion: proposal.version,
      applied: results,
      proposalStatus: status,
      readbackSummary,
    };
  });
}

/** Reads back everything applied from a proposal, for the Review screen. */
export async function readbackProposal(
  db: Queryable,
  workspaceId: string,
  proposalId: string,
): Promise<
  {
    table: string;
    rowId: string;
    label: string;
    op: string;
    readbackOk: boolean;
    appliedAt: string;
    appliedByEmail: string | null;
    current: Record<string, unknown> | null;
  }[]
> {
  assertScope(workspaceId, 'readbackProposal');
  const changes = await db.rows<{
    table_name: string;
    row_id: string;
    op: string;
    readback_ok: boolean;
    applied_at: string;
    label: string;
    email: string | null;
  }>(
    `select c.table_name, c.row_id, c.op, c.readback_ok, c.applied_at, i.label, u.email
       from public.applied_changes c
       join public.proposal_items i on i.id = c.proposal_item_id
       left join public.app_users u on u.id = c.applied_by
      where c.workspace_id = $1 and c.proposal_id = $2
      order by c.applied_at`,
    [workspaceId, proposalId],
  );

  const out = [];
  for (const change of changes) {
    // Read the live row, not the stored snapshot: this is the actual result.
    const current =
      (await db.one<Record<string, unknown>>(
        `select * from public.${change.table_name} where workspace_id = $1 and id = $2`,
        [workspaceId, change.row_id],
      )) ?? null;
    out.push({
      table: change.table_name,
      rowId: change.row_id,
      label: change.label,
      op: change.op,
      readbackOk: change.readback_ok,
      appliedAt: change.applied_at,
      appliedByEmail: change.email,
      current,
    });
  }
  return out;
}
