import app from './app';
import { configureConnectionPool, client } from './db';
import { assertSchemaUpToDate } from './db/schema-guard';
import { initLicense } from './license';
import { syncModules, startModuleJobs } from './modules/host';
import { createServer } from './realtime/server';
import { startRedisFanout } from './realtime/hub';
import { installConsoleJson, logger } from './ops/logger';
import { processRole, runsJobs } from './ops/role';
import { startJobs, stopJobs } from './ops/jobs';
import { coreJobs } from './ops/core-jobs';
import { gracefulShutdown } from './ops/shutdown';
import { httpInFlight } from './ops/metrics';
import { initTracing, shutdownTracing } from './observability/tracing';

// Structured JSON logs (LOG_LEVEL, LOG_FORMAT): route every console.* call through the scrubbing logger.
if ((process.env.LOG_FORMAT || 'json').toLowerCase() !== 'raw') installConsoleJson();

// OpenTelemetry tracing: only when an OTLP endpoint is configured (docs/observability.md)
if (initTracing()) {
  let host = 'the configured endpoint';
  try { host = new URL(process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_ENDPOINT || '').host || host; } catch { /* not a URL: say nothing about it */ }
  logger.info('tracing enabled', { exporter: 'otlp-http', endpoint_host: host });
}

const port = Number(process.env.PORT) || 3000;
const role = processRole(); // throws on an invalid VEQSIO_ROLE: fail at startup, not silently run everything

configureConnectionPool();

// Refuse to run new code against an old schema (production / REQUIRE_MIGRATIONS=1; dev and tests use `drizzle-kit push`).
try {
  await assertSchemaUpToDate((q) => client.unsafe(q) as unknown as Promise<Array<Record<string, unknown>>>);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}

const licence = await initLicense();
console.log(`[licence] ${licence.message}`);

// Bundled modules (modules/*, ee/modules/*): register, migrate (when licensed), hook into core, start their jobs.
try { await syncModules(); await startModuleJobs(); } catch (e) { console.error('[modules] startup failed:', e); }

console.log(`Veqsio API starting on port ${port}`);
// HTTP + WebSocket (/ws) on the same port; app.fetch stays socket-free and testable.
const { server } = createServer({ port, fetch: app.fetch });
startRedisFanout().catch((e) => console.error('[realtime] Redis fan-out unavailable, instance-local only:', e?.message));


// Background jobs (email queue, SLA breaches, digests, intake snooze, approvals, IMAP, recurring issues). Each run
// takes a PostgreSQL advisory lock, so several nodes never double-run a job; VEQSIO_ROLE=web starts none.
const started = startJobs(coreJobs());
logger.info('ready', { role, port, jobs: runsJobs() ? started : 0 });

// Graceful shutdown: /ready turns 503, in-flight requests finish, pool closes.
let shuttingDown = false;
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void gracefulShutdown(sig, {
      stopListening: () => { void server.stop(); },
      forceClose: () => server.stop(true),
      stopJobs,
      closeDb: async () => { await shutdownTracing(); await client.end({ timeout: 5 }); },
      inFlight: () => httpInFlight.get(),
      exit: (code) => process.exit(code),
    });
  });
}
