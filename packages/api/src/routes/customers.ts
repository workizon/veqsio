import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, count, desc, eq, sql } from 'drizzle-orm';
import { requireAuth, sessionMiddleware } from '../auth/middleware';
import type { AppContext } from '../auth/middleware';
import { db } from '../db';
import * as schema from '@veqsio/db';
import { checkProjectPermission } from '../middleware/permissions';
import { getBrowsableProjectIds } from '../services/browse';
import { hasGlobalPermission } from '../rbac/service';
import { canSeeIssue, issueVisibleFor } from '../security/issue-security';

/**
 * Customers linked to work ("who needs this"). Any signed-in user can list customers and create one; the creator or an
 * administrator edits or deletes it. Linking a customer to an issue needs EDIT_ISSUES on the issue's project. Issue
 * lists respect project permissions and issue security. Revenue is shown to everyone who can see the customer.
 */
const app = new Hono<AppContext>();
app.use('/rest/api/2/customer*', sessionMiddleware);
app.use('/rest/api/2/issue/*/customer*', sessionMiddleware);
const P = '/rest/api/2/customer';

const body = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  importance: z.number().int().min(1).max(5).default(3),
  annualRevenue: z.number().min(0).max(1e12).nullable().optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).default('USD'),
});

const shape = (c: typeof schema.customers.$inferSelect) => ({
  id: c.id, name: c.name, description: c.description, importance: c.importance,
  annualRevenue: c.annualRevenue === null ? null : Number(c.annualRevenue), currency: c.currency,
});

const dup = (e: unknown) => (e as any)?.code === '23505' || (e as any)?.cause?.code === '23505' || /customers_name_uniq|duplicate key/i.test(`${(e as any)?.message ?? ''} ${(e as any)?.cause?.message ?? ''}`);

async function load(id: number) {
  const [r] = Number.isInteger(id) ? await db.select().from(schema.customers).where(eq(schema.customers.id, id)).limit(1) : [];
  return r ?? null;
}
const mayEdit = async (user: { id: number }, c: typeof schema.customers.$inferSelect) => c.createdBy === user.id || (await hasGlobalPermission(user.id, 'SYSTEM_ADMIN'));

/** Issues linked to a customer that the viewer may see. */
async function linkedIssues(user: any, customerId: number) {
  const browsable = await getBrowsableProjectIds(user);
  if (!browsable.length) return [];
  return db.execute(sql`
    SELECT issues.id, issues.issue_key AS "key", issues.summary, s.name AS status, s.category AS "statusCategory", l.note, l.customer_id AS "customerId"
    FROM customer_issue_links l
    JOIN issues ON issues.id = l.issue_id
    JOIN statuses s ON s.id = issues.status_id
    WHERE l.customer_id = ${customerId} AND issues.project_id IN (${sql.join(browsable.map((i) => sql`${i}`), sql`, `)}) AND ${issueVisibleFor(user)}
    ORDER BY issues.id DESC LIMIT 500`) as unknown as Promise<Array<{ id: number; key: string; summary: string; status: string; statusCategory: string; note: string | null; customerId: number }>>;
}

app.get(P, requireAuth, async (c) => {
  const q = (c.req.query('query') ?? '').trim().toLowerCase();
  const rows = await db.select().from(schema.customers).where(q ? sql`lower(${schema.customers.name}) like ${'%' + q.replace(/[%_\\]/g, (m) => '\\' + m) + '%'}` : undefined)
    .orderBy(desc(schema.customers.importance), asc(schema.customers.name)).limit(500);
  const n = await db.select({ id: schema.customerIssueLinks.customerId, n: count() }).from(schema.customerIssueLinks).groupBy(schema.customerIssueLinks.customerId);
  const m = new Map(n.map((x) => [x.id, Number(x.n)]));
  return c.json({ customers: rows.map((r) => ({ ...shape(r), linkedIssues: m.get(r.id) ?? 0 })) });
});

app.get(`${P}/:id`, requireAuth, async (c) => {
  const user = c.get('user')!;
  const cu = await load(Number(c.req.param('id')));
  if (!cu) return c.json({ errorMessages: ['Customer not found'] }, 404);
  const issues = await linkedIssues(user, cu.id);
  return c.json({ ...shape(cu), canEdit: await mayEdit(user, cu), issues });
});

app.post(P, requireAuth, zValidator('json', body), async (c) => {
  const b = c.req.valid('json');
  try {
    const [r] = await db.insert(schema.customers).values({ name: b.name, description: b.description ?? null, importance: b.importance, annualRevenue: b.annualRevenue == null ? null : String(b.annualRevenue), currency: b.currency, createdBy: c.get('user')!.id }).returning();
    return c.json(shape(r), 201);
  } catch (e) {
    if (dup(e)) return c.json({ errorMessages: ['A customer with this name already exists'] }, 409);
    throw e;
  }
});

app.put(`${P}/:id`, requireAuth, zValidator('json', body), async (c) => {
  const cu = await load(Number(c.req.param('id')));
  if (!cu) return c.json({ errorMessages: ['Customer not found'] }, 404);
  if (!(await mayEdit(c.get('user')!, cu))) return c.json({ errorMessages: ['Only the creator or an administrator can change a customer'] }, 403);
  const b = c.req.valid('json');
  try {
    const [r] = await db.update(schema.customers).set({ name: b.name, description: b.description ?? null, importance: b.importance, annualRevenue: b.annualRevenue == null ? null : String(b.annualRevenue), currency: b.currency }).where(eq(schema.customers.id, cu.id)).returning();
    return c.json(shape(r));
  } catch (e) {
    if (dup(e)) return c.json({ errorMessages: ['A customer with this name already exists'] }, 409);
    throw e;
  }
});

app.delete(`${P}/:id`, requireAuth, async (c) => {
  const cu = await load(Number(c.req.param('id')));
  if (!cu) return c.json({ errorMessages: ['Customer not found'] }, 404);
  if (!(await mayEdit(c.get('user')!, cu))) return c.json({ errorMessages: ['Only the creator or an administrator can delete a customer'] }, 403);
  await db.delete(schema.customers).where(eq(schema.customers.id, cu.id));
  return c.body(null, 204);
});

/* ---- on an issue ---- */
async function issueRow(c: any, write: boolean) {
  const user = c.get('user')!;
  const key = c.req.param('idOrKey');
  const [i] = await db.select({ id: schema.issues.id, projectId: schema.issues.projectId }).from(schema.issues)
    .where(/^\d+$/.test(key) ? eq(schema.issues.id, Number(key)) : eq(schema.issues.issueKey, key)).limit(1);
  if (!i || !(await checkProjectPermission(user, i.projectId, 'BROWSE_PROJECTS')) || !(await canSeeIssue(user.id, i.id))) return { err: c.json({ errorMessages: ['Issue not found'] }, 404) };
  if (write && !(await checkProjectPermission(user, i.projectId, 'EDIT_ISSUES'))) return { err: c.json({ errorMessages: ['Forbidden'] }, 403) };
  return { issue: i };
}

app.get('/rest/api/2/issue/:idOrKey/customer', requireAuth, async (c) => {
  const r = await issueRow(c, false);
  if (r.err) return r.err;
  const rows = await db.select({ cu: schema.customers, note: schema.customerIssueLinks.note }).from(schema.customerIssueLinks)
    .innerJoin(schema.customers, eq(schema.customers.id, schema.customerIssueLinks.customerId))
    .where(eq(schema.customerIssueLinks.issueId, r.issue!.id)).orderBy(desc(schema.customers.importance), asc(schema.customers.name));
  return c.json({ customers: rows.map((x) => ({ ...shape(x.cu), note: x.note })) });
});

app.post('/rest/api/2/issue/:idOrKey/customer', requireAuth, zValidator('json', z.object({ customerId: z.number().int().positive(), note: z.string().max(1000).nullable().optional() })), async (c) => {
  const r = await issueRow(c, true);
  if (r.err) return r.err;
  const b = c.req.valid('json');
  if (!(await load(b.customerId))) return c.json({ errorMessages: ['Customer not found'] }, 404);
  await db.insert(schema.customerIssueLinks).values({ customerId: b.customerId, issueId: r.issue!.id, note: b.note ?? null, createdBy: c.get('user')!.id })
    .onConflictDoUpdate({ target: [schema.customerIssueLinks.customerId, schema.customerIssueLinks.issueId], set: { note: b.note ?? null } });
  return c.json({ ok: true }, 201);
});

app.delete('/rest/api/2/issue/:idOrKey/customer/:customerId', requireAuth, async (c) => {
  const r = await issueRow(c, true);
  if (r.err) return r.err;
  const cid = Number(c.req.param('customerId'));
  if (!Number.isInteger(cid)) return c.json({ errorMessages: ['Customer not found'] }, 404);
  await db.delete(schema.customerIssueLinks).where(and(eq(schema.customerIssueLinks.issueId, r.issue!.id), eq(schema.customerIssueLinks.customerId, cid)));
  return c.body(null, 204);
});

export default app;
