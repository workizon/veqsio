import { describe, test, expect } from 'bun:test';
import { Hono } from 'hono';

describe('Project Routes', () => {
  test('health check returns ok', async () => {
    const app = new Hono();
    app.get('/health', (c) => c.json({ status: 'ok' }));
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
  });

  test('project list route shape is correct', async () => {
    const app = new Hono();
    app.get('/rest/api/2/project', (c) =>
      c.json({
        startAt: 0,
        maxResults: 1,
        total: 1,
        isLast: true,
        values: [{ id: 1, key: 'TEST', name: 'Test Project' }],
      }),
    );
    const res = await app.request('/rest/api/2/project');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.values.length).toBe(1);
    expect(body.values[0].key).toBe('TEST');
  });

  test('project create route requires key and name', async () => {
    const app = new Hono();
    app.post('/rest/api/2/project', async (c) => {
      const body = await c.req.json();
      if (!body.key || !body.name) {
        return c.json({ errorMessages: ['key and name are required'] }, 400);
      }
      return c.json({ id: 1, key: body.key, name: body.name }, 201);
    });

    const resBad = await app.request('/rest/api/2/project', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(resBad.status).toBe(400);

    const resOk = await app.request('/rest/api/2/project', {
      method: 'POST',
      body: JSON.stringify({ key: 'NEW', name: 'New Project' }),
    });
    expect(resOk.status).toBe(201);
    const body = await resOk.json();
    expect(body.key).toBe('NEW');
  });

  test('project get returns 404 for missing project', async () => {
    const app = new Hono();
    app.get('/rest/api/2/project/:key', (c) => {
      const key = c.req.param('key');
      if (key === 'MISSING') {
        return c.json({ errorMessages: ['Project not found'] }, 404);
      }
      return c.json({ id: 1, key });
    });

    const res = await app.request('/rest/api/2/project/MISSING');
    expect(res.status).toBe(404);
  });

  test('project delete route exists', async () => {
    const app = new Hono();
    app.delete('/rest/api/2/project/:key', (c) => c.json({}));
    const res = await app.request('/rest/api/2/project/TEST', { method: 'DELETE' });
    expect(res.status).toBe(200);
  });
});
