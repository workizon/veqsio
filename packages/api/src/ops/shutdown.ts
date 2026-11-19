import { logger } from './logger';
import { setDraining } from './readiness';

export interface ShutdownDeps {
  /** stop accepting new connections; resolves when in-flight requests are done (Bun: server.stop()) */
  stopListening: () => Promise<void> | void;
  /** hard-close what is left (WebSockets); Bun: server.stop(true) */
  forceClose: () => Promise<void> | void;
  stopJobs: () => void;
  closeDb: () => Promise<void>;
  inFlight: () => number;
  sleep?: (ms: number) => Promise<void>;
  exit: (code: number) => void;
}

/**
 * Graceful shutdown on SIGTERM / SIGINT:
 *  1. /ready turns 503 (the load balancer stops sending new requests) while /health stays 200;
 *  2. wait SHUTDOWN_DRAIN_MS (default 5 s in production, 0 otherwise) so the balancer notices;
 *  3. stop the job timers, stop listening, wait for in-flight requests up to SHUTDOWN_TIMEOUT_MS (default 25 s);
 *  4. close WebSockets and the database pool, exit 0.
 * A job that is running when the signal arrives is not interrupted; its advisory lock is released with its
 * transaction when the pool closes, so another node picks the work up on its next tick.
 */
export async function gracefulShutdown(signal: string, deps: ShutdownDeps, env: Record<string, string | undefined> = process.env): Promise<void> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const drainMs = Number(env.SHUTDOWN_DRAIN_MS ?? (env.NODE_ENV === 'production' ? 5000 : 0));
  const timeoutMs = Number(env.SHUTDOWN_TIMEOUT_MS ?? 25000);
  logger.info('shutdown requested', { signal, drain_ms: drainMs, timeout_ms: timeoutMs });
  setDraining(true);
  if (drainMs > 0) await sleep(drainMs);
  deps.stopJobs();
  const deadline = Date.now() + timeoutMs;
  try {
    await Promise.race([Promise.resolve(deps.stopListening()), sleep(timeoutMs)]);
    while (deps.inFlight() > 0 && Date.now() < deadline) await sleep(100);
    if (deps.inFlight() > 0) logger.warn('shutdown timeout, closing with requests in flight', { in_flight: deps.inFlight() });
    await deps.forceClose();
    await Promise.race([deps.closeDb(), sleep(5000)]);
    logger.info('shutdown complete');
    deps.exit(0);
  } catch (e) {
    logger.error('shutdown failed', { error: e });
    deps.exit(1);
  }
}
