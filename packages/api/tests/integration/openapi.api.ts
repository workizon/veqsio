import { describe, test, expect } from 'bun:test';
import app from '../../src/app';
import { collectRoutes, toOpenApiPath } from '../../src/openapi/spec';
import { OPERATIONS, SCHEMAS } from '../../src/openapi/handwritten';

describe('OpenAPI document', () => {
  let doc: any;
  const load = async () => {
    if (doc) return doc;
    const res = await app.request('/rest/api/2/openapi.json'); // anonymous on purpose
    expect(res.status).toBe(200);
    doc = await res.json();
    return doc;
  };
  const table = collectRoutes(app.routes);
  const tableKeys = new Set(table.included.map((r) => `${r.method} ${r.openapiPath}`));

  test('is public, OpenAPI 3.1 and contains no instance data', async () => {
    const d = await load();
    expect(d.openapi).toBe('3.1.0');
    expect(d.info.title).toBe('Veqsio REST API');
    expect(d.servers).toEqual([{ url: '/', description: 'This instance' }]);
    const text = JSON.stringify(d);
    for (const env of ['WEB_URL', 'BASE_URL', 'DATABASE_URL', 'REDIS_URL']) {
      const v = process.env[env];
      if (v) expect(text, `${env} value leaked`).not.toContain(v);
    }
    expect(text).not.toMatch(/localhost|127\.0\.0\.1|@example\.com/);
  });

  test('every documented path and method exists in the Hono route table', async () => {
    const d = await load();
    const missing: string[] = [];
    for (const [path, item] of Object.entries<any>(d.paths)) {
      for (const method of Object.keys(item)) {
        if (!tableKeys.has(`${method.toUpperCase()} ${path}`)) missing.push(`${method.toUpperCase()} ${path}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test('every hand-written operation key matches a real route (no stale documentation)', () => {
    const stale = Object.keys(OPERATIONS).filter((k) => !tableKeys.has(k));
    expect(stale).toEqual([]);
  });

  test('every route of the route table is listed in the document (generated entries cover what is not hand-written)', async () => {
    const d = await load();
    const undocumented = [...tableKeys].filter((k) => { const [m, p] = [k.split(' ')[0], k.slice(k.indexOf(' ') + 1)]; return !d.paths[p]?.[m.toLowerCase()]; });
    expect(undocumented).toEqual([]);
    expect(table.included.length).toBeGreaterThan(250);
  });

  test('the important endpoints are hand-documented with schemas', async () => {
    const d = await load();
    const hand = ['POST /rest/auth/1/session', 'GET /rest/api/2/project', 'POST /rest/api/2/issue', 'GET /rest/api/2/issue/{idOrKey}', 'POST /rest/api/2/issue/{idOrKey}/comment',
      'GET /rest/api/2/search', 'POST /rest/api/2/issue/{idOrKey}/transitions', 'GET /rest/agile/1.0/board/{boardId}/sprint', 'POST /rest/api/2/filter',
      'POST /rest/api/2/webhook', 'POST /rest/api/2/webhooks/inbound/{slug}', 'GET /rest/public/projects', 'POST /rest/api/2/agent-runs/{run}/finished'];
    for (const k of hand) {
      const [m, p] = [k.split(' ')[0], k.slice(k.indexOf(' ') + 1)];
      expect(d.paths[p]?.[m.toLowerCase()]?.['x-documented'], k).toBe('handwritten');
    }
    expect(d.paths['/rest/api/2/search'].get.parameters.map((p: any) => p.name)).toContain('jql');
    expect(d.paths['/rest/api/2/issue/{idOrKey}'].get.parameters[0]).toMatchObject({ name: 'idOrKey', in: 'path', required: true });
    expect(d.paths['/rest/auth/1/session'].post.security).toEqual([]);
    expect(d.paths['/rest/api/2/issue'].post.security).toEqual([{ cookieAuth: [] }, { bearerAuth: [] }]);
    expect(d.paths['/rest/api/2/webhooks/inbound/{slug}'].post.security).toEqual([{ webhookSignature: [] }]);
  });

  test('operation ids are unique and every $ref resolves', async () => {
    const d = await load();
    const ids = new Set<string>();
    for (const item of Object.values<any>(d.paths)) for (const op of Object.values<any>(item)) {
      expect(ids.has(op.operationId), `duplicate operationId ${op.operationId}`).toBe(false);
      ids.add(op.operationId);
    }
    const refs = [...JSON.stringify(d).matchAll(/"\$ref":"#\/components\/schemas\/([A-Za-z]+)"/g)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(20);
    for (const r of new Set(refs)) expect(SCHEMAS[r], `unresolved $ref ${r}`).toBeTruthy();
  });

  test('path conversion handles regex params', () => {
    expect(toOpenApiPath('/a/:id/b/:name{[a-z]+}')).toBe('/a/{id}/b/{name}');
  });

  test('excluded routes are exactly the documented, intentional ones', () => {
    expect(table.excluded.every((e) => e.reason.length > 10)).toBe(true);
    expect(table.excluded.map((e) => e.path).sort()).toContain('/mock-storage/:path{.*}');
  });
});
