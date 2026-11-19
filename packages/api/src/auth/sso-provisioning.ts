/**
 * Helpers shared by the SAML and LDAP integrations: unique usernames, group mirroring with the "only memberships
 * this provider added are ever removed" rule, and deactivation. (The generic OIDC flow has its own copies in
 * oidc-service.ts which are intentionally left untouched.)
 */
import { randomBytes } from 'crypto';
import { and, eq, inArray } from 'drizzle-orm';
import * as schema from '@veqsio/db';
import { db } from '../db';
import { deleteAllUserSessions } from './session';

export function usernameSeed(seed: string): string {
  return seed.toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 40) || 'user';
}

/** The built-in administrator account passes every permission check by its name; nobody provisioned from outside may take that name. */
const RESERVED_USERNAMES = new Set(['admin']);

export async function uniqueUsername(seed: string): Promise<string> {
  const base = usernameSeed(seed);
  let candidate = base;
  for (let i = 0; i < 20; i++) {
    if (RESERVED_USERNAMES.has(candidate.toLowerCase())) { candidate = `${base}${i + 2}`; continue; }
    const [row] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.username, candidate)).limit(1);
    if (!row) return candidate;
    candidate = `${base}${i + 2}`;
  }
  return `${base}-${randomBytes(4).toString('hex')}`;
}

async function groupByName(name: string, description: string) {
  let [group] = await db.select().from(schema.groups).where(eq(schema.groups.name, name)).limit(1);
  if (!group) {
    [group] = await db.insert(schema.groups).values({ name, description }).onConflictDoNothing().returning();
    if (!group) [group] = await db.select().from(schema.groups).where(eq(schema.groups.name, name)).limit(1);
  }
  return group ?? null;
}

/**
 * Mirrors `groupNames` into Veqsio groups (created when missing) for the user's identity at `providerKey`.
 * The groups this provider added are remembered in the identity's rawProfile.syncedGroups, so a membership is
 * only removed when this provider added it earlier and no longer lists it. Memberships made by hand or by
 * another provider are never touched (unless they coincide with a previously synced group of this provider).
 */
export async function syncIdentityGroups(userId: number, providerKey: string, providerName: string, groupNames: string[]): Promise<void> {
  const [identity] = await db.select().from(schema.userIdentities)
    .where(and(eq(schema.userIdentities.userId, userId), eq(schema.userIdentities.provider, providerKey))).limit(1);
  if (!identity) return;
  const previous: string[] = Array.isArray((identity.rawProfile as any)?.syncedGroups) ? (identity.rawProfile as any).syncedGroups : [];

  for (const name of groupNames) {
    const group = await groupByName(name, `Synced from ${providerName}`);
    if (group) await db.insert(schema.userGroups).values({ userId, groupId: group.id }).onConflictDoNothing();
  }
  const current = new Set(groupNames);
  const dropped = previous.filter((n) => !current.has(n));
  if (dropped.length > 0) {
    const rows = await db.select({ id: schema.groups.id }).from(schema.groups).where(inArray(schema.groups.name, dropped));
    if (rows.length > 0) {
      await db.delete(schema.userGroups).where(and(eq(schema.userGroups.userId, userId), inArray(schema.userGroups.groupId, rows.map((r) => r.id))));
    }
  }
  await db.update(schema.userIdentities)
    .set({ rawProfile: { ...(identity.rawProfile as object), syncedGroups: groupNames }, updatedAt: new Date() })
    .where(eq(schema.userIdentities.id, identity.id));
}

/** Adds the user to groups by name (existing groups only; an unknown default group is skipped, not created). */
export async function addToExistingGroups(userId: number, names: string[]): Promise<void> {
  if (names.length === 0) return;
  const rows = await db.select({ id: schema.groups.id }).from(schema.groups).where(inArray(schema.groups.name, names));
  for (const g of rows) await db.insert(schema.userGroups).values({ userId, groupId: g.id }).onConflictDoNothing();
}

/** Deactivates a user (never deletes) and ends their sessions. */
export async function deactivateUser(userId: number): Promise<void> {
  await db.update(schema.users).set({ active: false }).where(eq(schema.users.id, userId));
  await deleteAllUserSessions(userId);
}
