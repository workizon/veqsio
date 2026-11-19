import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { asc, eq } from 'drizzle-orm';
import * as schema from '@veqsio/db';
import { db } from '../db';
import { requireAuth, type AppContext } from '../auth/middleware';
import { requireGlobalPermission } from '../rbac/middleware';
import { featureRefusal, hasFeature, requireFeature } from '../license';
import { encryptSecret, SecretsConfigError } from '../auth/secrets';
import { isValidFilter } from '../auth/ldap-client';
import { runSync, testConnection, type LdapDirectoryRow } from '../auth/ldap-service';

const app = new Hono<AppContext>();
const admin = '/rest/api/2/admin/ldap';
app.use(admin, requireAuth, requireGlobalPermission('SYSTEM_ADMIN'));
app.use(`${admin}/*`, requireAuth, requireGlobalPermission('SYSTEM_ADMIN'));

const isProd = () => process.env.NODE_ENV === 'production';

const attr = z.string().trim().regex(/^[A-Za-z][A-Za-z0-9;-]{0,99}$/, 'Invalid attribute name');
const filter = z.string().trim().max(1000).refine(isValidFilter, 'Must be one parenthesised LDAP filter, e.g. (objectClass=person)');
const dn = z.string().trim().min(1).max(1000);

const fields = {
  name: z.string().trim().min(1).max(100),
  url: z.string().trim().max(500).refine((v) => {
    try {
      const u = new URL(v);
      return (u.protocol === 'ldap:' || u.protocol === 'ldaps:') && !!u.hostname && !u.username && !u.password && (u.pathname === '' || u.pathname === '/') && !u.search && !u.hash;
    } catch { return false; }
  }, 'Must be ldap://host[:port] or ldaps://host[:port]'),
  startTls: z.boolean(),
  tlsRejectUnauthorized: z.boolean(),
  bindDn: dn,
  bindPassword: z.string().min(1).max(1024).refine((v) => !v.includes('\u0000'), 'Invalid password'),
  baseDn: dn,
  userFilter: filter,
  usernameAttribute: attr,
  emailAttribute: attr,
  displayNameAttribute: attr,
  uniqueIdAttribute: attr,
  groupBaseDn: z.string().trim().max(1000).nullable(),
  groupFilter: filter,
  groupNameAttribute: attr,
  groupMemberAttribute: attr,
  nestedGroups: z.boolean(),
  loginEnabled: z.boolean(),
  autoProvision: z.boolean(),
  linkByEmail: z.boolean(),
  syncEnabled: z.boolean(),
  syncIntervalMinutes: z.number().int().min(5).max(10080),
  deactivateMissing: z.boolean(),
  maxEntries: z.number().int().min(1).max(50000),
  timeoutMs: z.number().int().min(1000).max(60000),
  enabled: z.boolean(),
};

const createSchema = z.object({
  name: fields.name, url: fields.url,
  startTls: fields.startTls.default(false), tlsRejectUnauthorized: fields.tlsRejectUnauthorized.default(true),
  bindDn: fields.bindDn, bindPassword: fields.bindPassword, baseDn: fields.baseDn,
  userFilter: fields.userFilter.default('(objectClass=person)'),
  usernameAttribute: fields.usernameAttribute.default('uid'), emailAttribute: fields.emailAttribute.default('mail'),
  displayNameAttribute: fields.displayNameAttribute.default('cn'), uniqueIdAttribute: fields.uniqueIdAttribute.default('entryUUID'),
  groupBaseDn: fields.groupBaseDn.default(null), groupFilter: fields.groupFilter.default('(objectClass=groupOfNames)'),
  groupNameAttribute: fields.groupNameAttribute.default('cn'), groupMemberAttribute: fields.groupMemberAttribute.default('member'),
  nestedGroups: fields.nestedGroups.default(false), loginEnabled: fields.loginEnabled.default(true),
  autoProvision: fields.autoProvision.default(false), linkByEmail: fields.linkByEmail.default(false),
  syncEnabled: fields.syncEnabled.default(false), syncIntervalMinutes: fields.syncIntervalMinutes.default(360),
  deactivateMissing: fields.deactivateMissing.default(true), maxEntries: fields.maxEntries.default(10000),
  timeoutMs: fields.timeoutMs.default(10000), enabled: fields.enabled.default(true),
}).strict();

const updateSchema = z.object(fields).partial().strict();

/** Plain ldap:// without StartTLS sends the bind password in clear text: refused in production unless explicitly allowed. */
function transportProblem(url: string, startTls: boolean): string | null {
  const ldaps = url.toLowerCase().startsWith('ldaps:');
  if (ldaps && startTls) return 'StartTLS cannot be combined with ldaps://';
  if (!ldaps && !startTls && isProd() && process.env.LDAP_ALLOW_INSECURE !== 'true') return 'Use ldaps:// or enable StartTLS (plain LDAP would send passwords unencrypted)';
  return null;
}

function present(row: LdapDirectoryRow) {
  const { bindPasswordEncrypted, syncLockUntil, ...rest } = row;
  return { ...rest, hasBindPassword: !!bindPasswordEncrypted, syncRunning: !!syncLockUntil && syncLockUntil.getTime() > Date.now() };
}

function encrypt(secret: string): { value: string } | { error: Response } {
  try {
    return { value: encryptSecret(secret) };
  } catch (err) {
    if (err instanceof SecretsConfigError) {
      return { error: new Response(JSON.stringify({ errorMessages: ['SECRETS_ENCRYPTION_KEY is not configured on the server; refusing to store the bind password'] }), { status: 409, headers: { 'Content-Type': 'application/json' } }) };
    }
    throw err;
  }
}

app.get(admin, async (c) => c.json((await db.select().from(schema.ldapDirectories).orderBy(asc(schema.ldapDirectories.id))).map(present)));

app.post(admin, requireFeature('ldap'), zValidator('json', createSchema), async (c) => {
  const body = c.req.valid('json');
  const problem = transportProblem(body.url, body.startTls);
  if (problem) return c.json({ errorMessages: [problem] }, 400);
  const enc = encrypt(body.bindPassword);
  if ('error' in enc) return enc.error;
  const { bindPassword: _p, ...rest } = body;
  const [row] = await db.insert(schema.ldapDirectories).values({ ...rest, bindPasswordEncrypted: enc.value }).returning();
  return c.json(present(row), 201);
});

app.get(`${admin}/:id{[0-9]+}`, async (c) => {
  const [row] = await db.select().from(schema.ldapDirectories).where(eq(schema.ldapDirectories.id, Number(c.req.param('id')))).limit(1);
  return row ? c.json(present(row)) : c.json({ errorMessages: ['Not found'] }, 404);
});

app.put(`${admin}/:id{[0-9]+}`, zValidator('json', updateSchema), async (c) => {
  const id = Number(c.req.param('id'));
  const { bindPassword, ...rest } = c.req.valid('json');
  const onlyDisabling = bindPassword === undefined && Object.keys(rest).length === 1 && rest.enabled === false;
  if (!hasFeature('ldap') && !onlyDisabling) return c.json(featureRefusal('ldap'), 402);
  const [current] = await db.select().from(schema.ldapDirectories).where(eq(schema.ldapDirectories.id, id)).limit(1);
  if (!current) return c.json({ errorMessages: ['Not found'] }, 404);
  const problem = transportProblem(rest.url ?? current.url, rest.startTls ?? current.startTls);
  if (problem && !onlyDisabling) return c.json({ errorMessages: [problem] }, 400);
  const patch: Record<string, unknown> = { ...rest, updatedAt: new Date() };
  if (bindPassword !== undefined) {
    const enc = encrypt(bindPassword);
    if ('error' in enc) return enc.error;
    patch.bindPasswordEncrypted = enc.value;
  }
  if (Object.keys(rest).length === 0 && bindPassword === undefined) return c.json({ errorMessages: ['Nothing to update'] }, 400);
  const [row] = await db.update(schema.ldapDirectories).set(patch).where(eq(schema.ldapDirectories.id, id)).returning();
  return c.json(present(row));
});

app.delete(`${admin}/:id{[0-9]+}`, async (c) => {
  const [row] = await db.delete(schema.ldapDirectories).where(eq(schema.ldapDirectories.id, Number(c.req.param('id')))).returning({ id: schema.ldapDirectories.id });
  return row ? c.body(null, 204) : c.json({ errorMessages: ['Not found'] }, 404);
});

app.post(`${admin}/:id{[0-9]+}/test`, requireFeature('ldap'), async (c) => {
  const [row] = await db.select().from(schema.ldapDirectories).where(eq(schema.ldapDirectories.id, Number(c.req.param('id')))).limit(1);
  if (!row) return c.json({ errorMessages: ['Not found'] }, 404);
  return c.json(await testConnection(row));
});

const syncBody = z.object({ dryRun: z.boolean().default(true), force: z.boolean().default(false) }).strict();

/** Dry-run (default) shows what a sync would do; `dryRun: false` applies it. */
app.post(`${admin}/:id{[0-9]+}/sync`, requireFeature('ldap'), zValidator('json', syncBody), async (c) => {
  const [row] = await db.select().from(schema.ldapDirectories).where(eq(schema.ldapDirectories.id, Number(c.req.param('id')))).limit(1);
  if (!row) return c.json({ errorMessages: ['Not found'] }, 404);
  const { dryRun, force } = c.req.valid('json');
  const result = await runSync(row, { dryRun, force });
  return c.json(result, result.ok || dryRun ? 200 : result.error?.includes('already running') ? 409 : 200);
});

export default app;
