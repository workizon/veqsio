/**
 * The one implementation of "may this user do X": global permissions, project permissions and the
 * issue guard. `middleware/permissions.ts` wraps these for the real checks (detailed = false, short
 * circuits as early as before); the admin permission helper calls the very same functions with
 * detailed = true and gets the ordered reasons, so the explanation cannot drift from the decision.
 */
import { db } from '../db'
import * as schema from '@veqsio/db'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { explainIssueSecurity, canSeeIssue } from '../security/issue-security'

type User = typeof schema.users.$inferSelect

export interface Reason {
  kind: string
  /** true = this rule grants access, false = this rule was looked at and does not grant it. */
  granted: boolean
  /** false for pure information that did not influence the verdict. */
  decisive: boolean
  text: string
  link?: string
}

export interface Evaluation {
  allowed: boolean
  reasons: Reason[]
}

export const SCHEME_LINK = '/admin?tab=permissions'
const ROLES_LINK = '/admin?tab=roles'
const GROUPS_LINK = '/admin?tab=groups'

const reason = (kind: string, granted: boolean, text: string, link?: string, decisive = true): Reason => ({ kind, granted, decisive, text, link })

/**
 * SQL predicate: permission entry `e` grants a permission to user `uid` in project `pid` through any of
 * "any logged-in user", a direct user entry, one of the user's groups, or a project role (assigned to the user
 * directly or through one of their groups). Shared by the real check, getBrowsableProjectIds and the helper.
 */
export function entryGrantsSql(uid: number, pid: SQL) {
  // "Any logged-in user" never includes an AI agent: agents see and act only where a role, group or user entry names them.
  return sql`((e.any_user = true AND NOT EXISTS (SELECT 1 FROM agents ag WHERE ag.user_id = ${uid}))
    OR (e.project_lead = true AND EXISTS (SELECT 1 FROM projects lp WHERE lp.id = ${pid} AND lp.lead_id = ${uid}))
    OR e.user_id = ${uid}
    OR e.group_id IN (SELECT ug.group_id FROM user_groups ug WHERE ug.user_id = ${uid})
    OR e.project_role_id IN (
      SELECT a.role_id FROM project_role_actors a
      WHERE a.project_id = ${pid} AND (a.user_id = ${uid} OR a.group_id IN (SELECT ug.group_id FROM user_groups ug WHERE ug.user_id = ${uid}))))`
}

interface GlobalHit { via: 'user' | 'group'; schemeId: number; schemeName: string; groupName?: string }

/** Entries of `permission` across all schemes held by the user directly or through a group (global checks). */
async function globalEntries(userId: number, permission: string, detailed: boolean): Promise<GlobalHit[]> {
  const out: GlobalHit[] = []
  const query = (cond: SQL) => {
    const q = db
      .select({ schemeId: schema.permissionEntries.schemeId, schemeName: schema.permissionSchemes.name, groupName: schema.groups.name })
      .from(schema.permissionEntries)
      .innerJoin(schema.permissionSchemes, eq(schema.permissionSchemes.id, schema.permissionEntries.schemeId))
      .leftJoin(schema.groups, eq(schema.groups.id, schema.permissionEntries.groupId))
      .where(and(eq(schema.permissionEntries.permissionKey, permission), cond)!)
    return detailed ? q : q.limit(1)
  }
  for (const r of await query(eq(schema.permissionEntries.userId, userId))) out.push({ via: 'user', schemeId: r.schemeId, schemeName: r.schemeName })
  if (!detailed && out.length) return out
  const groups = await db.select({ groupId: schema.userGroups.groupId }).from(schema.userGroups).where(eq(schema.userGroups.userId, userId))
  const groupIds = groups.map((g) => g.groupId)
  if (groupIds.length === 0) return out
  for (const r of await query(inArray(schema.permissionEntries.groupId, groupIds))) out.push({ via: 'group', schemeId: r.schemeId, schemeName: r.schemeName, groupName: r.groupName ?? undefined })
  return out
}

const how = (a: GlobalHit) => (a.via === 'group' ? `through group "${a.groupName}"` : 'directly')

export async function evaluateGlobal(user: User, permission: string, detailed = false): Promise<Evaluation> {
  const reasons: Reason[] = []
  // Legacy admin bypass
  if (user.username === 'admin') {
    reasons.push(reason('builtin-admin', true, 'The built-in "admin" account passes every permission check.'))
    return { allowed: true, reasons }
  }

  // Global ADMINISTER bypasses everything else
  if (permission !== 'ADMINISTER') {
    const admin = await globalEntries(user.id, 'ADMINISTER', detailed)
    if (admin.length) {
      reasons.push(reason('administer', true, `Holds the ADMINISTER permission (${how(admin[0])}, scheme "${admin[0].schemeName}"), which grants all permissions.`, SCHEME_LINK))
      return { allowed: true, reasons }
    }
    reasons.push(reason('administer', false, 'Does not hold the global ADMINISTER permission, which would grant everything.', SCHEME_LINK, false))
  }

  const entries = await globalEntries(user.id, permission, detailed)
  for (const e of entries) {
    reasons.push(reason(e.via, true, e.via === 'user'
      ? `Named directly in an entry for ${permission} in permission scheme "${e.schemeName}".`
      : `Member of group "${e.groupName}", which has ${permission} in permission scheme "${e.schemeName}".`, e.via === 'group' ? GROUPS_LINK : SCHEME_LINK))
  }
  if (entries.length) return { allowed: true, reasons }
  reasons.push(reason('missing', false, `No permission scheme entry gives this user or one of their groups ${permission}.`, SCHEME_LINK))
  return { allowed: false, reasons }
}

interface ProjectFacts { scheme_id: number | null; is_admin: boolean; allowed: boolean }

export async function evaluateProject(user: User | null, projectId: number, permission: string, detailed = false): Promise<Evaluation> {
  const reasons: Reason[] = []
  // Administer bypass
  if (user && user.username === 'admin') {
    reasons.push(reason('builtin-admin', true, 'The built-in "admin" account passes every permission check.'))
    return { allowed: true, reasons }
  }

  // Anonymous check
  if (!user) {
    const assoc = await db
      .select({ schemeId: schema.permissionSchemeAssociations.schemeId })
      .from(schema.permissionSchemeAssociations)
      .where(eq(schema.permissionSchemeAssociations.projectId, projectId))
      .limit(1)
    const schemeId = assoc[0]?.schemeId
    if (!schemeId) {
      reasons.push(reason('no-scheme', false, 'The project has no permission scheme, so anonymous access is denied.', SCHEME_LINK))
      return { allowed: false, reasons }
    }
    const anonEntries = await db
      .select({ id: schema.permissionEntries.id })
      .from(schema.permissionEntries)
      .where(and(eq(schema.permissionEntries.schemeId, schemeId), eq(schema.permissionEntries.permissionKey, permission), eq(schema.permissionEntries.anonymous, true)))
      .limit(1)
    const ok = anonEntries.length > 0
    reasons.push(reason('anonymous', ok, ok ? `The scheme grants ${permission} to anonymous users.` : `The scheme does not grant ${permission} to anonymous users.`, SCHEME_LINK))
    return { allowed: ok, reasons }
  }

  // One round trip instead of up to nine: global ADMINISTER, the project's scheme and the grant check.
  const rows = (await db.execute(sql`
    SELECT
      (SELECT a.scheme_id FROM permission_scheme_associations a WHERE a.project_id = ${projectId} LIMIT 1) AS scheme_id,
      EXISTS (
        SELECT 1 FROM permission_entries e
        WHERE e.permission_key = 'ADMINISTER'
          AND (e.user_id = ${user.id} OR e.group_id IN (SELECT ug.group_id FROM user_groups ug WHERE ug.user_id = ${user.id}))
      ) AS is_admin,
      EXISTS (
        SELECT 1 FROM permission_entries e
        WHERE e.scheme_id = (SELECT a.scheme_id FROM permission_scheme_associations a WHERE a.project_id = ${projectId} LIMIT 1)
          AND e.permission_key = ${permission}
          AND ${entryGrantsSql(user.id, sql`${projectId}`)}
      ) AS allowed
  `)) as unknown as ProjectFacts[]
  const row = rows[0]
  if (row?.is_admin) {
    if (detailed) {
      const a = (await globalEntries(user.id, 'ADMINISTER', true))[0]
      reasons.push(reason('administer', true, a ? `Holds the global ADMINISTER permission (${how(a)}, scheme "${a.schemeName}"), which grants every project permission.` : 'Holds the global ADMINISTER permission.', SCHEME_LINK))
    }
    return { allowed: true, reasons }
  }
  // No scheme associated: fall back to the global permission check
  if (!row || row.scheme_id === null || row.scheme_id === undefined) {
    const g = await evaluateGlobal(user, permission, detailed)
    if (detailed) reasons.push(reason('no-scheme', false, 'The project has no permission scheme, so the global permission check applies instead.', SCHEME_LINK, false), ...g.reasons)
    return { allowed: g.allowed, reasons }
  }
  const allowed = !!row.allowed
  if (detailed) reasons.push(...(await projectEntryReasons(user, projectId, row.scheme_id, permission)))
  return { allowed, reasons }
}

interface EntryRow {
  id: number; any_user: boolean | null; project_lead?: boolean | null; user_id: number | null; group_id: number | null; project_role_id: number | null
  anonymous: boolean | null; user_name: string | null; group_name: string | null; role_name: string | null; matches: boolean
}

/** One reason per scheme entry for this permission: the ones that match the user (granted) and the ones that do not. */
async function projectEntryReasons(user: User, projectId: number, schemeId: number, permission: string): Promise<Reason[]> {
  const scheme = await db.select({ name: schema.permissionSchemes.name }).from(schema.permissionSchemes).where(eq(schema.permissionSchemes.id, schemeId)).limit(1)
  const schemeName = scheme[0]?.name ?? `#${schemeId}`
  const entries = (await db.execute(sql`
    SELECT e.id, e.any_user, e.project_lead, e.user_id, e.group_id, e.project_role_id, e.anonymous,
           u.display_name AS user_name, g.name AS group_name, r.name AS role_name,
           ${entryGrantsSql(user.id, sql`${projectId}`)} AS matches
    FROM permission_entries e
    LEFT JOIN users u ON u.id = e.user_id
    LEFT JOIN groups g ON g.id = e.group_id
    LEFT JOIN project_roles r ON r.id = e.project_role_id
    WHERE e.scheme_id = ${schemeId} AND e.permission_key = ${permission}
    ORDER BY e.id
  `)) as unknown as EntryRow[]

  const myGroups = await db
    .select({ id: schema.userGroups.groupId, name: schema.groups.name })
    .from(schema.userGroups)
    .innerJoin(schema.groups, eq(schema.groups.id, schema.userGroups.groupId))
    .where(eq(schema.userGroups.userId, user.id))
  const myGroupIds = new Set(myGroups.map((g) => g.id))
  const actors = await db.select().from(schema.projectRoleActors).where(eq(schema.projectRoleActors.projectId, projectId))

  const out: Reason[] = []
  for (const e of entries) {
    const m = !!e.matches
    if (e.any_user) {
      out.push(reason('any-user', m, `Scheme "${schemeName}" grants ${permission} to any logged-in user.`, SCHEME_LINK))
    } else if (e.project_lead) {
      out.push(reason('project-lead', m, m
        ? `Scheme "${schemeName}" grants ${permission} to the project lead, and this user leads this project.`
        : `Scheme "${schemeName}" grants ${permission} to the project lead, but this user is not the lead of this project.`, SCHEME_LINK))
    } else if (e.user_id) {
      out.push(reason('user', m, m
        ? `Scheme "${schemeName}" grants ${permission} to this user directly.`
        : `Scheme "${schemeName}" grants ${permission} to the single user ${e.user_name}, not to this user.`, SCHEME_LINK))
    } else if (e.group_id) {
      out.push(reason('group', m, m
        ? `Member of group "${e.group_name}", which has ${permission} in scheme "${schemeName}".`
        : `Scheme "${schemeName}" grants ${permission} to group "${e.group_name}", which this user is not a member of.`, m ? GROUPS_LINK : SCHEME_LINK))
    } else if (e.project_role_id) {
      const mine = actors.filter((a) => a.roleId === e.project_role_id && (a.userId === user.id || (a.groupId != null && myGroupIds.has(a.groupId))))
      let text: string
      if (m) {
        const direct = mine.find((a) => a.userId === user.id)
        const viaGroup = mine.find((a) => a.groupId != null)
        const way = direct ? 'is assigned to the role directly' : `is in the role through group "${myGroups.find((g) => g.id === viaGroup?.groupId)?.name}"`
        text = `Scheme "${schemeName}" grants ${permission} to project role "${e.role_name}", and this user ${way} in this project.`
      } else {
        text = `Scheme "${schemeName}" grants ${permission} to project role "${e.role_name}", but this user has no part in that role in this project.`
      }
      out.push(reason('role', m, text, ROLES_LINK))
    }
    // anonymous-only entries never apply to a logged-in user and are not listed
  }
  if (!out.some((r) => r.granted)) {
    out.push(reason('missing', false, `Scheme "${schemeName}" has no entry that gives this user ${permission}${out.length ? '' : ' (it has no entries for this permission at all)'}.`, SCHEME_LINK))
  }
  return out
}

export type IssueAccessOutcome = 'ok' | 'hidden' | 'forbidden'

/**
 * The issue guard: without BROWSE_PROJECTS the issue is hidden (the caller answers 404), with it but without
 * `permission` the answer is forbidden. requireIssueAccess and the helper both use this.
 */
export async function evaluateIssueAccess(user: User, projectId: number, permission: string, detailed = false, issueId?: number): Promise<Evaluation & { outcome: IssueAccessOutcome }> {
  const browse = await evaluateProject(user, projectId, 'BROWSE_PROJECTS', detailed)
  if (!browse.allowed) return { outcome: 'hidden', allowed: false, reasons: browse.reasons.map((r) => ({ ...r, text: `Browse access: ${r.text}` })) }
  // Issue security level: applies on top of browse access, to everybody (no administrator bypass).
  let securityReasons: Reason[] = []
  if (issueId !== undefined) {
    if (detailed) {
      const sec = await explainIssueSecurity(user.id, issueId)
      securityReasons = sec.reasons.map((r) => ({ ...r, text: `Issue security: ${r.text}` }))
      if (sec.hidden) return { outcome: 'hidden', allowed: false, reasons: [...browse.reasons.map((r) => ({ ...r, text: `Browse access: ${r.text}` })), ...securityReasons] }
    } else if (!(await canSeeIssue(user.id, issueId))) {
      return { outcome: 'hidden', allowed: false, reasons: [] }
    }
  }
  if (permission === 'BROWSE_PROJECTS') return { outcome: 'ok', allowed: true, reasons: detailed ? [...browse.reasons, ...securityReasons] : browse.reasons }
  const perm = await evaluateProject(user, projectId, permission, detailed)
  const reasons = detailed ? [...browse.reasons.map((r) => ({ ...r, text: `Browse access: ${r.text}` })), ...securityReasons, ...perm.reasons] : []
  return { outcome: perm.allowed ? 'ok' : 'forbidden', allowed: perm.allowed, reasons }
}
