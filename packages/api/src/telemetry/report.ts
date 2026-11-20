import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import * as schema from '@veqsio/db';
import { db } from '../db';
import { isCloud } from '../cloud/mode';
import { getLicenseInfo } from '../license';
import { countActiveUsers } from '../license/seats';
import { getInstanceSettings } from '../settings/instance';
import { buildId, VERSION } from '../version';

/**
 * Anonymous usage statistics (docs/telemetry.md). About once a day an instance tells the Veqsio project that it exists: a random id, the version, the edition,
 * how it is deployed and a rough user range. Nothing else leaves the server: no names, no e-mail addresses, no host name, no data. It can be switched off in
 * Administration > Instance settings > Updates, or with VEQSIO_TELEMETRY=off (which also hides the setting's effect). Managed cloud workspaces, the public demo
 * and non-production runs never report.
 */
export const DEFAULT_URL = 'https://cloud.veqsio.com/api/telemetry/ping';
export type Ping = { v: 1; id: string; version: string; build: string; edition: 'community' | 'team' | 'enterprise'; deploy: 'docker' | 'kubernetes' | 'other'; users: string };

export const telemetryUrl = (env: NodeJS.ProcessEnv = process.env): string => {
  const u = (env.VEQSIO_TELEMETRY_URL || '').trim();
  return /^https:\/\//i.test(u) ? u : DEFAULT_URL; // only https: a mistyped or hostile value never turns into plain-text traffic
};

/** Why this process never reports, regardless of the setting; null when it may. */
export function neverReports(env: NodeJS.ProcessEnv = process.env): string | null {
  if (/^(off|0|false|no|disabled)$/i.test((env.VEQSIO_TELEMETRY || '').trim())) return 'VEQSIO_TELEMETRY is off';
  if (isCloud(env)) return 'managed cloud workspace';
  if (env.VEQSIO_DEMO === '1') return 'public demo';
  if (env.NODE_ENV !== 'production') return 'not a production run';
  return null;
}

export const usersBucket = (n: number): string => (n <= 10 ? '1-10' : n <= 50 ? '11-50' : n <= 200 ? '51-200' : n <= 1000 ? '201-1000' : '1000+');
export const deployKind = (env: NodeJS.ProcessEnv = process.env, dockerenv = existsSync('/.dockerenv')): Ping['deploy'] => (env.KUBERNETES_SERVICE_HOST ? 'kubernetes' : dockerenv ? 'docker' : 'other');

/** The random id of this installation, created on first use. It identifies nothing but the installation itself. */
export async function installId(): Promise<string> {
  const key = 'telemetry.id';
  const [row] = await db.select().from(schema.systemSettings).where(eq(schema.systemSettings.key, key)).limit(1);
  if (row && /^[0-9a-f-]{36}$/.test(row.value)) return row.value;
  const id = randomUUID();
  if (row) await db.update(schema.systemSettings).set({ value: id, updatedAt: new Date() }).where(eq(schema.systemSettings.key, key));
  else await db.insert(schema.systemSettings).values({ key: key, value: id });
  return id;
}

/** Exactly what would be sent. The same function feeds the preview in the admin API and the real report, so the preview cannot drift from reality. */
export async function composePing(): Promise<Ping> {
  const lic = getLicenseInfo();
  const edition = lic && (lic.plan === 'team' || lic.plan === 'enterprise') ? lic.plan : 'community';
  return { v: 1, id: await installId(), version: VERSION, build: buildId(), edition, deploy: deployKind(), users: usersBucket(await countActiveUsers()) };
}

export async function reportingEnabled(): Promise<{ enabled: boolean; reason: string | null }> {
  const why = neverReports();
  if (why) return { enabled: false, reason: why };
  const on = (await getInstanceSettings()).shareUsageStats === true;
  return { enabled: on, reason: on ? null : 'switched off in the instance settings' };
}

const SENT_KEY = 'telemetry.lastSent';
const DAY = 23 * 3_600_000;
const bootedAt = Date.now();

/**
 * Called every few hours by the scheduler. Sends at most once a day, and never within the first ten minutes after the first start, so an administrator who
 * dislikes the idea has time to switch it off before anything leaves the server.
 */
export async function runUsageReport(fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<'sent' | 'skipped' | 'failed'> {
  if (!(await reportingEnabled()).enabled) return 'skipped';
  const [last] = await db.select().from(schema.systemSettings).where(eq(schema.systemSettings.key, SENT_KEY)).limit(1);
  if (last && now - Number(last.value) < DAY) return 'skipped';
  if (!last && now - bootedAt < 10 * 60_000) return 'skipped';
  try {
    const r = await fetchImpl(telemetryUrl(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await composePing()), signal: AbortSignal.timeout(10_000), redirect: 'error' });
    if (!r.ok) return 'failed';
  } catch { return 'failed'; } // no internet, a firewall, our server down: all fine, tried again later, never an error for the user
  if (last) await db.update(schema.systemSettings).set({ value: String(now), updatedAt: new Date() }).where(eq(schema.systemSettings.key, SENT_KEY));
  else await db.insert(schema.systemSettings).values({ key: SENT_KEY, value: String(now) });
  return 'sent';
}
