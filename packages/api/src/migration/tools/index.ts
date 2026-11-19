import { eq } from 'drizzle-orm'
import { db } from '../../db'
import * as schema from '@veqsio/db'
import { cancelMigration, clearCancellation, isCancelled } from '../service'
import { AsanaClient, ASANA_INFO } from './asana'
import { ClickupClient, CLICKUP_INFO } from './clickup'
import { runToolImport, type EngineHooks, type EngineOptions, type ToolReport } from './engine'
import { GenericJsonSource, GENERIC_INFO } from './generic'
import { LinearClient, LINEAR_INFO } from './linear'
import { UnsupportedCollector, type ExtractOptions, type SourceAdapter, type SourceInfo, type ToolSourceId } from './model'

export const SOURCE_INFO: Record<ToolSourceId, SourceInfo> = { linear: LINEAR_INFO, asana: ASANA_INFO, clickup: CLICKUP_INFO, json: GENERIC_INFO }

/**
 * Test hook: the integration tests swap in recorded fixtures and a no-op sleep so no request ever leaves the process.
 * Production code never sets this.
 */
let transport: { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {}
export function setToolTransportOverride(t: typeof transport) { transport = t }

export interface AdapterInput { token?: string; json?: string; namespace?: string }

export function createAdapter(source: ToolSourceId, input: AdapterInput): SourceAdapter {
  const common = { fetchImpl: transport.fetchImpl, sleep: transport.sleep }
  switch (source) {
    case 'linear': return new LinearClient({ token: input.token ?? '', ...common })
    case 'asana': return new AsanaClient({ token: input.token ?? '', ...common })
    case 'clickup': return new ClickupClient({ token: input.token ?? '', ...common })
    case 'json': return new GenericJsonSource(input.json ?? '', input.namespace)
  }
}

export interface ToolRunParams {
  source: ToolSourceId
  adapter: SourceAdapter
  extract: ExtractOptions
  engine: Omit<EngineOptions, 'source' | 'staticUnsupported'>
  userId: number
  /** Redacted from error messages. */
  secrets?: string[]
}

export function redact(message: string, secrets: string[] = []): string {
  let m = message
  for (const s of secrets) if (s && s.length >= 6) m = m.split(s).join('[redacted]')
  return m.replace(/Bearer\s+\S+/gi, '[redacted]').slice(0, 400)
}

/** Runs one import synchronously (used by the background job and directly by tests). */
export async function runSourceImport(
  p: ToolRunParams, hooks: EngineHooks = {},
): Promise<ToolReport> {
  const unsupported = new UnsupportedCollector()
  const ctx = { unsupported, isCancelled: hooks.isCancelled ?? (() => false) }
  return runToolImport(
    p.adapter.extract(p.extract, ctx), unsupported,
    { ...p.engine, source: p.source, staticUnsupported: SOURCE_INFO[p.source].unsupported },
    p.userId, hooks,
  )
}

/** Creates the session row and runs the import in the background; progress and the final report land in the row. */
export async function startToolImport(p: ToolRunParams & { storedOptions: Record<string, unknown> }): Promise<number> {
  const dryRun = !!p.engine.dryRun
  const [session] = await db.insert(schema.migrationSessions).values({
    status: 'running',
    backupPath: `${p.source}:${dryRun ? 'preview' : 'import'}`,
    options: { toolImport: true, source: p.source, dryRun, ...p.storedOptions }, // credentials and file contents are never stored
    createdBy: p.userId,
  }).returning()

  void (async () => {
    try {
      const report = await runSourceImport(p, {
        sessionId: dryRun ? null : session.id,
        isCancelled: () => isCancelled(session.id),
        onProgress: async (info) => {
          await db.update(schema.migrationSessions)
            .set({ totalEntities: info.total, processedEntities: info.processed, errors: info.errors.slice(0, 200) })
            .where(eq(schema.migrationSessions.id, session.id))
        },
      })
      await db.update(schema.migrationSessions).set({
        status: report.cancelled ? 'cancelled' : report.errors.length ? 'completed_with_errors' : 'completed',
        completedAt: new Date(),
        errors: report.errors.slice(0, 500),
        options: { toolImport: true, source: p.source, dryRun, ...p.storedOptions, report },
      }).where(eq(schema.migrationSessions.id, session.id))
    } catch (e: any) {
      await db.update(schema.migrationSessions).set({
        status: 'failed', completedAt: new Date(), errors: [redact(String(e?.message ?? e), p.secrets)],
      }).where(eq(schema.migrationSessions.id, session.id))
    } finally {
      await clearCancellation(session.id).catch(() => {})
    }
  })()

  return session.id
}

export { cancelMigration }
