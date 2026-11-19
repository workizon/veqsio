import Redis from 'ioredis';

type ZMember = { score: number; value: string };

const MEMORY_STORE = new Map<string, { value: string; ttl: number }>();
const ZSETS = new Map<string, ZMember[]>();

function nowMs() {
  return Date.now();
}

function createMemoryRedis() {
  return {
    async get(key: string) {
      const entry = MEMORY_STORE.get(key);
      if (!entry) return null;
      if (nowMs() > entry.ttl) {
        MEMORY_STORE.delete(key);
        return null;
      }
      return entry.value;
    },
    async setex(key: string, ttl: number, value: string) {
      MEMORY_STORE.set(key, { value, ttl: nowMs() + ttl * 1000 });
    },
    /** SET with the EX/PX/NX options used by the SSO replay protection (atomic within this process). */
    async set(key: string, value: string, ...opts: Array<string | number>) {
      let ttlMs = 0;
      let nx = false;
      for (let i = 0; i < opts.length; i++) {
        const o = String(opts[i]).toUpperCase();
        if (o === 'EX') ttlMs = Number(opts[++i]) * 1000;
        else if (o === 'PX') ttlMs = Number(opts[++i]);
        else if (o === 'NX') nx = true;
      }
      if (nx && (await this.get(key)) !== null) return null;
      MEMORY_STORE.set(key, { value, ttl: ttlMs > 0 ? nowMs() + ttlMs : nowMs() + 365 * 24 * 3600 * 1000 });
      return 'OK';
    },
    async incr(key: string) {
      const cur = await this.get(key);
      const next = (cur === null ? 0 : Number(cur)) + 1;
      const entry = MEMORY_STORE.get(key);
      MEMORY_STORE.set(key, { value: String(next), ttl: entry ? entry.ttl : nowMs() + 365 * 24 * 3600 * 1000 });
      return next;
    },
    async expire(key: string, ttl: number) {
      const entry = MEMORY_STORE.get(key);
      if (entry) entry.ttl = nowMs() + ttl * 1000;
    },
    async pexpire(key: string, ttl: number) {
      const entry = MEMORY_STORE.get(key);
      if (entry) entry.ttl = nowMs() + ttl;
    },
    async del(...keys: string[]) {
      for (const key of keys) {
        MEMORY_STORE.delete(key);
        ZSETS.delete(key);
      }
    },
    async keys(pattern: string) {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
      const result: string[] = [];
      // Sorted sets (rate limit counters) live in a separate map and must be visible to KEYS as well.
      for (const key of new Set([...MEMORY_STORE.keys(), ...ZSETS.keys()])) {
        if (regex.test(key)) result.push(key);
      }
      return result;
    },
    async zadd(key: string, ...args: any[]) {
      let members: ZMember[] = ZSETS.get(key) || [];
      const newMembers: ZMember[] = [];
      if (args.length === 2 && typeof args[0] === 'number' && typeof args[1] === 'string') {
        newMembers.push({ score: args[0], value: args[1] });
      } else {
        for (let i = 0; i < args.length; i += 2) {
          newMembers.push({ score: Number(args[i]), value: String(args[i + 1]) });
        }
      }
      for (const m of newMembers) {
        const idx = members.findIndex((x) => x.value === m.value);
        if (idx >= 0) members[idx].score = m.score;
        else members.push(m);
      }
      ZSETS.set(key, members);
      return newMembers.length;
    },
    async zremrangebyscore(key: string, min: number | string, max: number | string) {
      let members: ZMember[] = ZSETS.get(key) || [];
      const minScore = typeof min === 'string' && min.startsWith('(') ? Number(min.slice(1)) + 0.0001 : Number(min);
      const maxScore = typeof max === 'string' && max.startsWith('(') ? Number(max.slice(1)) - 0.0001 : Number(max);
      const removed = members.filter((m) => m.score >= minScore && m.score <= maxScore).length;
      members = members.filter((m) => !(m.score >= minScore && m.score <= maxScore));
      ZSETS.set(key, members);
      return removed;
    },
    async zrem(key: string, ...values: string[]) {
      const members: ZMember[] = ZSETS.get(key) || [];
      const kept = members.filter((m) => !values.includes(m.value));
      ZSETS.set(key, kept);
      return members.length - kept.length;
    },
    async zcard(key: string) {
      return (ZSETS.get(key) || []).length;
    },
    async zrange(key: string, start: number, stop: number, ...args: any[]) {
      let members: ZMember[] = ZSETS.get(key) || [];
      members = [...members].sort((a, b) => a.score - b.score);
      const result: string[] = [];
      const end = stop < 0 ? members.length + stop : stop;
      for (let i = start; i <= end && i < members.length; i++) {
        if (args.includes('WITHSCORES')) {
          result.push(members[i].value);
          result.push(String(members[i].score));
        } else {
          result.push(members[i].value);
        }
      }
      return result;
    },
    on() {
      // no-op event listener
    },
    once() {
      // no-op event listener
    },
    pipeline() {
      const commands: Array<{ method: string; args: any[] }> = [];
      const add = (method: string) => (...args: any[]) => {
        commands.push({ method, args });
        return p;
      };
      const p = {
        zremrangebyscore: add('zremrangebyscore'),
        zadd: add('zadd'),
        zcard: add('zcard'),
        pexpire: add('pexpire'),
        exec: async () => {
          const self = createMemoryRedis();
          const results: any[] = [];
          for (const cmd of commands) {
            try {
              const fn = (self as any)[cmd.method];
              const res = await fn(...cmd.args);
              results.push([null, res]);
            } catch (e) {
              results.push([e, null]);
            }
          }
          return results;
        },
      };
      return p;
    },
  };
}

export function getRedisClient() {
  const url = process.env.REDIS_URL || 'redis://localhost:6380';
  if (url === 'memory:') {
    return createMemoryRedis() as any;
  }
  return new Redis(url);
}
