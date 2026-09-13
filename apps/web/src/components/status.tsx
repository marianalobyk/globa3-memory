import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  CircleDashed,
  Clock,
  FileWarning,
  GitCompare,
  HelpCircle,
  Link2,
  Loader2,
  Pencil,
  Plus,
  ShieldAlert,
  SkipForward,
  XCircle,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { titleCase } from '@/lib/utils';

/**
 * One place where every status becomes a colour and a word.
 *
 * The colour choices carry meaning rather than decoration: green only for
 * something finished and verified, amber for something that needs a person,
 * red for blocked or failed, neutral for informational.
 */

export function RunStatusBadge({ status, isMock }: { status: string; isMock?: boolean }) {
  const map: Record<string, { variant: Parameters<typeof Badge>[0]['variant']; icon: React.ReactNode }> = {
    queued: { variant: 'secondary', icon: <Clock /> },
    running: { variant: 'default', icon: <Loader2 className="animate-spin" /> },
    succeeded: { variant: 'success', icon: <CheckCircle2 /> },
    failed: { variant: 'destructive', icon: <XCircle /> },
    canceled: { variant: 'muted', icon: <Ban /> },
  };
  const entry = map[status] ?? { variant: 'outline' as const, icon: <CircleDashed /> };
  return (
    <span className="inline-flex items-center gap-1.5">
      <Badge variant={entry.variant}>
        {entry.icon}
        {titleCase(status)}
      </Badge>
      {isMock ? <Badge variant="warning">Mock</Badge> : null}
    </span>
  );
}

/**
 * A format's release gate. Deliberately never rendered as plain "approved":
 * a QA pass is not a person approving a database record.
 */
export function QaStatusBadge({ status }: { status: string | null }) {
  if (!status || status === 'not_run') return <Badge variant="muted">QA not run</Badge>;
  const map: Record<string, { variant: Parameters<typeof Badge>[0]['variant']; label: string; icon: React.ReactNode }> = {
    pass_internal_only: { variant: 'success', label: 'QA pass — internal only', icon: <CheckCircle2 /> },
    pass_quiet_window_internal_only: {
      variant: 'success',
      label: 'QA pass — quiet window',
      icon: <CheckCircle2 />,
    },
    review_internal_only: { variant: 'warning', label: 'QA review needed', icon: <AlertTriangle /> },
    fail_do_not_distribute: { variant: 'destructive', label: 'QA fail — do not distribute', icon: <FileWarning /> },
  };
  const entry = map[status];
  if (!entry) return <Badge variant="outline">{titleCase(status)}</Badge>;
  return (
    <Badge variant={entry.variant}>
      {entry.icon}
      {entry.label}
    </Badge>
  );
}

export function ProposalStatusBadge({ status }: { status: string }) {
  const map: Record<string, { variant: Parameters<typeof Badge>[0]['variant']; label: string }> = {
    draft: { variant: 'secondary', label: 'Draft' },
    pending_review: { variant: 'warning', label: 'Needs review' },
    partially_applied: { variant: 'default', label: 'Partly applied' },
    applied: { variant: 'success', label: 'Applied' },
    rejected: { variant: 'muted', label: 'Rejected' },
    superseded: { variant: 'muted', label: 'Superseded' },
  };
  const entry = map[status] ?? { variant: 'outline' as const, label: titleCase(status) };
  return <Badge variant={entry.variant}>{entry.label}</Badge>;
}

/** Resolution outcome for a proposed record. */
export function MatchStatusBadge({ status }: { status: string }) {
  if (status === 'existing') {
    return (
      <Badge variant="secondary">
        <Link2 />
        Existing record
      </Badge>
    );
  }
  if (status === 'ambiguous') {
    return (
      <Badge variant="warning">
        <HelpCircle />
        Ambiguous — needs a decision
      </Badge>
    );
  }
  return (
    <Badge variant="outline">
      <Plus />
      New record
    </Badge>
  );
}

export function DecisionBadge({ decision, applied }: { decision: string; applied?: boolean }) {
  if (applied) {
    return (
      <Badge variant="success">
        <CheckCircle2 />
        Applied
      </Badge>
    );
  }
  if (decision === 'approved') {
    return (
      <Badge variant="default">
        <CheckCircle2 />
        Approved
      </Badge>
    );
  }
  if (decision === 'rejected') {
    return (
      <Badge variant="muted">
        <XCircle />
        Rejected
      </Badge>
    );
  }
  return (
    <Badge variant="outline">
      <CircleDashed />
      Pending
    </Badge>
  );
}

export function OpBadge({ op }: { op: string }) {
  const map: Record<string, { icon: React.ReactNode; label: string }> = {
    create: { icon: <Plus />, label: 'Create' },
    update: { icon: <Pencil />, label: 'Update' },
    link: { icon: <Link2 />, label: 'Link' },
    attach: { icon: <GitCompare />, label: 'Attach' },
    skip: { icon: <SkipForward />, label: 'Skip' },
  };
  const entry = map[op] ?? { icon: <CircleDashed />, label: titleCase(op) };
  return (
    <Badge variant="outline" className="font-mono text-[0.6875rem] uppercase">
      {entry.icon}
      {entry.label}
    </Badge>
  );
}

export function ClaimTypeBadge({ type }: { type: string | null }) {
  if (!type) return null;
  const map: Record<string, Parameters<typeof Badge>[0]['variant']> = {
    fact: 'secondary',
    inference: 'outline',
    recommendation: 'outline',
    next_step: 'outline',
    gap: 'warning',
    risk: 'destructive',
  };
  return <Badge variant={map[type] ?? 'outline'}>{titleCase(type)}</Badge>;
}

export function UploadStatusBadge({ status }: { status: string }) {
  const map: Record<string, { variant: Parameters<typeof Badge>[0]['variant']; icon: React.ReactNode }> = {
    pending: { variant: 'secondary', icon: <Clock /> },
    queued: { variant: 'secondary', icon: <Clock /> },
    processing: { variant: 'default', icon: <Loader2 className="animate-spin" /> },
    parsed: { variant: 'success', icon: <CheckCircle2 /> },
    failed: { variant: 'destructive', icon: <XCircle /> },
    skipped: { variant: 'muted', icon: <SkipForward /> },
    rejected: { variant: 'destructive', icon: <ShieldAlert /> },
  };
  const entry = map[status] ?? { variant: 'outline' as const, icon: <CircleDashed /> };
  return (
    <Badge variant={entry.variant}>
      {entry.icon}
      {titleCase(status)}
    </Badge>
  );
}

export function ConfidenceBadge({ confidence }: { confidence: string | null }) {
  if (!confidence) return null;
  const map: Record<string, Parameters<typeof Badge>[0]['variant']> = {
    high: 'secondary',
    medium: 'outline',
    low: 'warning',
  };
  return <Badge variant={map[confidence] ?? 'outline'}>{titleCase(confidence)} confidence</Badge>;
}

export function PriorityBadge({ priority }: { priority: string }) {
  const map: Record<string, Parameters<typeof Badge>[0]['variant']> = {
    high: 'default',
    medium: 'secondary',
    low: 'muted',
    skip: 'muted',
  };
  return <Badge variant={map[priority] ?? 'outline'}>{titleCase(priority)}</Badge>;
}
