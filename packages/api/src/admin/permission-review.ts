/**
 * Permission review: for each project, who really has which permission, and how (a project role, a group, straight to the
 * user, as project lead, to every signed-in user, to anyone). Built for access reviews and security audits.
 *
 * Reads the permission scheme of the project, expands roles and groups to people and lists findings worth a look.
 * `buildReview` is pure (no database), so the rules are unit-tested.
 */
import { eq, inArray } from 'drizzle-orm';
import * as schema from '@veqsio/db';
import { db } from '../db';
import { PERMISSION_INFO } from '../rbac/permission-info';

export type ViaType = 'role' | 'group' | 'direct' | 'lead';
export interface Via { type: ViaType; name: string; /** a role granted through a group */ group?: string }
export interface Finding { severity: 'high' | 'medium' | 'low' | 'info'; code: string; text: string }

export interface ReviewInput {
  project: { id: number; key: string; name: string; leadId: number | null };
  scheme: { id: number; name: string } | null;
  entries: Array<{ permissionKey: string; userId: number | null; groupId: number | null; projectRoleId: number | null; anyUser: boolean | null; projectLead: boolean | null; anonymous: boolean | null }>;
  users: Array<{ id: number; username: string; displayName: string; email: string; active: boolean }>;
  groups: Array<{ id: number; name: string }>;
  members: Array<{ userId: number; groupId: number }>;
  roles: Array<{ id: number; name: string }>;
  actors: Array<{ roleId: number; userId: number | null; groupId: number | null }>;
}

export interface PersonRow { id: number; username: string; displayName: string; email: string; active: boolean; permissions: Array<{ key: string; via: Via[] }> }
export interface ProjectReview {
  project: { key: string; name: string; lead: string | null };
  scheme: { id: number; name: string } | null;
  anyone: string[];
  loggedIn: string[];
  people: PersonRow[];
  counts: { people: number; active: number; browse: number; admins: number; directGrants: number; groups: number; roles: number };
  groups: Array<{ name: string; members: number; permissions: number }>;
  findings: Finding[];
}

const WRITE = new Set(['EDIT_ISSUES', 'DELETE_ISSUES', 'CREATE_ISSUES', 'TRANSITION_ISSUES', 'ASSIGN_ISSUES', 'MODIFY_REPORTER', 'DELETE_ALL_COMMENTS', 'EDIT_ALL_COMMENTS', 'DELETE_ALL_ATTACHMENTS', 'DELETE_ALL_WORKLOGS', 'EDIT_ALL_WORKLOGS', 'MANAGE_SPRINTS', 'SET_ISSUE_SECURITY', 'PROJECT_ADMIN', 'ADMINISTER_PROJECTS', 'CLOSE_ISSUES', 'RESOLVE_ISSUES']);
const name = (k: string) => PERMISSION_INFO[k]?.name ?? k;

export function buildReview(i: ReviewInput): ProjectReview {
  const userById = new Map(i.users.map((u) => [u.id, u]));
  const groupById = new Map(i.groups.map((g) => [g.id, g]));
  const roleById = new Map(i.roles.map((r) => [r.id, r]));
  const membersOf = (groupId: number) => i.members.filter((m) => m.groupId === groupId).map((m) => m.userId);
  const people = new Map<number, Map<string, Via[]>>();
  const give = (userId: number, perm: string, via: Via) => {
    if (!userById.has(userId)) return;
    const byPerm = people.get(userId) ?? new Map<string, Via[]>();
    const list = byPerm.get(perm) ?? [];
    if (!list.some((v) => v.type === via.type && v.name === via.name && v.group === via.group)) list.push(via);
    byPerm.set(perm, list); people.set(userId, byPerm);
  };

  const anyone = new Set<string>(), loggedIn = new Set<string>();
  const groupPerms = new Map<number, Set<string>>();
  let directGrants = 0;
  for (const e of i.entries) {
    const perm = e.permissionKey;
    if (e.anonymous) anyone.add(perm);
    if (e.anyUser) loggedIn.add(perm);
    if (e.projectLead && i.project.leadId) give(i.project.leadId, perm, { type: 'lead', name: 'Project lead' });
    if (e.userId) { directGrants++; give(e.userId, perm, { type: 'direct', name: 'Granted to the person' }); }
    if (e.groupId) {
      const g = groupById.get(e.groupId);
      (groupPerms.get(e.groupId) ?? groupPerms.set(e.groupId, new Set()).get(e.groupId)!).add(perm);
      for (const uid of membersOf(e.groupId)) give(uid, perm, { type: 'group', name: g?.name ?? `group ${e.groupId}` });
    }
    if (e.projectRoleId) {
      const role = roleById.get(e.projectRoleId);
      for (const a of i.actors.filter((x) => x.roleId === e.projectRoleId)) {
        if (a.userId) give(a.userId, perm, { type: 'role', name: role?.name ?? `role ${e.projectRoleId}` });
        if (a.groupId) for (const uid of membersOf(a.groupId)) give(uid, perm, { type: 'role', name: role?.name ?? `role ${e.projectRoleId}`, group: groupById.get(a.groupId)?.name });
      }
    }
  }

  const rows: PersonRow[] = [...people.entries()].map(([uid, perms]) => {
    const u = userById.get(uid)!;
    return { id: u.id, username: u.username, displayName: u.displayName, email: u.email, active: u.active, permissions: [...perms.entries()].map(([key, via]) => ({ key, via })).sort((a, b) => a.key.localeCompare(b.key)) };
  }).sort((a, b) => a.displayName.localeCompare(b.displayName));

  const holders = (perm: string) => rows.filter((r) => r.permissions.some((p) => p.key === perm));
  const counts = {
    people: rows.length, active: rows.filter((r) => r.active).length, browse: holders('BROWSE_PROJECTS').length,
    admins: holders('PROJECT_ADMIN').length, directGrants,
    groups: new Set(i.entries.filter((e) => e.groupId).map((e) => e.groupId)).size,
    roles: new Set(i.entries.filter((e) => e.projectRoleId).map((e) => e.projectRoleId)).size,
  };

  const findings: Finding[] = [];
  if (!i.scheme) findings.push({ severity: 'info', code: 'no-scheme', text: 'The project has no permission scheme: only administrators can use it.' });
  const anyoneWrite = [...anyone].filter((p) => p !== 'BROWSE_PROJECTS');
  if (anyoneWrite.length) findings.push({ severity: 'high', code: 'anonymous-write', text: `Anyone, also without signing in, is allowed to: ${anyoneWrite.map(name).join(', ')}.` });
  else if (anyone.has('BROWSE_PROJECTS')) findings.push({ severity: 'medium', code: 'anonymous-browse', text: 'Anyone, also without signing in, may browse the project (it is public).' });
  const loggedInWrite = [...loggedIn].filter((p) => WRITE.has(p));
  if (loggedInWrite.length) findings.push({ severity: 'medium', code: 'everyone-write', text: `Every signed-in user is allowed to: ${loggedInWrite.map(name).join(', ')}.` });
  const inactive = rows.filter((r) => !r.active);
  if (inactive.length) findings.push({ severity: 'medium', code: 'inactive-access', text: `${inactive.length} deactivated account(s) still hold permissions through roles or groups: ${inactive.slice(0, 5).map((r) => r.displayName).join(', ')}${inactive.length > 5 ? '…' : ''}.` });
  if (directGrants) findings.push({ severity: 'low', code: 'direct-grants', text: `${directGrants} permission(s) are granted straight to people. Roles and groups are easier to review and to take away.` });
  if (counts.admins > 3) findings.push({ severity: 'info', code: 'many-admins', text: `${counts.admins} people can administer this project.` });
  for (const [gid, perms] of groupPerms) if (membersOf(gid).length === 0) findings.push({ severity: 'low', code: 'empty-group', text: `The group ${groupById.get(gid)?.name ?? gid} holds ${perms.size} permission(s) but has no members.` });
  const usedRoles = new Set(i.entries.map((e) => e.projectRoleId).filter(Boolean) as number[]);
  for (const rid of usedRoles) if (!i.actors.some((a) => a.roleId === rid)) findings.push({ severity: 'info', code: 'empty-role', text: `The role ${roleById.get(rid)?.name ?? rid} is used by the scheme but nobody is in it in this project.` });
  const order = { high: 0, medium: 1, low: 2, info: 3 } as const;
  findings.sort((a, b) => order[a.severity] - order[b.severity]);

  const lead = i.project.leadId ? userById.get(i.project.leadId)?.displayName ?? null : null;
  return {
    project: { key: i.project.key, name: i.project.name, lead }, scheme: i.scheme,
    anyone: [...anyone].sort(), loggedIn: [...loggedIn].sort(), people: rows, counts,
    groups: [...groupPerms.entries()].map(([gid, perms]) => ({ name: groupById.get(gid)?.name ?? String(gid), members: membersOf(gid).length, permissions: perms.size })).sort((a, b) => a.name.localeCompare(b.name)),
    findings,
  };
}

/** Loads what the review needs and builds one review per project (or just the given one). */
export async function reviewProjects(onlyKey?: string): Promise<ProjectReview[]> {
  const projects = onlyKey
    ? await db.select().from(schema.projects).where(eq(schema.projects.projectKey, onlyKey))
    : await db.select().from(schema.projects).orderBy(schema.projects.projectKey);
  if (projects.length === 0) return [];
  const projectIds = projects.map((p) => p.id);
  const [assocs, schemes, users, groups, members, roles, actors] = await Promise.all([
    db.select().from(schema.permissionSchemeAssociations).where(inArray(schema.permissionSchemeAssociations.projectId, projectIds)),
    db.select().from(schema.permissionSchemes),
    db.select({ id: schema.users.id, username: schema.users.username, displayName: schema.users.displayName, email: schema.users.email, active: schema.users.active }).from(schema.users),
    db.select({ id: schema.groups.id, name: schema.groups.name }).from(schema.groups),
    db.select({ userId: schema.userGroups.userId, groupId: schema.userGroups.groupId }).from(schema.userGroups),
    db.select({ id: schema.projectRoles.id, name: schema.projectRoles.name }).from(schema.projectRoles),
    db.select().from(schema.projectRoleActors).where(inArray(schema.projectRoleActors.projectId, projectIds)),
  ]);
  const schemeIds = [...new Set(assocs.map((a) => a.schemeId))];
  const entries = schemeIds.length ? await db.select().from(schema.permissionEntries).where(inArray(schema.permissionEntries.schemeId, schemeIds)) : [];
  return projects.map((p) => {
    const assoc = assocs.find((a) => a.projectId === p.id);
    const scheme = assoc ? schemes.find((s) => s.id === assoc.schemeId) ?? null : null;
    return buildReview({
      project: { id: p.id, key: p.projectKey, name: p.name, leadId: p.leadId ?? null },
      scheme: scheme ? { id: scheme.id, name: scheme.name } : null,
      entries: assoc ? entries.filter((e) => e.schemeId === assoc.schemeId) : [],
      users: users.map((u) => ({ ...u, active: u.active !== false })), groups, members, roles,
      actors: actors.filter((a) => a.projectId === p.id).map((a) => ({ roleId: a.roleId, userId: a.userId, groupId: a.groupId })),
    });
  });
}
