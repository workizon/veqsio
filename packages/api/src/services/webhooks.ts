import { db } from '../db';
import { outboundFetch } from '../security/outbound';
import * as schema from '@veqsio/db';
import { eq, and, desc, isNull } from 'drizzle-orm';
import { dispatchPluginEvent } from '../plugins/events';
import { dispatchChatNotification } from '../integrations/notify';
import { webhookDeliveries as webhookDeliveryCounter } from '../ops/metrics';

export type WebhookEvent =
  | 'issue.created'
  | 'issue.updated'
  | 'issue.deleted'
  | 'comment.added'
  | 'issue.transitioned'
  | 'sprint.started'
  | 'sprint.closed'
  | 'sla.breached'
  | 'sla.warning'
  | 'approval.requested'
  | 'approval.decided'
  | 'incident.major';

export const ALL_EVENTS: WebhookEvent[] = [
  'issue.created',
  'sla.breached',
  'sla.warning',
  'issue.updated',
  'issue.deleted',
  'comment.added',
  'issue.transitioned',
  'sprint.started',
  'sprint.closed',
  'approval.requested',
  'approval.decided',
  'incident.major',
];

export async function registerWebhook(
  projectId: number | null,
  url: string,
  events: WebhookEvent[],
  secret?: string
): Promise<typeof schema.webhooks.$inferSelect> {
  const filtered = events.filter((e) => ALL_EVENTS.includes(e));
  const [webhook] = await db
    .insert(schema.webhooks)
    .values({
      projectId,
      url,
      secret: secret || null,
      events: filtered,
      active: true,
      failureCount: 0,
    })
    .returning();
  return webhook;
}

export async function unregisterWebhook(id: number): Promise<void> {
  await db.delete(schema.webhooks).where(eq(schema.webhooks.id, id));
}

export async function updateWebhook(
  id: number,
  data: Partial<Pick<typeof schema.webhooks.$inferInsert, 'url' | 'events' | 'secret' | 'active'>>
): Promise<typeof schema.webhooks.$inferSelect | null> {
  const existing = await db.select().from(schema.webhooks).where(eq(schema.webhooks.id, id)).limit(1);
  if (existing.length === 0) return null;

  const update: Partial<typeof schema.webhooks.$inferInsert> = { updatedAt: new Date() };
  if (data.url !== undefined) update.url = data.url;
  if (data.events != null && Array.isArray(data.events)) {
    update.events = data.events.filter((e: string) => ALL_EVENTS.includes(e as WebhookEvent));
  }
  if (data.secret !== undefined) update.secret = data.secret || null;
  if (data.active !== undefined) {
    update.active = data.active;
    if (data.active) update.failureCount = 0;
  }

  const [updated] = await db.update(schema.webhooks).set(update).where(eq(schema.webhooks.id, id)).returning();
  return updated;
}

export async function getWebhooks(projectId?: number): Promise<typeof schema.webhooks.$inferSelect[]> {
  if (projectId !== undefined) {
    return db
      .select()
      .from(schema.webhooks)
      .where(eq(schema.webhooks.projectId, projectId))
      .orderBy(desc(schema.webhooks.createdAt));
  }
  return db.select().from(schema.webhooks).orderBy(desc(schema.webhooks.createdAt));
}

export async function getWebhookById(id: number): Promise<typeof schema.webhooks.$inferSelect | null> {
  const rows = await db.select().from(schema.webhooks).where(eq(schema.webhooks.id, id)).limit(1);
  return rows[0] || null;
}

export async function getWebhookDeliveries(
  webhookId: number,
  limit = 50
): Promise<typeof schema.webhookDeliveries.$inferSelect[]> {
  return db
    .select()
    .from(schema.webhookDeliveries)
    .where(eq(schema.webhookDeliveries.webhookId, webhookId))
    .orderBy(desc(schema.webhookDeliveries.createdAt))
    .limit(limit);
}

async function generateHmacSignature(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function deliverWebhook(event: WebhookEvent, payload: Record<string, any>): Promise<void> {
  dispatchPluginEvent(event, payload); // out-of-process plugins (non-blocking, never throws)
  dispatchChatNotification(event, payload); // Slack / Teams channels (non-blocking, never throws)

  const projectId = payload.projectId ?? payload.project?.id ?? null;

  const conditions = [eq(schema.webhooks.active, true)];
  if (projectId !== null) {
    conditions.push(eq(schema.webhooks.projectId, projectId));
  } else {
    conditions.push(isNull(schema.webhooks.projectId));
  }

  const webhooks = await db
    .select()
    .from(schema.webhooks)
    .where(and(...conditions));

  const allHooks = webhooks.filter((w) => {
    const events = w.events as string[];
    return events.includes(event);
  });

  for (const hook of allHooks) {
    const body = JSON.stringify({ event, timestamp: new Date().toISOString(), payload });
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'Veqsio-Webhook/1.0',
      'X-Veqsio-Event': event,
      'X-Veqsio-Delivery': crypto.randomUUID(),
    };

    if (hook.secret) {
      const signature = await generateHmacSignature(body, hook.secret);
      headers['X-Veqsio-Signature'] = `sha256=${signature}`;
    }

    let success = false;
    let responseStatus: number | null = null;
    let responseBody = '';
    const start = Date.now();

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await outboundFetch(hook.url, {
          method: 'POST',
          headers,
          body,
          // @ts-ignore
          signal: AbortSignal.timeout(30000),
        });
        responseStatus = res.status;
        responseBody = await res.text();
        if (res.ok) {
          success = true;
          break;
        }
      } catch (err) {
        responseBody = err instanceof Error ? err.message : String(err);
      }

      if (attempt < 2) {
        const delay = Math.pow(2, attempt) * 1000; // 1s, 2s
        await sleep(delay);
      }
    }

    const duration = Date.now() - start;
    webhookDeliveryCounter.inc({ result: success ? 'success' : 'failure' });

    await db.insert(schema.webhookDeliveries).values({
      webhookId: hook.id,
      event,
      payload: { event, payload },
      responseStatus: responseStatus ?? 0,
      responseBody,
      success,
      durationMs: duration,
    });

    if (!success) {
      const newFailureCount = (hook.failureCount || 0) + 1;
      const update: Partial<typeof schema.webhooks.$inferInsert> = {
        failureCount: newFailureCount,
        updatedAt: new Date(),
      };
      if (newFailureCount >= 10) {
        update.active = false;
      }
      await db.update(schema.webhooks).set(update).where(eq(schema.webhooks.id, hook.id));
    } else if (hook.failureCount && hook.failureCount > 0) {
      await db
        .update(schema.webhooks)
        .set({ failureCount: 0, updatedAt: new Date() })
        .where(eq(schema.webhooks.id, hook.id));
    }
  }
}

export async function testWebhook(id: number): Promise<{ success: boolean; responseStatus?: number; responseBody?: string; error?: string }> {
  const hook = await getWebhookById(id);
  if (!hook) return { success: false, error: 'Webhook not found' };

  const body = JSON.stringify({ event: 'ping', timestamp: new Date().toISOString(), payload: { test: true } });
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'Veqsio-Webhook/1.0',
    'X-Veqsio-Event': 'ping',
    'X-Veqsio-Delivery': crypto.randomUUID(),
  };

  if (hook.secret) {
    const signature = await generateHmacSignature(body, hook.secret);
    headers['X-Veqsio-Signature'] = `sha256=${signature}`;
  }

  try {
    const res = await outboundFetch(hook.url, {
      method: 'POST',
      headers,
      body,
      // @ts-ignore
      signal: AbortSignal.timeout(30000),
    });
    const responseBody = await res.text();
    return { success: res.ok, responseStatus: res.status, responseBody };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
