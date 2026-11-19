/**
 * Pure SCIM PATCH (RFC 7644 section 3.5.2) application for Users and Groups.
 * Unknown attributes are ignored (Entra and Okta send extension attributes we do not model).
 */
import { ScimError } from './errors';

export interface PatchOp {
  op: string;
  path?: string;
  value?: unknown;
}

export interface UserModel {
  userName: string;
  displayName: string | null;
  givenName: string | null;
  familyName: string | null;
  email: string | null;
  active: boolean;
  externalId: string | null;
}

export interface GroupModel {
  displayName: string;
  memberIds: string[];
}

const USER_SCHEMA_PREFIX = 'urn:ietf:params:scim:schemas:core:2.0:user:';
const GROUP_SCHEMA_PREFIX = 'urn:ietf:params:scim:schemas:core:2.0:group:';
const MAX_OPS = 100;

export function normalizeOps(body: unknown): { op: 'add' | 'replace' | 'remove'; path?: string; value?: unknown }[] {
  const ops = (body as any)?.Operations ?? (body as any)?.operations;
  if (!Array.isArray(ops) || ops.length === 0) throw ScimError.invalidSyntax('Operations array is required');
  if (ops.length > MAX_OPS) throw ScimError.invalidSyntax('Too many operations');
  return ops.map((o: any) => {
    const op = typeof o?.op === 'string' ? o.op.toLowerCase() : '';
    if (op !== 'add' && op !== 'replace' && op !== 'remove') throw ScimError.invalidSyntax(`Unsupported operation "${String(o?.op)}"`);
    if (o.path !== undefined && typeof o.path !== 'string') throw ScimError.invalidPath('path must be a string');
    return { op, path: o.path as string | undefined, value: o.value };
  });
}

export function toBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true') return true;
    if (s === 'false') return false;
  }
  throw ScimError.invalidValue('Expected a boolean');
}

function toStr(v: unknown, max = 255): string {
  if (typeof v !== 'string') throw ScimError.invalidValue('Expected a string');
  const s = v.trim();
  if (s.length > max) throw ScimError.invalidValue('Value too long');
  return s;
}

function pickEmail(v: unknown): string | null {
  const arr = Array.isArray(v) ? v : [v];
  const emails = arr.filter((e): e is { value: string; primary?: boolean } => !!e && typeof e === 'object' && typeof (e as any).value === 'string');
  const chosen = emails.find((e) => e.primary === true) ?? emails[0];
  return chosen ? toStr(chosen.value) : null;
}

function setUserAttr(m: UserModel, rawPath: string, value: unknown, op: 'add' | 'replace' | 'remove'): void {
  let path = rawPath.trim();
  if (path.toLowerCase().startsWith(USER_SCHEMA_PREFIX)) path = path.slice(USER_SCHEMA_PREFIX.length);
  const lower = path.toLowerCase();
  const remove = op === 'remove';

  if (lower === 'username') {
    if (remove) throw ScimError.mutability('userName is required');
    m.userName = toStr(value).toLowerCase();
  } else if (lower === 'displayname') {
    m.displayName = remove ? null : toStr(value);
  } else if (lower === 'active') {
    if (remove) throw ScimError.mutability('active cannot be removed');
    m.active = toBool(value);
  } else if (lower === 'externalid') {
    m.externalId = remove ? null : toStr(value);
  } else if (lower === 'name.givenname') {
    m.givenName = remove ? null : toStr(value);
  } else if (lower === 'name.familyname') {
    m.familyName = remove ? null : toStr(value);
  } else if (lower === 'name') {
    if (remove) { m.givenName = null; m.familyName = null; return; }
    const o = (value ?? {}) as Record<string, unknown>;
    if (typeof o !== 'object') throw ScimError.invalidValue('name must be an object');
    if (o.givenName !== undefined) m.givenName = toStr(o.givenName);
    if (o.familyName !== undefined) m.familyName = toStr(o.familyName);
    if (o.formatted !== undefined && m.displayName === null) m.displayName = toStr(o.formatted);
  } else if (lower === 'emails' || /^emails\[[^\]]*\](\.value)?$/.test(lower) || lower === 'emails.value') {
    if (remove) {
      // Veqsio requires an email; removing the primary one is refused rather than silently ignored.
      throw ScimError.mutability('emails cannot be removed');
    }
    const next = lower.endsWith('.value') ? pickEmail([{ value, primary: true }]) : pickEmail(value);
    if (next) m.email = next.toLowerCase();
  }
  // anything else: ignored
}

export function applyUserPatch(current: UserModel, body: unknown): UserModel {
  const m: UserModel = { ...current };
  for (const o of normalizeOps(body)) {
    if (o.path) {
      if (o.op === 'remove') setUserAttr(m, o.path, undefined, 'remove');
      else setUserAttr(m, o.path, o.value, o.op);
    } else {
      if (o.op === 'remove') throw ScimError.noTarget('remove requires a path');
      if (!o.value || typeof o.value !== 'object' || Array.isArray(o.value)) throw ScimError.invalidValue('value must be an object when path is omitted');
      for (const [k, v] of Object.entries(o.value as Record<string, unknown>)) {
        if (k === 'schemas') continue;
        setUserAttr(m, k, v, o.op);
      }
    }
  }
  return m;
}

function memberValues(v: unknown): string[] {
  const arr = Array.isArray(v) ? v : [v];
  const out: string[] = [];
  for (const e of arr) {
    const val = e && typeof e === 'object' ? (e as any).value : undefined;
    if (typeof val !== 'string' || !val) throw ScimError.invalidValue('Each member needs a value');
    out.push(val);
  }
  return out;
}

export function applyGroupPatch(current: GroupModel, body: unknown): GroupModel {
  const m: GroupModel = { displayName: current.displayName, memberIds: [...current.memberIds] };
  for (const o of normalizeOps(body)) {
    let path = o.path?.trim();
    if (path && path.toLowerCase().startsWith(GROUP_SCHEMA_PREFIX)) path = path.slice(GROUP_SCHEMA_PREFIX.length);
    const lower = path?.toLowerCase();

    if (!path) {
      if (o.op === 'remove') throw ScimError.noTarget('remove requires a path');
      if (!o.value || typeof o.value !== 'object' || Array.isArray(o.value)) throw ScimError.invalidValue('value must be an object when path is omitted');
      const v = o.value as Record<string, unknown>;
      if (v.displayName !== undefined) m.displayName = toStr(v.displayName);
      if (v.members !== undefined) {
        const ids = memberValues(v.members);
        m.memberIds = o.op === 'replace' ? ids : [...new Set([...m.memberIds, ...ids])];
      }
    } else if (lower === 'displayname') {
      if (o.op === 'remove') throw ScimError.mutability('displayName is required');
      m.displayName = toStr(o.value);
    } else if (lower === 'members') {
      if (o.op === 'remove') {
        if (o.value === undefined) m.memberIds = [];
        else { const rm = new Set(memberValues(o.value)); m.memberIds = m.memberIds.filter((id) => !rm.has(id)); }
      } else {
        const ids = memberValues(o.value);
        m.memberIds = o.op === 'replace' ? [...new Set(ids)] : [...new Set([...m.memberIds, ...ids])];
      }
    } else {
      const match = /^members\[\s*value\s+eq\s+"([^"]*)"\s*\]$/i.exec(path);
      if (match && o.op === 'remove') {
        m.memberIds = m.memberIds.filter((id) => id !== match[1]);
      } else if (match) {
        throw ScimError.invalidPath('Filtered members path is only valid for remove');
      }
      // other attributes: ignored
    }
  }
  return m;
}
