/**
 * Minimal module host: discovers bundled modules, runs their migrations, serves their routes under
 * /rest/modules/<id>/*, registers their hooks and runs their jobs.
 *
 *  - Modules are discovered on disk (`modules/*` for community modules, `ee/modules/*` for paid ones) and loaded with
 *    a runtime `import()` of a computed path. The community code therefore never names `ee/` in an import, which is
 *    what scripts/check-ee-boundary.sh enforces, and a checkout without `ee/` simply finds fewer modules.
 *  - A request is served only when the module is licensed (402 otherwise), enabled (404 otherwise) and migrated.
 *  - Licence lapse switches behaviour off (routes, hooks, jobs). Module data stays untouched.
 *  - Route permissions are declared in the manifest (`contributes.server.routes`); undeclared routes are not served.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { defineJob, runJobOnce } from '../ops/jobs'
import { runsJobs } from '../ops/role'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Hono, type Context } from 'hono'
import { eq } from 'drizzle-orm'
import { installedModules, projects, issues } from '@veqsio/db'
import { parseManifest, GLOBAL_PERMISSION_KEYS, type ModuleContext, type ModuleDefinition, type ModuleLogger, type ModuleUser, type ModuleManifest, type RouteDecl } from '@veqsio/sdk'
import { db } from '../db'
import { hasFeature, getLicenseInfo } from '../license'
import { hasGlobalPermission, hasProjectPermission } from '../rbac/service'
import { requireAuth, type AppContext } from '../auth/middleware'
import { runModuleMigrations } from './migrations'
import { registerWorklogGuard, registerTransitionCheck, registerRequestCreatedHook, unregisterHooks } from './hooks'
import { coreServices } from './core-services'
import { registerDeskTemplate } from '../servicedesk/template-registry'

const REPO_ROOT = resolve(import.meta.dir, '../../../..')

export function moduleRoots(): string[] {
  const extra = (process.env.VEQSIO_MODULE_DIRS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  return [join(REPO_ROOT, 'modules'), join(REPO_ROOT, 'ee', 'modules'), ...extra]
}

interface Entry {
  manifest: ModuleManifest
  dir: string
  def: ModuleDefinition
  ctx: ModuleContext
  sub: Hono | null
  ready: Promise<void> | null
  jobTimers: Array<ReturnType<typeof setInterval>>
}

const entries = new Map<string, Entry>()
let loading: Promise<void> | null = null
let enabledCache: { at: number; map: Map<string, { enabled: boolean; version: string; settings: Record<string, unknown> }> } | null = null

export function resetModuleHostForTests(): void {
  for (const e of entries.values()) { e.jobTimers.forEach(clearInterval); unregisterHooks(e.manifest.id) }
  entries.clear()
  loading = null
  enabledCache = null
}

function logger(id: string): ModuleLogger {
  const p = `[module:${id}]`
  return {
    debug: (m, d) => { if (process.env.VEQSIO_DEBUG) console.debug(p, m, d ?? '') },
    info: (m, d) => console.log(p, m, d ?? ''),
    warn: (m, d) => console.warn(p, m, d ?? ''),
    error: (m, d) => console.error(p, m, d ?? ''),
  }
}

async function loadInstalled() {
  if (enabledCache && Date.now() - enabledCache.at < 5000) return enabledCache.map
  const rows = await db.select().from(installedModules)
  const map = new Map(rows.map((r) => [r.id, { enabled: r.enabled, version: r.version, settings: (r.settings ?? {}) as Record<string, unknown> }]))
  enabledCache = { at: Date.now(), map }
  return map
}
const invalidate = () => { enabledCache = null }

function makeContext(manifest: ModuleManifest): ModuleContext {
  const id = manifest.id
  const asUser = (u: ModuleUser | null) => (u ? u.id : null)
  return {
    moduleId: id,
    version: manifest.version,
    db,
    logger: logger(id),
    settings: {
      async get() {
        const row = (await loadInstalled()).get(id)
        const out: Record<string, unknown> = {}
        for (const [k, p] of Object.entries(manifest.settings?.properties ?? {})) if ('default' in p && p.default !== undefined) out[k] = p.default
        return { ...out, ...(row?.settings ?? {}) } as never
      },
    },
    user: (c: Context) => (c.get('user') as ModuleUser | null) ?? null,
    permissions: {
      async can(user, permission) { const uid = asUser(user); return uid === null ? false : hasGlobalPermission(uid, permission) },
      async canInProject(user, permission, projectKey) {
        const uid = asUser(user); if (uid === null) return false
        const [p] = await db.select({ id: projects.id }).from(projects).where(eq(projects.projectKey, projectKey)).limit(1)
        return p ? hasProjectPermission(uid, p.id, permission) : false
      },
      async canOnIssue(user, permission, issueKey) {
        const uid = asUser(user); if (uid === null) return false
        const [i] = await db.select({ projectId: issues.projectId }).from(issues).where(eq(issues.issueKey, issueKey)).limit(1)
        return i ? hasProjectPermission(uid, i.projectId, permission) : false
      },
    },
    licence: { has: (f) => hasFeature(f) },
    core: coreServices,
  }
}

async function discover(): Promise<void> {
  for (const root of moduleRoots()) {
    if (!existsSync(root)) continue
    for (const name of readdirSync(root)) {
      const dir = join(root, name)
      const manifestPath = join(dir, 'veqsio.module.json')
      const entry = join(dir, 'src', 'server.ts')
      if (!existsSync(manifestPath) || !existsSync(entry)) continue
      try {
        const manifest = parseManifest(JSON.parse(readFileSync(manifestPath, 'utf8')))
        if (manifest.devOnly && process.env.VEQSIO_DEV_MODULES !== '1') continue
        if (entries.has(manifest.id)) continue
        // Computed specifier on purpose: community code must not name ee/ (see scripts/check-ee-boundary.sh).
        const mod = await import(pathToFileURL(entry).href)
        const def = (mod.default ?? mod) as ModuleDefinition
        if (!def?.manifest || def.manifest.id !== manifest.id) throw new Error('server entry must default-export defineModule(...) with the same id')
        const ctx = makeContext(def.manifest)
        const e: Entry = { manifest: def.manifest, dir, def, ctx, sub: null, ready: null, jobTimers: [] }
        entries.set(manifest.id, e)
        for (const [name, check] of Object.entries(def.transitionChecks ?? {})) {
          registerTransitionCheck(manifest.id, name, async (input) => {
            // Licence lapse or disabling switches the check off; it never locks issues.
            if (!(await isServing(manifest.id))) return null
            await ensureReady(e)
            return check(input as never, ctx)
          })
        }
        const afterRequest = def.hooks?.afterRequestCreated
        if (afterRequest) {
          registerRequestCreatedHook(manifest.id, async (info) => {
            if (!(await isServing(manifest.id))) return
            await ensureReady(e)
            await afterRequest(info as never, ctx)
          })
        }
        for (const t of def.deskTemplates ?? []) {
          registerDeskTemplate(manifest.id, {
            id: t.id, title: t.title, description: t.description, feature: manifest.feature ?? manifest.id,
            isAvailable: () => isServing(manifest.id),
            apply: async (tx, p) => { await ensureReady(e); await t.apply(tx, p, ctx) },
          })
        }
        const guard = def.hooks?.beforeWorklogChange
        if (guard) {
          registerWorklogGuard(manifest.id, async (change) => {
            if (!(await isServing(manifest.id))) return
            await ensureReady(e)
            return guard(change, ctx)
          })
        }
      } catch (err) {
        console.error(`[modules] could not load module in ${dir}:`, (err as Error).message)
      }
    }
  }
}

export function loadModules(): Promise<void> {
  loading ??= discover()
  return loading
}

export function isLicensed(m: ModuleManifest): boolean {
  return m.edition === 'community' || (!!m.feature && hasFeature(m.feature))
}

/** Enabled in the database and licensed. Unknown modules and modules never seen before are not serving. */
async function isServing(id: string): Promise<boolean> {
  const e = entries.get(id)
  if (!e || !isLicensed(e.manifest)) return false
  return (await loadInstalled()).get(id)?.enabled === true
}

function ensureReady(e: Entry): Promise<void> {
  e.ready ??= (async () => {
    try {
      if (e.def.migrations?.length) await runModuleMigrations(db, e.manifest.id, e.def.migrations)
      const sub = new Hono<{ Bindings: { user: unknown }; Variables: { user: unknown } }>()
      sub.use('*', async (c, next) => { c.set('user', c.env?.user ?? null); await next() })
      // Defaults first so a module can override them in routes().
      sub.notFound((c) => c.json({ errorMessages: ['Resource not found'] }, 404))
      sub.onError((err, c) => { e.ctx.logger.error('request failed', err); return c.json({ errorMessages: ['Internal server error'] }, 500) })
      await e.def.routes?.(sub as unknown as Hono, e.ctx)
      e.sub = sub as unknown as Hono
    } catch (err) {
      e.ready = null // retry on the next request
      throw err
    }
  })()
  return e.ready
}

/**
 * Registers newly discovered modules in `installed_modules` (enabled by default; an administrator can disable them),
 * keeps the stored version in step with the bundled one and prepares licensed modules (migrations).
 */
export async function syncModules(): Promise<void> {
  await loadModules()
  for (const e of entries.values()) {
    const [row] = await db.select().from(installedModules).where(eq(installedModules.id, e.manifest.id)).limit(1)
    if (!row) await db.insert(installedModules).values({ id: e.manifest.id, version: e.manifest.version, enabled: true })
    else if (row.version !== e.manifest.version) await db.update(installedModules).set({ version: e.manifest.version, updatedAt: new Date() }).where(eq(installedModules.id, e.manifest.id))
  }
  invalidate()
  for (const e of entries.values()) {
    if (isLicensed(e.manifest)) {
      try { await ensureReady(e) } catch (err) { e.ctx.logger.error('migration failed; module not served', (err as Error).message) }
    }
  }
}

/** Starts the interval jobs of all modules. Each run is skipped while the previous one is still going. */
export async function startModuleJobs(): Promise<void> {
  await loadModules()
  if (!runsJobs()) return // VEQSIO_ROLE=web: no timers on this node
  for (const e of entries.values()) {
    for (const job of e.def.jobs ?? []) {
      let running = false
      const def = defineJob({
        name: `module:${e.manifest.id}:${job.name}`,
        everyMs: job.everyMs,
        run: async () => {
          if (!(await isServing(e.manifest.id))) return
          await ensureReady(e)
          await job.run(e.ctx)
        },
      })
      // Cluster-wide single run via an advisory lock, heartbeat and metrics come from the shared job runner.
      const timer = setInterval(async () => {
        if (running) return
        running = true
        try { await runJobOnce(def) } finally { running = false }
      }, job.everyMs)
      ;(timer as { unref?: () => void }).unref?.()
      e.jobTimers.push(timer)
    }
  }
}

/** Runs one job once, regardless of its schedule (tests and the admin "run now" action). */
export async function runModuleJob(id: string, name: string): Promise<void> {
  await loadModules()
  const e = entries.get(id)
  const job = e?.def.jobs?.find((j) => j.name === name)
  if (!e || !job) throw new Error(`unknown job ${id}/${name}`)
  await ensureReady(e)
  await job.run(e.ctx)
}

/* ------------------------------------------------------------------ */
/*  Route permission matching                                          */
/* ------------------------------------------------------------------ */

export function matchRouteDecl(decls: RouteDecl[], method: string, path: string): RouteDecl | null {
  for (const d of decls) {
    if (d.method !== '*' && d.method !== method) continue
    const re = new RegExp('^' + d.path.split('/').map((seg) => (seg === '*' ? '.*' : seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/') + '/?$')
    if (re.test(path)) return d
  }
  return null
}

const app = new Hono<AppContext>()

app.all('/rest/modules/:id/*', async (c) => {
  // Module APIs are never anonymous: answer 401 before revealing whether a module exists or is licensed.
  const user = c.get('user')
  if (!user) return c.json({ errorMessages: ['Authentication required'] }, 401)
  await loadModules()
  const id = c.req.param('id')
  const e = entries.get(id)
  if (!e) return c.json({ errorMessages: ['Module not found'] }, 404)
  if (!isLicensed(e.manifest)) {
    return c.json({ errorMessages: [`This feature requires a Veqsio Enterprise licence (${e.manifest.feature}).`], feature: e.manifest.feature, licence: getLicenseInfo().state }, 402)
  }
  if (!(await isServing(id))) return c.json({ errorMessages: [`Module "${e.manifest.name}" is not enabled`] }, 404)

  const url = new URL(c.req.url)
  const prefix = `/rest/modules/${id}`
  const subPath = url.pathname.slice(prefix.length) || '/'
  const decl = matchRouteDecl(e.manifest.contributes.server.routes, c.req.method, subPath)
  if (!decl) return c.json({ errorMessages: ['Resource not found'] }, 404)
  {
    if (decl.permission === 'admin' || decl.permission === 'SYSTEM_ADMIN') {
      if (!(await hasGlobalPermission(user.id, 'SYSTEM_ADMIN'))) return c.json({ errorMessages: ['Forbidden'] }, 403)
    } else if (decl.permission !== 'authenticated' && (GLOBAL_PERMISSION_KEYS as readonly string[]).includes(decl.permission)) {
      if (!(await hasGlobalPermission(user.id, decl.permission))) return c.json({ errorMessages: ['Forbidden'] }, 403)
    } else if (decl.permission !== 'authenticated') {
      // Project permissions need a project/issue parameter; modules that use them check inside the handler.
      return c.json({ errorMessages: ['Forbidden'] }, 403)
    }
  }
  try { await ensureReady(e) } catch (err) {
    e.ctx.logger.error('module not ready', (err as Error).message)
    return c.json({ errorMessages: ['Module is not ready'] }, 503)
  }
  // The body guard has already consumed the raw stream (Hono caches the parsed body), so rebuild it from the cache.
  const hasBody = !['GET', 'HEAD'].includes(c.req.method)
  const req = new Request(url.origin + subPath + url.search, { method: c.req.method, headers: c.req.raw.headers, body: hasBody ? await c.req.text() : undefined })
  return e.sub!.fetch(req, { user })
})

/** Modules that are currently serving, with the web contributions the UI should render. */
app.get('/rest/api/2/modules/active', requireAuth, async (c) => {
  await loadModules()
  const out = []
  for (const e of entries.values()) {
    if (!(await isServing(e.manifest.id))) continue
    out.push({ id: e.manifest.id, name: e.manifest.name, version: e.manifest.version, feature: e.manifest.feature ?? null, web: e.manifest.contributes.web })
  }
  return c.json({ modules: out })
})

/** Administrator overview: every bundled module with licence and enabled state. */
app.get('/rest/api/2/modules', requireAuth, async (c) => {
  const user = c.get('user')!
  if (!(await hasGlobalPermission(user.id, 'SYSTEM_ADMIN'))) return c.json({ errorMessages: ['Forbidden'] }, 403)
  await loadModules()
  const installed = await loadInstalled()
  return c.json({
    modules: [...entries.values()].map((e) => ({
      id: e.manifest.id, name: e.manifest.name, version: e.manifest.version, edition: e.manifest.edition, feature: e.manifest.feature ?? null,
      description: e.manifest.description, licensed: isLicensed(e.manifest), enabled: installed.get(e.manifest.id)?.enabled ?? false,
    })),
  })
})

// The parameter is deliberately not called `:id`: numericIdGuard answers 404 for every `:id` that is not an integer, and a module id is a string such as "timesheets".
app.put('/rest/api/2/modules/:moduleKey', requireAuth, async (c) => {
  const user = c.get('user')!
  if (!(await hasGlobalPermission(user.id, 'SYSTEM_ADMIN'))) return c.json({ errorMessages: ['Forbidden'] }, 403)
  await loadModules()
  const id = c.req.param('moduleKey')
  const e = entries.get(id)
  if (!e) return c.json({ errorMessages: ['Module not found'] }, 404)
  const body = await c.req.json().catch(() => null) as { enabled?: unknown } | null
  if (!body || typeof body.enabled !== 'boolean') return c.json({ errorMessages: ['enabled (boolean) is required'] }, 400)
  const [row] = await db.select().from(installedModules).where(eq(installedModules.id, id)).limit(1)
  if (row) await db.update(installedModules).set({ enabled: body.enabled, updatedAt: new Date() }).where(eq(installedModules.id, id))
  else await db.insert(installedModules).values({ id, version: e.manifest.version, enabled: body.enabled, installedBy: user.id })
  invalidate()
  return c.json({ id, enabled: body.enabled })
})

export default app
