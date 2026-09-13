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
 *      dependency order. If any one fails, nothing is written.
 *   5. Pre-write re-check -- a create is re-resolved immediately before writing,
 *      so a record that appeared since the proposal was built is not duplicated.
 *   6. Readback -- every written row is read back from the database and the
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

async function updateRow(
  db: Queryable,
  workspaceId: string,
  table: string,
  rowId: string,
  values: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const entries = Object.entries(values);
  if (entries.length === 0) {
    const existing = await db.one<Record<string, unknown>>(
      `select * from public.${table} where workspace_id = $1 and id = $2`,
      [workspaceId, rowId],
    );
    if (!existing) throw notFound(`${table} row ${rowId} no longer exists`);
    return existing;
  }
  const assignments = entries.map(([column], i) => `"${column}" = $${i + 3}`);
  const row = await db.one<Record<string, unknown>>(
    `update public.${table} set ${assignments.join(', ')}
      where workspace_id = $1 and id = $2
      returning *`,
    [workspaceId, rowId, ...entries.map(([, value]) => value)],
  );
  if (!row) throw notFound(`${table} row ${rowId} no longer exists`);
  return row;
}

/** Finds an existing row matching the natural key, to make creates idempotent. */
async function findByNaturalKey(
  db: Queryable,
  workspaceId: string,
  table: string,
  values: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const spec = tableSpec(table);
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

      const missing = spec.required.filter((c) => values[c] === undefined || values[c] === null);
      if (missing.length > 0) {
        throw conflict(
          `Item ${item.seq} ("${item.label}") cannot be applied: missing ${missing.join(', ')}. Edit the item and approve again.`,
        );
      }

      let before: Record<string, unknown> | null = null;
      let after: Record<string, unknown>;
      let effectiveOp = item.op;

      if (item.op === 'create') {
        // 5. Re-check immediately before writing: something may have been
        //    created since the proposal was built.
        if (item.target_table === 'entities') {
          const entityType = ENTITY_TYPES.includes(values.entity_type as ResolvableType)
            ? (values.entity_type as ResolvableType)
            : 'other';
          const recheck = await resolveEntity(db, workspaceId, {
            name: String(values.display_name ?? item.label),
            entityType,
          });
          if (recheck.status === 'existing' && recheck.best) {
            throw conflict(
              `"${item.label}" now matches the existing record "${recheck.best.displayName}", which did not exist when this proposal was built. Reload the proposal so the change becomes an update rather than a duplicate.`,
              { existingId: recheck.best.id, itemSeq: item.seq },
            );
          }
        }

        const duplicate = await findByNaturalKey(db, workspaceId, item.target_table, values);
        if (duplicate) {
          // Same natural key already present: treat as an update of that row so
          // a re-run cannot create a second copy.
          before = duplicate;
          after = await updateRow(db, workspaceId, item.target_table, duplicate.id as string, values);
          effectiveOp = 'update';
        } else {
          try {
            after = await insertRow(db, workspaceId, item.target_table, values);
          } catch (error) {
            if (!isUniqueViolation(error)) throw error;
            const raced = await findByNaturalKey(db, workspaceId, item.target_table, values);
            if (!raced) throw error;
            before = raced;
            after = await updateRow(db, workspaceId, item.target_table, raced.id as string, values);
            effectiveOp = 'update';
          }
        }
      } else if (item.op === 'skip') {
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
      } else {
        // update / link / attach all target an existing row.
        let targetId = item.target_id;
        if (!targetId) {
          const existing = await findByNaturalKey(db, workspaceId, item.target_table, values);
          if (existing) targetId = existing.id as string;
        }
        if (!targetId) {
          const created = await insertRow(db, workspaceId, item.target_table, values);
          before = null;
          after = created;
          effectiveOp = 'create';
        } else {
          before =
            (await db.one<Record<string, unknown>>(
              `select * from public.${item.target_table} where workspace_id = $1 and id = $2`,
              [workspaceId, targetId],
            )) ?? null;
          after = await updateRow(db, workspaceId, item.target_table, targetId, values);
        }
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
          effectiveOp,
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
        op: effectiveOp,
        status: 'applied',
        rowId,
        readback,
        readbackOk,
        note:
          effectiveOp !== item.op
            ? `Proposed as ${item.op}; applied as ${effectiveOp} because a matching record already existed.`
            : null,
      });
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
