/**
 * Web Push for assignments and mentions. VAPID keys live in the `vapid_keys` system setting (generated on first
 * use, never in the repo); env VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY override. Sending never throws: a failed push
 * must not break the action that caused it. Subscriptions the push service reports gone (404/410) are deleted.
 */
import * as webpush from 'web-push';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import * as schema from '@veqsio/db';
import { shouldPush, type PushKind, type PushPrefs } from './push-preferences';

/** `kind` decides which of the recipient's switches and quiet hours apply; without it the push is always delivered. */
export interface PushPayload { title: string; body: string; url: string; tag?: string; kind?: PushKind }
export type PushSender = (sub: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string) => Promise<void>;

const KEY = 'vapid_keys';
let cached: { publicKey: string; privateKey: string } | null = null;
let sender: PushSender | null = null;
/** Tests replace the network sender. */
export function setPushSender(s: PushSender | null) { sender = s; }

export async function getVapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  if (cached) return cached;
  const [row] = await db.select().from(schema.systemSettings).where(eq(schema.systemSettings.key, KEY)).limit(1);
  let v: { publicKey?: string; privateKey?: string } | null = null;
  try { v = row?.value ? JSON.parse(row.value) : null; } catch { v = null; }
  if (v?.publicKey && v?.privateKey) return (cached = { publicKey: v.publicKey, privateKey: v.privateKey });
  const k = webpush.generateVAPIDKeys();
  await db.insert(schema.systemSettings).values({ key: KEY, value: JSON.stringify(k) }).onConflictDoNothing();
  const [again] = await db.select().from(schema.systemSettings).where(eq(schema.systemSettings.key, KEY)).limit(1);
  let a: { publicKey: string; privateKey: string } | null = null;
  try { a = again?.value ? JSON.parse(again.value) : null; } catch { a = null; }
  return (cached = a ?? k);
}

async function realSender(sub: Parameters<PushSender>[0], payload: string) {
  const keys = await getVapidKeys();
  await webpush.sendNotification(sub, payload, {
    vapidDetails: { subject: process.env.VAPID_SUBJECT || 'mailto:noreply@localhost.invalid', ...keys },
    TTL: 3600,
    timeout: 8000,
  });
}

/** Sends to every browser of the given users. Returns how many deliveries succeeded. */
export async function sendPush(userIds: number[], payload: PushPayload): Promise<number> {
  try {
    let ids = [...new Set(userIds)];
    if (!ids.length) return 0;
    if (payload.kind) {
      const rows = await db.select().from(schema.pushPreferences).where(inArray(schema.pushPreferences.userId, ids));
      const prefs = new Map<number, PushPrefs>(rows.map((r) => [r.userId, { events: r.events ?? {}, quietEnabled: r.quietEnabled, quietStart: r.quietStart, quietEnd: r.quietEnd, timezone: r.timezone }]));
      const now = new Date();
      ids = ids.filter((id) => shouldPush(prefs.get(id), payload.kind!, now));
      if (!ids.length) return 0;
    }
    const subs = await db.select().from(schema.pushSubscriptions).where(inArray(schema.pushSubscriptions.userId, ids));
    const body = JSON.stringify({ title: payload.title.slice(0, 120), body: payload.body.slice(0, 200), url: payload.url, tag: payload.tag });
    let ok = 0;
    await Promise.all(subs.map(async (s) => {
      try {
        await (sender ?? realSender)({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body);
        ok++;
      } catch (e: any) {
        if (e?.statusCode === 404 || e?.statusCode === 410) await db.delete(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.id, s.id));
        else console.error('[push] delivery failed:', e?.statusCode ?? (e instanceof Error ? e.message : 'error'));
      }
    }));
    return ok;
  } catch (e) {
    console.error('[push] failed:', e instanceof Error ? e.message : 'error');
    return 0;
  }
}

/** `@username` mentions in comment text, as usernames (lower case, de-duplicated). */
export function mentionedUsernames(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?:^|[^\w@.])@([A-Za-z0-9][A-Za-z0-9._-]{0,63})/g)) out.add(m[1].replace(/[.]+$/, '').toLowerCase());
  return [...out];
}
