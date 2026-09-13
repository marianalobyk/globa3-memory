'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  Check,
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
import { Input, Label, Textarea } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ClaimTypeBadge, DecisionBadge, MatchStatusBadge, OpBadge } from '@/components/status';
import { api, RequestFailed } from '@/lib/client';
import { cn, formatDateTime, titleCase } from '@/lib/utils';

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

const HIDDEN_FIELDS = new Set(['workspace_id', 'id', 'created_at', 'updated_at']);

function describe(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'object') {
    const ref = value as { $ref?: { seq: number } };
    if (ref.$ref) return `↳ the record proposed as item ${ref.$ref.seq}`;
    return JSON.stringify(value);
  }
  return String(value);
}

function isRef(value: unknown): boolean {
  return typeof value === 'object' && value !== null && '$ref' in (value as object);
}

/**
 * The approval surface.
 *
 * Every item shows the operation, the target table, how it resolved, and the
 * exact old and new value of every field. Partial approval is the default shape
 * of the screen: items are approved individually, and editing one is treated as
 * consequential because it revokes any approval already given.
 */
export function ProposalReview({
  proposalId,
  version,
  contentHash,
  status,
  items,
  canApprove,
  readback,
  approvals,
  hasLiveApproval,
}: {
  proposalId: string;
  version: number;
  contentHash: string;
  status: string;
  items: ReviewItem[];
  canApprove: boolean;
  readback: ReadbackEntry[];
  approvals: ApprovalEntry[];
  hasLiveApproval: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [staleWarning, setStaleWarning] = useState(false);

  const pending = items.filter((i) => !i.appliedAt);
  const approved = pending.filter((i) => i.decision === 'approved');
  const blocked = useMemo(
    () => new Set(items.filter((i) => (i.reason ?? '').includes('Needs attention')).map((i) => i.id)),
    [items],
  );

  const [checked, setChecked] = useState<Set<string>>(new Set(approved.map((i) => i.id)));

  const fail = (failure: unknown, fallback: string) => {
    if (failure instanceof RequestFailed) {
      setError(failure.payload.error);
      if (failure.isConflict) setStaleWarning(true);
    } else {
      setError(fallback);
    }
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
      router.refresh();
    } catch (failure) {
      fail(failure, 'Could not record the decision.');
    } finally {
      setBusy(null);
    }
  };

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
      setNotice(
        `Saved. ${result.applied.filter((a) => a.status === 'applied').length} record(s) written, ${result.applied.filter((a) => a.status === 'already_applied').length} already present. Readback is shown below.`,
      );
      router.refresh();
    } catch (failure) {
      fail(failure, 'Could not apply the approved changes.');
    } finally {
      setBusy(null);
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
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectable = pending.filter((i) => !blocked.has(i.id));
  const allSelected = selectable.length > 0 && selectable.every((i) => checked.has(i.id));

  return (
    <div className="space-y-5">
      {staleWarning ? (
        <Card className="border-destructive/40 bg-destructive/5 shadow-none">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <AlertTriangle className="size-4 text-destructive" />
              This proposal changed
            </CardTitle>
            <CardDescription>
              The content moved since this page loaded, so nothing was written. Reload to see the
              current values, then approve again.
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

      {/* Action bar */}
      {pending.length > 0 ? (
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
                {checked.size} of {pending.length} selected
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
                Reject selected
              </Button>
              <Button
                size="sm"
                loading={busy === 'apply'}
                disabled={!canApprove || checked.size === 0 || busy !== null}
                onClick={approveAndApply}
              >
                <ShieldCheck />
                Approve and save {checked.size}
              </Button>
            </div>
            <p className="w-full text-xs text-muted-foreground">
              Approval applies to version {version} exactly (hash{' '}
              <code className="break-all font-mono">{contentHash.slice(0, 10)}</code>). Editing any item
              revokes it.
              {blocked.size > 0
                ? ` ${blocked.size} item(s) need attention before they can be selected.`
                : ''}
            </p>
          </CardContent>
        </Card>
      ) : null}

      {/* Items */}
      <ol className="space-y-3">
        {items.map((item) => (
          <ItemCard
            key={item.id}
            item={item}
            proposalId={proposalId}
            selected={checked.has(item.id)}
            selectable={canApprove && !item.appliedAt && !blocked.has(item.id)}
            blocked={blocked.has(item.id)}
            onToggle={() => toggle(item.id)}
            onEdited={() => {
              setChecked(new Set());
              setNotice(
                'Item saved. Any earlier approval of this proposal was revoked and every item is pending again.',
              );
              router.refresh();
            }}
            onError={(message) => setError(message)}
          />
        ))}
      </ol>

      {pending.length > 0 && canApprove ? (
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={reject} loading={busy === 'reject'}>
            Reject the whole proposal
          </Button>
        </div>
      ) : null}

      {/* Readback */}
      {readback.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Database className="size-4" />
              Readback — what is actually stored
            </CardTitle>
            <CardDescription>
              Read back out of the database after writing, not taken from the write itself.
            </CardDescription>
          </CardHeader>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Record</TableHead>
                <TableHead>Table / row</TableHead>
                <TableHead>Stored values</TableHead>
                <TableHead>Applied</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {readback.map((entry) => (
                <TableRow key={entry.rowId}>
                  <TableCell className="max-w-[14rem]">
                    <p className="font-medium">{entry.label}</p>
                    <Badge variant={entry.readbackOk ? 'success' : 'destructive'} className="mt-1">
                      {entry.readbackOk ? 'Matches approved values' : 'Differs from approved values'}
                    </Badge>
                  </TableCell>
                  <TableCell className="break-all font-mono text-xs">
                    {entry.table}
                    <br />
                    <span className="text-muted-foreground">{entry.rowId}</span>
                  </TableCell>
                  <TableCell className="max-w-sm">
                    <dl className="space-y-0.5 text-xs">
                      {Object.entries(entry.current ?? {})
                        .filter(([key, value]) => !HIDDEN_FIELDS.has(key) && value !== null && value !== '')
                        .slice(0, 6)
                        .map(([key, value]) => (
                          <div key={key} className="flex gap-1.5">
                            <dt className="shrink-0 font-mono text-muted-foreground">{key}</dt>
                            <dd className="min-w-0 break-words">{describe(value)}</dd>
                          </div>
                        ))}
                    </dl>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {formatDateTime(entry.appliedAt)}
                    <br />
                    {entry.appliedByEmail ?? 'unknown'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      ) : null}

      {/* Approval history */}
      {approvals.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <History className="size-4" />
              Approval history
            </CardTitle>
            <CardDescription>
              An approval is bound to one version. A revoked approval can never be applied.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {approvals.map((approval) => (
              <div
                key={approval.id}
                className="flex flex-wrap items-center gap-2 rounded-md border p-2.5 text-sm"
              >
                {approval.revokedAt ? (
                  <Badge variant="muted">Revoked</Badge>
                ) : approval.version === version ? (
                  <Badge variant="success">
                    <CheckCircle2 />
                    Live
                  </Badge>
                ) : (
                  <Badge variant="outline">Superseded</Badge>
                )}
                <span>
                  {approval.itemCount} item(s) at version {approval.version}
                </span>
                <span className="text-muted-foreground">
                  by {approval.approvedByEmail ?? 'unknown'} · {formatDateTime(approval.approvedAt)}
                </span>
                {approval.revokedReason ? (
                  <p className="w-full text-xs text-muted-foreground">{approval.revokedReason}</p>
                ) : null}
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      {!hasLiveApproval && pending.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          No live approval exists for version {version}. Selecting items and choosing
          &ldquo;Approve and save&rdquo; records one and applies it in a single transaction.
        </p>
      ) : null}
      {status === 'applied' ? (
        <p className="text-xs text-muted-foreground">
          Every item in this proposal has been settled. Re-sending the same approval writes nothing
          new.
        </p>
      ) : null}
    </div>
  );
}

function ItemCard({
  item,
  proposalId,
  selected,
  selectable,
  blocked,
  onToggle,
  onEdited,
  onError,
}: {
  item: ReviewItem;
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
  const effective = { ...item.newValues, ...(item.editedValues ?? {}) };
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      Object.entries(effective)
        .filter(([, value]) => !isRef(value))
        .map(([key, value]) => [key, value === null || value === undefined ? '' : String(value)]),
    ),
  );

  const fields = Object.keys(effective).filter((key) => !HIDDEN_FIELDS.has(key));

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
      onError(
        failure instanceof RequestFailed ? failure.payload.error : 'Could not save the edit.',
      );
    } finally {
      setSaving(false);
    }
  };

  const sourceUrls = Array.isArray(item.provenance.source_urls)
    ? (item.provenance.source_urls as string[])
    : [];
  const blockers = Array.isArray(item.provenance.blockers) ? (item.provenance.blockers as string[]) : [];

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
          <span className="mt-0.5 w-4 shrink-0 text-center text-xs font-mono text-muted-foreground">
            {item.seq}
          </span>
        )}

        <div className="min-w-0 flex-1 space-y-2.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <OpBadge op={item.op} />
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{item.targetTable}</code>
            <span className="text-sm font-medium">{item.label}</span>
            <MatchStatusBadge status={item.matchStatus} />
            <ClaimTypeBadge type={item.claimType} />
            {item.confidence ? <Badge variant="outline">{titleCase(item.confidence)}</Badge> : null}
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

          {/* Ambiguous candidates */}
          {item.candidates
            .filter((c) => c.status === 'ambiguous' && (c.candidates?.length ?? 0) > 0)
            .map((candidate, index) => (
              <div key={index} className="rounded-md border border-warning/40 bg-warning/5 p-2.5 text-xs">
                <p className="font-medium">
                  Ambiguous match for {candidate.field ? `${candidate.field}: ` : ''}
                  &ldquo;{candidate.query}&rdquo;
                </p>
                <ul className="mt-1 space-y-0.5">
                  {candidate.candidates?.slice(0, 4).map((c) => (
                    <li key={c.id} className="flex items-center gap-1.5 text-muted-foreground">
                      <Link2 className="size-3" />
                      {c.displayName} — {c.similarity.toFixed(2)} ({c.matchedVia.replace(/_/g, ' ')})
                    </li>
                  ))}
                </ul>
                {candidate.rationale ? (
                  <p className="mt-1 text-muted-foreground">{candidate.rationale}</p>
                ) : null}
              </div>
            ))}

          {item.dependsOnSeq.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              Depends on item{item.dependsOnSeq.length > 1 ? 's' : ''} {item.dependsOnSeq.join(', ')}.
              Approve them together, or neither.
            </p>
          ) : null}

          {/* Field diff */}
          <div className="scroll-x rounded-md border">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-2.5 py-1.5 text-left font-medium">Field</th>
                  <th className="px-2.5 py-1.5 text-left font-medium">Old</th>
                  <th className="px-2.5 py-1.5 text-left font-medium">New</th>
                </tr>
              </thead>
              <tbody>
                {fields.map((field) => {
                  const oldValue = item.oldValues ? item.oldValues[field] : undefined;
                  const newValue = effective[field];
                  const changed =
                    !item.oldValues || String(oldValue ?? '') !== String(newValue ?? '');
                  return (
                    <tr key={field} className="border-b last:border-0">
                      <td className="px-2.5 py-1.5 align-top font-mono text-muted-foreground">
                        {field}
                      </td>
                      <td className="px-2.5 py-1.5 align-top text-muted-foreground">
                        {item.oldValues ? describe(oldValue) : <em>new record</em>}
                      </td>
                      <td className={cn('px-2.5 py-1.5 align-top', changed && 'font-medium')}>
                        {editing && !isRef(newValue) ? (
                          (String(newValue ?? '').length > 80 ? (
                            <Textarea
                              value={draft[field] ?? ''}
                              onChange={(event) =>
                                setDraft((prev) => ({ ...prev, [field]: event.target.value }))
                              }
                              className="min-h-[70px] text-xs"
                            />
                          ) : (
                            <Input
                              value={draft[field] ?? ''}
                              onChange={(event) =>
                                setDraft((prev) => ({ ...prev, [field]: event.target.value }))
                              }
                              className="h-7 text-xs"
                            />
                          ))
                        ) : (
                          describe(newValue)
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {sourceUrls.length > 0 ? (
            <div className="text-xs text-muted-foreground">
              <span className="font-medium">Sources: </span>
              {sourceUrls.map((url, index) => (
                <span key={url}>
                  {index > 0 ? ', ' : ''}
                  <a
                    href={url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="break-all underline underline-offset-2"
                  >
                    {url}
                  </a>
                </span>
              ))}
            </div>
          ) : null}

          {item.appliedRowId ? (
            <p className="break-all font-mono text-xs text-muted-foreground">
              Saved as {item.targetTable}/{item.appliedRowId} at {formatDateTime(item.appliedAt)}
            </p>
          ) : null}
          {item.applyError ? (
            <p className="text-xs text-destructive">{item.applyError}</p>
          ) : null}

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
                    Saving an edit revokes any approval already given for this proposal.
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
