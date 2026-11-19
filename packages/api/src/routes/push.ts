import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { requireAuth } from '../auth/middleware';
import type { AppContext } from '../auth/middleware';
import { db } from '../db';
import * as schema from '@veqsio/db';
import { getVapidKeys } from '../services/push';
import { DEFAULT_PREFS, PUSH_KINDS, PUSH_KIND_LABELS, isHHMM, resolvedEvents, validTimeZone } from '../services/push-preferences';

const app = new Hono<AppContext>();
const P = '/rest/api/2/push';

/** Public VAPID key the browser needs to subscribe (the private key never leaves the server). */
app.get(`${P}/key`, requireAuth, async (c) => c.json({ publicKey: (await getVapidKeys()).publicKey }));

const sub = z.object({
  endpoint: z.string().url().max(2000).refine((u) => u.startsWith('https://'), 'The push endpoint must be https'),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
});

app.post(`${P}/subscription`, requireAuth, zValidator('json', sub), async (c) => {
  const user = c.get('user')!;
  const b = c.req.valid('json');
  const ua = (c.req.header('user-agent') || '').slice(0, 255) || null;
  // A browser endpoint belongs to whoever subscribed last (shared computers: the new login takes it over).
  await db.insert(schema.pushSubscriptions).values({ userId: user.id, endpoint: b.endpoint, p256dh: b.keys.p256dh, auth: b.keys.auth, userAgent: ua })
    .onConflictDoUpdate({ target: schema.pushSubscriptions.endpoint, set: { userId: user.id, p256dh: b.keys.p256dh, auth: b.keys.auth, userAgent: ua } });
  return c.json({ ok: true }, 201);
});

app.delete(`${P}/subscription`, requireAuth, zValidator('json', z.object({ endpoint: z.string().max(2000) })), async (c) => {
  const user = c.get('user')!;
  await db.delete(schema.pushSubscriptions).where(and(eq(schema.pushSubscriptions.userId, user.id), eq(schema.pushSubscriptions.endpoint, c.req.valid('json').endpoint)));
  return c.body(null, 204);
});

const prefsBody = z.object({
  events: z.record(z.enum(PUSH_KINDS), z.boolean()).optional(),
  quietEnabled: z.boolean().optional(),
  quietStart: z.string().refine(isHHMM, 'Use the form HH:MM (24 hours)').optional(),
  quietEnd: z.string().refine(isHHMM, 'Use the form HH:MM (24 hours)').optional(),
  timezone: z.string().refine(validTimeZone, 'Unknown time zone').optional(),
}).strict();

async function readPrefs(userId: number) {
  const [row] = await db.select().from(schema.pushPreferences).where(eq(schema.pushPreferences.userId, userId)).limit(1);
  const p = row ?? { ...DEFAULT_PREFS };
  return {
    events: resolvedEvents(p.events ?? {}),
    quietEnabled: p.quietEnabled, quietStart: p.quietStart, quietEnd: p.quietEnd, timezone: p.timezone,
    kinds: PUSH_KINDS.map((k) => ({ key: k, label: PUSH_KIND_LABELS[k] })),
  };
}

/** The signed-in person's own push preferences (which kinds of push they get, and quiet hours). */
app.get(`${P}/preferences`, requireAuth, async (c) => c.json(await readPrefs(c.get('user')!.id)));

app.put(`${P}/preferences`, requireAuth, zValidator('json', prefsBody), async (c) => {
  const user = c.get('user')!;
  const b = c.req.valid('json');
  const [row] = await db.select().from(schema.pushPreferences).where(eq(schema.pushPreferences.userId, user.id)).limit(1);
  const cur = row ?? { ...DEFAULT_PREFS };
  // only the switches that differ from "on" are stored; a change merges into what is there
  const events: Record<string, boolean> = { ...(cur.events ?? {}) };
  for (const [k, v] of Object.entries(b.events ?? {})) { if (v) delete events[k]; else events[k] = false; }
  const next = {
    events,
    quietEnabled: b.quietEnabled ?? cur.quietEnabled,
    quietStart: b.quietStart ?? cur.quietStart,
    quietEnd: b.quietEnd ?? cur.quietEnd,
    timezone: b.timezone ?? cur.timezone,
    updatedAt: new Date(),
  };
  await db.insert(schema.pushPreferences).values({ userId: user.id, ...next }).onConflictDoUpdate({ target: schema.pushPreferences.userId, set: next });
  return c.json(await readPrefs(user.id));
});

export default app;
