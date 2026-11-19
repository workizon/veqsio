import { Hono } from 'hono';
import { sessionMiddleware, requireAuth } from '../auth/middleware';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import { hasProjectPermission, hasGlobalPermission } from '../rbac/service';
import { PROJECT_PERMISSIONS, GLOBAL_PERMISSIONS } from '../rbac/types';
import type { AppContext } from '../auth/middleware';

const sql = postgres(process.env.DATABASE_URL!);
const db = drizzle(sql, { schema });

const app = new Hono<AppContext>();
app.use('/rest/api/2/permissions*', sessionMiddleware);
app.use('/rest/api/2/mypermissions', sessionMiddleware);
app.use('/rest/api/2/permissionscheme*', sessionMiddleware);

app.get('/rest/api/2/permissions', requireAuth, async (c) => {
  const permissions = [...GLOBAL_PERMISSIONS, ...PROJECT_PERMISSIONS].map((p, i) => ({
    id: i + 1,
    key: p,
    name: p.replace(/_/g, ' '),
    type: GLOBAL_PERMISSIONS.includes(p as any) ? 'GLOBAL' : 'PROJECT',
  }));
  return c.json({ permissions });
});

app.get('/rest/api/2/mypermissions', requireAuth, async (c) => {
  const user = c.get('user')!;
  const projectKey = c.req.query('projectKey');
  const permissions: Record<string, any> = {};

  for (const p of GLOBAL_PERMISSIONS) {
    permissions[p] = { key: p, name: p, havePermission: await hasGlobalPermission(user.id, p) };
  }

  if (projectKey) {
    const project = await db.select().from(schema.projects).where(eq(schema.projects.projectKey, projectKey)).limit(1);
    if (project.length > 0) {
      for (const p of PROJECT_PERMISSIONS) {
        permissions[p] = {
          key: p,
          name: p,
          havePermission: await hasProjectPermission(user.id, project[0].id, p),
        };
      }
    }
  }

  return c.json({ permissions });
});

export default app;
