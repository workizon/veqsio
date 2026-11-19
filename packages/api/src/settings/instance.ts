/**
 * Instance-wide settings an administrator can change at runtime (stored in `system_settings` as `instance.<key>`).
 * The catalogue below is the single source of truth: it drives validation, defaults and the admin form.
 */
import { eq, like, sql } from 'drizzle-orm';
import * as schema from '@veqsio/db';
import { db } from '../db';
import { isCloud } from '../cloud/mode';
import { blockedByPlatform, storageRefusal } from '../cloud/limits';

export type SettingType = 'int' | 'bool' | 'text' | 'list' | 'enum';
export interface SettingDef {
  key: string;
  group: 'Security' | 'Public access' | 'Attachments' | 'Maintenance' | 'Announcement' | 'Terminology' | 'Workflow' | 'Updates';
  label: string;
  description: string;
  type: SettingType;
  default: number | boolean | string | string[];
  min?: number;
  max?: number;
  maxLength?: number;
  options?: string[];
  /** Default on managed cloud tenants (VEQSIO_CLOUD=1), when it differs from `default`. */
  cloudDefault?: number | boolean | string | string[];
}

export const SETTINGS: readonly SettingDef[] = [
  { key: 'passwordMinLength', group: 'Security', label: 'Minimum password length', description: 'Applies to new users and password resets. Existing passwords keep working until changed.', type: 'int', default: 8, min: 6, max: 128 },
  { key: 'passwordRequireMixed', group: 'Security', label: 'Require letters and digits', description: 'New passwords must contain at least one letter and one digit.', type: 'bool', default: false },
  { key: 'sessionIdleMinutes', group: 'Security', label: 'Sign out after inactivity (minutes)', description: 'A session that is not used for this long ends. Default 43200 (30 days). Applies to new and refreshed sessions.', type: 'int', default: 43200, min: 5, max: 129600 },
  { key: 'sessionMaxHours', group: 'Security', label: 'Maximum session length (hours)', description: 'Force a new sign-in after this many hours even if the session is in use. 0 means no limit.', type: 'int', default: 0, min: 0, max: 8760 },
  { key: 'loginMaxFailures', group: 'Security', label: 'Failed sign-ins before a temporary lock', description: 'Per user name and address. The lock lasts for the window below. The environment variable LOGIN_MAX_FAILURES is the default when this is left at 10.', type: 'int', default: 10, min: 3, max: 100 },
  { key: 'loginLockMinutes', group: 'Security', label: 'Lock window (minutes)', description: 'Failed attempts are counted over this period and the lock lasts until the oldest one leaves it.', type: 'int', default: 15, min: 1, max: 1440 },
  { key: 'auditRetentionDays', group: 'Security', label: 'Keep the audit log for (days)', description: 'Audit entries older than this are deleted once a day (a single entry records each cleanup). 0 keeps everything. Needs an Enterprise licence; without one nothing is deleted.', type: 'int', default: 0, min: 0, max: 3650 },
  { key: 'publicProjectsEnabled', group: 'Public access', label: 'Allow public projects', description: 'Lets project administrators make a project readable by anyone without signing in (read-only, no internal comments, no service desk projects). Off by default.', type: 'bool', default: false },
  { key: 'publicIndexing', group: 'Public access', label: 'Search engines and AI crawlers', description: 'all: index everything and serve llms.txt. search: search engines only, AI training crawlers are blocked in robots.txt. none: noindex, nothing is advertised.', type: 'enum', default: 'search', options: ['all', 'search', 'none'] },
  { key: 'attachmentMaxMb', group: 'Attachments', label: 'Maximum attachment size (MB)', description: 'Per file, for issues and service desk requests.', type: 'int', default: 100, min: 1, max: 1024 },
  { key: 'attachmentProjectQuotaMb', group: 'Attachments', label: 'Attachment storage per project (MB)', description: 'The most attachment data one project may hold; an upload that would go over is refused. 0 means no limit. A project can have its own limit under Administration → Storage.', type: 'int', default: 0, min: 0, max: 100000000 },
  { key: 'attachmentBlockedExtensions', group: 'Attachments', label: 'Blocked file extensions', description: 'Uploads of these types are refused (without the dot, e.g. exe, bat, js).', type: 'list', default: [] },
  { key: 'issueTerm', group: 'Terminology', label: 'What issues are called', description: 'The word shown in the interface for an issue: issue, work item, ticket or task. Only labels change; API field names, JQL, URLs and issue keys stay the same.', type: 'enum', default: 'issue', options: ['issue', 'work item', 'ticket', 'task'] },
  { key: 'workflowGovernance', group: 'Workflow', label: 'Workflow governance', description: 'any: project administrators may assign a workflow scheme to their project. constrained: only system administrators can change the workflow scheme of a project.', type: 'enum', default: 'any', options: ['any', 'constrained'] },
  { key: 'autoUpdateMode', group: 'Updates', label: 'Automatic updates', description: 'off: never update by itself. security: install only releases marked as security fixes. all: install every release. On Veqsio Cloud the platform installs updates for you inside the window below; self-hosted installs need the optional updater (see docs/cloud-architecture.md). Backups are always taken first.', type: 'enum', default: 'off', options: ['off', 'security', 'all'], cloudDefault: 'all' },
  { key: 'autoUpdateWindowDay', group: 'Updates', label: 'Maintenance window: day (UTC)', description: 'Updates start only on this day. "any" allows every day.', type: 'enum', default: 'any', options: ['any', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] },
  { key: 'autoUpdateWindowHour', group: 'Updates', label: 'Maintenance window: hour (UTC, 0-23)', description: 'Updates start in this hour. The service is unavailable for a short time while it restarts.', type: 'int', default: 3, min: 0, max: 23 },
  { key: 'autoUpdateNotifyAdmins', group: 'Updates', label: 'Notify administrators before updating', description: 'Send an e-mail to the administrators before an automatic update starts.', type: 'bool', default: true },
  { key: 'maintenanceEnabled', group: 'Maintenance', label: 'Maintenance mode', description: 'While on, everybody except system administrators gets a "back soon" answer instead of the application. Administrators can still sign in and work, and the health check keeps answering. Turn it on before an upgrade or a restore.', type: 'bool', default: false },
  { key: 'maintenanceMessage', group: 'Maintenance', label: 'Maintenance message', description: 'Shown to people while maintenance mode is on. Plain text, up to 500 characters.', type: 'text', default: 'Veqsio is being maintained and will be back shortly.', maxLength: 500 },
  { key: 'announcementEnabled', group: 'Announcement', label: 'Show announcement banner', description: 'A banner at the top of every page, also on the sign-in page.', type: 'bool', default: false },
  { key: 'announcementLevel', group: 'Announcement', label: 'Banner style', description: 'Information, warning or critical.', type: 'enum', default: 'info', options: ['info', 'warning', 'critical'] },
  { key: 'announcementMessage', group: 'Announcement', label: 'Banner text', description: 'Plain text, up to 500 characters.', type: 'text', default: '', maxLength: 500 },
];

type Values = Record<string, number | boolean | string | string[]>;
const PREFIX = 'instance.';
let cache: { at: number; values: Values } | null = null;
const TTL_MS = 5_000;

export function invalidateInstanceSettings() { cache = null; }

/** Coerces and validates one value; returns an error message instead of throwing. */
export function validateSetting(def: SettingDef, raw: unknown): { ok: true; value: Values[string] } | { ok: false; error: string } {
  switch (def.type) {
    case 'int':
      if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < (def.min ?? 0) || raw > (def.max ?? 1e9)) return { ok: false, error: `${def.label} must be a whole number from ${def.min} to ${def.max}` };
      return { ok: true, value: raw };
    case 'bool':
      return typeof raw === 'boolean' ? { ok: true, value: raw } : { ok: false, error: `${def.label} must be true or false` };
    case 'text':
      return typeof raw === 'string' && raw.length <= (def.maxLength ?? 1000) ? { ok: true, value: raw.trim() } : { ok: false, error: `${def.label} must be text of at most ${def.maxLength} characters` };
    case 'enum':
      return typeof raw === 'string' && def.options!.includes(raw) ? { ok: true, value: raw } : { ok: false, error: `${def.label} must be one of: ${def.options!.join(', ')}` };
    case 'list': {
      if (!Array.isArray(raw) || raw.length > 100 || raw.some((x) => typeof x !== 'string')) return { ok: false, error: `${def.label} must be a list of up to 100 entries` };
      const items = [...new Set((raw as string[]).map((x) => x.trim().toLowerCase().replace(/^\./, '')).filter(Boolean))];
      if (items.some((x) => !/^[a-z0-9_+-]{1,20}$/.test(x))) return { ok: false, error: `${def.label} entries may only contain letters, digits, _ + -` };
      return { ok: true, value: items };
    }
  }
}

export async function getInstanceSettings(): Promise<Values> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.values;
  const rows = await db.select().from(schema.systemSettings).where(like(schema.systemSettings.key, `${PREFIX}%`));
  const stored = new Map(rows.map((r) => [r.key.slice(PREFIX.length), r.value]));
  const values: Values = {};
  for (const def of SETTINGS) {
    let v: unknown = isCloud() && def.cloudDefault !== undefined ? def.cloudDefault : def.default;
    if (stored.has(def.key)) {
      try {
        const checked = validateSetting(def, JSON.parse(stored.get(def.key) ?? 'null'));
        if (checked.ok) v = checked.value;
      } catch { /* corrupted value: the default applies */ }
    }
    values[def.key] = v as Values[string];
  }
  cache = { at: Date.now(), values };
  return values;
}

export async function updateInstanceSettings(patch: Record<string, unknown>): Promise<{ ok: true } | { ok: false; errors: string[] }> {
  const errors: string[] = [];
  const next: Array<[string, Values[string]]> = [];
  for (const [key, raw] of Object.entries(patch)) {
    const def = SETTINGS.find((s) => s.key === key);
    if (!def) { errors.push(`Unknown setting: ${key}`); continue; }
    const r = validateSetting(def, raw);
    if (r.ok) next.push([key, r.value]); else errors.push(r.error);
  }
  if (errors.length) return { ok: false, errors };
  for (const [key, value] of next) {
    const k = PREFIX + key, v = JSON.stringify(value);
    const [existing] = await db.select({ id: schema.systemSettings.id }).from(schema.systemSettings).where(eq(schema.systemSettings.key, k)).limit(1);
    if (existing) await db.update(schema.systemSettings).set({ value: v, updatedAt: new Date() }).where(eq(schema.systemSettings.key, k));
    else await db.insert(schema.systemSettings).values({ key: k, value: v });
  }
  invalidateInstanceSettings();
  return { ok: true };
}

export async function sessionPolicy(): Promise<{ idleSeconds: number; maxMs: number }> {
  const s = await getInstanceSettings();
  return { idleSeconds: (s.sessionIdleMinutes as number) * 60, maxMs: (s.sessionMaxHours as number) * 3_600_000 };
}

/** Null when the password satisfies the configured policy, otherwise the reason. */
export async function checkPasswordPolicy(password: string): Promise<string | null> {
  const s = await getInstanceSettings();
  const min = s.passwordMinLength as number;
  if (password.length < min) return `Password must be at least ${min} characters`;
  if (s.passwordRequireMixed && !(/[A-Za-z]/.test(password) && /\d/.test(password))) return 'Password must contain at least one letter and one digit';
  return null;
}

/** Null when the upload is acceptable, otherwise the reason (size in bytes, file name). */
export async function checkAttachmentPolicy(size: number, filename: string, projectId?: number): Promise<string | null> {
  const s = await getInstanceSettings();
  const maxMb = s.attachmentMaxMb as number;
  if (size > maxMb * 1024 * 1024) return `File too large (max ${maxMb} MB)`;
  const ext = filename.includes('.') ? filename.split('.').pop()!.toLowerCase() : '';
  if (ext && (s.attachmentBlockedExtensions as string[]).includes(ext)) return `Files of type .${ext} are not allowed`;
  if (projectId !== undefined) {
    const quota = await projectQuotaRefusal(projectId, size, s.attachmentProjectQuotaMb as number)
    if (quota) return quota
  }
  // managed tenants: platform-wide blocked types, per-file cap and total storage of the plan
  return blockedByPlatform(filename) ?? (await storageRefusal(size));
}


/** The attachment quota of one project in MB: its own limit (Administration → Storage) or the instance-wide one; 0 means none. */
export async function projectQuotaMb(projectId: number, instanceDefaultMb: number): Promise<number> {
  const [p] = await db.select({ key: schema.projects.projectKey }).from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1)
  if (!p) return instanceDefaultMb
  const [row] = await db.select({ v: schema.systemSettings.value }).from(schema.systemSettings).where(eq(schema.systemSettings.key, `storage.quota.${p.key}`)).limit(1)
  const own = row?.v == null || row.v === '' ? null : Number(row.v)
  return own !== null && Number.isFinite(own) && own >= 0 ? own : instanceDefaultMb
}

/** A refusal when adding `size` bytes would take the project over its quota, else null. */
export async function projectQuotaRefusal(projectId: number, size: number, instanceDefaultMb: number): Promise<string | null> {
  const quotaMb = await projectQuotaMb(projectId, instanceDefaultMb)
  if (quotaMb <= 0) return null
  const [{ used }] = await db.select({ used: sql<string>`coalesce(sum(${schema.attachments.filesize}), 0)` }).from(schema.attachments)
    .innerJoin(schema.issues, eq(schema.issues.id, schema.attachments.issueId)).where(eq(schema.issues.projectId, projectId))
  const usedBytes = Number(used)
  if (usedBytes + size > quotaMb * 1024 * 1024) return `This project has reached its attachment storage limit (${Math.round(usedBytes / 1048576)} of ${quotaMb} MB used)`
  return null
}
