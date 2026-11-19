/**
 * LDAP / Active Directory integration: password login fallback (search, then bind as the user), JIT provisioning
 * and the user/group sync (planner is pure and unit-tested, applying it is separate so dry-run shows exact counts).
 * Users are NEVER deleted: users that disappeared from the directory are deactivated.
 */
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import * as schema from '@veqsio/db';
import { db } from '../db';
import { hasFeature } from '../license';
import { assertSeatAvailable, countActiveUsers, seatLimit, SeatLimitError } from '../license/seats';
import { decryptSecret } from './secrets';
import { escapeFilterValue, guardedBind, ldaptsFactory, LdapError, normalizeDn, type LdapClient, type LdapClientFactory, type LdapEntry } from './ldap-client';
import { deactivateUser, syncIdentityGroups, uniqueUsername } from './sso-provisioning';

export type LdapDirectoryRow = typeof schema.ldapDirectories.$inferSelect;

let factory: LdapClientFactory = ldaptsFactory;
/** Tests inject an in-memory directory here; pass null to restore the real implementation. */
export function setLdapClientFactoryForTests(f: LdapClientFactory | null): void {
  factory = f ?? ldaptsFactory;
}

export const ldapProviderKey = (id: number) => `ldap:${id}`;
const HARD_MAX_ENTRIES = 50_000;

async function connect(dir: LdapDirectoryRow): Promise<LdapClient> {
  return factory({ url: dir.url, startTls: dir.startTls, tlsRejectUnauthorized: dir.tlsRejectUnauthorized, timeoutMs: Math.min(Math.max(dir.timeoutMs, 1000), 60_000) });
}

/** Connects and binds as the service account. The caller must close the client. */
async function openServiceClient(dir: LdapDirectoryRow): Promise<LdapClient> {
  const client = await connect(dir);
  try {
    await guardedBind(client, dir.bindDn, decryptSecret(dir.bindPasswordEncrypted));
  } catch (err) {
    await client.close().catch(() => {});
    throw err;
  }
  return client;
}

const maxEntries = (dir: LdapDirectoryRow) => Math.min(Math.max(dir.maxEntries, 1), HARD_MAX_ENTRIES);

/* ------------------------------------------------------------------ */
/*  Entries -> users                                                   */
/* ------------------------------------------------------------------ */

export interface DirUser {
  /** Stable key: the unique id attribute, or the normalised DN when the server has none. */
  key: string;
  dn: string;
  username: string | null;
  email: string | null;
  name: string | null;
}

const first = (e: LdapEntry, attr: string): string | null => {
  const k = Object.keys(e.attrs).find((x) => x.toLowerCase() === attr.toLowerCase());
  const v = k ? e.attrs[k]?.[0] : undefined;
  return v && v.trim() ? v.trim() : null;
};

type UserAttrConfig = Pick<LdapDirectoryRow, 'usernameAttribute' | 'emailAttribute' | 'displayNameAttribute' | 'uniqueIdAttribute'>;

export function entryToUser(dir: UserAttrConfig, e: LdapEntry): DirUser {
  const uid = first(e, dir.uniqueIdAttribute);
  const email = first(e, dir.emailAttribute);
  return {
    key: (uid ?? `dn:${normalizeDn(e.dn)}`).slice(0, 255),
    dn: e.dn,
    username: first(e, dir.usernameAttribute),
    email: email && /^[^@\s]+@[^@\s]+$/.test(email) ? email.toLowerCase().slice(0, 255) : null,
    name: first(e, dir.displayNameAttribute)?.slice(0, 255) ?? null,
  };
}

const userAttributes = (dir: UserAttrConfig) => [dir.usernameAttribute, dir.emailAttribute, dir.displayNameAttribute, dir.uniqueIdAttribute];

export function userLookupFilter(dir: Pick<LdapDirectoryRow, 'userFilter' | 'usernameAttribute'>, username: string): string {
  return `(&${dir.userFilter.trim()}(${dir.usernameAttribute}=${escapeFilterValue(username)}))`;
}

/* ------------------------------------------------------------------ */
/*  Test connection                                                    */
/* ------------------------------------------------------------------ */

export async function testConnection(dir: LdapDirectoryRow): Promise<{ ok: boolean; error?: string; users?: number; groups?: number | null; truncated?: boolean }> {
  let client: LdapClient | null = null;
  try {
    client = await openServiceClient(dir);
    const limit = Math.min(maxEntries(dir), 200);
    const u = await client.search(dir.baseDn, { filter: dir.userFilter, attributes: userAttributes(dir), sizeLimit: limit });
    let groups: number | null = null;
    if (dir.groupBaseDn) groups = (await client.search(dir.groupBaseDn, { filter: dir.groupFilter, attributes: [dir.groupNameAttribute], sizeLimit: limit })).entries.length;
    return { ok: true, users: u.entries.length, groups, truncated: u.truncated };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  } finally {
    await client?.close().catch(() => {});
  }
}

export function describeError(err: unknown): string {
  if (err instanceof LdapError) {
    switch (err.code) {
      case 'invalid_credentials': return 'The service account bind was rejected (check bind DN and password)';
      case 'refused': return `Refused: ${err.message}`;
      case 'timeout': return 'The directory did not answer in time';
      case 'connect': return `Cannot connect to the directory: ${err.message.slice(0, 160)}`;
      case 'size_limit': return 'The directory returned more entries than the configured limit';
      default: return `Directory error: ${err.message.slice(0, 160)}`;
    }
  }
  return err instanceof Error ? err.message.slice(0, 160) : 'unknown error';
}

/* ------------------------------------------------------------------ */
/*  Authentication (search, then bind as the user)                     */
/* ------------------------------------------------------------------ */

/**
 * Returns the directory user when `password` is the correct password for the directory entry whose login attribute
 * equals `username`; null when the credentials are wrong or the user is not unique. Throws LdapError when the
 * directory cannot be reached. The DN that is bound comes from the SEARCH RESULT, never from user input.
 */
export async function authenticateAgainst(dir: LdapDirectoryRow, username: string, password: string): Promise<DirUser | null> {
  if (typeof username !== 'string' || typeof password !== 'string') return null;
  if (!username.trim() || username.length > 255 || password.length === 0 || password.length > 1024) return null;
  if (username.includes('\u0000') || password.includes('\u0000')) return null;

  let svc: LdapClient | null = null;
  try {
    svc = await openServiceClient(dir);
    const { entries } = await svc.search(dir.baseDn, { filter: userLookupFilter(dir, username.trim()), attributes: userAttributes(dir), sizeLimit: 2 });
    if (entries.length !== 1) return null; // unknown or ambiguous: never guess
    const entry = entries[0];
    const user = entryToUser(dir, entry);
    let userClient: LdapClient | null = null;
    try {
      userClient = await connect(dir);
      await guardedBind(userClient, entry.dn, password);
    } catch (err) {
      if (err instanceof LdapError && (err.code === 'invalid_credentials' || err.code === 'refused')) return null;
      throw err;
    } finally {
      await userClient?.close().catch(() => {});
    }
    return user;
  } finally {
    await svc?.close().catch(() => {});
  }
}

export interface LdapLoginOutcome {
  /** True when a directory decided this login (success or failure): the local password must then not be consulted. */
  handled: boolean;
  userId?: number;
}

/** Group names a user belongs to (direct membership). Used at login when nested groups are off. */
async function directGroupsOf(dir: LdapDirectoryRow, user: DirUser, username: string): Promise<string[] | null> {
  if (!dir.groupBaseDn || dir.nestedGroups) return null;
  const svc = await openServiceClient(dir);
  try {
    const mem = dir.groupMemberAttribute;
    const value = mem.toLowerCase() === 'memberuid' ? username : user.dn;
    const { entries } = await svc.search(dir.groupBaseDn, { filter: `(&${dir.groupFilter.trim()}(${mem}=${escapeFilterValue(value)}))`, attributes: [dir.groupNameAttribute], sizeLimit: maxEntries(dir) });
    return [...new Set(entries.map((e) => first(e, dir.groupNameAttribute)).filter((x): x is string => !!x))];
  } finally {
    await svc.close().catch(() => {});
  }
}

async function activeLoginDirectories(): Promise<LdapDirectoryRow[]> {
  if (!hasFeature('ldap')) return [];
  return db.select().from(schema.ldapDirectories).where(and(eq(schema.ldapDirectories.enabled, true), eq(schema.ldapDirectories.loginEnabled, true)));
}

/**
 * Directory login for POST /session. `existing` is the local user with this username, if any.
 *  - a local user linked to a directory is checked against that directory ONLY,
 *  - a local user that is not linked is never touched (handled=false: local password applies, no takeover by name),
 *  - an unknown username is tried against directories that auto-provision (JIT).
 */
export async function ldapLogin(username: string, password: string, existing: { id: number; active: boolean | null } | null): Promise<LdapLoginOutcome> {
  const dirs = await activeLoginDirectories();
  if (dirs.length === 0) return { handled: false };

  if (existing) {
    const identities = await db.select().from(schema.userIdentities)
      .where(and(eq(schema.userIdentities.userId, existing.id), like(schema.userIdentities.provider, 'ldap:%')));
    if (identities.length === 0) return { handled: false };
    for (const identity of identities) {
      const dir = dirs.find((d) => ldapProviderKey(d.id) === identity.provider);
      if (!dir) continue;
      const login = (identity.rawProfile as any)?.ldapLogin || username;
      let user: DirUser | null = null;
      try { user = await authenticateAgainst(dir, login, password); } catch (err) { console.warn('LDAP login failed', { directory: dir.id, reason: describeError(err) }); continue; }
      if (!user || user.key !== identity.providerUserId) continue; // wrong password, or the login now belongs to another entry
      await refreshProfile(dir, existing.id, identity.id, user, login);
      return { handled: true, userId: existing.id };
    }
    return { handled: true };
  }

  for (const dir of dirs.filter((d) => d.autoProvision)) {
    let user: DirUser | null = null;
    try { user = await authenticateAgainst(dir, username, password); } catch (err) { console.warn('LDAP login failed', { directory: dir.id, reason: describeError(err) }); continue; }
    if (!user) continue;
    const id = await provisionLoginUser(dir, user, username);
    if (id) {
      const g = await directGroupsOf(dir, user, username).catch(() => null);
      if (g) await syncIdentityGroups(id, ldapProviderKey(dir.id), dir.name, g);
      return { handled: true, userId: id };
    }
  }
  return { handled: false };
}

async function refreshProfile(dir: LdapDirectoryRow, userId: number, identityId: number, u: DirUser, login: string) {
  const patch: Record<string, unknown> = {};
  if (u.name) patch.displayName = u.name;
  if (u.email) {
    const [other] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, u.email)).limit(1);
    if (!other || other.id === userId) patch.email = u.email;
  }
  if (Object.keys(patch).length > 0) await db.update(schema.users).set(patch).where(eq(schema.users.id, userId));
  void login;
  const groups = await directGroupsOf(dir, u, login).catch(() => null);
  if (groups) await syncIdentityGroups(userId, ldapProviderKey(dir.id), dir.name, groups);
  void identityId;
}

/** JIT: returns the new (or linked) user id, or null when provisioning is refused. */
async function provisionLoginUser(dir: LdapDirectoryRow, u: DirUser, login: string): Promise<number | null> {
  if (!u.email) return null;
  const key = ldapProviderKey(dir.id);
  const [byIdentity] = await db.select().from(schema.userIdentities).where(and(eq(schema.userIdentities.provider, key), eq(schema.userIdentities.providerUserId, u.key))).limit(1);
  if (byIdentity) {
    const [usr] = await db.select().from(schema.users).where(eq(schema.users.id, byIdentity.userId)).limit(1);
    return usr && usr.active !== false ? usr.id : null;
  }
  const [existing] = await db.select().from(schema.users).where(eq(schema.users.email, u.email)).limit(1);
  if (existing) {
    if (!dir.linkByEmail || existing.active === false) return null;
    await db.insert(schema.userIdentities).values({ userId: existing.id, provider: key, providerUserId: u.key, email: u.email, rawProfile: { syncedGroups: [], ldapLogin: login } });
    return existing.id;
  }
  try { await assertSeatAvailable(); } catch (e) { if (e instanceof SeatLimitError) return null; throw e; }
  const username = await uniqueUsername(u.username || u.email.split('@')[0]);
  const [created] = await db.insert(schema.users).values({ username, email: u.email, displayName: u.name || u.email, passwordHash: null, active: true }).returning();
  await db.insert(schema.userIdentities).values({ userId: created.id, provider: key, providerUserId: u.key, email: u.email, rawProfile: { syncedGroups: [], ldapLogin: login } });
  return created.id;
}

/* ------------------------------------------------------------------ */
/*  Sync planner (pure)                                                */
/* ------------------------------------------------------------------ */

export interface ExistingIdentity {
  identityId: number;
  userId: number;
  key: string;
  active: boolean;
  email: string;
  displayName: string;
  syncedGroups: string[];
  deactivatedBySync: boolean;
}

export interface PlanInput {
  autoProvision: boolean;
  linkByEmail: boolean;
  deactivateMissing: boolean;
  users: DirUser[];
  existing: ExistingIdentity[];
  /** Local users by e-mail (for linking and e-mail conflict checks); `linkedToThis` = already has an identity of this directory. */
  emailOwners: Map<string, { userId: number; active: boolean; linkedToThis: boolean }>;
  /** Group name -> member user keys (nested groups already expanded). */
  groups: Map<string, Set<string>>;
  /** Current memberships by user id (group names), for exact add/remove counts. */
  memberships: Map<number, Set<string>>;
  /** Free seats (null = unlimited). */
  seatsFree: number | null;
}

export interface PlannedUser {
  key: string;
  dn: string;
  username: string | null;
  action: 'create' | 'link' | 'update' | 'unchanged' | 'reactivate';
  userId?: number;
  identityId?: number;
  email: string | null;
  name: string | null;
  setEmail?: boolean;
  setName?: boolean;
  groups: string[];
}

export interface SyncPlan {
  users: PlannedUser[];
  deactivate: ExistingIdentity[];
  skipped: Array<{ key: string; reason: string }>;
  groupsToCreate: string[];
  counts: {
    directoryUsers: number; create: number; link: number; update: number; reactivate: number; deactivate: number; skipped: number;
    groupsCreate: number; membershipsAdd: number; membershipsRemove: number;
  };
}

export function planSync(input: PlanInput, existingGroupNames: Set<string>): SyncPlan {
  const byKey = new Map(input.existing.map((e) => [e.key, e]));
  const present = new Set(input.users.map((u) => u.key));
  const userGroups = new Map<string, string[]>();
  for (const [g, members] of input.groups) for (const k of members) userGroups.set(k, [...(userGroups.get(k) ?? []), g]);

  let seats = input.seatsFree;
  const takeSeat = () => { if (seats === null) return true; if (seats <= 0) return false; seats--; return true; };

  const plan: SyncPlan = { users: [], deactivate: [], skipped: [], groupsToCreate: [], counts: { directoryUsers: input.users.length, create: 0, link: 0, update: 0, reactivate: 0, deactivate: 0, skipped: 0, groupsCreate: 0, membershipsAdd: 0, membershipsRemove: 0 } };
  const seenEmails = new Set<string>();
  const newGroups = new Set<string>();
  const skip = (key: string, reason: string) => { plan.skipped.push({ key, reason }); plan.counts.skipped++; };

  for (const u of input.users) {
    const groups = [...new Set(userGroups.get(u.key) ?? [])].sort();
    const ex = byKey.get(u.key);
    let p: PlannedUser | null = null;
    if (ex) {
      let action: PlannedUser['action'] = 'unchanged';
      if (!ex.active && ex.deactivatedBySync) {
        if (!takeSeat()) { skip(u.key, 'seat_limit'); continue; }
        action = 'reactivate';
      } else if (!ex.active) {
        skip(u.key, 'deactivated_manually'); // an administrator switched this account off: sync does not undo that
        continue;
      }
      const emailOwner = u.email ? input.emailOwners.get(u.email) : undefined;
      const emailFree = !!u.email && (!emailOwner || emailOwner.userId === ex.userId) && !seenEmails.has(u.email);
      const setEmail = !!u.email && u.email !== ex.email && emailFree;
      const setName = !!u.name && u.name !== ex.displayName;
      if (u.email) seenEmails.add(u.email);
      if (action === 'unchanged' && (setEmail || setName)) action = 'update';
      p = { key: u.key, dn: u.dn, username: u.username, action, userId: ex.userId, identityId: ex.identityId, email: u.email, name: u.name, setEmail, setName, groups };
    } else {
      if (!u.email) { skip(u.key, 'no_email'); continue; }
      if (seenEmails.has(u.email)) { skip(u.key, 'duplicate_email'); continue; }
      const owner = input.emailOwners.get(u.email);
      if (owner) {
        if (!input.linkByEmail) { skip(u.key, 'email_in_use'); continue; }
        if (!owner.active || owner.linkedToThis) { skip(u.key, owner.linkedToThis ? 'email_in_use' : 'deactivated_manually'); continue; }
        seenEmails.add(u.email);
        p = { key: u.key, dn: u.dn, username: u.username, action: 'link', userId: owner.userId, email: u.email, name: u.name, groups };
      } else {
        if (!input.autoProvision) { skip(u.key, 'not_provisioned'); continue; }
        if (!takeSeat()) { skip(u.key, 'seat_limit'); continue; }
        seenEmails.add(u.email);
        p = { key: u.key, dn: u.dn, username: u.username, action: 'create', email: u.email, name: u.name, groups };
      }
    }
    plan.users.push(p);
    if (p.action !== 'unchanged') plan.counts[p.action]++;

    const current = p.userId ? input.memberships.get(p.userId) ?? new Set<string>() : new Set<string>();
    const prevSynced = ex?.syncedGroups ?? [];
    for (const g of groups) {
      if (!current.has(g)) plan.counts.membershipsAdd++;
      if (!existingGroupNames.has(g)) newGroups.add(g);
    }
    for (const g of prevSynced) if (!groups.includes(g) && current.has(g)) plan.counts.membershipsRemove++;
  }

  if (input.deactivateMissing) {
    for (const e of input.existing) {
      if (!present.has(e.key) && e.active) { plan.deactivate.push(e); plan.counts.deactivate++; }
    }
  }
  plan.groupsToCreate = [...newGroups].sort();
  plan.counts.groupsCreate = plan.groupsToCreate.length;
  return plan;
}

/** Group name -> user keys. Handles `member` (DN values), `memberUid` (login names) and nested groups. */
export function buildGroupMembers(
  dir: Pick<LdapDirectoryRow, 'groupNameAttribute' | 'groupMemberAttribute' | 'nestedGroups'>,
  groupEntries: LdapEntry[],
  users: DirUser[],
): Map<string, Set<string>> {
  const byDn = new Map(users.map((u) => [normalizeDn(u.dn), u.key]));
  const byLogin = new Map(users.filter((u) => u.username).map((u) => [u.username!.toLowerCase(), u.key]));
  const useUid = dir.groupMemberAttribute.toLowerCase() === 'memberuid';
  const memberAttr = (e: LdapEntry) => e.attrs[Object.keys(e.attrs).find((k) => k.toLowerCase() === dir.groupMemberAttribute.toLowerCase()) ?? ''] ?? [];

  const groups = groupEntries.map((e) => ({ dn: normalizeDn(e.dn), name: first(e, dir.groupNameAttribute), members: memberAttr(e) })).filter((g) => !!g.name);
  const groupByDn = new Map(groups.map((g) => [g.dn, g]));
  const out = new Map<string, Set<string>>();

  const resolve = (g: (typeof groups)[number], seen: Set<string>): Set<string> => {
    const keys = new Set<string>();
    if (seen.has(g.dn)) return keys; // cycle
    seen.add(g.dn);
    for (const m of g.members) {
      const k = useUid ? byLogin.get(m.toLowerCase()) : byDn.get(normalizeDn(m));
      if (k) keys.add(k);
      else if (dir.nestedGroups) {
        const child = groupByDn.get(normalizeDn(m));
        if (child) for (const x of resolve(child, seen)) keys.add(x);
      }
    }
    return keys;
  };
  for (const g of groups) {
    const keys = resolve(g, new Set());
    if (keys.size === 0) continue;
    const name = g.name!.slice(0, 255);
    out.set(name, new Set([...(out.get(name) ?? []), ...keys]));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  Sync run                                                           */
/* ------------------------------------------------------------------ */

export interface SyncResult {
  ok: boolean;
  dryRun: boolean;
  error?: string;
  counts?: SyncPlan['counts'];
  skipped?: SyncPlan['skipped'];
  groupsToCreate?: string[];
  at: string;
}

const LEASE_MS = 10 * 60_000;

async function acquireLease(id: number): Promise<boolean> {
  const rows = await db.update(schema.ldapDirectories)
    .set({ syncLockUntil: new Date(Date.now() + LEASE_MS) })
    .where(and(eq(schema.ldapDirectories.id, id), sql`(${schema.ldapDirectories.syncLockUntil} is null or ${schema.ldapDirectories.syncLockUntil} < now())`))
    .returning({ id: schema.ldapDirectories.id });
  return rows.length > 0;
}

async function releaseLease(id: number) {
  await db.update(schema.ldapDirectories).set({ syncLockUntil: null }).where(eq(schema.ldapDirectories.id, id));
}

async function loadPlanInput(dir: LdapDirectoryRow, users: DirUser[], groupEntries: LdapEntry[]): Promise<{ input: PlanInput; groupNames: Set<string> }> {
  const key = ldapProviderKey(dir.id);
  const idents = await db.select({
    identityId: schema.userIdentities.id, userId: schema.userIdentities.userId, key: schema.userIdentities.providerUserId, raw: schema.userIdentities.rawProfile,
    active: schema.users.active, email: schema.users.email, displayName: schema.users.displayName,
  }).from(schema.userIdentities).innerJoin(schema.users, eq(schema.users.id, schema.userIdentities.userId)).where(eq(schema.userIdentities.provider, key));
  const existing: ExistingIdentity[] = idents.map((r) => ({
    identityId: r.identityId, userId: r.userId, key: r.key, active: r.active !== false, email: r.email, displayName: r.displayName ?? '',
    syncedGroups: Array.isArray((r.raw as any)?.syncedGroups) ? (r.raw as any).syncedGroups : [], deactivatedBySync: !!(r.raw as any)?.deactivatedBySync,
  }));
  const linkedUserIds = new Set(existing.map((e) => e.userId));

  const emails = [...new Set(users.map((u) => u.email).filter((e): e is string => !!e))];
  const emailOwners: PlanInput['emailOwners'] = new Map();
  for (let i = 0; i < emails.length; i += 500) {
    const rows = await db.select({ id: schema.users.id, email: schema.users.email, active: schema.users.active }).from(schema.users).where(inArray(schema.users.email, emails.slice(i, i + 500)));
    for (const r of rows) emailOwners.set(r.email.toLowerCase(), { userId: r.id, active: r.active !== false, linkedToThis: linkedUserIds.has(r.id) });
  }

  const memberships = new Map<number, Set<string>>();
  const userIds = existing.map((e) => e.userId);
  for (let i = 0; i < userIds.length; i += 500) {
    const rows = await db.select({ userId: schema.userGroups.userId, name: schema.groups.name }).from(schema.userGroups)
      .innerJoin(schema.groups, eq(schema.groups.id, schema.userGroups.groupId)).where(inArray(schema.userGroups.userId, userIds.slice(i, i + 500)));
    for (const r of rows) memberships.set(r.userId, (memberships.get(r.userId) ?? new Set()).add(r.name));
  }
  // Link-by-email targets also need their memberships for exact counts.
  const groups = buildGroupMembers(dir, groupEntries, users);
  const allGroupNames = new Set((await db.select({ name: schema.groups.name }).from(schema.groups)).map((g) => g.name));

  const limit = seatLimit();
  const seatsFree = limit === null ? null : Math.max(0, limit - (await countActiveUsers()));
  return { input: { autoProvision: dir.autoProvision, linkByEmail: dir.linkByEmail, deactivateMissing: dir.deactivateMissing, users, existing, emailOwners, groups, memberships, seatsFree }, groupNames: allGroupNames };
}

export async function runSync(dir: LdapDirectoryRow, opts: { dryRun: boolean; force?: boolean }): Promise<SyncResult> {
  const at = new Date().toISOString();
  const fail = async (error: string): Promise<SyncResult> => {
    const r: SyncResult = { ok: false, dryRun: opts.dryRun, error, at };
    if (!opts.dryRun) await db.update(schema.ldapDirectories).set({ lastSyncAt: new Date(), lastSyncResult: r as any }).where(eq(schema.ldapDirectories.id, dir.id));
    return r;
  };
  if (!hasFeature('ldap')) return { ok: false, dryRun: opts.dryRun, error: 'licence_required', at };
  if (!opts.dryRun && !(await acquireLease(dir.id))) return { ok: false, dryRun: false, error: 'A sync of this directory is already running', at };

  let client: LdapClient | null = null;
  try {
    client = await openServiceClient(dir);
    const limit = maxEntries(dir);
    const found = await client.search(dir.baseDn, { filter: dir.userFilter, attributes: userAttributes(dir), sizeLimit: limit });
    // A truncated listing would look like "everyone else left": refuse instead of deactivating people.
    if (found.truncated) return await fail(`The directory returned more than ${limit} users; raise the entry limit or narrow the user filter`);
    const users = found.entries.map((e) => entryToUser(dir, e));
    let groupEntries: LdapEntry[] = [];
    if (dir.groupBaseDn) {
      const g = await client.search(dir.groupBaseDn, { filter: dir.groupFilter, attributes: [dir.groupNameAttribute, dir.groupMemberAttribute], sizeLimit: limit });
      if (g.truncated) return await fail(`The directory returned more than ${limit} groups; raise the entry limit or narrow the group filter`);
      groupEntries = g.entries;
    }

    const { input, groupNames } = await loadPlanInput(dir, users, groupEntries);
    const plan = planSync(input, groupNames);

    const linked = input.existing.filter((e) => e.active).length;
    if (users.length === 0 && linked > 0 && dir.deactivateMissing) return await fail('The directory returned no users; refusing to deactivate every linked account');
    if (!opts.force && linked >= 5 && plan.counts.deactivate > linked / 2) {
      return await fail(`The sync would deactivate ${plan.counts.deactivate} of ${linked} linked users; check the directory settings, then run it manually with force`);
    }

    const result: SyncResult = { ok: true, dryRun: opts.dryRun, counts: plan.counts, skipped: plan.skipped.slice(0, 200), groupsToCreate: plan.groupsToCreate.slice(0, 200), at };
    if (opts.dryRun) return result;

    await applyPlan(dir, plan);
    await db.update(schema.ldapDirectories).set({ lastSyncAt: new Date(), lastSyncResult: { ...result, skipped: result.skipped?.slice(0, 50) } as any }).where(eq(schema.ldapDirectories.id, dir.id));
    return result;
  } catch (err) {
    console.warn('LDAP sync failed', { directory: dir.id, reason: describeError(err) });
    return await fail(describeError(err));
  } finally {
    await client?.close().catch(() => {});
    if (!opts.dryRun) await releaseLease(dir.id).catch(() => {});
  }
}

async function applyPlan(dir: LdapDirectoryRow, plan: SyncPlan) {
  const key = ldapProviderKey(dir.id);
  for (const p of plan.users) {
    let userId = p.userId;
    if (p.action === 'create') {
      const username = await uniqueUsername(p.username || p.email!.split('@')[0]);
      const [u] = await db.insert(schema.users).values({ username, email: p.email!, displayName: p.name || p.email!, passwordHash: null, active: true }).returning();
      userId = u.id;
      await db.insert(schema.userIdentities).values({ userId, provider: key, providerUserId: p.key, email: p.email!, rawProfile: { syncedGroups: [], ldapLogin: p.username } });
    } else if (p.action === 'link') {
      await db.insert(schema.userIdentities).values({ userId: userId!, provider: key, providerUserId: p.key, email: p.email!, rawProfile: { syncedGroups: [], ldapLogin: p.username } });
    } else if (p.action === 'reactivate') {
      await db.update(schema.users).set({ active: true }).where(eq(schema.users.id, userId!));
      const [ident] = await db.select().from(schema.userIdentities).where(eq(schema.userIdentities.id, p.identityId!)).limit(1);
      if (ident) await db.update(schema.userIdentities).set({ rawProfile: { ...(ident.rawProfile as object), deactivatedBySync: false }, updatedAt: new Date() }).where(eq(schema.userIdentities.id, ident.id));
    }
    if (p.action === 'update' || p.action === 'reactivate') {
      const patch: Record<string, unknown> = {};
      if (p.setEmail && p.email) patch.email = p.email;
      if (p.setName && p.name) patch.displayName = p.name;
      if (Object.keys(patch).length > 0) await db.update(schema.users).set(patch).where(eq(schema.users.id, userId!));
    }
    if (userId && (dir.groupBaseDn)) {
      await syncIdentityGroups(userId, key, dir.name, p.groups);
    }
    if (userId && p.username) {
      const [ident] = await db.select().from(schema.userIdentities).where(and(eq(schema.userIdentities.userId, userId), eq(schema.userIdentities.provider, key))).limit(1);
      if (ident && (ident.rawProfile as any)?.ldapLogin !== p.username) {
        await db.update(schema.userIdentities).set({ rawProfile: { ...(ident.rawProfile as object), ldapLogin: p.username } }).where(eq(schema.userIdentities.id, ident.id));
      }
    }
  }
  for (const e of plan.deactivate) {
    await deactivateUser(e.userId);
    const [ident] = await db.select().from(schema.userIdentities).where(eq(schema.userIdentities.id, e.identityId)).limit(1);
    if (ident) await db.update(schema.userIdentities).set({ rawProfile: { ...(ident.rawProfile as object), deactivatedBySync: true }, updatedAt: new Date() }).where(eq(schema.userIdentities.id, ident.id));
  }
}

/** Scheduler entry: runs every enabled directory whose interval elapsed. Safe against double runs (DB lease). */
export async function runDueDirectorySyncs(): Promise<number> {
  if (!hasFeature('ldap')) return 0;
  const dirs = await db.select().from(schema.ldapDirectories).where(and(eq(schema.ldapDirectories.enabled, true), eq(schema.ldapDirectories.syncEnabled, true)));
  let n = 0;
  for (const d of dirs) {
    const due = !d.lastSyncAt || Date.now() - d.lastSyncAt.getTime() >= Math.max(d.syncIntervalMinutes, 5) * 60_000;
    if (!due) continue;
    const r = await runSync(d, { dryRun: false });
    if (r.ok) n++;
  }
  return n;
}
