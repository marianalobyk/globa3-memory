/**
 * Background worker.
 *
 * Reads jobs from Supabase Queues, runs the pipeline for each, and keeps the
 * lease alive while it works. Nothing here depends on an HTTP request or an open
 * browser tab: the web app only enqueues, and a long research run continues after
 * the user closes the page.
 *
 * Failure behaviour, in one place so it is auditable:
 *
 *   - Lease. Claiming a run sets lease_owner and lease_expires_at, and a heartbeat
 *     extends both the run lease and the queue message's visibility timeout. If
 *     this process dies, both lapse: the queue redelivers the message and
 *     reclaimStaleRuns() returns the run to `queued`.
 *   - Resume, not restart. Every stage stores its output, so a redelivered run
 *     skips completed stages. A deep-research stage additionally stores the
 *     provider response id, so a restart resumes polling the same background
 *     research instead of paying for it twice.
 *   - Duplicate delivery. claimRun() only succeeds when no live lease exists, so a
 *     second delivery of the same message is a no-op rather than a second run.
 *   - Retries. A failure below the attempt ceiling returns the run to `queued` and
 *     releases the message with backoff. At the ceiling the run is marked failed
 *     and the message is archived, so it does not spin.
 */
import {
  archiveJob,
  claimRun,
  closePool,
  completeRun,
  env,
  extendLease,
  failRun,
  getAiProvider,
  heartbeatRun,
  QUEUE_INGEST,
  QUEUE_RUNS,
  readJobs,
  reclaimStaleRuns,
  releaseJob,
  requeueRun,
  runBriefPipeline,
  runIngestPipeline,
  runResearchPipeline,
  withService,
  type JobPayload,
  type PipelineContext,
  type QueueMessage,
  type RunRecord,
} from '@g3/core';
import { hostname } from 'node:os';

const config = env();
const workerId = config.WORKER_ID ?? `${hostname()}-${process.pid}`;
const provider = getAiProvider();

let running = true;
let activeJobs = 0;

const log = (level: 'info' | 'warn' | 'error', message: string, extra?: unknown): void => {
  const line = `[worker ${workerId}] ${new Date().toISOString()} ${level.toUpperCase()} ${message}`;
  if (level === 'error') console.error(line, extra ?? '');
  else if (level === 'warn') console.warn(line, extra ?? '');
  else console.log(line, extra ?? '');
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff, capped, so a persistently failing job stops hammering. */
function backoffSeconds(attempt: number): number {
  return Math.min(300, 15 * 2 ** Math.max(0, attempt - 1));
}

async function handleRun(queue: string, message: QueueMessage<JobPayload>): Promise<void> {
  const { runId, workspaceId, kind } = message.payload;
  if (!runId || !workspaceId) {
    log('warn', `Message ${message.msgId} has no runId/workspaceId; archiving it.`);
    await archiveJob(queue, message.msgId);
    return;
  }

  const run: RunRecord | null = await claimRun(runId, workerId, config.WORKER_VISIBILITY_TIMEOUT_S);
  if (!run) {
    // Another worker holds a live lease, or the run is already finished.
    log('info', `Run ${runId} is not claimable (already leased or finished); archiving message.`);
    await archiveJob(queue, message.msgId);
    return;
  }

  if (run.status === 'succeeded' || run.status === 'canceled') {
    await archiveJob(queue, message.msgId);
    return;
  }

  log(
    'info',
    `Claimed run ${runId} (${kind}, attempt ${run.attempt}/${run.max_attempts}${run.is_mock ? ', mock' : ''}).`,
  );

  // Heartbeat extends the run lease and the queue message together, so a job
  // that is genuinely still working is never redelivered underneath itself.
  let heartbeatFailed = false;
  const heartbeat = setInterval(() => {
    void (async () => {
      try {
        const held = await heartbeatRun(runId, workerId, config.WORKER_VISIBILITY_TIMEOUT_S);
        if (!held) {
          heartbeatFailed = true;
          log('warn', `Lost the lease on run ${runId}; another worker may have taken it.`);
          return;
        }
        await extendLease(queue, message.msgId, config.WORKER_VISIBILITY_TIMEOUT_S);
      } catch (error) {
        log('warn', `Heartbeat for run ${runId} failed`, error);
      }
    })();
  }, config.WORKER_HEARTBEAT_INTERVAL_MS);

  const ctx: PipelineContext = {
    run,
    workspaceId,
    provider,
    keepAlive: async () => {
      if (heartbeatFailed) {
        throw new Error(
          `Lease on run ${runId} was lost, so this worker stopped to avoid two workers writing the same run.`,
        );
      }
      await heartbeatRun(runId, workerId, config.WORKER_VISIBILITY_TIMEOUT_S);
      await extendLease(queue, message.msgId, config.WORKER_VISIBILITY_TIMEOUT_S);
    },
  };

  try {
    let summary: unknown;
    switch (run.kind) {
      case 'brief':
        summary = await runBriefPipeline(ctx);
        break;
      case 'research':
        summary = await runResearchPipeline(ctx);
        break;
      case 'ingest':
        summary = await runIngestPipeline(ctx);
        break;
      default:
        throw new Error(`Worker does not handle run kind "${run.kind}"`);
    }

    clearInterval(heartbeat);
    await completeRun(workspaceId, runId);
    await archiveJob(queue, message.msgId);
    log('info', `Run ${runId} succeeded.`, summary);
  } catch (error) {
    clearInterval(heartbeat);
    const outcome = await failRun(workspaceId, runId, error, run.current_stage);
    log(
      outcome.willRetry ? 'warn' : 'error',
      `Run ${runId} failed on attempt ${outcome.attempt}/${outcome.maxAttempts}${outcome.willRetry ? '; will retry' : '; giving up'}.`,
      error instanceof Error ? error.message : error,
    );

    if (outcome.willRetry) {
      // Make the message visible again after a backoff. Completed stages are
      // stored, so the retry resumes rather than restarting.
      await releaseJob(queue, message.msgId, backoffSeconds(outcome.attempt));
    } else {
      await archiveJob(queue, message.msgId);
    }
  }
}

async function pollQueue(queue: string): Promise<number> {
  const capacity = config.WORKER_CONCURRENCY - activeJobs;
  if (capacity <= 0) return 0;

  const messages = await readJobs<JobPayload>(queue, capacity, config.WORKER_VISIBILITY_TIMEOUT_S);
  if (messages.length === 0) return 0;

  await Promise.all(
    messages.map(async (message) => {
      activeJobs += 1;
      try {
        await handleRun(queue, message);
      } catch (error) {
        log('error', `Unhandled error processing message ${message.msgId}`, error);
      } finally {
        activeJobs -= 1;
      }
    }),
  );
  return messages.length;
}

/**
 * Returns runs abandoned by a dead worker to `queued` and re-enqueues them. The
 * queue redelivers on its own via the visibility timeout; this also covers runs
 * whose message was already archived.
 */
async function recoverAbandonedRuns(): Promise<void> {
  const stale = await reclaimStaleRuns(config.WORKER_VISIBILITY_TIMEOUT_S);
  for (const run of stale) {
    log(
      'warn',
      `Recovered run ${run.id} abandoned by "${run.lease_owner ?? 'unknown'}" at stage "${run.current_stage ?? 'unknown'}"; re-enqueued.`,
    );
    await requeueRun(run.workspace_id, run.id, run.kind);
  }
}

async function main(): Promise<void> {
  log(
    'info',
    `Started. provider=${provider.kind}${provider.isMock ? ' (MOCK: no OPENAI_API_KEY, all output is synthetic and labelled)' : ''} concurrency=${config.WORKER_CONCURRENCY} visibilityTimeout=${config.WORKER_VISIBILITY_TIMEOUT_S}s`,
  );

  // A restart is the most likely moment to find abandoned work.
  await recoverAbandonedRuns();

  let idleCycles = 0;
  let lastRecovery = Date.now();

  while (running) {
    try {
      const handled = (await pollQueue(QUEUE_RUNS)) + (await pollQueue(QUEUE_INGEST));
      idleCycles = handled > 0 ? 0 : idleCycles + 1;

      // Periodic sweep for runs whose worker died without releasing anything.
      if (Date.now() - lastRecovery > config.WORKER_VISIBILITY_TIMEOUT_S * 1000) {
        await recoverAbandonedRuns();
        lastRecovery = Date.now();
      }

      // Back off gently while idle rather than polling hard.
      const wait = Math.min(config.WORKER_POLL_INTERVAL_MS * Math.max(1, Math.min(idleCycles, 8)), 15_000);
      await sleep(handled > 0 ? 50 : wait);
    } catch (error) {
      log('error', 'Poll cycle failed; retrying shortly.', error);
      await sleep(5_000);
    }
  }

  log('info', 'Draining; waiting for in-flight jobs.');
  const drainDeadline = Date.now() + 30_000;
  while (activeJobs > 0 && Date.now() < drainDeadline) await sleep(200);
  await closePool();
  log('info', 'Stopped.');
  process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (!running) process.exit(1);
    log('info', `${signal} received; finishing in-flight work then stopping.`);
    running = false;
  });
}

process.on('unhandledRejection', (reason) => {
  log('error', 'Unhandled rejection', reason);
});

await main();
