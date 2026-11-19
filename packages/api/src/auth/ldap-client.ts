/**
 * LDAP protocol seam. The rest of the code only knows the small `LdapClient` interface; the production
 * implementation uses `ldapts`, tests use an in-memory fake. This file also holds the injection-safety helpers
 * (RFC 4515 filter escaping, RFC 4514 DN escaping) and the bind guard that refuses anonymous / unauthenticated binds.
 */
import { Client, InvalidCredentialsError, SizeLimitExceededError } from 'ldapts';

export class LdapError extends Error {
  constructor(public code: 'invalid_credentials' | 'size_limit' | 'connect' | 'timeout' | 'protocol' | 'refused', detail?: string) {
    super(detail ?? code);
    this.name = 'LdapError';
  }
}

export interface LdapEntry {
  dn: string;
  /** All attribute values as strings (binary values already converted, see `attributeToStrings`). */
  attrs: Record<string, string[]>;
}

export interface LdapSearchOptions {
  filter: string;
  attributes: string[];
  scope?: 'base' | 'one' | 'sub';
  /** Maximum number of entries the caller accepts. More than this is reported as `truncated`. */
  sizeLimit: number;
}

export interface LdapClient {
  /** Simple bind. Implementations must never be called with an empty DN or password (see `guardedBind`). */
  bind(dn: string, password: string): Promise<void>;
  search(baseDn: string, opts: LdapSearchOptions): Promise<{ entries: LdapEntry[]; truncated: boolean }>;
  close(): Promise<void>;
}

export interface LdapConnectionConfig {
  url: string;
  startTls: boolean;
  tlsRejectUnauthorized: boolean;
  timeoutMs: number;
}

export type LdapClientFactory = (cfg: LdapConnectionConfig) => Promise<LdapClient>;

/* ------------------------------------------------------------------ */
/*  Escaping and binding guards                                        */
/* ------------------------------------------------------------------ */

/** RFC 4515 section 3: escape `\ * ( )` and NUL (and everything non-ASCII as UTF-8 byte escapes for strict servers). */
export function escapeFilterValue(value: string): string {
  let out = '';
  for (const ch of value) {
    const cp = ch.codePointAt(0)!;
    if (ch === '\\') out += '\\5c';
    else if (ch === '*') out += '\\2a';
    else if (ch === '(') out += '\\28';
    else if (ch === ')') out += '\\29';
    else if (cp === 0) out += '\\00';
    else if (cp > 0x7f) out += [...Buffer.from(ch, 'utf8')].map((b) => `\\${b.toString(16).padStart(2, '0')}`).join('');
    else out += ch;
  }
  return out;
}

/** RFC 4514 section 2.4: escape a single attribute VALUE for use inside a DN. */
export function escapeDnValue(value: string): string {
  let out = value.replace(/[\\,+"<>;=]/g, (c) => `\\${c}`).replace(/\u0000/g, '\\00');
  if (out.startsWith('#') || out.startsWith(' ')) out = `\\${out}`;
  if (out.endsWith(' ') && !out.endsWith('\\ ')) out = `${out.slice(0, -1)}\\ `;
  return out;
}

/** Lower-cases and removes insignificant spaces so two spellings of one DN compare equal. */
export function normalizeDn(dn: string): string {
  return dn.trim().replace(/\s*([,=+])\s*/g, '$1').toLowerCase();
}

/** A filter must be one parenthesised expression with balanced parentheses (escaped ones excluded). */
export function isValidFilter(filter: string): boolean {
  const f = filter.trim();
  if (!f.startsWith('(') || !f.endsWith(')') || f.length > 1000) return false;
  let depth = 0;
  for (let i = 0; i < f.length; i++) {
    const c = f[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0 && i !== f.length - 1) return false; if (depth < 0) return false; }
  }
  return depth === 0;
}

/**
 * Anonymous and "unauthenticated" binds succeed on many servers when the DN is given with an EMPTY password; an
 * application that trusts bind success then logs anyone in. Every bind goes through this guard.
 */
export async function guardedBind(client: LdapClient, dn: string, password: string): Promise<void> {
  if (typeof dn !== 'string' || dn.trim() === '') throw new LdapError('refused', 'empty bind DN');
  if (typeof password !== 'string' || password.length === 0) throw new LdapError('refused', 'empty password');
  if (password.includes('\u0000') || dn.includes('\u0000')) throw new LdapError('refused', 'NUL byte in credentials');
  await client.bind(dn, password);
}

/** LDAP values to plain strings. Known binary attributes become readable ids (objectGUID -> GUID text, others hex). */
export function attributeToStrings(name: string, value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value];
  return list.filter((v) => v !== undefined && v !== null).map((v) => {
    if (typeof v === 'string') return v;
    if (Buffer.isBuffer(v)) {
      if (name.toLowerCase() === 'objectguid' && v.length === 16) {
        const h = Buffer.from([v[3], v[2], v[1], v[0], v[5], v[4], v[7], v[6], ...v.subarray(8)]).toString('hex');
        return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
      }
      const text = v.toString('utf8');
      return /^[\x20-\x7e -￿]*$/.test(text) ? text : v.toString('hex');
    }
    return String(v);
  });
}

/* ------------------------------------------------------------------ */
/*  Production implementation (ldapts)                                 */
/* ------------------------------------------------------------------ */

export const ldaptsFactory: LdapClientFactory = async (cfg) => {
  const secure = cfg.url.toLowerCase().startsWith('ldaps:');
  const tlsOptions = { rejectUnauthorized: cfg.tlsRejectUnauthorized };
  const client = new Client({ url: cfg.url, timeout: cfg.timeoutMs, connectTimeout: cfg.timeoutMs, tlsOptions: secure ? tlsOptions : undefined, strictDN: false });
  const wrap = (err: unknown): LdapError => {
    if (err instanceof LdapError) return err;
    if (err instanceof InvalidCredentialsError) return new LdapError('invalid_credentials');
    if (err instanceof SizeLimitExceededError) return new LdapError('size_limit');
    const msg = err instanceof Error ? err.message : String(err);
    if (/timed? ?out/i.test(msg)) return new LdapError('timeout', msg);
    if (/ECONN|ENOTFOUND|EHOSTUNREACH|socket|connect|certificate|TLS|SSL/i.test(msg)) return new LdapError('connect', msg);
    return new LdapError('protocol', msg);
  };
  try {
    if (cfg.startTls && !secure) await client.startTLS(tlsOptions);
  } catch (err) {
    await client.unbind().catch(() => {});
    throw wrap(err);
  }
  return {
    async bind(dn, password) {
      try { await client.bind(dn, password); } catch (err) { throw wrap(err); }
    },
    async search(baseDn, opts) {
      try {
        const res = await client.search(baseDn, {
          scope: opts.scope ?? 'sub', filter: opts.filter, attributes: opts.attributes, sizeLimit: opts.sizeLimit + 1,
          explicitBufferAttributes: opts.attributes.filter((a) => /^objectguid$|^objectsid$/i.test(a)),
          derefAliases: 'never',
        });
        const entries = res.searchEntries.map((e) => {
          const attrs: Record<string, string[]> = {};
          for (const [k, v] of Object.entries(e)) if (k !== 'dn') attrs[k] = attributeToStrings(k, v);
          return { dn: e.dn, attrs };
        });
        return { entries: entries.slice(0, opts.sizeLimit), truncated: entries.length > opts.sizeLimit };
      } catch (err) {
        throw wrap(err);
      }
    },
    async close() { await client.unbind().catch(() => {}); },
  };
};
