'use client';

import { REVIEW_BAND_ORDER, REVIEW_BANDS, reviewBand, type ReviewBand } from '@g3/shared';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Database,
  History,
  Link2,
  Pencil,
  Save,
  ShieldCheck,
  X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input, Label, Textarea } from '@/components/ui/input';
import { ClaimTypeBadge, DecisionBadge, MatchStatusBadge } from '@/components/status';
import { api, RequestFailed } from '@/lib/client';
import {
  CLAIM_MEANING,
  displayLabel,
  fieldLabel,
  humanValue,
  isSubjectKind,
  opVerb,
  recordKind,
  SYSTEM_FIELDS,
  type RecordKind,
} from '@/lib/labels';
import { cn, formatDateTime, formatRelative, titleCase } from '@/lib/utils';

interface Candidate {
  field?: string;
  query?: string;
  status?: string;
  rationale?: string;
  best?: { displayName: string; similarity: number; matchedVia: string } | null;
  candidates?: { id: string; displayName: string; similarity: number; matchedVia: string }[];
}

export interface ReviewItem {
  id: string;
  seq: number;
  op: string;
  targetTable: string;
  targetId: string | null;
  matchStatus: string;
  candidates: Candidate[];
  label: string;
  claimType: string | null;
  confidence: string | null;
  reason: string | null;
  newValues: Record<string, unknown>;
  oldValues: Record<string, unknown> | null;
  editedValues: Record<string, unknown> | null;
  wasEdited: boolean;
  provenance: Record<string, unknown>;
  dependsOnSeq: number[];
  decision: string;
  appliedAt: string | null;
  appliedRowId: string | null;
  applyError: string | null;
}

interface ReadbackEntry {
  table: string;
  rowId: string;
  label: string;
  op: string;
  readbackOk: boolean;
  appliedAt: string;
  appliedByEmail: string | null;
  current: Record<string, unknown> | null;
}

interface ApprovalEntry {
  id: string;
  version: number;
  itemCount: number;
  approvedAt: string;
  approvedByEmail: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
}

interface SavedSummary {
  written: number;
  alreadyPresent: number;
  records: { label: string; kind: RecordKind }[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONNECTION_TABLES = new Set(['signal_entities', 'research_finding_evidence']);

/** Fields that point at the record a change is about, in order of preference. */
const SUBJECT_REF_FIELDS = [
  'person_entity_id',
  'related_entity_id',
  'entity_id',
  'external_entity_id',
  'organization_entity_id',
  'candidate_entity_id',
];

function effectiveValues(item: ReviewItem): Record<string, unknown> {
  return { ...item.newValues, ...(item.editedValues ?? {}) };
}

function itemKind(item: ReviewItem): RecordKind {
  return recordKind(item.targetTable, { ...(item.oldValues ?? {}), ...effectiveValues(item) });
}

function isRef(value: unknown): value is { $ref: { seq: number } } {
  return typeof value === 'object' && value !== null && '$ref' in (value as object);
}

/**
 * A value as a person reads it: linked records by name, never by id.
 */
function useDescribe(items: ReviewItem[], refNames: Record<string, string>) {
  const bySeq = useMemo(() => new Map(items.map((i) => [i.seq, i])), [items]);
  return (value: unknown, field?: string): string => {
    if (value === null || value === undefined || value === '') return '—';
    if (isRef(value)) {
      const target = bySeq.get(value.$ref.seq);
      return target ? `${displayLabel(target.label)} (change ${target.seq}, new)` : `the record proposed as change ${value.$ref.seq}`;
    }
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    if (typeof value === 'string' && UUID.test(value)) {
      return refNames[value] ?? 'a stored record (name not available)';
    }
    if (field === 'entity_type' && typeof value === 'string') return recordKind('entities', { entity_type: value });
    if (typeof value === 'object') return JSON.stringify(value);
    return typeof value === 'string' ? humanValue(field, value) : String(value);
  };
}

/**
 * The approval surface.
 *
 * Changes are grouped by the person, company or project they are about and
 * described in plain words. Every field stays inspectable under Details. The
 * approval logic is unchanged: items are approved individually, approval is tied
 * to one version, editing revokes it, and saving is one transaction on the server.
 */
export function ProposalReview({
  proposalId,
  version,
  contentHash,
  status,
  sourceKind,
  items,
  canApprove,
  readback,
  approvals,
  hasLiveApproval,
  refNames,
  defaultSelectedIds = [],
  captureReview = false,
}: {
  proposalId: string;
  version: number;
  contentHash: string;
  status: string;
  sourceKind: string;
  items: ReviewItem[];
  canApprove: boolean;
  readback: ReadbackEntry[];
  approvals: ApprovalEntry[];
  hasLiveApproval: boolean;
  refNames: Record<string, string>;
  /** Suggested capture records are selected locally until the person confirms save. */
  defaultSelectedIds?: string[];
  /** Capture reviews lead with plain language rather than proposal terminology. */
  captureReview?: boolean;
}) {
  const router = useRouter();
  const describe = useDescribe(items, refNames);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedSummary | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [staleWarning, setStaleWarning] = useState(false);
  // Set when the server refused because the approved operation no longer matches
  // the stored data and built a replacement for re-approval.
  const [replacement, setReplacement] = useState<{
    proposalId: string;
    conflicts: { label: string; table: string; approvedOp: string; replacementOp: string; kind: string; message: string }[];
  } | null>(null);

  const pending = items.filter((i) => !i.appliedAt);
  // Rejected items are final for this proposal. Keeping them visible preserves
  // the audit trail, but they must not leave a misleading active checkbox or
  // a second discard action behind.
  const reviewable = pending.filter((i) => i.decision !== 'rejected');
  const approved = reviewable.filter((i) => i.decision === 'approved');
  const blocked = useMemo(
    () => new Set(items.filter((i) => (i.reason ?? '').includes('Needs attention')).map((i) => i.id)),
    [items],
  );

  const [checked, setChecked] = useState<Set<string>>(
    new Set([
      ...approved.map((i) => i.id),
      ...reviewable.filter((i) => defaultSelectedIds.includes(i.id)).map((i) => i.id),
    ]),
  );

  const groups = useMemo(
    () => (sourceKind === 'research' ? researchGroups(items) : groupItems(items, refNames)),
    [items, refNames, sourceKind],
  );
  const claimTypes = useMemo(
    () => [...new Set(items.map((i) => i.claimType).filter((t): t is string => Boolean(t && CLAIM_MEANING[t])))],
    [items],
  );

  const fail = (failure: unknown, fallback: string) => {
    if (!(failure instanceof RequestFailed)) {
      setError(fallback);
      return;
    }
    setError(failure.payload.error);
    const detail = failure.payload.detail as
      | {
          reason?: string;
          replacementProposalId?: string;
          conflicts?: {
            label: string; table: string; approvedOp: string; replacementOp: string; kind: string; message: string;
          }[];
        }
      | undefined;

    if (detail?.reason === 'approved_operation_no_longer_valid' && detail.replacementProposalId) {
      setReplacement({ proposalId: detail.replacementProposalId, conflicts: detail.conflicts ?? [] });
      return;
    }
    if (failure.isConflict) setStaleWarning(true);
  };

  const decide = async (itemIds: string[], decision: 'approved' | 'rejected' | 'pending') => {
    setBusy('decide');
    setError(null);
    setNotice(null);
    try {
      await api(`/api/proposals/${proposalId}/decide`, {
        method: 'POST',
        json: { decisions: itemIds.map((itemId) => ({ itemId, decision })) },
      });
      setChecked((current) => {
        const next = new Set(current);
        for (const itemId of itemIds) {
          if (decision === 'rejected') next.delete(itemId);
          else if (decision === 'approved') next.add(itemId);
        }
        return next;
      });
      router.refresh();
    } catch (failure) {
      fail(failure, 'Could not record the decision.');
    } finally {
      setBusy(null);
    }
  };

  const selectedItems = items.filter((i) => checked.has(i.id));

  const approveAndApply = async () => {
    const itemIds = [...checked];
    setBusy('apply');
    setError(null);
    setNotice(null);
    try {
      // Mark them approved, record the approval against this exact version, then
      // apply. The server refuses each step if the content moved underneath.
      await api(`/api/proposals/${proposalId}/decide`, {
        method: 'POST',
        json: { decisions: itemIds.map((itemId) => ({ itemId, decision: 'approved' })) },
      });
      await api(`/api/proposals/${proposalId}/approve`, {
        method: 'POST',
        json: { action: 'approve', itemIds },
      });
      const result = await api<{
        applied: { label: string; table: string; status: string; rowId: string | null; readbackOk: boolean }[];
        readbackSummary: string[];
      }>(`/api/proposals/${proposalId}/apply`, {
        method: 'POST',
        json: { expectedVersion: version, itemIds },
      });
      const kindByLabel = new Map(selectedItems.map((i) => [`${i.targetTable}:${i.label}`, itemKind(i)]));
      setSaved({
        written: result.applied.filter((a) => a.status === 'applied').length,
        alreadyPresent: result.applied.filter((a) => a.status === 'already_applied').length,
        records: result.applied
          .filter((a) => a.status === 'applied' || a.status === 'already_applied')
          .map((a) => ({ label: a.label, kind: kindByLabel.get(`${a.table}:${a.label}`) ?? recordKind(a.table) })),
      });
      setChecked(new Set());
      router.refresh();
    } catch (failure) {
      fail(failure, 'Could not save the approved changes.');
    } finally {
      setBusy(null);
      setConfirming(false);
    }
  };

  const reject = async () => {
    setBusy('reject');
    setError(null);
    try {
      await api(`/api/proposals/${proposalId}/approve`, {
        method: 'POST',
        json: { action: 'reject', reason: 'Rejected in review.' },
      });
      router.refresh();
    } catch (failure) {
      fail(failure, 'Could not reject the proposal.');
    } finally {
      setBusy(null);
    }
  };

  const toggle = (id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      const byId = new Map(items.map((item) => [item.id, item]));
      const bySeq = new Map(items.map((item) => [item.seq, item]));
      const include = (itemId: string) => {
        const item = byId.get(itemId);
        if (!item || next.has(itemId) || item.appliedAt || item.decision === 'rejected' || blocked.has(itemId)) return;
        for (const dependencySeq of item.dependsOnSeq) {
          const dependency = bySeq.get(dependencySeq);
          if (dependency) include(dependency.id);
        }
        next.add(itemId);
      };
      const exclude = (itemId: string) => {
        const item = byId.get(itemId);
        if (!item || !next.delete(itemId)) return;
        // Removing a record must remove any selected relationship or fact that
        // relies on it, so the saved set remains internally consistent.
        for (const dependent of items) {
          if (dependent.dependsOnSeq.includes(item.seq)) exclude(dependent.id);
        }
      };

      if (next.has(id)) exclude(id);
      else include(id);
      return next;
    });
  };

  const selectable = reviewable.filter((i) => !blocked.has(i.id));
  const allSelected = selectable.length > 0 && selectable.every((i) => checked.has(i.id));

  const opCounts = countOps(selectedItems);
  const selectedConnectionCount = selectedItems.filter((item) => CONNECTION_TABLES.has(item.targetTable)).length;
  const selectedRecordCount = selectedItems.length - selectedConnectionCount;
  const selectionLabel = captureReview
    ? `${selectedRecordCount} recommended record${selectedRecordCount === 1 ? '' : 's'} selected${selectedConnectionCount ? ` · ${selectedConnectionCount} connection${selectedConnectionCount === 1 ? '' : 's'} included` : ''}`
    : `${checked.size} of ${reviewable.length} change${reviewable.length === 1 ? '' : 's'} selected`;
  const selectedSeqs = new Set(selectedItems.map((i) => i.seq));
  const missingDependencies = selectedItems.flatMap((item) =>
    item.dependsOnSeq
      .filter((seq) => !selectedSeqs.has(seq))
      .filter((seq) => !items.find((i) => i.seq === seq)?.appliedAt)
      .map((seq) => ({ item, seq })),
  );

  return (
    <div className="space-y-5">
      {replacement ? (
        <Card className="border-warning/50 bg-warning/5 shadow-none">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <AlertTriangle className="size-4 text-warning" />
              Nothing was saved — the approved changes no longer match what is stored
            </CardTitle>
            <CardDescription>
              The change you approved is no longer the right one, so it was refused rather than turned
              into something you did not approve. A revised proposal was prepared against what is stored
              now.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <ul className="space-y-2">
              {replacement.conflicts.map((c, index) => (
                <li key={index} className="rounded-md border bg-background p-2.5 text-sm">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium">{c.label}</span>
                    <Badge variant="outline">{recordKind(c.table)}</Badge>
                    <Badge variant="outline">
                      approved as {opVerb(c.approvedOp).toLowerCase()} → now {opVerb(c.replacementOp).toLowerCase()}
                    </Badge>
                  </div>
                  <p className="mt-1 text-muted-foreground">{c.message}</p>
                </li>
              ))}
            </ul>
            <Button asChild size="sm">
              <a href={`/review/${replacement.proposalId}`}>Review the revised proposal</a>
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {staleWarning ? (
        <Card className="border-destructive/40 bg-destructive/5 shadow-none">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <AlertTriangle className="size-4 text-destructive" />
              This proposal changed
            </CardTitle>
            <CardDescription>
              It changed since this page loaded, so nothing was saved. Reload to see the current values,
              then approve again.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" size="sm" onClick={() => router.refresh()}>
              Reload proposal
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {error && !staleWarning ? (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="rounded-md border border-success/40 bg-success/5 px-3 py-2 text-sm">{notice}</p>
      ) : null}

      {saved ? <SavedPanel saved={saved} /> : null}

      {/* Action bar */}
      {reviewable.length > 0 ? (
        <Card className="sticky top-2 z-10 shadow-sm">
          <CardContent className="flex flex-wrap items-center gap-3 p-4">
            <div className="flex items-center gap-2">
              <Checkbox
                id="select-all"
                checked={allSelected ? true : checked.size > 0 ? 'indeterminate' : false}
                onCheckedChange={() =>
                  setChecked(allSelected ? new Set() : new Set(selectable.map((i) => i.id)))
                }
                disabled={!canApprove || selectable.length === 0}
              />
              <Label htmlFor="select-all" className="cursor-pointer">
                {selectionLabel}
              </Label>
            </div>
            <div className="ml-auto flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={!canApprove || checked.size === 0 || busy !== null}
                onClick={() => decide([...checked], 'rejected')}
              >
                <X />
                {captureReview ? 'Do not save selected' : 'Reject selected'}
              </Button>
              <Button
                size="sm"
                loading={busy === 'apply'}
                disabled={!canApprove || checked.size === 0 || busy !== null}
                onClick={() => setConfirming(true)}
              >
                <ShieldCheck />
                Approve and save {checked.size}
              </Button>
            </div>
            <p className="w-full text-xs text-muted-foreground" title={`Version ${version}, content hash ${contentHash.slice(0, 10)}`}>
              {canApprove
                ? captureReview
                  ? 'Suggested records are preselected. Connections keep people, organisations, projects and signals linked; removing a record also removes its dependent connections. Nothing is saved until you confirm.'
                  : 'Your approval covers exactly these changes as shown. Editing any change cancels an earlier approval.'
                : 'You can read these changes, but your role cannot approve them.'}
              {sourceKind === 'research' ? ' Anything left unchecked stays out of memory.' : ''}
              {blocked.size > 0 ? ` ${blocked.size} change(s) need attention before they can be selected.` : ''}
            </p>
          </CardContent>
        </Card>
      ) : null}

      {claimTypes.length > 0 ? (
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {claimTypes.map((type) => (
            <span key={type}>
              <span className="font-medium text-foreground">{CLAIM_MEANING[type]!.label}</span> —{' '}
              {CLAIM_MEANING[type]!.meaning}
            </span>
          ))}
        </p>
      ) : null}

      {/* Changes, grouped by what they are about */}
      <div className="space-y-6">
        {groups.map((group) => (
          <section key={group.key} className="space-y-2">
            <div className="flex flex-wrap items-baseline gap-2">
              <h2 className="text-sm font-semibold">{group.title}</h2>
              {group.kind ? <Badge variant="outline">{group.kind}</Badge> : null}
              {group.existing ? <Badge variant="secondary">Already in knowledge</Badge> : null}
              <span className="text-xs text-muted-foreground">
                {group.items.length} change{group.items.length === 1 ? '' : 's'}
              </span>
            </div>
            {group.bands.map((band) => (
              <div key={band.key} className="space-y-2">
                {group.bands.length > 1 ? (
                  <p className="flex flex-wrap items-baseline gap-x-2 border-l-2 border-muted pl-2 text-xs">
                    <span className="font-medium uppercase tracking-wide text-muted-foreground">{band.label}</span>
                    {band.note ? <span className="text-muted-foreground">{band.note}</span> : null}
                  </p>
                ) : null}
                <ol className="space-y-3">
                  {band.items.map((item) => (
                    <ItemCard
                      key={item.id}
                      item={item}
                      items={items}
                      describe={describe}
                      proposalId={proposalId}
                      selected={checked.has(item.id)}
                      selectable={canApprove && !item.appliedAt && item.decision !== 'rejected' && !blocked.has(item.id)}
                      blocked={blocked.has(item.id)}
                      onToggle={() => toggle(item.id)}
                      onEdited={() => {
                        setChecked(new Set());
                        setNotice(
                          'Edit saved. Any earlier approval of this proposal was cancelled, and every change is awaiting review again.',
                        );
                        router.refresh();
                      }}
                      onError={(message) => setError(message)}
                    />
                  ))}
                </ol>
              </div>
            ))}
          </section>
        ))}
      </div>

      {reviewable.length === 0 && pending.length > 0 ? (
        <Card className="border-muted bg-muted/20 shadow-none">
          <CardContent className="p-4 text-sm text-muted-foreground">
            This review was discarded. No records were saved to knowledge.
          </CardContent>
        </Card>
      ) : null}

      {reviewable.length > 0 && canApprove ? (
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={reject} loading={busy === 'reject'}>
            {captureReview ? 'Discard this capture review' : 'Reject the whole proposal'}
          </Button>
        </div>
      ) : null}

      {/* Confirmation before anything is written */}
      <Dialog open={confirming} onOpenChange={(open) => (busy === 'apply' ? null : setConfirming(open))}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {captureReview
                ? `Save ${selectedRecordCount} record${selectedRecordCount === 1 ? '' : 's'} to knowledge?`
                : `Save ${checked.size} change${checked.size === 1 ? '' : 's'} to knowledge?`}
            </DialogTitle>
            <DialogDescription>{formatOpCounts(opCounts)}</DialogDescription>
          </DialogHeader>
          {captureReview && selectedConnectionCount > 0 ? (
            <p className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              {selectedConnectionCount} connection{selectedConnectionCount === 1 ? '' : 's'} will be saved with these records so the relationships shown in this review remain intact.
            </p>
          ) : null}
          <ul className="max-h-60 space-y-1 overflow-y-auto rounded-md border p-2 text-sm">
            {selectedItems
              .sort((a, b) => a.seq - b.seq)
              .map((item) => (
                <li key={item.id} className="flex flex-wrap items-center gap-1.5">
                  <Badge variant="outline">{opVerb(item.op)}</Badge>
                  <span className="text-muted-foreground">{itemKind(item)}</span>
                  <span className="min-w-0 font-medium">{displayLabel(item.label)}</span>
                </li>
              ))}
          </ul>
          {missingDependencies.length > 0 ? (
            <p className="rounded-md border border-warning/40 bg-warning/10 p-2.5 text-xs">
              Some selected changes depend on changes you did not select (for example change{' '}
              {missingDependencies[0]!.seq} for “{missingDependencies[0]!.item.label}”). Saving will be
              refused until they are selected together.
            </p>
          ) : null}
          <p className="text-sm text-muted-foreground">
            These records are written to knowledge now, in one step. There is no one-click undo: a
            mistake has to be corrected with a new change.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)} disabled={busy === 'apply'}>
              Cancel
            </Button>
            <Button onClick={approveAndApply} loading={busy === 'apply'}>
              <ShieldCheck />
              Approve and save {checked.size}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Readback */}
      {readback.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Database className="size-4" />
              What is stored now
            </CardTitle>
            <CardDescription>
              Read back from knowledge after saving, not copied from the approval.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <ul className="divide-y border-t">
              {readback.map((entry) => {
                const kind = recordKind(entry.table, entry.current);
                const fields = Object.entries(entry.current ?? {})
                  .filter(([key, value]) => !SYSTEM_FIELDS.has(key) && value !== null && value !== '')
                  .slice(0, 5);
                return (
                  <li key={entry.rowId} className="space-y-1.5 px-6 py-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline">{kind}</Badge>
                      <span className="font-medium">{displayLabel(entry.label)}</span>
                      <Badge variant={entry.readbackOk ? 'success' : 'destructive'}>
                        {entry.readbackOk ? 'Matches what you approved' : 'Differs from what you approved'}
                      </Badge>
                      <span className="ml-auto text-xs text-muted-foreground">
                        Saved {formatDateTime(entry.appliedAt)}
                        {entry.appliedByEmail ? ` by ${entry.appliedByEmail}` : ''}
                      </span>
                    </div>
                    <dl className="grid gap-x-4 gap-y-0.5 text-xs sm:grid-cols-[10rem_minmax(0,1fr)]">
                      {fields.map(([key, value]) => (
                        <div key={key} className="contents">
                          <dt className="text-muted-foreground">{fieldLabel(key)}</dt>
                          <dd className="min-w-0 break-words">{describe(value, key)}</dd>
                        </div>
                      ))}
                    </dl>
                    <Link
                      href={`/knowledge?q=${encodeURIComponent(entry.label)}`}
                      className="inline-flex items-center gap-1 text-xs underline underline-offset-2"
                    >
                      View in Knowledge <ArrowRight className="size-3" />
                    </Link>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      {/* Approval history */}
      {approvals.length > 0 ? (
        <details className="rounded-lg border px-4 py-3">
          <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium text-muted-foreground">
            <History className="size-4" />
            Approval history ({approvals.length})
          </summary>
          <div className="mt-3 space-y-2">
            <p className="text-xs text-muted-foreground">
              An approval covers one version of the proposal. A cancelled approval can never be used to save.
            </p>
            {approvals.map((approval) => (
              <div key={approval.id} className="flex flex-wrap items-center gap-2 rounded-md border p-2.5 text-sm">
                {approval.revokedAt ? (
                  <Badge variant="muted">Cancelled</Badge>
                ) : approval.version === version ? (
                  <Badge variant="success">
                    <CheckCircle2 />
                    Current
                  </Badge>
                ) : (
                  <Badge variant="outline">Earlier version</Badge>
                )}
                <span>
                  {approval.itemCount} change(s), version {approval.version}
                </span>
                <span className="text-muted-foreground">
                  by {approval.approvedByEmail ?? 'unknown'} · {formatDateTime(approval.approvedAt)}
                </span>
                {approval.revokedReason ? (
                  <p className="w-full text-xs text-muted-foreground">{approval.revokedReason}</p>
                ) : null}
              </div>
            ))}
          </div>
        </details>
      ) : null}

      {!hasLiveApproval && reviewable.length > 0 && canApprove ? (
        <p className="text-xs text-muted-foreground">
          Approving and saving happen together, for the changes you select, after you confirm.
        </p>
      ) : null}
      {status === 'applied' ? (
        <p className="text-xs text-muted-foreground">
          Every change in this proposal is settled. Saving the same approval again writes nothing new.
        </p>
      ) : null}
    </div>
  );
}

function SavedPanel({ saved }: { saved: SavedSummary }) {
  const subjects = saved.records.filter((r) => isSubjectKind(r.kind));
  const firstSearch = (subjects[0] ?? saved.records[0])?.label;
  return (
    <div className="space-y-3 rounded-lg border border-success/40 bg-success/5 p-4" role="status">
      <p className="flex items-center gap-2 text-sm font-medium">
        <CheckCircle2 className="size-4 text-success" />
        Saved {saved.written} change{saved.written === 1 ? '' : 's'} to knowledge
        {saved.alreadyPresent > 0 ? ` · ${saved.alreadyPresent} already there` : ''}
      </p>
      <ul className="flex flex-wrap gap-1.5 text-sm">
        {saved.records.map((record, index) => (
          <li key={`${record.label}-${index}`}>
            <Link
              href={`/knowledge?q=${encodeURIComponent(record.label)}`}
              className="inline-flex items-center gap-1.5 rounded-md border bg-background px-2 py-1 hover:bg-accent/50"
            >
              <span className="text-xs text-muted-foreground">{record.kind}</span>
              <span className="font-medium">{displayLabel(record.label)}</span>
            </Link>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        {firstSearch ? (
          <Button asChild size="sm">
            <Link href={`/knowledge?q=${encodeURIComponent(firstSearch)}`}>
              View {firstSearch} in Knowledge
              <ArrowRight />
            </Link>
          </Button>
        ) : null}
        <Button asChild size="sm" variant="outline">
          <Link href="/">Back to Today</Link>
        </Button>
      </div>
    </div>
  );
}

function countOps(items: ReviewItem[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[item.op] = (counts[item.op] ?? 0) + 1;
  return counts;
}

function formatOpCounts(counts: Record<string, number>): string {
  const order = ['create', 'link', 'attach', 'update'];
  const keys = [...order.filter((k) => counts[k]), ...Object.keys(counts).filter((k) => !order.includes(k))];
  return keys.map((key) => `${opVerb(key)} ${counts[key]}`).join(' · ') || 'Nothing selected';
}

interface Group {
  key: string;
  title: string;
  kind: RecordKind | null;
  existing: boolean;
  order: number;
  items: ReviewItem[];
  bands: Band[];
}

/**
 * Within one subject, changes are separated by what kind of statement they are.
 * The classification is shared with the mobile API (see @g3/shared review.ts),
 * so both clients always put a change in the same group.
 */
type BandKey = ReviewBand | 'risk' | 'sources';

interface Band {
  key: BandKey;
  label: string;
  note: string | null;
  items: ReviewItem[];
}

function bandsFor(items: ReviewItem[]): Band[] {
  const bands = new Map<ReviewBand, Band>();
  for (const item of items) {
    const key = reviewBand(item.targetTable, item.claimType);
    if (!bands.has(key)) bands.set(key, { key, ...REVIEW_BANDS[key], items: [] });
    bands.get(key)!.items.push(item);
  }
  return REVIEW_BAND_ORDER.filter((key) => bands.has(key)).map((key) => bands.get(key)!);
}

/**
 * Research is reviewed by epistemic status before record ownership. A source,
 * a source-backed fact and our own interpretation must never read as the same
 * kind of statement, even when all three concern the same person.
 */
function researchGroups(items: ReviewItem[]): Group[] {
  const buckets: { key: BandKey; label: string; note: string | null; matches: (item: ReviewItem) => boolean }[] = [
    {
      key: 'fact',
      label: 'Facts to save',
      note: 'Claims stated by the sources shown below.',
      matches: (item) => item.targetTable === 'research_findings' && item.claimType === 'fact',
    },
    {
      key: 'inference',
      label: 'Our reading',
      note: 'Interpretations and suggested next steps, not source-backed facts.',
      matches: (item) =>
        item.targetTable === 'research_findings' && ['inference', 'recommendation', 'next_step'].includes(item.claimType ?? ''),
    },
    {
      key: 'gap',
      label: 'Still unconfirmed',
      note: 'Research did not establish these points.',
      matches: (item) => item.targetTable === 'research_findings' && item.claimType === 'gap',
    },
    {
      key: 'risk',
      label: 'Needs care',
      note: 'Risks raised by the research.',
      matches: (item) => item.targetTable === 'research_findings' && item.claimType === 'risk',
    },
    {
      key: 'sources',
      label: 'Sources',
      note: 'Pages found by research, and the citations that connect them to facts.',
      matches: (item) => ['evidence', 'research_finding_evidence'].includes(item.targetTable),
    },
    {
      key: 'record',
      label: 'Other proposed records',
      note: null,
      matches: () => true,
    },
  ];
  const remaining = new Set(items.map((item) => item.id));
  const bands: Band[] = [];
  for (const bucket of buckets) {
    const matched = items.filter((item) => remaining.has(item.id) && bucket.matches(item));
    if (matched.length === 0) continue;
    for (const item of matched) remaining.delete(item.id);
    bands.push({ key: bucket.key, label: bucket.label, note: bucket.note, items: matched });
  }
  return [
    {
      key: 'research-results',
      title: 'Research results',
      kind: null,
      existing: false,
      order: 0,
      items,
      bands,
    },
  ];
}

/**
 * Groups changes by the record they are about: a new or existing person,
 * company or project collects the changes that point at it. Sources, unconfirmed
 * names and anything unrelated follow.
 */
function groupItems(items: ReviewItem[], refNames: Record<string, string>): Group[] {
  const bySeq = new Map(items.map((i) => [i.seq, i]));
  const groups = new Map<string, Group>();

  const subjectKeyForSeq = (seq: number): string | null => {
    const target = bySeq.get(seq);
    if (!target || target.targetTable !== 'entities') return null;
    return target.targetId ? `id:${target.targetId}` : `seq:${seq}`;
  };

  const ensure = (key: string, init: Omit<Group, 'items'>) => {
    if (!groups.has(key)) groups.set(key, { ...init, items: [] });
    return groups.get(key)!;
  };

  for (const item of [...items].sort((a, b) => a.seq - b.seq)) {
    const kind = itemKind(item);
    let key: string | null = null;
    let title = '';
    let groupKind: RecordKind | null = null;
    let existing = false;

    if (item.targetTable === 'entities') {
      key = item.targetId ? `id:${item.targetId}` : `seq:${item.seq}`;
      title = item.label;
      groupKind = kind;
      existing = Boolean(item.targetId);
    } else if (item.targetTable === 'evidence') {
      key = 'sources';
      title = 'Sources';
    } else if (item.targetTable === 'entity_mentions') {
      key = 'unconfirmed';
      title = 'Unconfirmed names';
    } else {
      const values = { ...(item.oldValues ?? {}), ...effectiveValues(item) };
      for (const field of SUBJECT_REF_FIELDS) {
        const value = values[field];
        if (isRef(value)) {
          key = subjectKeyForSeq(value.$ref.seq);
          const target = bySeq.get(value.$ref.seq);
          if (key && target) {
            title = target.label;
            groupKind = itemKind(target);
          }
        } else if (typeof value === 'string' && UUID.test(value)) {
          key = `id:${value}`;
          title = refNames[value] ?? 'An existing record';
          existing = true;
          groupKind = null;
        }
        if (key) break;
      }
      if (!key) {
        key = 'other';
        title = 'Other changes';
      }
    }

    const order = key === 'sources' ? 1e6 : key === 'unconfirmed' ? 1e6 + 1 : key === 'other' ? 1e6 + 2 : item.seq;
    const group = ensure(key, { key, title, kind: groupKind, existing, order, bands: [] });
    // A subject group created from a pointing change gets its real title and kind
    // once the subject's own change is seen.
    if (item.targetTable === 'entities') {
      group.title = item.label;
      group.kind = kind;
      group.existing = Boolean(item.targetId);
      group.order = Math.min(group.order, item.seq);
    }
    group.items.push(item);
  }

  for (const group of groups.values()) group.bands = bandsFor(group.items);
  return [...groups.values()].sort((a, b) => a.order - b.order);
}

function ItemCard({
  item,
  items,
  describe,
  proposalId,
  selected,
  selectable,
  blocked,
  onToggle,
  onEdited,
  onError,
}: {
  item: ReviewItem;
  items: ReviewItem[];
  describe: (value: unknown, field?: string) => string;
  proposalId: string;
  selected: boolean;
  selectable: boolean;
  blocked: boolean;
  onToggle: () => void;
  onEdited: () => void;
  onError: (message: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const effective = effectiveValues(item);
  const kind = itemKind(item);
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      Object.entries(effective)
        .filter(([, value]) => !isRef(value))
        .map(([key, value]) => [key, value === null || value === undefined ? '' : String(value)]),
    ),
  );

  const isUpdate = Boolean(item.oldValues);
  const allFields = Object.keys({ ...(item.oldValues ?? {}), ...effective }).filter(
    (key) => !['workspace_id', 'id', 'created_at', 'updated_at'].includes(key),
  );
  const changed = (field: string) =>
    !isUpdate || String(item.oldValues?.[field] ?? '') !== String(effective[field] ?? '');
  const readable = allFields.filter((f) => !SYSTEM_FIELDS.has(f) && f in effective && changed(f));
  const detailFields = allFields.filter((f) => !readable.includes(f));

  const save = async () => {
    setSaving(true);
    try {
      const edits: Record<string, string | null> = {};
      for (const [key, value] of Object.entries(draft)) {
        const original = effective[key];
        const originalText = original === null || original === undefined ? '' : String(original);
        if (value !== originalText) edits[key] = value === '' ? null : value;
      }
      if (Object.keys(edits).length === 0) {
        setEditing(false);
        return;
      }
      await api(`/api/proposals/${proposalId}/items/${item.id}`, {
        method: 'PATCH',
        json: { edits },
      });
      setEditing(false);
      onEdited();
    } catch (failure) {
      onError(failure instanceof RequestFailed ? failure.payload.error : 'Could not save the edit.');
    } finally {
      setSaving(false);
    }
  };

  const sourceUrls = Array.isArray(item.provenance.source_urls)
    ? (item.provenance.source_urls as string[])
    : [];
  const blockers = Array.isArray(item.provenance.blockers) ? (item.provenance.blockers as string[]) : [];
  const dependencyLabels = item.dependsOnSeq.map((seq) => {
    const target = items.find((i) => i.seq === seq);
    return target ? `${seq} (${target.label})` : String(seq);
  });

  return (
    <li
      className={cn(
        'rounded-lg border p-4',
        selected && 'border-primary/50 bg-accent/20',
        item.appliedAt && 'bg-muted/30',
        blocked && 'border-warning/50 bg-warning/5',
      )}
    >
      <div className="flex gap-3">
        {selectable ? (
          <Checkbox
            checked={selected}
            onCheckedChange={onToggle}
            className="mt-1"
            aria-label={`Select ${item.label}`}
          />
        ) : (
          <span className="mt-1 w-4 shrink-0" aria-hidden />
        )}

        <div className="min-w-0 flex-1 space-y-2.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-xs text-muted-foreground" title="Change number">
              {item.seq}
            </span>
            <Badge variant="outline">{opVerb(item.op)}</Badge>
            <span className="text-xs text-muted-foreground">{kind}</span>
            <span className="text-sm font-medium">{displayLabel(item.label)}</span>
            {selectable ? (
              <Badge variant={selected ? 'success' : 'secondary'}>{selected ? 'Will save' : 'Not selected'}</Badge>
            ) : null}
            {CONNECTION_TABLES.has(item.targetTable) ? <Badge variant="outline">Connection</Badge> : null}
            {isSubjectKind(kind) && !item.appliedAt ? <MatchStatusBadge status={item.matchStatus} /> : null}
            <ClaimTypeBadge type={item.claimType} />
            {item.confidence ? <Badge variant="outline">{titleCase(item.confidence)} confidence</Badge> : null}
            {item.wasEdited ? (
              <Badge variant="secondary">
                <Pencil />
                Edited
              </Badge>
            ) : null}
            <span className="ml-auto">
              <DecisionBadge decision={item.decision} applied={Boolean(item.appliedAt)} />
            </span>
          </div>

          {item.reason ? <p className="text-sm text-muted-foreground">{item.reason}</p> : null}

          {blockers.length > 0 ? (
            <div className="rounded-md border border-warning/40 bg-warning/10 p-2.5 text-xs">
              <p className="font-medium">Needs attention before this can be saved</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                {blockers.map((blocker, index) => (
                  <li key={index}>{blocker}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {item.candidates
            .filter((c) => c.status === 'ambiguous' && (c.candidates?.length ?? 0) > 0)
            .map((candidate, index) => (
              <div key={index} className="rounded-md border border-warning/40 bg-warning/5 p-2.5 text-xs">
                <p className="font-medium">Possible existing matches for “{candidate.query}”</p>
                <ul className="mt-1 space-y-0.5">
                  {candidate.candidates?.slice(0, 4).map((c) => (
                    <li key={c.id} className="flex items-center gap-1.5 text-muted-foreground">
                      <Link2 className="size-3" />
                      {c.displayName} — {Math.round(c.similarity * 100)}% similar name
                    </li>
                  ))}
                </ul>
                {candidate.rationale ? <p className="mt-1 text-muted-foreground">{candidate.rationale}</p> : null}
              </div>
            ))}

          {item.dependsOnSeq.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              Needs change{item.dependsOnSeq.length > 1 ? 's' : ''} {dependencyLabels.join(', ')}. Approve them
              together, or neither.
            </p>
          ) : null}

          {readable.length > 0 || editing ? (
            <div className="scroll-x rounded-md border">
              <table className="w-full text-sm">
                {isUpdate ? (
                  <thead>
                    <tr className="border-b bg-muted/50 text-xs">
                      <th className="px-2.5 py-1.5 text-left font-medium">What changes</th>
                      <th className="px-2.5 py-1.5 text-left font-medium">Now</th>
                      <th className="px-2.5 py-1.5 text-left font-medium">After saving</th>
                    </tr>
                  </thead>
                ) : null}
                <tbody>
                  {(editing ? allFields.filter((f) => !SYSTEM_FIELDS.has(f) && f in effective) : readable).map((field) => {
                    const newValue = effective[field];
                    return (
                      <tr key={field} className="border-b align-top last:border-0">
                        <td className="w-40 px-2.5 py-1.5 text-xs text-muted-foreground">{fieldLabel(field)}</td>
                        {isUpdate ? (
                          <td className="px-2.5 py-1.5 text-muted-foreground">{describe(item.oldValues?.[field], field)}</td>
                        ) : null}
                        <td className="px-2.5 py-1.5">
                          {editing && !isRef(newValue) ? (
                            String(newValue ?? '').length > 80 ? (
                              <Textarea
                                value={draft[field] ?? ''}
                                onChange={(event) => setDraft((prev) => ({ ...prev, [field]: event.target.value }))}
                                className="min-h-[70px] text-xs"
                                aria-label={fieldLabel(field)}
                              />
                            ) : (
                              <Input
                                value={draft[field] ?? ''}
                                onChange={(event) => setDraft((prev) => ({ ...prev, [field]: event.target.value }))}
                                className="h-7 text-xs"
                                aria-label={fieldLabel(field)}
                              />
                            )
                          ) : (
                            <span className="break-words">{describe(newValue, field)}</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}

          {sourceUrls.length > 0 ? (
            <div className="text-xs text-muted-foreground">
              <span className="font-medium">Sources: </span>
              {sourceUrls.map((url, index) => (
                <span key={url}>
                  {index > 0 ? ', ' : ''}
                  <a href={url} target="_blank" rel="noreferrer noopener" className="break-all underline underline-offset-2">
                    {url}
                  </a>
                </span>
              ))}
            </div>
          ) : null}

          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">Details</summary>
            <dl className="mt-2 grid gap-x-4 gap-y-1 rounded-md border bg-muted/30 p-2.5 sm:grid-cols-[12rem_minmax(0,1fr)]">
              <dt className="text-muted-foreground">Stored as</dt>
              <dd className="font-mono">
                {item.targetTable}
                {item.targetId ? ` / ${item.targetId}` : ''}
              </dd>
              {item.appliedRowId ? (
                <>
                  <dt className="text-muted-foreground">Saved record id</dt>
                  <dd className="break-all font-mono">{item.appliedRowId}</dd>
                </>
              ) : null}
              {detailFields.map((field) => (
                <div key={field} className="contents">
                  <dt className="font-mono text-muted-foreground">{field}</dt>
                  <dd className="min-w-0 break-words">
                    {isUpdate && changed(field)
                      ? `${describe(item.oldValues?.[field], field)} → ${describe(effective[field], field)}`
                      : describe(field in effective ? effective[field] : item.oldValues?.[field], field)}
                  </dd>
                </div>
              ))}
            </dl>
          </details>

          {item.appliedAt ? (
            <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <CheckCircle2 className="size-3.5 text-success" />
              Saved {formatRelative(item.appliedAt)}
              <Link
                href={`/knowledge?q=${encodeURIComponent(item.label)}`}
                className="inline-flex items-center gap-1 underline underline-offset-2"
              >
                View in Knowledge <ArrowRight className="size-3" />
              </Link>
            </p>
          ) : null}
          {item.applyError ? <p className="text-xs text-destructive">{item.applyError}</p> : null}

          {!item.appliedAt ? (
            <div className="flex flex-wrap gap-2 pt-0.5">
              {editing ? (
                <>
                  <Button size="sm" variant="outline" onClick={save} loading={saving}>
                    <Save />
                    Save edit
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                    Cancel
                  </Button>
                  <p className="w-full text-xs text-warning">
                    Saving an edit cancels any approval already given for this proposal.
                  </p>
                </>
              ) : (
                <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
                  <Pencil />
                  Edit values
                </Button>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </li>
  );
}
