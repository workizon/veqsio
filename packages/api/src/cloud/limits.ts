/**
 * Plan limits for a managed tenant. The control plane sets them as environment variables when it creates the
 * tenant's containers (it knows the plan); a missing variable means "no limit" so self-hosted installs are unaffected.
 *   VEQSIO_LIMIT_USERS            active human users (also capped by the licence seat count; the lower wins)
 *   VEQSIO_LIMIT_STORAGE_MB       total attachment storage
 *   VEQSIO_LIMIT_ATTACHMENT_MB    largest single attachment (cloud default 25)
 *   VEQSIO_LIMIT_EMAILS_PER_HOUR  outgoing e-mails per hour (cloud default 200)
 *   RATE_LIMIT_USER_MAX           API requests per minute and user (existing variable; the control plane sets it per plan)
 * Modules and paid features by plan come from the tenant's licence key (see license/features.ts), not from here.
 */
import { sql } from 'drizzle-orm';
import * as schema from '@veqsio/db';
import { db } from '../db';
import { isCloud } from './mode';

const posInt = (v: string | undefined): number | null => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
};

export interface PlanLimits { users: number | null; storageBytes: number | null; attachmentMaxBytes: number | null; emailsPerHour: number | null; apiRequestsPerMinute: number | null }

export function planLimits(env: NodeJS.ProcessEnv = process.env): PlanLimits {
  const cloud = isCloud(env);
  const storageMb = posInt(env.VEQSIO_LIMIT_STORAGE_MB);
  const attMb = posInt(env.VEQSIO_LIMIT_ATTACHMENT_MB) ?? (cloud ? 25 : null);
  return {
    users: posInt(env.VEQSIO_LIMIT_USERS),
    storageBytes: storageMb === null ? null : storageMb * 1024 * 1024,
    attachmentMaxBytes: attMb === null ? null : attMb * 1024 * 1024,
    emailsPerHour: posInt(env.VEQSIO_LIMIT_EMAILS_PER_HOUR) ?? (cloud ? 200 : null),
    apiRequestsPerMinute: posInt(env.RATE_LIMIT_USER_MAX),
  };
}

/** Executables and scripts are refused as attachments on cloud tenants on top of the administrator's own list. */
export const CLOUD_BLOCKED_EXTENSIONS = ['exe', 'bat', 'cmd', 'com', 'scr', 'msi', 'dll', 'vbs', 'ps1', 'jar', 'apk', 'sh', 'app', 'dmg', 'iso', 'lnk', 'hta'];

export function blockedByPlatform(filename: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!isCloud(env)) return null;
  const ext = filename.includes('.') ? filename.split('.').pop()!.toLowerCase() : '';
  return ext && CLOUD_BLOCKED_EXTENSIONS.includes(ext) ? `Files of type .${ext} are not allowed on Veqsio Cloud` : null;
}

// ---------- storage ----------
let storageCache: { at: number; bytes: number; files: number } | null = null;
export function invalidateStorageUsage() { storageCache = null; }

export async function storageUsage(): Promise<{ bytes: number; files: number }> {
  if (storageCache && Date.now() - storageCache.at < 30_000) return storageCache;
  const [r] = await db.select({ bytes: sql<string>`coalesce(sum(${schema.attachments.filesize}), 0)::bigint`, files: sql<number>`count(*)::int` }).from(schema.attachments);
  storageCache = { at: Date.now(), bytes: Number(r?.bytes ?? 0), files: r?.files ?? 0 };
  return storageCache;
}

/** Pure decision for tests. */
export function exceedsStorage(limitBytes: number | null, usedBytes: number, adding: number): boolean {
  return limitBytes !== null && usedBytes + adding > limitBytes;
}

export async function storageRefusal(size: number, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const { attachmentMaxBytes, storageBytes } = planLimits(env);
  if (attachmentMaxBytes !== null && size > attachmentMaxBytes) return `File too large for your plan (max ${Math.floor(attachmentMaxBytes / 1048576)} MB)`;
  if (storageBytes === null) return null;
  const used = await storageUsage();
  return exceedsStorage(storageBytes, used.bytes, size)
    ? `Storage limit of your plan reached (${Math.floor(storageBytes / 1048576)} MB). Delete files or upgrade your plan.`
    : null;
}

// ---------- outgoing e-mail ----------
/** How many of `batch` queued e-mails may be sent now given the hourly cap and what was already sent. */
export function emailBudget(limitPerHour: number | null, sentLastHour: number, batch: number): number {
  if (limitPerHour === null) return batch;
  return Math.max(0, Math.min(batch, limitPerHour - sentLastHour));
}

export async function emailsSentLastHour(): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.emailQueue).where(sql`${schema.emailQueue.status} = 'sent' and ${schema.emailQueue.sentAt} > now() - interval '1 hour'`);
  return r?.n ?? 0;
}
