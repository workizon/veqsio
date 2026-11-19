import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { sessionMiddleware, requireAuth } from '../auth/middleware';
import { requireGlobalPermission } from '../rbac/middleware';
import { db } from '../db';
import * as schema from '@veqsio/db';
import { eq, and, desc } from 'drizzle-orm';
import {
  getWebhooks,
  getWebhookById,
  registerWebhook,
  unregisterWebhook,
  updateWebhook,
  getWebhookDeliveries,
  testWebhook,
} from '../services/webhooks';
import type { AppContext } from '../auth/middleware';
import type { WebhookEvent } from '../services/webhooks';

const app = new Hono<AppContext>();
app.use('/rest/api/2/notification*', sessionMiddleware);
app.use('/rest/api/2/webhook*', sessionMiddleware);

const eventTypeSchema = z.enum([
  'issue.created',
  'issue.updated',
  'issue.deleted',
  'comment.added',
  'issue.transitioned',
  'sprint.started',
  'sprint.closed',
]);

// Notification Schemes
app.get('/rest/api/2/notification', requireAuth, requireGlobalPermission('ADMINISTER'), async (c) => {
  const projectId = c.req.query('projectId');
  let query = db.select().from(schema.notificationSchemes);
  if (projectId) {
    query = query.where(eq(schema.notificationSchemes.projectId, Number(projectId))) as typeof query;
  }
  const schemes = await query;
  return c.json({ schemes });
});

app.get('/rest/api/2/notification/:id', requireAuth, requireGlobalPermission('ADMINISTER'), async (c) => {
  const id = Number(c.req.param('id'));
  const scheme = await db.select().from(schema.notificationSchemes).where(eq(schema.notificationSchemes.id, id)).limit(1);
  if (scheme.length === 0) return c.json({ errorMessages: ['Notification scheme not found'] }, 404);
  const events = await db
    .select()
    .from(schema.notificationSchemeEvents)
    .where(eq(schema.notificationSchemeEvents.schemeId, id));
  return c.json({ ...scheme[0], events });
});

const createSchemeSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  projectId: z.number().optional(),
  isDefault: z.boolean().optional(),
  events: z
    .array(
      z.object({
        eventType: eventTypeSchema,
        notifyAssignee: z.boolean().default(false),
        notifyReporter: z.boolean().default(false),
        notifyWatchers: z.boolean().default(false),
        notifyProjectLead: z.boolean().default(false),
        notifyAllAdmins: z.boolean().default(false),
        notifyCurrentUser: z.boolean().default(false),
      })
    )
    .optional(),
});

app.post('/rest/api/2/notification', requireAuth, requireGlobalPermission('ADMINISTER'), zValidator('json', createSchemeSchema), async (c) => {
  try {
    const body = c.req.valid('json');
    const [scheme] = await db
      .insert(schema.notificationSchemes)
      .values({
        name: body.name,
        description: body.description,
        projectId: body.projectId,
        isDefault: body.isDefault,
      })
      .returning();

    if (body.events?.length) {
      await db.insert(schema.notificationSchemeEvents).values(
        body.events.map((e) => ({
          schemeId: scheme.id,
          eventType: e.eventType,
          notifyAssignee: e.notifyAssignee,
          notifyReporter: e.notifyReporter,
          notifyWatchers: e.notifyWatchers,
          notifyProjectLead: e.notifyProjectLead,
          notifyAllAdmins: e.notifyAllAdmins,
          notifyCurrentUser: e.notifyCurrentUser,
        }))
      );
    }

    return c.json({ id: scheme.id, self: `/rest/api/2/notification/${scheme.id}` }, 201);
  } catch (err: any) {
    return c.json({ errorMessages: [err.message || 'Failed to create notification scheme'] }, 500);
  }
});

app.put('/rest/api/2/notification/:id', requireAuth, requireGlobalPermission('ADMINISTER'), zValidator('json', createSchemeSchema), async (c) => {
  try {
    const id = Number(c.req.param('id'));
    const body = c.req.valid('json');

    const existing = await db.select().from(schema.notificationSchemes).where(eq(schema.notificationSchemes.id, id)).limit(1);
    if (existing.length === 0) return c.json({ errorMessages: ['Notification scheme not found'] }, 404);

    await db
      .update(schema.notificationSchemes)
      .set({
        name: body.name,
        description: body.description,
        projectId: body.projectId,
        isDefault: body.isDefault,
        updatedAt: new Date(),
      })
      .where(eq(schema.notificationSchemes.id, id));

    if (body.events) {
      await db.delete(schema.notificationSchemeEvents).where(eq(schema.notificationSchemeEvents.schemeId, id));
      if (body.events.length > 0) {
        await db.insert(schema.notificationSchemeEvents).values(
          body.events.map((e) => ({
            schemeId: id,
            eventType: e.eventType,
            notifyAssignee: e.notifyAssignee,
            notifyReporter: e.notifyReporter,
            notifyWatchers: e.notifyWatchers,
            notifyProjectLead: e.notifyProjectLead,
            notifyAllAdmins: e.notifyAllAdmins,
            notifyCurrentUser: e.notifyCurrentUser,
          }))
        );
      }
    }

    return c.json({ id });
  } catch (err: any) {
    return c.json({ errorMessages: [err.message || 'Failed to update notification scheme'] }, 500);
  }
});

app.delete('/rest/api/2/notification/:id', requireAuth, requireGlobalPermission('ADMINISTER'), async (c) => {
  const id = Number(c.req.param('id'));
  await db.delete(schema.notificationSchemes).where(eq(schema.notificationSchemes.id, id));
  return c.json({});
});

// Webhooks
app.get('/rest/api/2/webhook', requireAuth, requireGlobalPermission('ADMINISTER'), async (c) => {
  const projectId = c.req.query('projectId');
  const webhooks = await getWebhooks(projectId ? Number(projectId) : undefined);
  // the signing secret is shown when it is set and never returned: whoever can read this list could otherwise forge signed deliveries
  return c.json({ webhooks: webhooks.map((w: any) => { const { secret, ...rest } = w; return { ...rest, hasSecret: !!secret }; }) });
});

const createWebhookSchema = z.object({
  projectId: z.number().nullable().optional(),
  url: z.string().url(),
  secret: z.string().optional(),
  events: z.array(eventTypeSchema).min(1),
});

app.post('/rest/api/2/webhook', requireAuth, requireGlobalPermission('ADMINISTER'), zValidator('json', createWebhookSchema), async (c) => {
  try {
    const body = c.req.valid('json');
    const webhook = await registerWebhook(
      body.projectId ?? null,
      body.url,
      body.events as WebhookEvent[],
      body.secret
    );
    return c.json({ id: webhook.id, self: `/rest/api/2/webhook/${webhook.id}` }, 201);
  } catch (err: any) {
    return c.json({ errorMessages: [err.message || 'Failed to register webhook'] }, 500);
  }
});

const updateWebhookSchema = z.object({
  url: z.string().url().optional(),
  secret: z.string().optional(),
  events: z.array(eventTypeSchema).min(1).optional(),
  active: z.boolean().optional(),
});

app.put('/rest/api/2/webhook/:id', requireAuth, requireGlobalPermission('ADMINISTER'), zValidator('json', updateWebhookSchema), async (c) => {
  try {
    const id = Number(c.req.param('id'));
    const body = c.req.valid('json');
    const updated = await updateWebhook(id, {
      url: body.url,
      events: body.events,
      secret: body.secret,
      active: body.active,
    });
    if (!updated) return c.json({ errorMessages: ['Webhook not found'] }, 404);
    return c.json({ id: updated.id });
  } catch (err: any) {
    return c.json({ errorMessages: [err.message || 'Failed to update webhook'] }, 500);
  }
});

app.delete('/rest/api/2/webhook/:id', requireAuth, requireGlobalPermission('ADMINISTER'), async (c) => {
  try {
    const id = Number(c.req.param('id'));
    await unregisterWebhook(id);
    return c.json({});
  } catch (err: any) {
    return c.json({ errorMessages: [err.message || 'Failed to delete webhook'] }, 500);
  }
});

app.get('/rest/api/2/webhook/:id/delivery', requireAuth, requireGlobalPermission('ADMINISTER'), async (c) => {
  const id = Number(c.req.param('id'));
  const limit = Number(c.req.query('limit') || '50');
  const deliveries = await getWebhookDeliveries(id, limit);
  return c.json({ deliveries });
});

app.post('/rest/api/2/webhook/:id/test', requireAuth, requireGlobalPermission('ADMINISTER'), async (c) => {
  const id = Number(c.req.param('id'));
  const result = await testWebhook(id);
  if (result.error && !result.success) {
    return c.json({ success: false, error: result.error }, 400);
  }
  return c.json({
    success: result.success,
    responseStatus: result.responseStatus,
    responseBody: result.responseBody,
  });
});

export default app;
