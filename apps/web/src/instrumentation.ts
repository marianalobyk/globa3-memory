/**
 * Runs once when the server process starts (Next.js instrumentation hook).
 *
 * Opens a few database connections ahead of the first request; see
 * instrumentation-node.ts. The runtime check must wrap the import directly so
 * the Node-only database code is left out of the Edge bundle.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./instrumentation-node');
  }
}
