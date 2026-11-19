import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { asc, eq } from 'drizzle-orm';
import * as schema from '@veqsio/db';
import { db } from '../db';
import { requireAuth, type AppContext } from '../auth/middleware';
import { requireGlobalPermission } from '../rbac/middleware';
import { SCIM_CONTENT_TYPE, generateScimToken, hashScimToken, scimAuth } from '../scim/auth';
import { ScimError, errorBody } from '../scim/errors';
import { GROUP_SCHEMA, USER_SCHEMA, listResponse, pageParams, parseGroupBody, parseUserBody } from '../scim/mapping';
import { applyGroupPatch, applyUserPatch } from '../scim/patch';
import * as svc from '../scim/service';
import { featureRefusal, hasFeature, requireFeature } from '../license';
import { SeatLimitError } from '../license/seats';

const app = new Hono<AppContext>();
const MAX_BODY = 1_000_000;

function reply(c: Context, body: unknown, status = 200, headers: Record<string, string> = {}) {
  return c.body(JSON.stringify(body), status as any, { 'Content-Type': SCIM_CONTENT_TYPE, ...headers });
}

function pid(c: Context): string {
  return c.req.param('id') ?? '';
}

function baseUrl(c: Context) {
  return new URL(c.req.url).origin;
}

async function readBody(c: Context): Promise<unknown> {
  const len = Number(c.req.header('content-length') ?? 0);
  if (len > MAX_BODY) throw new ScimError(413, 'tooMany', 'Request body too large');
  try {
    return await c.req.json();
  } catch {
    throw ScimError.invalidSyntax('Request body is not valid JSON');
  }
}

type H = (c: Context) => Promise<Response>;
const wrap = (fn: H) => async (c: Context) => {
  try {
    return await fn(c);
  } catch (err) {
    if (err instanceof ScimError) return reply(c, errorBody(err.status, err.detail, err.scimType), err.status);
    if (err instanceof SeatLimitError) return reply(c, errorBody(402, err.message), 402);
    console.error('SCIM internal error', err instanceof Error ? err.name : 'unknown');
    return reply(c, errorBody(500, 'Internal server error'), 500);
  }
};

/* ------------------------------------------------------------------ */
/*  SCIM endpoints (dedicated bearer token)                            */
/* ------------------------------------------------------------------ */

app.use('/scim/v2/*', scimAuth);
// SCIM provisioning is an Enterprise feature. Authenticate first so anonymous callers still get 401.
app.use('/scim/v2/*', async (c, next) => {
  if (!hasFeature('scim')) return reply(c, errorBody(402, featureRefusal('scim').errorMessages[0]), 402);
  await next();
});

app.get('/scim/v2/ServiceProviderConfig', wrap(async (c) => reply(c, {
  schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
  documentationUri: 'https://veqsio.com/docs/security',
  patch: { supported: true },
  bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
  filter: { supported: true, maxResults: 200 },
  changePassword: { supported: false },
  sort: { supported: false },
  etag: { supported: false },
  authenticationSchemes: [{ type: 'oauthbearertoken', name: 'Bearer token', description: 'Dedicated SCIM bearer token', primary: true }],
  meta: { resourceType: 'ServiceProviderConfig', location: `${baseUrl(c)}/scim/v2/ServiceProviderConfig` },
})));

const userSchemaDoc = {
  id: USER_SCHEMA, name: 'User', description: 'User account',
  attributes: [
    { name: 'userName', type: 'string', multiValued: false, required: true, caseExact: false, mutability: 'readWrite', returned: 'default', uniqueness: 'server' },
    { name: 'externalId', type: 'string', multiValued: false, required: false, mutability: 'readWrite', returned: 'default' },
    { name: 'displayName', type: 'string', multiValued: false, required: false, mutability: 'readWrite', returned: 'default' },
    { name: 'name', type: 'complex', multiValued: false, required: false, subAttributes: [
      { name: 'givenName', type: 'string', multiValued: false, required: false, mutability: 'readWrite' },
      { name: 'familyName', type: 'string', multiValued: false, required: false, mutability: 'readWrite' },
    ] },
    { name: 'emails', type: 'complex', multiValued: true, required: false, subAttributes: [
      { name: 'value', type: 'string', multiValued: false, required: true, mutability: 'readWrite' },
      { name: 'primary', type: 'boolean', multiValued: false, required: false, mutability: 'readWrite' },
    ] },
    { name: 'active', type: 'boolean', multiValued: false, required: false, mutability: 'readWrite', returned: 'default' },
  ],
  meta: { resourceType: 'Schema', location: '/scim/v2/Schemas/' + USER_SCHEMA },
};
const groupSchemaDoc = {
  id: GROUP_SCHEMA, name: 'Group', description: 'Group',
  attributes: [
    { name: 'displayName', type: 'string', multiValued: false, required: true, mutability: 'readWrite', returned: 'default', uniqueness: 'server' },
    { name: 'members', type: 'complex', multiValued: true, required: false, subAttributes: [
      { name: 'value', type: 'string', multiValued: false, required: true, mutability: 'immutable' },
    ] },
  ],
  meta: { resourceType: 'Schema', location: '/scim/v2/Schemas/' + GROUP_SCHEMA },
};

app.get('/scim/v2/Schemas', wrap(async (c) => reply(c, listResponse([userSchemaDoc, groupSchemaDoc], 2, 1))));
app.get('/scim/v2/Schemas/:id', wrap(async (c) => {
  const doc = [userSchemaDoc, groupSchemaDoc].find((d) => d.id === pid(c));
  if (!doc) throw ScimError.notFound();
  return reply(c, doc);
}));
app.get('/scim/v2/ResourceTypes', wrap(async (c) => reply(c, listResponse([
  { schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'], id: 'User', name: 'User', endpoint: '/Users', schema: USER_SCHEMA, meta: { resourceType: 'ResourceType', location: '/scim/v2/ResourceTypes/User' } },
  { schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'], id: 'Group', name: 'Group', endpoint: '/Groups', schema: GROUP_SCHEMA, meta: { resourceType: 'ResourceType', location: '/scim/v2/ResourceTypes/Group' } },
], 2, 1))));

/* ---- Users ---- */

app.get('/scim/v2/Users', wrap(async (c) => {
  const { startIndex, count } = pageParams(c.req.query('startIndex'), c.req.query('count'));
  const r = await svc.listUsers({ filter: c.req.query('filter'), startIndex, count, baseUrl: baseUrl(c) });
  return reply(c, listResponse(r.resources, r.total, startIndex));
}));

app.post('/scim/v2/Users', wrap(async (c) => {
  const user = await svc.createUser(parseUserBody(await readBody(c)), baseUrl(c));
  return reply(c, user, 201, { Location: user.meta.location });
}));

app.get('/scim/v2/Users/:id', wrap(async (c) => reply(c, await svc.getUser(pid(c), baseUrl(c)))));

app.put('/scim/v2/Users/:id', wrap(async (c) => {
  const model = parseUserBody(await readBody(c));
  return reply(c, await svc.saveUser(pid(c), model, baseUrl(c)));
}));

app.patch('/scim/v2/Users/:id', wrap(async (c) => {
  const id = pid(c);
  const body = await readBody(c);
  const next = applyUserPatch(await svc.userModelOf(id), body);
  if (!next.userName) throw ScimError.invalidValue('userName is required');
  if (!next.email || !/^[^@\s]+@[^@\s]+$/.test(next.email)) throw ScimError.invalidValue('A valid email is required');
  return reply(c, await svc.saveUser(id, next, baseUrl(c)));
}));

app.delete('/scim/v2/Users/:id', wrap(async (c) => {
  await svc.deactivateUser(pid(c));
  return c.body(null, 204, { 'Content-Type': SCIM_CONTENT_TYPE });
}));

/* ---- Groups ---- */

app.get('/scim/v2/Groups', wrap(async (c) => {
  const { startIndex, count } = pageParams(c.req.query('startIndex'), c.req.query('count'));
  const r = await svc.listGroups({ filter: c.req.query('filter'), startIndex, count, baseUrl: baseUrl(c) });
  return reply(c, listResponse(r.resources, r.total, startIndex));
}));

app.post('/scim/v2/Groups', wrap(async (c) => {
  const group = await svc.createGroup(parseGroupBody(await readBody(c)), baseUrl(c));
  return reply(c, group, 201, { Location: group.meta.location });
}));

app.get('/scim/v2/Groups/:id', wrap(async (c) => reply(c, await svc.getGroup(pid(c), baseUrl(c)))));

app.put('/scim/v2/Groups/:id', wrap(async (c) => {
  const model = parseGroupBody(await readBody(c));
  return reply(c, await svc.saveGroup(pid(c), model, baseUrl(c)));
}));

app.patch('/scim/v2/Groups/:id', wrap(async (c) => {
  const id = pid(c);
  const body = await readBody(c);
  const next = applyGroupPatch(await svc.groupModelOf(id), body);
  if (!next.displayName) throw ScimError.invalidValue('displayName is required');
  return reply(c, await svc.saveGroup(id, next, baseUrl(c)));
}));

app.delete('/scim/v2/Groups/:id', wrap(async (c) => {
  await svc.deleteGroup(pid(c));
  return c.body(null, 204, { 'Content-Type': SCIM_CONTENT_TYPE });
}));

app.all('/scim/v2/*', wrap(async () => { throw ScimError.notFound(); }));

/* ------------------------------------------------------------------ */
/*  Admin: manage SCIM tokens (system administrators, user sessions)   */
/* ------------------------------------------------------------------ */

const adminBase = '/rest/api/2/admin/scim/tokens';
app.use(adminBase, requireAuth, requireGlobalPermission('SYSTEM_ADMIN'));
app.use(`${adminBase}/*`, requireAuth, requireGlobalPermission('SYSTEM_ADMIN'));

app.get(adminBase, async (c) => {
  const rows = await db.select({
    id: schema.scimTokens.id, name: schema.scimTokens.name, createdAt: schema.scimTokens.createdAt,
    lastUsedAt: schema.scimTokens.lastUsedAt, revokedAt: schema.scimTokens.revokedAt,
  }).from(schema.scimTokens).orderBy(asc(schema.scimTokens.id));
  return c.json(rows);
});

app.post(adminBase, requireFeature('scim'), zValidator('json', z.object({ name: z.string().trim().min(1).max(255) }).strict()), async (c) => {
  const user = c.get('user')!;
  const token = generateScimToken();
  const [row] = await db.insert(schema.scimTokens).values({
    name: c.req.valid('json').name, tokenHash: hashScimToken(token), createdBy: user.id,
  }).returning({ id: schema.scimTokens.id, name: schema.scimTokens.name, createdAt: schema.scimTokens.createdAt });
  c.header('Cache-Control', 'no-store');
  // The only time the token is ever returned.
  return c.json({ ...row, token }, 201);
});

app.delete(`${adminBase}/:id{[0-9]+}`, async (c) => {
  const [row] = await db.update(schema.scimTokens).set({ revokedAt: new Date() })
    .where(eq(schema.scimTokens.id, Number(pid(c)))).returning({ id: schema.scimTokens.id });
  if (!row) return c.json({ errorMessages: ['Not found'] }, 404);
  return c.body(null, 204);
});

export default app;
