import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/**
 * "Last verified backup" card. scripts/backup.sh writes <dir>/last-backup.json and scripts/restore-verify.sh writes
 * <dir>/last-verify.json; the API only READS them (no shell execution, no database table, no migration). The directory
 * is BACKUP_STATUS_DIR, else BACKUP_DIR, else ./backups relative to the API working directory (mount the backup
 * directory read-only into the API container, see docs/backup-and-recovery.md).
 *
 * The files are untrusted input from the API's point of view: they are size-capped and every field is re-validated
 * and re-typed before it leaves this module. Absolute paths are never returned.
 */
export interface BackupRecord { at: string; ok: boolean; file: string | null; bytes: number | null; sha256: string | null; durationSeconds: number | null; error: string | null }
export interface VerifyRecord extends BackupRecord {
  migrations: { applied: number; expected: number } | null;
  rowCounts: Record<string, number>;
  checks: Array<{ name: string; ok: boolean }>;
}
export interface BackupStatus {
  configured: boolean;
  backup: BackupRecord | null;
  verify: VerifyRecord | null;
  /** ok = verified within maxAgeHours; stale = older; failed = last verification failed; unknown = never verified. */
  state: 'ok' | 'stale' | 'failed' | 'unknown';
  maxAgeHours: number;
}

export function statusDir(env: Record<string, string | undefined> = process.env): string {
  return resolve(env.BACKUP_STATUS_DIR || env.BACKUP_DIR || './backups');
}

const str = (v: unknown, max = 300) => (typeof v === 'string' ? v.slice(0, max) : null);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const iso = (v: unknown) => { const s = str(v, 40); return s && !Number.isNaN(Date.parse(s)) ? new Date(s).toISOString() : null; };

function record(v: any): BackupRecord | null {
  const at = iso(v?.at);
  if (!at) return null;
  return { at, ok: v.ok === true, file: str(v.file, 200), bytes: num(v.bytes), sha256: str(v.sha256, 64), durationSeconds: num(v.durationSeconds), error: str(v.error, 400) };
}

export function parseStatus(raw: unknown, now = Date.now(), maxAgeHours = 36): Omit<BackupStatus, 'configured'> {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const backup = record(o.backup);
  const vr = record(o.verify);
  let verify: VerifyRecord | null = null;
  if (vr) {
    const counts: Record<string, number> = {};
    if (o.verify.rowCounts && typeof o.verify.rowCounts === 'object') {
      for (const [k, n] of Object.entries(o.verify.rowCounts).slice(0, 30)) if (/^[a-z_]{1,40}$/.test(k) && typeof n === 'number') counts[k] = n;
    }
    const m = o.verify.migrations;
    verify = {
      ...vr,
      migrations: m && num(m.applied) != null && num(m.expected) != null ? { applied: m.applied, expected: m.expected } : null,
      rowCounts: counts,
      checks: Array.isArray(o.verify.checks) ? o.verify.checks.slice(0, 20).map((c: any) => ({ name: str(c?.name, 80) ?? '?', ok: c?.ok === true })) : [],
    };
  }
  let state: BackupStatus['state'] = 'unknown';
  if (verify) state = !verify.ok ? 'failed' : now - Date.parse(verify.at) > maxAgeHours * 3_600_000 ? 'stale' : 'ok';
  return { backup, verify, state, maxAgeHours };
}

async function readJson(path: string): Promise<unknown | null> {
  try {
    const st = await stat(path);
    if (!st.isFile() || st.size > 64 * 1024) return null;
    return JSON.parse(await readFile(path, 'utf8'));
  } catch { return null; }
}

export async function readBackupStatus(env: Record<string, string | undefined> = process.env, now = Date.now()): Promise<BackupStatus> {
  const dir = statusDir(env);
  const maxAgeHours = Number(env.BACKUP_VERIFY_MAX_AGE_HOURS) > 0 ? Number(env.BACKUP_VERIFY_MAX_AGE_HOURS) : 36;
  const [backup, verify] = await Promise.all([readJson(join(dir, 'last-backup.json')), readJson(join(dir, 'last-verify.json'))]);
  const parsed = parseStatus({ backup, verify }, now, maxAgeHours);
  return { configured: backup !== null || verify !== null, ...parsed };
}
