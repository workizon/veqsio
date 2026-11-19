import { createHash, randomBytes } from 'crypto';
import { redis } from '../services/cache';

/**
 * Short-lived single-use WebSocket tickets for browsers that cannot send the session cookie
 * (cross-origin API host). A ticket is a random 32-byte token bound to a user id, valid for 30 s
 * and consumed on first use. Only the SHA-256 of the token is stored.
 */
export const TICKET_TTL_SECONDS = 30;
const PREFIX = 'veqsio:wsticket:';
const consuming = new Set<string>();

function keyFor(ticket: string) {
  return PREFIX + createHash('sha256').update(ticket).digest('hex');
}

export async function issueTicket(userId: number): Promise<string> {
  const ticket = randomBytes(32).toString('base64url');
  await redis.setex(keyFor(ticket), TICKET_TTL_SECONDS, JSON.stringify({ userId }));
  return ticket;
}

/** Returns the bound user id and invalidates the ticket, or null. */
export async function consumeTicket(ticket: string): Promise<number | null> {
  if (typeof ticket !== 'string' || ticket.length < 20 || ticket.length > 100) return null;
  const key = keyFor(ticket);
  if (consuming.has(key)) return null;
  consuming.add(key);
  try {
    const atomic = typeof (redis as any).getdel === 'function';
    const raw = atomic ? await (redis as any).getdel(key) : await redis.get(key);
    if (!raw) return null;
    if (!atomic) await redis.del(key);
    const parsed = JSON.parse(raw);
    return typeof parsed.userId === 'number' ? parsed.userId : null;
  } catch {
    return null;
  } finally {
    // keep the key blocked briefly in-process so a racing second consumer cannot slip in
    const t: any = setTimeout(() => consuming.delete(key), 1000);
    t.unref?.();
  }
}
