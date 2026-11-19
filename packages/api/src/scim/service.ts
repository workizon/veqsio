import { assertSeatAvailable } from '../license/seats';
import { and, asc, eq, inArray, isNull, ne, or, sql, count, type SQL } from 'drizzle-orm';
import * as schema from '@veqsio/db';
import { db } from '../db';
import { deleteAllUserSessions } from '../auth/session';
import { invalidatePermissionCache } from '../rbac/service';
import { ScimError } from './errors';
import { isAgentUsername } from '../agents/logic';
import { parseFilter } from './filter';
import { filterToSql, type ColumnSpec } from './filter-sql';
import { groupToScim, userToScim, type ScimProfile } from './mapping';
import type { GroupModel, UserModel } from './patch';

const u = schema.users;
const g = schema.groups;
const ident = schema.userIdentities;

const userColumns: Record<string, ColumnSpec> = {
  id: { expr: sql`${u.id}`, kind: 'id' },
  username: { expr: sql`${u.username}`, kind: 'string' },
  displayname: { expr: sql`${u.displayName}`, kind: 'string' },
  active: { expr: sql`coalesce(${u.active}, true)`, kind: 'bool' },
  'emails.value': { expr: sql`${u.email}`, kind: 'string' },
  emails: { expr: sql`${u.email}`, kind: 'string' },
  externalid: {
    expr: sql`(select ${ident.rawProfile}->>'externalId' from ${ident} where ${ident.userId} = ${u.id} and ${ident.provider} = 'scim' limit 1)`,
    kind: 'string',
  },
};
const groupColumns: Record<string, ColumnSpec> = {
  id: { expr: sql`${g.id}`, kind: 'id' },
  displayname: { expr: sql`${g.name}`, kind: 'string' },
};

function whereFor(filter: string | undefined, columns: Record<string, ColumnSpec>): SQL | undefined {
  if (!filter) return undefined;
  return filterToSql(parseFilter(filter), columns);
}

function parseId(raw: string): number {
  if (!/^[0-9]{1,9}$/.test(raw)) throw ScimError.notFound();
  return Number(raw);
}

/* ------------------------------------------------------------------ */
/*  Users                                                              */
/* ------------------------------------------------------------------ */

async function profilesFor(userIds: number[]): Promise<Map<number, ScimProfile>> {
  const map = new Map<number, ScimProfile>();
  if (userIds.length === 0) return map;
  const rows = await db.select().from(ident).where(and(eq(ident.provider, 'scim'), inArray(ident.userId, userIds)));
  for (const r of rows) map.set(r.userId, (r.rawProfile ?? {}) as ScimProfile);
  return map;
}

export async function listUsers(p: { filter?: string; startIndex: number; count: number; baseUrl: string }) {
  const where = whereFor(p.filter, userColumns);
  const [{ total }] = await db.select({ total: count() }).from(u).where(where);
  const rows = p.count === 0 ? [] : await db.select().from(u).where(where).orderBy(asc(u.id)).limit(p.count).offset(p.startIndex - 1);
  const profiles = await profilesFor(rows.map((r) => r.id));
  return { total: Number(total), resources: rows.map((r) => userToScim(r, profiles.get(r.id) ?? {}, p.baseUrl)) };
}

export async function getUser(rawId: string, baseUrl: string) {
  const id = parseId(rawId);
  const [row] = await db.select().from(u).where(eq(u.id, id)).limit(1);
  if (!row) throw ScimError.notFound('User not found');
  const profiles = await profilesFor([id]);
  return userToScim(row, profiles.get(id) ?? {}, baseUrl);
}

export async function userModelOf(rawId: string): Promise<UserModel> {
  const id = parseId(rawId);
  const [row] = await db.select().from(u).where(eq(u.id, id)).limit(1);
  if (!row) throw ScimError.notFound('User not found');
  const profile = (await profilesFor([id])).get(id) ?? {};
  return {
    userName: row.username,
    displayName: row.displayName,
    givenName: profile.givenName ?? null,
    familyName: profile.familyName ?? null,
    email: row.email,
    active: row.active !== false,
    externalId: profile.externalId ?? null,
  };
}

async function assertUnique(model: UserModel, exceptId?: number) {
  const conds: SQL[] = [or(sql`lower(${u.username}) = ${model.userName}`, sql`lower(${u.email}) = ${model.email}`)!];
  if (exceptId !== undefined) conds.push(ne(u.id, exceptId));
  const [clash] = await db.select({ id: u.id }).from(u).where(and(...conds)).limit(1);
  if (clash) throw ScimError.uniqueness('A user with this userName or email already exists');
}

function resolveDisplayName(m: UserModel): string {
  return m.displayName || [m.givenName, m.familyName].filter(Boolean).join(' ') || m.userName;
}

async function writeProfile(userId: number, m: UserModel) {
  const profile = { externalId: m.externalId, givenName: m.givenName, familyName: m.familyName };
  const [existing] = await db.select({ id: ident.id }).from(ident).where(and(eq(ident.userId, userId), eq(ident.provider, 'scim'))).limit(1);
  if (existing) {
    await db.update(ident).set({ rawProfile: profile, email: m.email!, updatedAt: new Date() }).where(eq(ident.id, existing.id));
  } else {
    await db.insert(ident).values({ userId, provider: 'scim', providerUserId: String(userId), email: m.email!, rawProfile: profile });
  }
}

export async function createUser(m: UserModel, baseUrl: string) {
  if (isAgentUsername(m.userName)) throw ScimError.invalidValue('The agent: user name prefix is reserved for AI agents');
  if (m.userName.trim().toLowerCase() === 'admin') throw ScimError.invalidValue('This user name is reserved'); // the built-in administrator passes every check by this name
  await assertUnique(m);
  if (m.active) await assertSeatAvailable();
  const [row] = await db.insert(u).values({
    username: m.userName, email: m.email!, displayName: resolveDisplayName(m), passwordHash: null, active: m.active,
  }).returning();
  await writeProfile(row.id, m);
  return userToScim(row, { externalId: m.externalId, givenName: m.givenName, familyName: m.familyName }, baseUrl);
}

export async function saveUser(rawId: string, m: UserModel, baseUrl: string) {
  const id = parseId(rawId);
  const [before] = await db.select().from(u).where(eq(u.id, id)).limit(1);
  if (!before) throw ScimError.notFound('User not found');
  if (isAgentUsername(before.username) || isAgentUsername(m.userName)) throw ScimError.mutability('AI agents are managed under Administration > AI agents, not through SCIM');
  await assertUnique(m, id);
  if (before.active === false && m.active) await assertSeatAvailable();
  const [row] = await db.update(u).set({
    username: m.userName, email: m.email!, displayName: resolveDisplayName(m), active: m.active, updatedAt: new Date(),
  }).where(eq(u.id, id)).returning();
  await writeProfile(id, m);
  if (before.active !== false && !m.active) await revokeAccess(id);
  return userToScim(row, { externalId: m.externalId, givenName: m.givenName, familyName: m.familyName }, baseUrl);
}

/** DELETE /Users/:id is a soft delete: the account (and its issues, comments, history) is kept. */
export async function deactivateUser(rawId: string) {
  const id = parseId(rawId);
  const [row] = await db.update(u).set({ active: false, updatedAt: new Date() }).where(eq(u.id, id)).returning({ id: u.id });
  if (!row) throw ScimError.notFound('User not found');
  await revokeAccess(id);
}

/** Kill every credential of a user: web sessions and personal access tokens. */
export async function revokeAccess(userId: number) {
  await deleteAllUserSessions(userId);
  await db.update(schema.personalAccessTokens).set({ revokedAt: new Date() })
    .where(and(eq(schema.personalAccessTokens.userId, userId), isNull(schema.personalAccessTokens.revokedAt)));
  await invalidatePermissionCache(userId).catch(() => {});
}

/* ------------------------------------------------------------------ */
/*  Groups                                                             */
/* ------------------------------------------------------------------ */

async function membersOf(groupIds: number[]) {
  const map = new Map<number, { id: number; displayName: string }[]>();
  if (groupIds.length === 0) return map;
  const rows = await db.select({ groupId: schema.userGroups.groupId, id: u.id, displayName: u.displayName })
    .from(schema.userGroups).innerJoin(u, eq(u.id, schema.userGroups.userId))
    .where(inArray(schema.userGroups.groupId, groupIds)).orderBy(asc(u.id));
  for (const r of rows) {
    const list = map.get(r.groupId) ?? [];
    list.push({ id: r.id, displayName: r.displayName });
    map.set(r.groupId, list);
  }
  return map;
}

export async function listGroups(p: { filter?: string; startIndex: number; count: number; baseUrl: string }) {
  const where = whereFor(p.filter, groupColumns);
  const [{ total }] = await db.select({ total: count() }).from(g).where(where);
  const rows = p.count === 0 ? [] : await db.select().from(g).where(where).orderBy(asc(g.id)).limit(p.count).offset(p.startIndex - 1);
  const members = await membersOf(rows.map((r) => r.id));
  return { total: Number(total), resources: rows.map((r) => groupToScim(r, members.get(r.id) ?? [], p.baseUrl)) };
}

async function loadGroup(rawId: string) {
  const id = parseId(rawId);
  const [row] = await db.select().from(g).where(eq(g.id, id)).limit(1);
  if (!row) throw ScimError.notFound('Group not found');
  return row;
}

export async function getGroup(rawId: string, baseUrl: string) {
  const row = await loadGroup(rawId);
  return groupToScim(row, (await membersOf([row.id])).get(row.id) ?? [], baseUrl);
}

export async function groupModelOf(rawId: string): Promise<GroupModel> {
  const row = await loadGroup(rawId);
  const members = (await membersOf([row.id])).get(row.id) ?? [];
  return { displayName: row.name, memberIds: members.map((m) => String(m.id)) };
}

async function validMemberIds(ids: string[]): Promise<number[]> {
  const nums = ids.map((i) => {
    if (!/^[0-9]{1,9}$/.test(i)) throw ScimError.invalidValue(`Unknown member "${i.slice(0, 20)}"`);
    return Number(i);
  });
  if (nums.length === 0) return [];
  const found = await db.select({ id: u.id }).from(u).where(inArray(u.id, nums));
  const ok = new Set(found.map((f) => f.id));
  const missing = nums.find((n) => !ok.has(n));
  if (missing !== undefined) throw ScimError.invalidValue(`Unknown member "${missing}"`);
  return nums;
}

async function setMembers(groupId: number, ids: string[]) {
  const wanted = await validMemberIds(ids);
  const current = await db.select({ userId: schema.userGroups.userId }).from(schema.userGroups).where(eq(schema.userGroups.groupId, groupId));
  const have = new Set(current.map((c) => c.userId));
  const toRemove = [...have].filter((x) => !wanted.includes(x));
  if (toRemove.length) await db.delete(schema.userGroups).where(and(eq(schema.userGroups.groupId, groupId), inArray(schema.userGroups.userId, toRemove)));
  const toAdd = wanted.filter((x) => !have.has(x));
  if (toAdd.length) await db.insert(schema.userGroups).values(toAdd.map((userId) => ({ userId, groupId }))).onConflictDoNothing();
  for (const uid of new Set([...toRemove, ...toAdd])) await invalidatePermissionCache(uid).catch(() => {});
}

export async function createGroup(m: GroupModel, baseUrl: string) {
  const [clash] = await db.select({ id: g.id }).from(g).where(sql`lower(${g.name}) = ${m.displayName.toLowerCase()}`).limit(1);
  if (clash) throw ScimError.uniqueness('A group with this displayName already exists');
  await validMemberIds(m.memberIds);
  const [row] = await db.insert(g).values({ name: m.displayName, description: 'Provisioned via SCIM' }).returning();
  await setMembers(row.id, m.memberIds);
  return getGroup(String(row.id), baseUrl);
}

export async function saveGroup(rawId: string, m: GroupModel, baseUrl: string) {
  const row = await loadGroup(rawId);
  const [clash] = await db.select({ id: g.id }).from(g).where(and(sql`lower(${g.name}) = ${m.displayName.toLowerCase()}`, ne(g.id, row.id))).limit(1);
  if (clash) throw ScimError.uniqueness('A group with this displayName already exists');
  await validMemberIds(m.memberIds);
  if (row.name !== m.displayName) await db.update(g).set({ name: m.displayName }).where(eq(g.id, row.id));
  await setMembers(row.id, m.memberIds);
  return getGroup(String(row.id), baseUrl);
}

export async function deleteGroup(rawId: string) {
  const row = await loadGroup(rawId);
  const members = (await membersOf([row.id])).get(row.id) ?? [];
  await db.delete(g).where(eq(g.id, row.id));
  for (const m of members) await invalidatePermissionCache(m.id).catch(() => {});
}
