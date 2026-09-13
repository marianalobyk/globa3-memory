/**
 * Activity log: who did what, when, to which record.
 *
 * Written inside the same transaction as the change it describes, so the audit
 * trail cannot disagree with the data.
 */
import { assertScope, type Queryable } from './db.js';

export interface ActivityInput {
  workspaceId: string;
  actorId?: string | null;
  actorKind?: 'user' | 'worker' | 'system';
  action: string;
  subjectTable?: string | null;
  subjectId?: string | null;
  summary?: string | null;
  data?: Record<string, unknown>;
}

export async function logActivity(db: Queryable, input: ActivityInput): Promise<void> {
  assertScope(input.workspaceId, 'logActivity');
  await db.query(
    `insert into public.activity_log
       (workspace_id, actor_id, actor_kind, action, subject_table, subject_id, summary, data)
     values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
    [
      input.workspaceId,
      input.actorId ?? null,
      input.actorKind ?? (input.actorId ? 'user' : 'system'),
      input.action,
      input.subjectTable ?? null,
      input.subjectId ?? null,
      input.summary ?? null,
      JSON.stringify(input.data ?? {}),
    ],
  );
}

export interface ActivityRow {
  id: string;
  actor_kind: string;
  actor_email: string | null;
  actor_name: string | null;
  action: string;
  subject_table: string | null;
  subject_id: string | null;
  summary: string | null;
  data: Record<string, unknown>;
  created_at: string;
}

export async function listActivity(
  db: Queryable,
  workspaceId: string,
  limit = 100,
  offset = 0,
): Promise<ActivityRow[]> {
  assertScope(workspaceId, 'listActivity');
  return db.rows<ActivityRow>(
    `select a.id, a.actor_kind, u.email as actor_email, u.display_name as actor_name,
            a.action, a.subject_table, a.subject_id, a.summary, a.data, a.created_at
       from public.activity_log a
       left join public.app_users u on u.id = a.actor_id
      where a.workspace_id = $1
      order by a.created_at desc, a.id desc
      limit $2 offset $3`,
    [workspaceId, limit, offset],
  );
}
