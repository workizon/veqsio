process.env.REDIS_URL = 'memory:';
import { test, expect } from 'bun:test';
import { Hono } from 'hono';
import { cacheMiddleware, invalidateIssueCache } from './cache';

function build() {
  let n = 0;
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user' as never, { id: 7 } as never);
    await next();
  });
  app.get('/rest/api/2/search', cacheMiddleware(60), (c) => c.json({ n: ++n }));
  app.get('/rest/api/2/issue/:key', cacheMiddleware(60), (c) => c.json({ key: c.req.param('key'), n: ++n }));
  app.get('/rest/api/2/project', cacheMiddleware(60), (c) => c.json({ n: ++n }));
  return app;
}

test('cached GETs are served from the cache and never marked public', async () => {
  const app = build();
  const a = await app.request('/rest/api/2/project');
  const b = await app.request('/rest/api/2/project');
  expect(await a.json()).toEqual({ n: 1 });
  expect(await b.json()).toEqual({ n: 1 });
  expect(b.headers.get('x-cache')).toBe('HIT');
  expect(b.headers.get('cache-control')).toContain('private');
  expect(b.headers.get('content-type')).toContain('application/json');
});

test('an issue write invalidates search pages and that issue only (generation counters, no KEYS scan)', async () => {
  const app = build();
  const key = `CACHE-${Math.random().toString(36).slice(2, 8)}`;
  const other = `${key}-OTHER`;
  const s1 = await (await app.request('/rest/api/2/search?jql=x')).json();
  const i1 = await (await app.request(`/rest/api/2/issue/${key}`)).json();
  const o1 = await (await app.request(`/rest/api/2/issue/${other}`)).json();
  // still cached
  expect(await (await app.request('/rest/api/2/search?jql=x')).json()).toEqual(s1);

  await invalidateIssueCache(key);

  const s2 = await (await app.request('/rest/api/2/search?jql=x')).json();
  const i2 = await (await app.request(`/rest/api/2/issue/${key}`)).json();
  const o2 = await (await app.request(`/rest/api/2/issue/${other}`)).json();
  expect(s2.n).toBeGreaterThan(s1.n);
  expect(i2.n).toBeGreaterThan(i1.n);
  expect(o2).toEqual(o1); // a different issue stays cached
});
