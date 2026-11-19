/**
 * Pure decision logic for the module catalogue: engines and dependency checks, licence gating,
 * update detection and the user facing status. No I/O, so it is unit tested without a database.
 */
import { compareVersions, satisfies, type ModuleManifest } from '@veqsio/sdk'

export interface InstalledRow {
  id: string
  version: string
  enabled: boolean
  lastError?: string | null
}

export type ModuleStatus = 'available' | 'installed' | 'enabled' | 'update_available' | 'requires_licence' | 'incompatible'

export type DependencyState = 'ok' | 'missing' | 'not_installed' | 'disabled' | 'version_mismatch'

export interface DependencyCheck {
  id: string
  range: string
  state: DependencyState
  installedVersion?: string
}

export interface ModuleView {
  status: ModuleStatus
  installed: boolean
  enabled: boolean
  updateAvailable: boolean
  licensed: boolean
  compatible: boolean
  /** Why the module cannot be installed or enabled right now (engines, dependencies). Empty when it can. */
  problems: string[]
  dependencies: DependencyCheck[]
}

export function checkEngines(manifest: Pick<ModuleManifest, 'engines'>, appVersion: string): boolean {
  return satisfies(appVersion, manifest.engines.veqsio)
}

export function isLicensed(manifest: Pick<ModuleManifest, 'edition' | 'feature'>, hasFeature: (f: string) => boolean): boolean {
  if (manifest.edition === 'community') return true
  return !!manifest.feature && hasFeature(manifest.feature)
}

/** Evaluates a module's `dependencies` against the installed rows and the versions bundled in this build. */
export function checkDependencies(
  manifest: Pick<ModuleManifest, 'dependencies'>,
  installed: Map<string, InstalledRow>,
  bundledVersions: Map<string, string>,
): DependencyCheck[] {
  return Object.entries(manifest.dependencies).map(([id, range]) => {
    const bundled = bundledVersions.get(id)
    if (!bundled) return { id, range, state: 'missing' as const }
    const row = installed.get(id)
    if (!row) return { id, range, state: 'not_installed' as const }
    if (!satisfies(row.version, range)) return { id, range, state: 'version_mismatch' as const, installedVersion: row.version }
    if (!row.enabled) return { id, range, state: 'disabled' as const, installedVersion: row.version }
    return { id, range, state: 'ok' as const, installedVersion: row.version }
  })
}

const DEP_TEXT: Record<DependencyState, (d: DependencyCheck) => string> = {
  ok: () => '',
  missing: (d) => `Requires module "${d.id}" which is not part of this build`,
  not_installed: (d) => `Requires module "${d.id}" ${d.range} to be installed`,
  disabled: (d) => `Requires module "${d.id}" to be enabled`,
  version_mismatch: (d) => `Requires module "${d.id}" ${d.range} (installed ${d.installedVersion})`,
}

export function dependencyProblems(deps: DependencyCheck[]): string[] {
  return deps.filter((d) => d.state !== 'ok').map((d) => DEP_TEXT[d.state](d))
}

/** Enabled modules that currently depend on `id` (they block disabling or uninstalling it). */
export function enabledDependents(id: string, rows: InstalledRow[], manifests: Map<string, Pick<ModuleManifest, 'dependencies'>>): string[] {
  return rows.filter((r) => r.enabled && r.id !== id && manifests.get(r.id)?.dependencies[id] !== undefined).map((r) => r.id)
}

export function computeView(
  manifest: ModuleManifest,
  row: InstalledRow | undefined,
  ctx: { appVersion: string; hasFeature: (f: string) => boolean; installed: Map<string, InstalledRow>; bundledVersions: Map<string, string> },
): ModuleView {
  const compatible = checkEngines(manifest, ctx.appVersion)
  const licensed = isLicensed(manifest, ctx.hasFeature)
  const dependencies = checkDependencies(manifest, ctx.installed, ctx.bundledVersions)
  const problems: string[] = []
  if (!compatible) problems.push(`Requires Veqsio ${manifest.engines.veqsio} (this is ${ctx.appVersion})`)
  problems.push(...dependencyProblems(dependencies))
  const updateAvailable = !!row && compareVersions(manifest.version, row.version) > 0
  let status: ModuleStatus
  if (!compatible) status = 'incompatible'
  else if (!licensed) status = 'requires_licence'
  else if (!row) status = 'available'
  else if (updateAvailable) status = 'update_available'
  else status = row.enabled ? 'enabled' : 'installed'
  return { status, installed: !!row, enabled: !!row?.enabled, updateAvailable, licensed, compatible, problems, dependencies }
}

/**
 * Whether a module's routes and UI may be served right now. A module serves only when it is installed, enabled,
 * licensed, compatible and its installed version equals the bundled one (a pending update must be applied by an
 * administrator first, because new code must not run against an old schema).
 */
export type ServeDecision =
  | { ok: true }
  | { ok: false; status: 404 | 402 | 503; code: 'NOT_FOUND' | 'NOT_ENABLED' | 'LICENCE_REQUIRED' | 'UPDATE_REQUIRED' | 'INCOMPATIBLE'; message: string }

export function decideServe(
  manifest: ModuleManifest | undefined,
  row: InstalledRow | undefined,
  ctx: { appVersion: string; hasFeature: (f: string) => boolean },
): ServeDecision {
  if (!manifest) return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Module not found' }
  if (!row || !row.enabled) return { ok: false, status: 404, code: 'NOT_ENABLED', message: `Module "${manifest.id}" is not enabled` }
  if (!checkEngines(manifest, ctx.appVersion)) return { ok: false, status: 503, code: 'INCOMPATIBLE', message: `Module "${manifest.id}" is not compatible with this version of Veqsio` }
  if (!isLicensed(manifest, ctx.hasFeature)) {
    return { ok: false, status: 402, code: 'LICENCE_REQUIRED', message: `Module "${manifest.name}" requires an Enterprise licence (feature "${manifest.feature}")` }
  }
  if (row.version !== manifest.version) {
    return { ok: false, status: 503, code: 'UPDATE_REQUIRED', message: `Module "${manifest.name}" must be updated from ${row.version} to ${manifest.version} by an administrator` }
  }
  return { ok: true }
}
