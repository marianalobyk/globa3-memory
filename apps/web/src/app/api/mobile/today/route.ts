import { CAPTURE_PHASES, capturePhase } from '@g3/shared';
import { handler, ok } from '@/lib/api';
import { displayLabel, proposalSourceLabel, recordKind, plainKind, plainTitle } from '@/lib/labels';
import { loadTodayData } from '@/lib/page-data';
import { requireApiSession } from '@/lib/session';

/**
 * The mobile home screen, from the same loader as the web home page: what awaits
 * approval, what is being analysed, and what was saved. Plain words only.
 */
export const GET = handler(async () => {
  const session = await requireApiSession();
  const data = await loadTodayData(session);
  const savedToday = data.saved[0]?.total ?? 0;
  const saved = savedToday > 0 ? data.saved : data.recent;

  return ok({
    date: data.today,
    awaiting: data.awaiting,
    decisions: data.decisions.map((p) => ({
      proposalId: p.id,
      title: displayLabel(p.title),
      sourceLabel: proposalSourceLabel(p.source_kind),
      awaiting: p.awaiting,
      createdAt: p.created_at,
      isMock: p.is_mock,
    })),
    analysing: data.runs.map((run) => ({
      captureId: run.capture_id,
      title:
        run.kind === 'research'
          ? `Research: ${run.target_label ?? 'requested target'}`
          : run.capture_kind === 'file'
            ? 'Captured file'
            : run.capture_kind === 'url'
              ? 'Captured link'
              : 'Captured note',
      phaseLabel:
        run.status === 'failed'
          ? 'Stopped'
          : run.kind === 'research'
            ? run.status === 'queued'
              ? 'Waiting to start'
              : 'Researching'
            : CAPTURE_PHASES[capturePhase(run.capture_status ?? 'received', run.status === 'queued' ? null : run.current_stage)],
      failed: run.status === 'failed',
      createdAt: run.created_at,
    })),
    savedTitle: savedToday > 0 ? 'Saved today' : 'Recently saved',
    savedToday,
    saved: saved.map((change) => ({
      label: plainTitle(change.label),
      kind: plainKind(recordKind(change.table_name, { entity_type: change.entity_type })),
      verb: change.op === 'update' ? 'Updated' : change.op === 'link' ? 'Linked' : 'Saved',
      savedAt: change.applied_at,
      proposalId: change.proposal_id,
    })),
  });
});
