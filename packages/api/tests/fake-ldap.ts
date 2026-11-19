import { LdapError, normalizeDn, type LdapClient, type LdapClientFactory, type LdapConnectionConfig, type LdapEntry, type LdapSearchOptions } from '../src/auth/ldap-client';

export interface FakeEntry {
  dn: string;
  attrs: Record<string, string[]>;
  password?: string;
}

/* A small RFC 4515 filter evaluator: &, |, !, equality (case-insensitive), presence, with \xx unescaping. */
type Node = { op: '&' | '|' | '!'; kids: Node[] } | { op: '='; attr: string; value: string | null };

function unescapeValue(v: string): string {
  const bytes: number[] = [];
  const buf = Buffer.from(v, 'utf8');
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x5c && i + 2 < buf.length + 0 && /^[0-9a-fA-F]{2}$/.test(buf.subarray(i + 1, i + 3).toString())) { bytes.push(parseInt(buf.subarray(i + 1, i + 3).toString(), 16)); i += 2; }
    else bytes.push(buf[i]);
  }
  return Buffer.from(bytes).toString('utf8');
}

export function parseFilter(f: string): Node {
  let i = 0;
  const parse = (): Node => {
    if (f[i] !== '(') throw new Error(`bad filter at ${i}: ${f}`);
    i++;
    let node: Node;
    if (f[i] === '&' || f[i] === '|' || f[i] === '!') {
      const op = f[i++] as '&' | '|' | '!';
      const kids: Node[] = [];
      while (f[i] === '(') kids.push(parse());
      node = { op, kids };
    } else {
      let j = i;
      while (j < f.length && !(f[j] === ')' )) { if (f[j] === '(') throw new Error(`unescaped ( in filter ${f}`); j++; }
      const item = f.slice(i, j);
      const eq = item.indexOf('=');
      if (eq < 0) throw new Error(`bad item ${item}`);
      const raw = item.slice(eq + 1);
      node = { op: '=', attr: item.slice(0, eq), value: raw === '*' ? null : raw };
      i = j;
    }
    if (f[i] !== ')') throw new Error(`bad filter, expected ) at ${i}: ${f}`);
    i++;
    return node;
  };
  const n = parse();
  if (i !== f.length) throw new Error(`trailing characters in filter: ${f}`);
  return n;
}

function matches(n: Node, e: FakeEntry): boolean {
  if (n.op === '&') return n.kids.every((k) => matches(k, e));
  if (n.op === '|') return n.kids.some((k) => matches(k, e));
  if (n.op === '!') return !matches(n.kids[0], e);
  if (n.op !== '=') return false;
  const key = Object.keys(e.attrs).find((k) => k.toLowerCase() === n.attr.toLowerCase());
  const vals = key ? e.attrs[key] : [];
  if (n.value === null) return vals.length > 0;
  if (n.value.includes('*')) {
    // substring match; the escaped form \2a is a literal asterisk
    const parts = n.value.split('*').map(unescapeValue);
    const re = new RegExp(`^${parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');
    return vals.some((v) => re.test(v));
  }
  const want = unescapeValue(n.value).toLowerCase();
  return vals.some((v) => v.toLowerCase() === want);
}

export class FakeLdap {
  entries: FakeEntry[] = [];
  serviceDn = 'cn=svc,dc=example,dc=com';
  servicePassword = 'svc-secret';
  down = false;
  /** Emulates the classic server behaviour that accepts a DN with an EMPTY password as an unauthenticated bind. */
  allowEmptyPasswordBind = true;
  searches: Array<{ base: string; filter: string }> = [];
  binds: Array<{ dn: string; ok: boolean }> = [];
  configs: LdapConnectionConfig[] = [];
  closed = 0;
  opened = 0;

  factory: LdapClientFactory = async (cfg) => {
    this.configs.push(cfg);
    if (this.down) throw new LdapError('connect', 'ECONNREFUSED');
    this.opened++;
    const self = this;
    const client: LdapClient = {
      async bind(dn, password) {
        if (self.down) throw new LdapError('connect', 'ECONNREFUSED');
        const isSvc = normalizeDn(dn) === normalizeDn(self.serviceDn);
        const entry = isSvc ? null : self.entries.find((e) => normalizeDn(e.dn) === normalizeDn(dn));
        const expected = isSvc ? self.servicePassword : entry?.password;
        const ok = (expected !== undefined && password === expected) || (password === '' && self.allowEmptyPasswordBind);
        self.binds.push({ dn, ok });
        if (!ok) throw new LdapError('invalid_credentials');
      },
      async search(base, opts: LdapSearchOptions) {
        if (self.down) throw new LdapError('connect', 'ECONNREFUSED');
        self.searches.push({ base, filter: opts.filter });
        const tree = parseFilter(opts.filter);
        const b = normalizeDn(base);
        const found = self.entries.filter((e) => (normalizeDn(e.dn) === b || normalizeDn(e.dn).endsWith(`,${b}`)) && matches(tree, e));
        const out: LdapEntry[] = found.slice(0, opts.sizeLimit).map((e) => {
          const attrs: Record<string, string[]> = {};
          for (const a of opts.attributes) { const k = Object.keys(e.attrs).find((x) => x.toLowerCase() === a.toLowerCase()); if (k) attrs[k] = e.attrs[k]; }
          return { dn: e.dn, attrs };
        });
        return { entries: out, truncated: found.length > opts.sizeLimit };
      },
      async close() { self.closed++; },
    };
    return client;
  };

  addUser(uid: string, over: Partial<{ mail: string | null; cn: string; password: string; id: string; extra: Record<string, string[]> }> = {}) {
    const dn = `uid=${uid},ou=people,dc=example,dc=com`;
    const attrs: Record<string, string[]> = { objectClass: ['inetOrgPerson', 'person'], uid: [uid], cn: [over.cn ?? `User ${uid}`], entryUUID: [over.id ?? `uuid-${uid}`], ...(over.extra ?? {}) };
    if (over.mail !== null) attrs.mail = [over.mail ?? `${uid}@example.com`];
    this.entries.push({ dn, attrs, password: over.password ?? `pw-${uid}` });
    return dn;
  }

  addGroup(cn: string, members: string[], attr = 'member') {
    this.entries.push({ dn: `cn=${cn},ou=groups,dc=example,dc=com`, attrs: { objectClass: ['groupOfNames'], cn: [cn], [attr]: members } });
    return `cn=${cn},ou=groups,dc=example,dc=com`;
  }

  remove(uid: string) { this.entries = this.entries.filter((e) => e.attrs.uid?.[0] !== uid); }
}
