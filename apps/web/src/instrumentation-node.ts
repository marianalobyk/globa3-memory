/**
 * Pool warm-up at server start (Node.js runtime only).
 *
 * Against the Supabase pooler each new database connection costs ~0.7-1 s of
 * TCP, TLS and auth, so without this the first screen after a restart pays
 * several of them. Best effort: a failure only means the first request opens
 * its own connections. G3_WARM_POOL sets how many (0 disables).
 */
import { warmPool } from '@g3/core';

const count = Number(process.env.G3_WARM_POOL ?? 3);
if (count > 0) {
  warmPool(count)
    .then((opened) => console.log(`[db] warmed ${opened} connection(s)`))
    .catch((error: unknown) =>
      console.warn('[db] pool warm-up skipped:', error instanceof Error ? error.message : String(error)),
    );
}
