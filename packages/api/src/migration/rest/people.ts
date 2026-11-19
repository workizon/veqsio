import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../../db'
import * as schema from '@veqsio/db'
import type { JiraClient } from './client'
import type { Resolver } from '../resolver'
import { normalizeUser, type JiraUserRef } from './mapper'
import { usableAvatarUrl } from './avatars'

/**
 * People and their access, taken from Jira so that nobody has to be created by hand first: every user (matched to an existing
 * account by e-mail, else created without a password, to sign in through SSO or the password reset), the groups with their members,
 * the members of each project role in the imported projects, and the administrator groups. Jira Cloud and Data Center are both read.
 */

export interface PeopleReport {
  users: { created: number; matched: number; inactive: number; withoutEmail: number }
  groups: { created: number; matched: number; memberships: number }
  roleActors: number
  adminGroups: string[]
  /** Global permissions granted to single people (Jira Cloud): people checked, entries written. */
  globalPermissions?: { checked: number; entries: number }
}

type Getter = Pick<JiraClient, 'get'> & Partial<Pick<JiraClient, 'post'>>

const PAGE = 1000
/** Groups that mean "administrator" in a standard Jira. Holding them is carried over as the global ADMINISTER permission. */
export const ADMIN_GROUP_NAMES = /^(jira-administrators|system-administrators|site-admins|org-admins|administrators)$/i
/** Groups Atlassian maintains for itself; they say nothing about the customer's own organisation. */
export const INTERNAL_GROUP = /^(atlassian-addons|addon_|jira-servicedesk-system)/i

export function userKeys(u: JiraUserRef): string[] {
  return [u.accountId && `acct:${u.accountId}`, u.name && `name:${u.name}`, u.key && `key:${u.key}`].filter((x): x is string => !!x)
}

/** All users of the Jira, whichever flavour: the Cloud search first, then the Server / Data Center one. */
export async function fetchUsers(c: Getter, warnings: string[]): Promise<Array<JiraUserRef & { active?: boolean; accountType?: string }>> {
  const all: any[] = []
  let flavour: 'cloud' | 'server' = 'cloud'
  try {
    for (let startAt = 0, guard = 0; guard < 500; guard++) {
      const page: any = await c.get('/rest/api/2/users/search', { startAt, maxResults: PAGE })
      if (!Array.isArray(page)) throw new Error('not a list')
      all.push(...page)
      if (page.length < PAGE) break
      startAt += page.length
    }
  } catch {
    flavour = 'server'
    all.length = 0
    try {
      for (let startAt = 0, guard = 0; guard < 500; guard++) {
        const page: any = await c.get('/rest/api/2/user/search', { username: '.', includeInactive: 'true', startAt, maxResults: PAGE })
        if (!Array.isArray(page)) throw new Error('not a list')
        all.push(...page)
        if (page.length < PAGE) break
        startAt += page.length
      }
    } catch (e: any) {
      warnings.push(`People not imported: the user list could not be read (${String(e?.message ?? e).slice(0, 120)}); the token needs the Administer Jira permission`)
      return []
    }
  }
  // Cloud also lists apps and customers of a service desk; they are not people of the organisation
  return flavour === 'cloud' ? all.filter((u) => !u.accountType || u.accountType === 'atlassian') : all
}

export async function fetchGroupNames(c: Getter, warnings: string[]): Promise<string[]> {
  const names: string[] = []
  try {
    for (let startAt = 0, guard = 0; guard < 500; guard++) {
      const page: any = await c.get('/rest/api/2/group/bulk', { startAt, maxResults: 100 })
      const values: any[] = Array.isArray(page?.values) ? page.values : []
      for (const g of values) if (g?.name) names.push(String(g.name))
      if (page?.isLast !== false || values.length === 0) break
      startAt += values.length
    }
    if (names.length) return names
  } catch { /* Data Center has no bulk listing */ }
  try {
    const r: any = await c.get('/rest/api/2/groups/picker', { maxResults: 1000 })
    for (const g of r?.groups ?? []) if (g?.name) names.push(String(g.name))
  } catch (e: any) {
    warnings.push(`Groups not imported (${String(e?.message ?? e).slice(0, 120)})`)
  }
  return names
}

async function groupMembers(c: Getter, name: string): Promise<any[]> {
  const out: any[] = []
  for (let startAt = 0, guard = 0; guard < 500; guard++) {
    const page: any = await c.get('/rest/api/2/group/member', { groupname: name, includeInactiveUsers: 'true', startAt, maxResults: 50 })
    const values: any[] = Array.isArray(page?.values) ? page.values : []
    out.push(...values)
    if (page?.isLast !== false || values.length === 0) break
    startAt += values.length
  }
  return out
}

/** A role actor as Jira lists it, Cloud or Data Center: a user or a group, with the names under which it can be found. */
export function parseRoleActor(a: any): { kind: 'user'; ref: JiraUserRef } | { kind: 'group'; name: string } | null {
  const type = String(a?.type ?? '')
  if (/group/i.test(type)) {
    const name = a.actorGroup?.name ?? a.name ?? a.displayName
    return name ? { kind: 'group', name: String(name) } : null
  }
  if (/user/i.test(type)) {
    const ref: JiraUserRef = { accountId: a.actorUser?.accountId, name: a.name, displayName: a.displayName }
    return ref.accountId || ref.name ? { kind: 'user', ref } : null
  }
  return null
}

const pathOf = (u: string) => { try { const x = new URL(u); return x.pathname + x.search } catch { return u } }

export async function importPeople(
  client: Getter, resolver: Resolver, projects: Array<{ id: number; key: string }>, warnings: string[],
  /** 'accounts': users, groups and administrators (before the issues, so that nobody is created as a bare placeholder first); 'roles': who holds which project role (after the projects exist). */
  phase: 'accounts' | 'roles' | 'all' = 'all',
  /** Receives the avatar URL of each user that was created or matched, for the avatar copy. */
  avatarSources?: Map<number, string>,
): Promise<PeopleReport> {
  const report: PeopleReport = { users: { created: 0, matched: 0, inactive: 0, withoutEmail: 0 }, groups: { created: 0, matched: 0, memberships: 0 }, roleActors: 0, adminGroups: [] }
  const localByKey = new Map<string, number>()

  const doAccounts = phase !== 'roles'
  const doRoles = phase !== 'accounts'
  const jiraUsers = doAccounts ? await fetchUsers(client, warnings) : []
  const toLocal = async (u: JiraUserRef & { active?: boolean }): Promise<number | null> => {
    for (const k of userKeys(u)) { const hit = localByKey.get(k); if (hit !== undefined) return hit }
    const nu = normalizeUser(u)
    if (!nu) return null
    const existed = await resolver.findUser(nu)
    const id = await resolver.user(nu)
    if (id === null) return null
    if (existed === null) {
      report.users.created++
      if (nu.email.endsWith('@migrated.invalid')) report.users.withoutEmail++
      if (u.active === false) { await db.update(schema.users).set({ active: false }).where(eq(schema.users.id, id)); report.users.inactive++ }
    } else report.users.matched++
    for (const k of userKeys(u)) localByKey.set(k, id)
    const av = usableAvatarUrl((u as any).avatarUrls)
    if (av && avatarSources && !avatarSources.has(id)) avatarSources.set(id, av)
    return id
  }
  for (const u of jiraUsers) await toLocal(u)

  // groups and who is in them
  const groupIds = new Map<string, number>()
  for (const name of doAccounts ? await fetchGroupNames(client, warnings) : []) {
    if (INTERNAL_GROUP.test(name)) continue
    const [e] = await db.select({ id: schema.groups.id }).from(schema.groups).where(eq(schema.groups.name, name)).limit(1)
    let id = e?.id
    if (id === undefined) { [{ id }] = await db.insert(schema.groups).values({ name: name.slice(0, 255) }).returning({ id: schema.groups.id }); report.groups.created++ } else report.groups.matched++
    groupIds.set(name.toLowerCase(), id)
    try {
      for (const m of await groupMembers(client, name)) {
        const uid = await toLocal(m)
        if (uid === null) continue
        await db.insert(schema.userGroups).values({ userId: uid, groupId: id }).onConflictDoNothing()
        report.groups.memberships++
      }
    } catch (e: any) { warnings.push(`Members of group "${name}" not imported (${String(e?.message ?? e).slice(0, 100)})`) }
  }
  const groupId = async (name: string): Promise<number> => {
    const hit = groupIds.get(name.toLowerCase()); if (hit !== undefined) return hit
    const [e] = await db.select({ id: schema.groups.id }).from(schema.groups).where(eq(schema.groups.name, name)).limit(1)
    const id = e?.id ?? (await db.insert(schema.groups).values({ name: name.slice(0, 255) }).returning({ id: schema.groups.id }))[0].id
    groupIds.set(name.toLowerCase(), id)
    return id
  }

  // who holds which role in each project
  for (const p of doRoles ? projects : []) {
    let roles: Record<string, string>
    try { roles = await client.get<Record<string, string>>(`/rest/api/2/project/${encodeURIComponent(p.key)}/role`) } catch (e: any) { warnings.push(`${p.key}: project roles not imported (${String(e?.message ?? e).slice(0, 100)})`); continue }
    for (const [roleName, url] of Object.entries(roles ?? {})) {
      let detail: any
      try { detail = await client.get(pathOf(String(url))) } catch { continue }
      if (!Array.isArray(detail?.actors) || detail.actors.length === 0) continue
      let [role] = await db.select({ id: schema.projectRoles.id }).from(schema.projectRoles).where(eq(schema.projectRoles.name, roleName)).limit(1)
      if (!role) [role] = await db.insert(schema.projectRoles).values({ name: roleName.slice(0, 100) }).returning({ id: schema.projectRoles.id })
      for (const a of detail.actors) {
        const actor = parseRoleActor(a)
        if (!actor) continue
        const base = { projectId: p.id, roleId: role.id }
        if (actor.kind === 'group') {
          const gid = await groupId(actor.name)
          const [dup] = await db.select({ id: schema.projectRoleActors.id }).from(schema.projectRoleActors).where(and(eq(schema.projectRoleActors.projectId, p.id), eq(schema.projectRoleActors.roleId, role.id), eq(schema.projectRoleActors.groupId, gid))).limit(1)
          if (!dup) { await db.insert(schema.projectRoleActors).values({ ...base, groupId: gid }); report.roleActors++ }
        } else {
          const uid = await toLocal(actor.ref)
          if (uid === null) continue
          const [dup] = await db.select({ id: schema.projectRoleActors.id }).from(schema.projectRoleActors).where(and(eq(schema.projectRoleActors.projectId, p.id), eq(schema.projectRoleActors.roleId, role.id), eq(schema.projectRoleActors.userId, uid))).limit(1)
          if (!dup) { await db.insert(schema.projectRoleActors).values({ ...base, userId: uid }); report.roleActors++ }
        }
      }
    }
  }

  // administrators: the standard Jira administrator groups hold the global ADMINISTER permission here too
  const adminGroups = !doAccounts ? [] : [...groupIds.entries()].filter(([n]) => ADMIN_GROUP_NAMES.test(n)).map(([n, id]) => ({ name: n, id }))
  if (adminGroups.length) {
    let [scheme] = await db.select({ id: schema.permissionSchemes.id }).from(schema.permissionSchemes).where(eq(schema.permissionSchemes.name, 'Jira administrators')).limit(1)
    if (!scheme) [scheme] = await db.insert(schema.permissionSchemes).values({ name: 'Jira administrators', description: 'Global permissions of the administrator groups of the Jira this was imported from' }).returning({ id: schema.permissionSchemes.id })
    for (const g of adminGroups) {
      const [dup] = await db.select({ id: schema.permissionEntries.id }).from(schema.permissionEntries).where(and(eq(schema.permissionEntries.schemeId, scheme.id), eq(schema.permissionEntries.permissionKey, 'ADMINISTER'), eq(schema.permissionEntries.groupId, g.id))).limit(1)
      if (!dup) await db.insert(schema.permissionEntries).values({ schemeId: scheme.id, permissionKey: 'ADMINISTER', groupId: g.id })
      report.adminGroups.push(g.name)
    }
    warnings.push(`Members of ${report.adminGroups.join(', ')} are administrators here too (global ADMINISTER permission). Check Administration → Groups if that is not what you want.`)
  }
  // what individual people may do globally (Jira Cloud only: Data Center has no API for it)
  if (doAccounts && client.post) {
    const accounts = [...localByKey.entries()].filter(([k]) => k.startsWith('acct:')).map(([k, id]) => ({ accountId: k.slice(5), id }))
    report.globalPermissions = await importUserGlobalPermissions(client as Required<Pick<JiraClient, 'post'>>, accounts, warnings)
  }
  if (doAccounts && report.users.withoutEmail > 0) warnings.push(`${report.users.withoutEmail} people have no e-mail address in Jira (hidden by its privacy settings); they were created with a placeholder address ending in @migrated.invalid, so they cannot be matched to an SSO login by e-mail until it is corrected.`)
  if (doAccounts && report.users.created > 0) warnings.push(`${report.users.created} accounts were created without a password: people sign in through SSO or the password reset.`)
  return report
}

const GLOBAL_KEYS = ['ADMINISTER', 'SYSTEM_ADMIN', 'BROWSE_USERS', 'CREATE_PROJECT', 'MANAGE_GROUP_FILTER_SUBSCRIPTIONS'] as const
const MAX_CHECKED = 300

/**
 * Asks Jira Cloud which global permissions each person holds (`POST /permissions/check`) and records them as entries for that person.
 * A permission that nearly everybody holds (a default of the whole site) is not written one by one. Data Center answers 404 or 405,
 * which stops the attempt after the first person and is reported once.
 */
export async function importUserGlobalPermissions(
  client: Required<Pick<JiraClient, 'post'>>, accounts: Array<{ accountId: string; id: number }>, warnings: string[],
): Promise<{ checked: number; entries: number }> {
  const out = { checked: 0, entries: 0 }
  const people = accounts.slice(0, MAX_CHECKED)
  if (accounts.length > MAX_CHECKED) warnings.push(`Global permissions were read for the first ${MAX_CHECKED} of ${accounts.length} people; set the rest in Administration`)
  const granted = new Map<number, string[]>()
  for (const [i, p] of people.entries()) {
    try {
      const r: any = await client.post('/rest/api/2/permissions/check', { accountId: p.accountId, globalPermissions: [...GLOBAL_KEYS] })
      granted.set(p.id, (r?.globalPermissions ?? []).filter((k: string) => (GLOBAL_KEYS as readonly string[]).includes(k)))
      out.checked++
    } catch (e: any) {
      if (i === 0) { warnings.push(`Global permissions of single people were not imported: this Jira has no permission check API (Data Center) or the token lacks the right (${String(e?.message ?? e).slice(0, 80)}); set them in Administration`); return out }
    }
  }
  if (out.checked === 0) return out
  let [scheme] = await db.select({ id: schema.permissionSchemes.id }).from(schema.permissionSchemes).where(eq(schema.permissionSchemes.name, 'Jira administrators')).limit(1)
  if (!scheme) [scheme] = await db.insert(schema.permissionSchemes).values({ name: 'Jira administrators', description: 'Global permissions of the administrator groups of the Jira this was imported from' }).returning({ id: schema.permissionSchemes.id })
  for (const key of GLOBAL_KEYS) {
    const holders = [...granted.entries()].filter(([, keys]) => keys.includes(key)).map(([id]) => id)
    if (holders.length === 0) continue
    if (out.checked >= 10 && holders.length / out.checked >= 0.9) { warnings.push(`${key} is held by nearly everybody in Jira (${holders.length} of ${out.checked}); it was not written person by person`); continue }
    for (const userId of holders) {
      const [dup] = await db.select({ id: schema.permissionEntries.id }).from(schema.permissionEntries).where(and(eq(schema.permissionEntries.schemeId, scheme.id), eq(schema.permissionEntries.permissionKey, key), eq(schema.permissionEntries.userId, userId))).limit(1)
      if (!dup) { await db.insert(schema.permissionEntries).values({ schemeId: scheme.id, permissionKey: key, userId }); out.entries++ }
    }
  }
  return out
}

export interface PeoplePreview {
  users: { total: number; willMatch: number; willCreate: number; inactive: number; withoutEmail: number }
  groups: { total: number; willCreate: number; existing: number; administrators: string[] }
  /** The first people, with what would happen to each. */
  sample: Array<{ displayName: string; email: string; status: 'match' | 'create'; inactive: boolean; hiddenEmail: boolean; matchedTo?: string }>
  warnings: string[]
}

/** What the people import would do, without writing anything: who is matched to an existing account, who would be created, and the groups. */
export async function previewPeople(client: Getter, resolver: Resolver, limit = 200): Promise<PeoplePreview> {
  const warnings: string[] = []
  const users = await fetchUsers(client, warnings)
  const out: PeoplePreview = { users: { total: users.length, willMatch: 0, willCreate: 0, inactive: 0, withoutEmail: 0 }, groups: { total: 0, willCreate: 0, existing: 0, administrators: [] }, sample: [], warnings }
  for (const u of users) {
    const nu = normalizeUser(u)
    if (!nu) continue
    const hit = await resolver.findUser(nu)
    const hidden = nu.email.endsWith('@migrated.invalid')
    if (hit === null) { out.users.willCreate++; if (u.active === false) out.users.inactive++; if (hidden) out.users.withoutEmail++ } else out.users.willMatch++
    if (out.sample.length < limit) {
      let matchedTo: string | undefined
      if (hit !== null) { const [m] = await db.select({ username: schema.users.username }).from(schema.users).where(eq(schema.users.id, hit)).limit(1); matchedTo = m?.username }
      out.sample.push({ displayName: nu.displayName, email: hidden ? '' : nu.email, status: hit === null ? 'create' : 'match', inactive: u.active === false, hiddenEmail: hidden, matchedTo })
    }
  }
  const names = (await fetchGroupNames(client, warnings)).filter((n) => !INTERNAL_GROUP.test(n))
  out.groups.total = names.length
  const have = names.length ? await db.select({ name: schema.groups.name }).from(schema.groups) : []
  const haveSet = new Set(have.map((g) => g.name.toLowerCase()))
  for (const n of names) { if (haveSet.has(n.toLowerCase())) out.groups.existing++; else out.groups.willCreate++; if (ADMIN_GROUP_NAMES.test(n)) out.groups.administrators.push(n) }
  return out
}
