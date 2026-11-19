import { z } from 'zod';
import { ScimError } from './errors';
import type { GroupModel, UserModel } from './patch';

export const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
export const GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';
export const LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
export const PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';

// SCIM clients send many attributes we do not model; unknown keys are dropped (never applied), which is
// why these schemas are deliberately not `.strict()`.
const str = (max: number) => z.string().trim().max(max);
const userBody = z.object({
  userName: str(255).min(1),
  externalId: str(255).nullish(),
  displayName: str(255).nullish(),
  active: z.union([z.boolean(), z.string()]).nullish(),
  name: z.object({ givenName: str(255).nullish(), familyName: str(255).nullish(), formatted: str(255).nullish() }).nullish(),
  emails: z.array(z.object({ value: str(255), primary: z.boolean().nullish(), type: z.string().nullish() })).max(20).nullish(),
});

const groupBody = z.object({
  displayName: str(255).min(1),
  members: z.array(z.object({ value: str(64).min(1) })).max(5000).nullish(),
});

export function parseUserBody(body: unknown): UserModel {
  const r = userBody.safeParse(body);
  if (!r.success) throw ScimError.invalidValue(r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const b = r.data;
  const userName = b.userName.toLowerCase();
  const primary = b.emails?.find((e) => e.primary) ?? b.emails?.[0];
  const email = (primary?.value || (userName.includes('@') ? userName : '')).toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+$/.test(email)) throw ScimError.invalidValue('A valid email (emails[].value or an email-shaped userName) is required');
  let active = true;
  if (b.active !== undefined && b.active !== null) {
    if (typeof b.active === 'boolean') active = b.active;
    else if (b.active.toLowerCase() === 'true') active = true;
    else if (b.active.toLowerCase() === 'false') active = false;
    else throw ScimError.invalidValue('active must be a boolean');
  }
  return {
    userName,
    displayName: b.displayName || b.name?.formatted || null,
    givenName: b.name?.givenName || null,
    familyName: b.name?.familyName || null,
    email,
    active,
    externalId: b.externalId || null,
  };
}

export function parseGroupBody(body: unknown): GroupModel {
  const r = groupBody.safeParse(body);
  if (!r.success) throw ScimError.invalidValue(r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  return { displayName: r.data.displayName, memberIds: [...new Set((r.data.members ?? []).map((m) => m.value))] };
}

export interface UserRowLike {
  id: number;
  username: string;
  email: string;
  displayName: string;
  active: boolean | null;
  createdAt: Date | null;
  updatedAt: Date | null;
}
export interface ScimProfile { externalId?: string | null; givenName?: string | null; familyName?: string | null }

export function userToScim(u: UserRowLike, profile: ScimProfile, baseUrl: string) {
  return {
    schemas: [USER_SCHEMA],
    id: String(u.id),
    ...(profile.externalId ? { externalId: profile.externalId } : {}),
    userName: u.username,
    ...(u.username.startsWith('agent:') ? { userType: 'agent' } : {}), // AI agent service accounts are marked
    displayName: u.displayName,
    name: {
      formatted: u.displayName,
      ...(profile.givenName ? { givenName: profile.givenName } : {}),
      ...(profile.familyName ? { familyName: profile.familyName } : {}),
    },
    emails: [{ value: u.email, type: 'work', primary: true }],
    active: u.active !== false,
    meta: {
      resourceType: 'User',
      ...(u.createdAt ? { created: u.createdAt.toISOString() } : {}),
      ...(u.updatedAt ? { lastModified: u.updatedAt.toISOString() } : {}),
      location: `${baseUrl}/scim/v2/Users/${u.id}`,
    },
  };
}

export function groupToScim(g: { id: number; name: string }, members: { id: number; displayName: string }[], baseUrl: string) {
  return {
    schemas: [GROUP_SCHEMA],
    id: String(g.id),
    displayName: g.name,
    members: members.map((m) => ({ value: String(m.id), display: m.displayName, $ref: `${baseUrl}/scim/v2/Users/${m.id}`, type: 'User' })),
    meta: { resourceType: 'Group', location: `${baseUrl}/scim/v2/Groups/${g.id}` },
  };
}

export function listResponse(resources: unknown[], total: number, startIndex: number) {
  return { schemas: [LIST_SCHEMA], totalResults: total, startIndex, itemsPerPage: resources.length, Resources: resources };
}

/** Clamp paging parameters (RFC 7644 3.4.2.4): startIndex is 1-based and < 1 means 1; count < 0 means 0. */
export function pageParams(startIndexRaw?: string, countRaw?: string, defaultCount = 100, maxCount = 200) {
  const si = Number.parseInt(startIndexRaw ?? '', 10);
  const ct = Number.parseInt(countRaw ?? '', 10);
  const startIndex = Number.isFinite(si) && si >= 1 ? Math.min(si, 1_000_000_000) : 1;
  const count = Number.isFinite(ct) ? Math.max(0, Math.min(ct, maxCount)) : defaultCount;
  return { startIndex, count };
}
