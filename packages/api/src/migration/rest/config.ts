import { and, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../../db'
import * as schema from '@veqsio/db'
import type { JiraClient } from './client'

/**
 * The instance configuration of a Jira, not only the parts that issues happen to use: issue types (with their sub-task flag and
 * description), priorities in their order, statuses with their category, resolutions, link types and, per project, which issue types
 * the project offers (as an issue type scheme). Existing entries with the same name are kept as they are.
 */

export interface ConfigReport {
  issueTypes: { created: number; matched: number }
  priorities: { created: number; matched: number }
  statuses: { created: number; matched: number }
  resolutions: { created: number; matched: number }
  linkTypes: { created: number; matched: number }
  issueTypeSchemes: { created: number; assigned: number }
}

const CATEGORY: Record<string, string> = { new: 'to_do', undefined: 'to_do', indeterminate: 'in_progress', done: 'done' }
const HEX = /^#[0-9a-fA-F]{6}$/

export function statusCategory(raw: any): string {
  const key = String(raw?.statusCategory?.key ?? raw?.category ?? '').toLowerCase()
  return CATEGORY[key] ?? 'to_do'
}

/** An identical set of issue types is one scheme, however many projects use it; the name lists the types. */
export function schemeNameFor(typeNames: string[]): string {
  const sorted = [...typeNames].sort((a, b) => a.localeCompare(b))
  const name = `Jira: ${sorted.join(', ')}`
  return name.length > 250 ? `${name.slice(0, 247)}...` : name
}

type Getter = Pick<JiraClient, 'get'>

async function safe<T>(fn: () => Promise<T>, fallback: T, warnings: string[], what: string): Promise<T> {
  try { return await fn() } catch (e: any) { warnings.push(`${what} not imported (${String(e?.message ?? e).slice(0, 140)})`); return fallback }
}

const ci = <T extends { name: any }>(col: T['name']) => sql`lower(${col})`

export async function importGlobalConfig(client: Getter, warnings: string[]): Promise<ConfigReport> {
  const report: ConfigReport = {
    issueTypes: { created: 0, matched: 0 }, priorities: { created: 0, matched: 0 }, statuses: { created: 0, matched: 0 },
    resolutions: { created: 0, matched: 0 }, linkTypes: { created: 0, matched: 0 }, issueTypeSchemes: { created: 0, assigned: 0 },
  }

  const types = await safe(() => client.get<any[]>('/rest/api/2/issuetype'), [] as any[], warnings, 'Issue types')
  const seenTypes = new Set<string>()
  for (const t of Array.isArray(types) ? types : []) {
    const name = String(t?.name ?? '').slice(0, 100)
    if (!name || seenTypes.has(name.toLowerCase())) continue
    seenTypes.add(name.toLowerCase())
    const [e] = await db.select({ id: schema.issueTypes.id }).from(schema.issueTypes).where(eq(ci(schema.issueTypes.name), name.toLowerCase())).limit(1)
    if (e) { report.issueTypes.matched++; continue }
    await db.insert(schema.issueTypes).values({ name, description: t.description ? String(t.description).slice(0, 2000) : null, isSubtask: !!t.subtask })
    report.issueTypes.created++
  }

  const prios = await safe(() => client.get<any[]>('/rest/api/2/priority'), [] as any[], warnings, 'Priorities')
  if (Array.isArray(prios) && prios.length) {
    const [{ max }] = await db.select({ max: sql<number>`coalesce(max(${schema.priorities.sortOrder}), 0)` }).from(schema.priorities)
    let order = Number(max)
    for (const p of prios) {
      const name = String(p?.name ?? '').slice(0, 100)
      if (!name) continue
      const [e] = await db.select({ id: schema.priorities.id }).from(schema.priorities).where(eq(ci(schema.priorities.name), name.toLowerCase())).limit(1)
      if (e) { report.priorities.matched++; continue }
      await db.insert(schema.priorities).values({
        name, description: p.description ? String(p.description).slice(0, 2000) : null, sortOrder: ++order,
        ...(HEX.test(String(p.statusColor ?? '')) ? { color: String(p.statusColor) } : {}),
      })
      report.priorities.created++
    }
  }

  const statuses = await safe(() => client.get<any[]>('/rest/api/2/status'), [] as any[], warnings, 'Statuses')
  const seenStatus = new Set<string>()
  for (const s of Array.isArray(statuses) ? statuses : []) {
    const name = String(s?.name ?? '').slice(0, 100)
    if (!name || seenStatus.has(name.toLowerCase())) continue
    seenStatus.add(name.toLowerCase())
    const [e] = await db.select({ id: schema.statuses.id }).from(schema.statuses).where(eq(ci(schema.statuses.name), name.toLowerCase())).limit(1)
    if (e) { report.statuses.matched++; continue }
    await db.insert(schema.statuses).values({ name, category: statusCategory(s), description: s.description ? String(s.description).slice(0, 2000) : null })
    report.statuses.created++
  }

  const resolutions = await safe(() => client.get<any[]>('/rest/api/2/resolution'), [] as any[], warnings, 'Resolutions')
  for (const r of Array.isArray(resolutions) ? resolutions : []) {
    const name = String(r?.name ?? '').slice(0, 100)
    if (!name) continue
    const [e] = await db.select({ id: schema.resolutions.id }).from(schema.resolutions).where(eq(ci(schema.resolutions.name), name.toLowerCase())).limit(1)
    if (e) { report.resolutions.matched++; continue }
    await db.insert(schema.resolutions).values({ name, description: r.description ? String(r.description).slice(0, 2000) : null })
    report.resolutions.created++
  }

  const links = await safe(() => client.get<{ issueLinkTypes?: any[] }>('/rest/api/2/issueLinkType'), { issueLinkTypes: [] } as { issueLinkTypes?: any[] }, warnings, 'Issue link types')
  for (const l of links?.issueLinkTypes ?? []) {
    const name = String(l?.name ?? '').slice(0, 100)
    if (!name) continue
    const [e] = await db.select({ id: schema.linkTypes.id }).from(schema.linkTypes).where(eq(ci(schema.linkTypes.name), name.toLowerCase())).limit(1)
    if (e) { report.linkTypes.matched++; continue }
    await db.insert(schema.linkTypes).values({ name, inward: String(l.inward ?? name).slice(0, 100), outward: String(l.outward ?? name).slice(0, 100) })
    report.linkTypes.created++
  }
  return report
}

/** The issue types a project offers in Jira, as an issue type scheme assigned to the project (one scheme per distinct set). */
export async function importProjectIssueTypes(
  detail: { issueTypes?: Array<{ name?: string }> }, projectId: number, report: ConfigReport, warnings: string[],
): Promise<void> {
  const names = [...new Set((detail.issueTypes ?? []).map((t) => String(t?.name ?? '')).filter(Boolean))]
  if (names.length === 0) return
  const types = await db.select({ id: schema.issueTypes.id, name: schema.issueTypes.name }).from(schema.issueTypes).where(inArray(ci(schema.issueTypes.name) as any, names.map((n) => n.toLowerCase())))
  if (types.length === 0) return
  if (types.length < names.length) warnings.push(`Project issue types without a match here were left out of its scheme: ${names.filter((n) => !types.some((t) => t.name.toLowerCase() === n.toLowerCase())).join(', ')}`)
  const schemeName = schemeNameFor(types.map((t) => t.name))
  let [scheme] = await db.select({ id: schema.issueTypeSchemes.id }).from(schema.issueTypeSchemes).where(eq(schema.issueTypeSchemes.name, schemeName)).limit(1)
  if (!scheme) {
    ;[scheme] = await db.insert(schema.issueTypeSchemes).values({ name: schemeName, defaultIssueTypeId: types[0].id }).returning({ id: schema.issueTypeSchemes.id })
    await db.insert(schema.issueTypeSchemeItems).values(types.map((t) => ({ schemeId: scheme.id, issueTypeId: t.id })))
    report.issueTypeSchemes.created++
  }
  await db.delete(schema.issueTypeSchemeAssociations).where(eq(schema.issueTypeSchemeAssociations.projectId, projectId))
  await db.insert(schema.issueTypeSchemeAssociations).values({ projectId, schemeId: scheme.id })
  report.issueTypeSchemes.assigned++
}
