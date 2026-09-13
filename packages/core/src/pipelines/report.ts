/**
 * Daily Markdown report.
 *
 * Built entirely from applied_changes, so it states what actually changed rather
 * than what was proposed. For every change it names: the table and row, the
 * old and new values, who approved it, who applied it, and which brief or
 * research run it came from.
 *
 * No model is involved -- this is a rendering of the audit trail.
 */
import { startOfZonedDay, toZonedDate, toZonedIso } from '@g3/shared';
import { assertScope, withService, type Queryable } from './../db.js';
import { getStorage, reportKey } from '../storage.js';
import { logActivity } from '../activity.js';

interface ChangeRow {
  id: string;
  table_name: string;
  row_id: string;
  op: string;
  before_values: Record<string, unknown> | null;
  after_values: Record<string, unknown> | null;
  readback_values: Record<string, unknown> | null;
  readback_ok: boolean | null;
  applied_at: string;
  applied_by_email: string | null;
  applied_by_name: string | null;
  item_label: string;
  item_claim_type: string | null;
  item_reason: string | null;
  item_provenance: Record<string, unknown> | null;
  proposal_title: string;
  proposal_source_kind: string;
  proposal_is_mock: boolean;
  approved_by_email: string | null;
  approved_at: string | null;
  brief_title: string | null;
  brief_run_date: string | null;
  format_name: string | null;
}

/** Columns that carry no meaning in a change report. */
const NOISE_COLUMNS = new Set([
  'id', 'workspace_id', 'created_at', 'updated_at', 'slug', 'alias_slug', 'mention_slug',
]);

function describeValue(value: unknown): string {
  if (value === null || value === undefined) return '_empty_';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > 240 ? `${collapsed.slice(0, 240)}…` : collapsed;
}

function fieldChanges(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): { column: string; from: string; to: string }[] {
  if (!after) return [];
  const columns = new Set([...Object.keys(before ?? {}), ...Object.keys(after)]);
  const changes: { column: string; from: string; to: string }[] = [];
  for (const column of [...columns].sort()) {
    if (NOISE_COLUMNS.has(column)) continue;
    const from = before ? before[column] : undefined;
    const to = after[column];
    if (before && String(from ?? '') === String(to ?? '')) continue;
    if (!before && (to === null || to === undefined || to === '')) continue;
    changes.push({ column, from: before ? describeValue(from) : '_new record_', to: describeValue(to) });
  }
  return changes;
}

/**
 * Day boundaries for a report, computed in the WORKSPACE timezone.
 *
 * Not in the database session's timezone and not in UTC: either would put a
 * change into the wrong day's report whenever the two disagree, which is most
 * evenings. The bounds are passed to SQL as explicit timestamps so no `::date`
 * cast can reinterpret them.
 */
export function reportDayBounds(reportDate: string, timeZone: string): { startIso: string; endIso: string } {
  const start = startOfZonedDay(reportDate, timeZone);
  const nextDay = toZonedDate(new Date(start.getTime() + 36 * 3_600_000), timeZone);
  const end = startOfZonedDay(nextDay, timeZone);
  return { startIso: toZonedIso(start, timeZone), endIso: toZonedIso(end, timeZone) };
}

/** Today's date in the workspace timezone, for a default report date. */
export function todayInZone(timeZone: string): string {
  return toZonedDate(new Date(), timeZone);
}

export async function collectDailyChanges(
  db: Queryable,
  workspaceId: string,
  reportDate: string,
  timeZone: string,
): Promise<ChangeRow[]> {
  assertScope(workspaceId, 'collectDailyChanges');
  const { startIso, endIso } = reportDayBounds(reportDate, timeZone);
  return db.rows<ChangeRow>(
    `select c.id, c.table_name, c.row_id, c.op, c.before_values, c.after_values,
            c.readback_values, c.readback_ok, c.applied_at,
            au.email as applied_by_email, au.display_name as applied_by_name,
            i.label as item_label, i.claim_type as item_claim_type, i.reason as item_reason,
            i.provenance as item_provenance,
            p.title as proposal_title, p.source_kind as proposal_source_kind,
            p.is_mock as proposal_is_mock,
            apu.email as approved_by_email, ap.approved_at,
            b.title as brief_title, b.run_date as brief_run_date, f.name as format_name
       from public.applied_changes c
       join public.proposal_items i on i.id = c.proposal_item_id
       join public.proposals p on p.id = c.proposal_id
       left join public.app_users au on au.id = c.applied_by
       left join public.proposal_approvals ap on ap.id = c.approval_id
       left join public.app_users apu on apu.id = ap.approved_by
       left join public.brief_documents b on b.id = p.brief_document_id
       left join public.brief_formats f on f.id = b.format_id
      where c.workspace_id = $1
        and c.applied_at >= $2::timestamptz
        and c.applied_at < $3::timestamptz
      order by c.applied_at`,
    [workspaceId, startIso, endIso],
  );
}

export interface DailyReportResult {
  reportDate: string;
  bodyMd: string;
  changeCount: number;
  storagePath: string | null;
}

export async function buildDailyReport(
  workspaceId: string,
  reportDate: string,
  options?: { actorId?: string | null; persist?: boolean },
): Promise<DailyReportResult> {
  assertScope(workspaceId, 'buildDailyReport');

  const { changes, workspaceName, timeZone, bounds, runSummary, mockRuns } = await withService(async (db) => {
    const workspace = await db.oneOrFail<{ name: string; timezone: string }>(
      `select name, timezone from public.workspaces where id = $1`,
      [workspaceId],
    );
    const rows = await collectDailyChanges(db, workspaceId, reportDate, workspace.timezone);
    const bounds = reportDayBounds(reportDate, workspace.timezone);
    const runs = await db.rows<{
      kind: string;
      status: string;
      count: number;
      is_mock: boolean;
      format_name: string | null;
    }>(
      `select r.kind, r.status, count(*)::int as count, bool_or(r.is_mock) as is_mock,
              max(f.name) as format_name
         from public.runs r
         left join public.brief_formats f on f.id = r.format_id
        where r.workspace_id = $1
          and r.created_at >= $2::timestamptz and r.created_at < $3::timestamptz
        group by r.kind, r.status
        order by r.kind, r.status`,
      [workspaceId, bounds.startIso, bounds.endIso],
    );
    const mocks = await db.oneOrFail<{ n: number }>(
      `select count(*)::int as n from public.runs
        where workspace_id = $1 and is_mock
          and created_at >= $2::timestamptz and created_at < $3::timestamptz`,
      [workspaceId, bounds.startIso, bounds.endIso],
    );
    return {
      changes: rows,
      workspaceName: workspace.name,
      timeZone: workspace.timezone,
      bounds,
      runSummary: runs,
      mockRuns: mocks.n,
    };
  });

  const lines: string[] = [];
  lines.push(`# Daily change report — ${reportDate}`);
  lines.push('');
  lines.push(`**Workspace:** ${workspaceName}`);
  lines.push(`**Day boundaries (${timeZone}):** ${bounds.startIso} to ${bounds.endIso}`);
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push(`**Records changed:** ${changes.length}`);
  lines.push('');
  lines.push(
    'Every entry below is a change that was actually written to the database after a ' +
      'person approved it. Proposals that were not approved do not appear here.',
  );
  lines.push('');

  if (mockRuns > 0) {
    lines.push(
      `> **${mockRuns} run(s) today used the mock provider.** No live research was performed ` +
        'for those, and any records derived from them are synthetic. They are marked below.',
    );
    lines.push('');
  }

  if (runSummary.length > 0) {
    lines.push('## Runs today');
    lines.push('');
    for (const run of runSummary) {
      lines.push(
        `- ${run.count} × ${run.kind} — ${run.status}${run.format_name ? ` (${run.format_name})` : ''}${run.is_mock ? ' _[mock]_' : ''}`,
      );
    }
    lines.push('');
  }

  if (changes.length === 0) {
    lines.push('## Changes');
    lines.push('');
    lines.push('No records were changed on this date.');
  } else {
    // Grouped by origin, so provenance from briefs is visible at a glance.
    const byOrigin = new Map<string, ChangeRow[]>();
    for (const change of changes) {
      const origin = change.brief_title
        ? `${change.format_name ?? 'Brief'} — ${change.brief_title}${change.brief_run_date ? ` (${change.brief_run_date})` : ''}`
        : `${change.proposal_source_kind} — ${change.proposal_title}`;
      const list = byOrigin.get(origin) ?? [];
      list.push(change);
      byOrigin.set(origin, list);
    }

    lines.push('## Changes by origin');
    lines.push('');

    for (const [origin, group] of byOrigin) {
      lines.push(`### ${origin}`);
      lines.push('');
      if (group.some((c) => c.proposal_is_mock)) {
        lines.push('_Derived from a mock run: synthetic content._');
        lines.push('');
      }
      for (const change of group) {
        lines.push(`#### ${change.op.toUpperCase()} \`${change.table_name}\` — ${change.item_label}`);
        lines.push('');
        lines.push(`- **Row:** \`${change.row_id}\``);
        if (change.item_claim_type) lines.push(`- **Claim type:** ${change.item_claim_type}`);
        lines.push(
          `- **Approved by:** ${change.approved_by_email ?? 'unknown'}${change.approved_at ? ` at ${change.approved_at}` : ''}`,
        );
        lines.push(
          `- **Applied by:** ${change.applied_by_email ?? 'unknown'} at ${change.applied_at}`,
        );
        lines.push(
          `- **Readback:** ${change.readback_ok === true ? 'matched the approved values' : change.readback_ok === false ? '**did not match the approved values — inspect this record**' : 'not recorded'}`,
        );
        if (change.item_reason) lines.push(`- **Reason:** ${change.item_reason}`);

        const provenance = change.item_provenance ?? {};
        const sourceUrls = Array.isArray(provenance.source_urls) ? (provenance.source_urls as string[]) : [];
        if (sourceUrls.length > 0) {
          lines.push(`- **Sources:** ${sourceUrls.map((u) => `<${u}>`).join(', ')}`);
        }
        lines.push('');

        const diffs = fieldChanges(change.before_values, change.after_values);
        if (diffs.length > 0) {
          lines.push('| Field | Old | New |');
          lines.push('| --- | --- | --- |');
          for (const diff of diffs) {
            const escape = (value: string): string => value.replace(/\|/g, '\\|');
            lines.push(`| \`${diff.column}\` | ${escape(diff.from)} | ${escape(diff.to)} |`);
          }
          lines.push('');
        }
      }
    }

    // Flat table for quick scanning.
    lines.push('## All changes');
    lines.push('');
    lines.push('| Time | Table | Operation | Record | Approved by | Readback |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const change of changes) {
      lines.push(
        `| ${change.applied_at} | \`${change.table_name}\` | ${change.op} | ${change.item_label.replace(/\|/g, '\\|')} | ${change.approved_by_email ?? '—'} | ${change.readback_ok ? 'ok' : 'check'} |`,
      );
    }
    lines.push('');
  }

  const bodyMd = lines.join('\n');

  let storagePath: string | null = null;
  if (options?.persist !== false) {
    const storage = getStorage();
    const stored = await storage.put(
      workspaceId,
      reportKey(reportDate),
      Buffer.from(bodyMd, 'utf8'),
      'text/markdown',
    );
    storagePath = stored.key;

    await withService(async (db) => {
      await db.query(
        `insert into public.daily_reports
           (workspace_id, report_date, body_md, storage_path, change_count, generated_at)
         values ($1,$2,$3,$4,$5, now())
         on conflict (workspace_id, report_date) do update set
           body_md = excluded.body_md,
           storage_path = excluded.storage_path,
           change_count = excluded.change_count,
           generated_at = now()`,
        [workspaceId, reportDate, bodyMd, storagePath, changes.length],
      );
      await logActivity(db, {
        workspaceId,
        actorId: options?.actorId ?? null,
        actorKind: options?.actorId ? 'user' : 'system',
        action: 'report.generated',
        subjectTable: 'daily_reports',
        summary: `Daily report for ${reportDate}: ${changes.length} change(s).`,
        data: { reportDate, changeCount: changes.length },
      });
    });
  }

  return { reportDate, bodyMd, changeCount: changes.length, storagePath };
}
