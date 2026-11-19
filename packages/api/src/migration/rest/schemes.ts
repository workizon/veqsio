import { and, eq } from 'drizzle-orm'
import { db } from '../../db'
import * as schema from '@veqsio/db'
import { PROJECT_PERMISSIONS } from '../../rbac/types'
import type { JiraClient } from './client'
import type { Resolver } from '../resolver'

/**
 * Permission and notification schemes from Jira Cloud or Jira Data Center / Server (an administrator's token needed; both answer
 * the REST API version 2 in the same shape, except for how people and project roles are named), assigned to the projects that were imported.
 * What has no counterpart here is reported as a warning, never dropped silently: grants to the reporter or assignee,
 * to custom-field holders, and notifications to single users, groups, roles or e-mail addresses (a notification scheme
 * here has fixed recipient switches).
 */

/** A holder of a permission in a Jira permission scheme (the parts of the REST answer that matter). */
/** Jira Cloud identifies people by accountId, Jira Data Center by name (login) and key; both are read. */
export interface JiraHolder { type: string; parameter?: string; value?: string; user?: { accountId?: string; name?: string; key?: string; displayName?: string; emailAddress?: string }; group?: { name?: string }; projectRole?: { name?: string } }
export interface JiraGrant { permission: string; holder: JiraHolder }

export type EntryTarget =
  | { kind: 'group'; name: string }
  | { kind: 'role'; name: string }
  | { kind: 'user'; accountId: string; displayName?: string; email?: string }
  | { kind: 'lead' }
  | { kind: 'loggedIn' }
  | { kind: 'anyone' }

const KNOWN = new Set<string>(PROJECT_PERMISSIONS)
const RENAMED: Record<string, string> = { MANAGE_SPRINTS_PERMISSION: 'MANAGE_SPRINTS', VIEW_DEV_TOOLS: '', VIEW_READONLY_WORKFLOW: '' }

/** The permission key used here for a Jira permission key, or null when there is none. */
export function mapPermission(jiraKey: string): string | null {
  const k = jiraKey.toUpperCase()
  if (k in RENAMED) return RENAMED[k] || null
  return KNOWN.has(k) ? k : null
}

/** Who a Jira holder is, or null (with the reason) when it cannot be expressed here. */
export function mapHolder(h: JiraHolder, roleNames?: Map<string, string>): { target: EntryTarget } | { skip: string } {
  switch (h.type) {
    case 'group': { const name = h.group?.name ?? h.parameter; return name ? { target: { kind: 'group', name } } : { skip: 'a group without a name' } }
    // Data Center gives the role id as the parameter; the name comes from the role list
    case 'projectRole': { const name = h.projectRole?.name ?? (h.parameter ? roleNames?.get(String(h.parameter)) : undefined); return name ? { target: { kind: 'role', name } } : { skip: 'a project role without a name' } }
    case 'user': { const id = h.user?.accountId ?? h.user?.name ?? h.user?.key ?? h.parameter; return id ? { target: { kind: 'user', accountId: id, displayName: h.user?.displayName, email: h.user?.emailAddress } } : { skip: 'a user without an id' } }
    case 'projectLead':
    case 'lead': return { target: { kind: 'lead' } }
    case 'applicationRole': return { target: { kind: 'loggedIn' } }
    case 'anyone': return { target: { kind: 'anyone' } }
    default: return { skip: `holder type "${h.type}"` }
  }
}

/** Notification recipients here are fixed switches; this maps the Jira notification types that have one. */
const NOTIFY: Record<string, 'notifyAssignee' | 'notifyReporter' | 'notifyWatchers' | 'notifyProjectLead' | 'notifyCurrentUser'> = {
  CurrentAssignee: 'notifyAssignee', Assignee: 'notifyAssignee',
  Reporter: 'notifyReporter',
  AllWatchers: 'notifyWatchers', Watchers: 'notifyWatchers',
  ProjectLead: 'notifyProjectLead',
  CurrentUser: 'notifyCurrentUser',
}

/** Jira event names (any language of the standard set) to the events a scheme here can switch. */
const EVENTS: Array<[RegExp, string]> = [
  [/^issue created$/i, 'issue.created'],
  [/^issue deleted$/i, 'issue.deleted'],
  [/comment/i, 'comment.added'],
  [/^(issue (resolved|closed|reopened)|work (started|stopped) on issue)$/i, 'issue.transitioned'],
  [/^(issue updated|issue assigned|issue moved|generic event|issue work logged|issue worklog (updated|deleted))$/i, 'issue.updated'],
]
export function mapEvent(name: string): string | null {
  for (const [re, ev] of EVENTS) if (re.test(name.trim())) return ev
  return null
}

export interface EventSwitches { eventType: string; notifyAssignee: boolean; notifyReporter: boolean; notifyWatchers: boolean; notifyProjectLead: boolean; notifyAllAdmins: boolean; notifyCurrentUser: boolean }

/** Folds the events of a Jira notification scheme into one row per event type here (several Jira events can land on one). */
export function mapNotificationScheme(events: Array<{ event?: { name?: string }; notifications?: Array<{ notificationType?: string }> }>, warnings: string[], schemeName: string): EventSwitches[] {
  const rows = new Map<string, EventSwitches>()
  const unsupported = new Set<string>()
  const unknownEvents = new Set<string>()
  for (const e of events) {
    const name = e.event?.name ?? ''
    const type = mapEvent(name)
    if (!type) { if (name && (e.notifications?.length ?? 0) > 0) unknownEvents.add(name); continue }
    const row = rows.get(type) ?? { eventType: type, notifyAssignee: false, notifyReporter: false, notifyWatchers: false, notifyProjectLead: false, notifyAllAdmins: false, notifyCurrentUser: false }
    for (const n of e.notifications ?? []) {
      const key = n.notificationType ? NOTIFY[n.notificationType] : undefined
      if (key) row[key] = true
      else if (n.notificationType) unsupported.add(n.notificationType)
    }
    rows.set(type, row)
  }
  if (unsupported.size) warnings.push(`Notification scheme "${schemeName}": recipients of type ${[...unsupported].join(', ')} cannot be expressed (recipients here are the assignee, reporter, watchers, project lead and current user) and were left out`)
  if (unknownEvents.size) warnings.push(`Notification scheme "${schemeName}": events without a counterpart were left out: ${[...unknownEvents].join(', ')}`)
  return [...rows.values()]
}

export interface SchemeImportReport { permissionSchemes: number; permissionEntries: number; notificationSchemes: number; assigned: number }

async function optional<T>(fn: () => Promise<T>, fallback: T, warnings: string[], what: string): Promise<T> {
  try { return await fn() } catch (e: any) { const m = String(e?.message ?? e).slice(0, 160)
    warnings.push(`${what} not imported (${m}); ` + (/ 404 /.test(m) || /responded 404/.test(m) ? 'this Jira version does not offer it over the REST API' : 'the token needs the Administer Jira permission')); return fallback }
}

async function findOrCreateGroup(name: string): Promise<number> {
  const [g] = await db.select({ id: schema.groups.id }).from(schema.groups).where(eq(schema.groups.name, name)).limit(1)
  if (g) return g.id
  const [c] = await db.insert(schema.groups).values({ name }).returning({ id: schema.groups.id })
  return c.id
}
async function findOrCreateRole(name: string): Promise<number> {
  const [r] = await db.select({ id: schema.projectRoles.id }).from(schema.projectRoles).where(eq(schema.projectRoles.name, name)).limit(1)
  if (r) return r.id
  const [c] = await db.insert(schema.projectRoles).values({ name }).returning({ id: schema.projectRoles.id })
  return c.id
}

/** Imports the schemes used by `projects` (key to local id). Safe to run again: schemes with the same name are reused, not duplicated. */
export async function importSchemes(
  client: JiraClient, resolver: Resolver, projects: Array<{ id: number; key: string }>, warnings: string[],
): Promise<SchemeImportReport> {
  const report: SchemeImportReport = { permissionSchemes: 0, permissionEntries: 0, notificationSchemes: 0, assigned: 0 }

  // --- permission schemes: only those used by an imported project, with the Jira id kept to find them again
  const jiraPerm = await optional(async () => (await client.get<{ permissionSchemes?: any[] }>('/rest/api/2/permissionscheme', { expand: 'permissions,user,group,projectRole' })).permissionSchemes ?? [], [] as any[], warnings, 'Permission schemes')
  // Data Center names a project role by id in the scheme; the role list gives the names (Cloud includes them already)
  const roleNames = new Map<string, string>()
  const roles = await optional(() => client.get<Array<{ id: number | string; name: string }>>('/rest/api/2/role'), [] as Array<{ id: number | string; name: string }>, [], 'Project roles')
  for (const r of Array.isArray(roles) ? roles : []) roleNames.set(String(r.id), r.name)
  const permByJiraId = new Map<number, any>(jiraPerm.map((s) => [Number(s.id), s]))
  const localPerm = new Map<number, number>()
  const skippedHolders = new Map<string, number>()
  const unknownPerms = new Set<string>()

  for (const p of projects) {
    const assoc = await optional(() => client.get<{ id?: number }>(`/rest/api/2/project/${encodeURIComponent(p.key)}/permissionscheme`), null, warnings, `Permission scheme of ${p.key}`)
    const js = assoc?.id !== undefined ? permByJiraId.get(Number(assoc.id)) : undefined
    if (!js) continue
    let localId = localPerm.get(Number(js.id))
    if (localId === undefined) {
      const [existing] = await db.select({ id: schema.permissionSchemes.id }).from(schema.permissionSchemes).where(eq(schema.permissionSchemes.name, js.name)).limit(1)
      if (existing) { localId = existing.id; warnings.push(`Permission scheme "${js.name}" already exists here and was assigned as it is (its grants were not changed)`) }
      else {
        const [c] = await db.insert(schema.permissionSchemes).values({ name: js.name, description: js.description ?? null }).returning({ id: schema.permissionSchemes.id })
        localId = c.id
        report.permissionSchemes++
        const seen = new Set<string>()
        for (const g of (js.permissions ?? []) as JiraGrant[]) {
          const key = mapPermission(g.permission)
          if (!key) { unknownPerms.add(g.permission); continue }
          const m = mapHolder(g.holder, roleNames)
          if ('skip' in m) { skippedHolders.set(m.skip, (skippedHolders.get(m.skip) ?? 0) + 1); continue }
          const t = m.target
          const v: typeof schema.permissionEntries.$inferInsert = { schemeId: localId, permissionKey: key }
          let id: string
          if (t.kind === 'group') { v.groupId = await findOrCreateGroup(t.name); id = `g${v.groupId}` }
          else if (t.kind === 'role') { v.projectRoleId = await findOrCreateRole(t.name); id = `r${v.projectRoleId}` }
          else if (t.kind === 'user') {
            const uid = await resolver.findUser({ username: t.accountId, email: (t.email ?? '').toLowerCase(), displayName: t.displayName ?? t.accountId } as any)
            if (uid === null) { skippedHolders.set('a user that does not exist here', (skippedHolders.get('a user that does not exist here') ?? 0) + 1); continue }
            v.userId = uid; id = `u${uid}`
          }
          else if (t.kind === 'lead') { v.projectLead = true; id = 'lead' }
          else if (t.kind === 'loggedIn') { v.anyUser = true; id = 'any' }
          else { v.anonymous = true; id = 'anon' }
          if (seen.has(`${key}:${id}`)) continue
          seen.add(`${key}:${id}`)
          await db.insert(schema.permissionEntries).values(v)
          report.permissionEntries++
        }
      }
      localPerm.set(Number(js.id), localId)
    }
    await db.delete(schema.permissionSchemeAssociations).where(eq(schema.permissionSchemeAssociations.projectId, p.id))
    await db.insert(schema.permissionSchemeAssociations).values({ projectId: p.id, schemeId: localId })
    report.assigned++
  }
  if (unknownPerms.size) warnings.push(`Permissions without a counterpart were left out: ${[...unknownPerms].join(', ')}`)
  for (const [why, n] of skippedHolders) warnings.push(`${n} permission grant(s) to ${why} were left out`)

  // --- notification schemes: here a scheme belongs to one project, so each imported project gets its own copy
  for (const p of projects) {
    const assoc = await optional(() => client.get<any>(`/rest/api/2/project/${encodeURIComponent(p.key)}/notificationscheme`, { expand: 'all' }), null, warnings, `Notification scheme of ${p.key}`)
    if (!assoc || !assoc.name) continue
    const rows = mapNotificationScheme(assoc.notificationSchemeEvents ?? [], warnings, assoc.name)
    const [existing] = await db.select({ id: schema.notificationSchemes.id }).from(schema.notificationSchemes)
      .where(and(eq(schema.notificationSchemes.projectId, p.id), eq(schema.notificationSchemes.name, assoc.name))).limit(1)
    if (existing) continue
    const [c] = await db.insert(schema.notificationSchemes).values({ name: assoc.name, description: assoc.description ?? null, projectId: p.id }).returning({ id: schema.notificationSchemes.id })
    if (rows.length) await db.insert(schema.notificationSchemeEvents).values(rows.map((r) => ({ ...r, schemeId: c.id })))
    report.notificationSchemes++
  }
  return report
}
