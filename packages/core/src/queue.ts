/**
 * Job queue on Supabase Queues (pgmq).
 *
 * Uses pgmq's own functions, so this is the real Supabase Queues API in
 * production and a SQL-compatible implementation of the same functions in a
 * local test database (see migration 0008).
 *
 * Delivery model: a read() claims a message and hides it for a visibility
 * timeout. The worker extends that lease while it makes progress, then archives
 * the message. If the worker dies, the lease lapses and the message becomes
 * visible again -- which is what makes crash recovery work without a scheduler.
 */
import { withService, type Queryable } from './db.js';
import { env } from './env.js';

export const QUEUE_RUNS = 'g3_runs';
export const QUEUE_INGEST = 'g3_ingest';

export interface JobPayload {
  runId: string;
  workspaceId: string;
  kind: string;
  /** Incremented by the producer so a retry is distinguishable in logs. */
  enqueuedAt: string;
}

export interface QueueMessage<T = JobPayload> {
  msgId: string;
  readCount: number;
  enqueuedAt: Date;
  visibleAt: Date;
  payload: T;
}

export async function sendJob(
  db: Queryable,
  queue: string,
  payload: JobPayload,
  delaySeconds = 0,
): Promise<string> {
  const row = await db.oneOrFail<{ msg_id: string }>(
    `select pgmq.send($1, $2::jsonb, $3) as msg_id`,
    [queue, JSON.stringify(payload), delaySeconds],
  );
  return row.msg_id;
}

export async function readJobs<T = JobPayload>(
  queue: string,
  quantity = 1,
  visibilityTimeoutSeconds = env().WORKER_VISIBILITY_TIMEOUT_S,
): Promise<QueueMessage<T>[]> {
  return withService(async (db) => {
    const rows = await db.rows<{
      msg_id: string;
      read_ct: number;
      enqueued_at: Date;
      vt: Date;
      message: T;
    }>(`select * from pgmq.read($1, $2, $3)`, [queue, visibilityTimeoutSeconds, quantity]);
    return rows.map((r) => ({
      msgId: r.msg_id,
      readCount: r.read_ct,
      enqueuedAt: r.enqueued_at,
      visibleAt: r.vt,
      payload: r.message,
    }));
  });
}

/** Extends the lease on an in-flight message. Called from the heartbeat. */
export async function extendLease(
  queue: string,
  msgId: string,
  seconds = env().WORKER_VISIBILITY_TIMEOUT_S,
): Promise<void> {
  await withService((db) => db.query(`select pgmq.set_vt($1, $2, $3)`, [queue, msgId, seconds]));
}

/** Makes a message immediately visible again, for an intentional retry. */
export async function releaseJob(queue: string, msgId: string, delaySeconds = 0): Promise<void> {
  await withService((db) => db.query(`select pgmq.set_vt($1, $2, $3)`, [queue, msgId, delaySeconds]));
}

export async function archiveJob(queue: string, msgId: string): Promise<void> {
  await withService((db) => db.query(`select pgmq.archive($1, $2)`, [queue, msgId]));
}

export async function deleteJob(queue: string, msgId: string): Promise<void> {
  await withService((db) => db.query(`select pgmq.delete($1, $2)`, [queue, msgId]));
}

export async function queueDepth(queue: string): Promise<{ pending: number; inFlight: number }> {
  return withService(async (db) => {
    const row = await db.one<{ pending: number; in_flight: number }>(
      `select
         count(*) filter (where vt <= now())::int as pending,
         count(*) filter (where vt > now())::int as in_flight
       from pgmq.messages where queue_name = $1`,
      [queue],
    );
    return { pending: row?.pending ?? 0, inFlight: row?.in_flight ?? 0 };
  }).catch(async () =>
    // Real pgmq stores messages in per-queue tables; use its metrics view.
    withService(async (db) => {
      const row = await db.one<{ queue_length: number }>(
        `select queue_length from pgmq.metrics($1)`,
        [queue],
      );
      return { pending: row?.queue_length ?? 0, inFlight: 0 };
    }),
  );
}
