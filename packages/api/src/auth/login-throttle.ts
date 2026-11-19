import { redis } from '../services/cache';
import { getInstanceSettings } from '../settings/instance';

/**
 * Brute-force protection for password login.
 *
 * Failed attempts are counted per (client IP + username) and per client IP, in Redis, over a sliding window.
 * Counting per IP+username (not per username alone) means an attacker cannot lock a victim out from another
 * address; the per-IP counter stops credential stuffing across many usernames. Successful logins are not counted
 * and clear the per-account counter. Limits: LOGIN_MAX_FAILURES (default 10 per IP+username) and
 * LOGIN_MAX_FAILURES_PER_IP (default 40) within LOGIN_WINDOW_SECONDS (default 900).
 */
const envInt = (name: string, def: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
};
// Administrator-chosen values (Instance settings) win when they differ from the defaults; otherwise the environment applies.
let tuned = { maxFailures: 0, windowMs: 0 };
async function refreshTuning() {
  const s = await getInstanceSettings();
  tuned = {
    maxFailures: s.loginMaxFailures !== 10 ? (s.loginMaxFailures as number) : 0,
    windowMs: s.loginLockMinutes !== 15 ? (s.loginLockMinutes as number) * 60_000 : 0,
  };
}
const windowMs = () => tuned.windowMs || envInt('LOGIN_WINDOW_SECONDS', 900) * 1000;
const maxPerAccount = () => tuned.maxFailures || envInt('LOGIN_MAX_FAILURES', 10);
const maxPerIp = () => envInt('LOGIN_MAX_FAILURES_PER_IP', 40);

const accountKey = (ip: string, username: string) => `veqsio:ratelimit:login:acct:${ip}:${username.toLowerCase().slice(0, 100)}`;
const ipKey = (ip: string) => `veqsio:ratelimit:login:ip:${ip}`;

async function count(key: string): Promise<{ n: number; oldest: number }> {
  const now = Date.now();
  await redis.zremrangebyscore(key, 0, now - windowMs());
  const n = await redis.zcard(key);
  const first = n > 0 ? await redis.zrange(key, 0, 0, 'WITHSCORES') : [];
  return { n, oldest: first.length > 1 ? Number(first[1]) : now };
}

/** Seconds the client must wait, or 0 when another attempt is allowed. */
export async function loginRetryAfter(ip: string, username: string): Promise<number> {
  try {
    await refreshTuning();
    const [acct, perIp] = await Promise.all([count(accountKey(ip, username)), count(ipKey(ip))]);
    const waits: number[] = [];
    if (acct.n >= maxPerAccount()) waits.push(Math.ceil((acct.oldest + windowMs() - Date.now()) / 1000));
    if (perIp.n >= maxPerIp()) waits.push(Math.ceil((perIp.oldest + windowMs() - Date.now()) / 1000));
    return waits.length ? Math.max(1, ...waits) : 0;
  } catch {
    return 0; // Redis down: fail open (the global limiter has the same behaviour)
  }
}

export async function recordLoginFailure(ip: string, username: string): Promise<void> {
  try {
    await refreshTuning();
    const now = Date.now();
    const member = `${now}-${Math.random()}`;
    const ttl = windowMs();
    await Promise.all([
      redis.zadd(accountKey(ip, username), now, member).then(() => redis.pexpire(accountKey(ip, username), ttl)),
      redis.zadd(ipKey(ip), now, member).then(() => redis.pexpire(ipKey(ip), ttl)),
    ]);
  } catch {
    /* best effort */
  }
}

export async function clearLoginFailures(ip: string, username: string): Promise<void> {
  try {
    await redis.del(accountKey(ip, username));
  } catch {
    /* best effort */
  }
}
