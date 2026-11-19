/** Plugin registry operations (install, enable, update, settings). No plugin code ever runs here. */
import { randomBytes } from 'crypto';
import { and, eq } from 'drizzle-orm';
import * as schema from '@veqsio/db';
import { db } from '../db';
import { encryptSecret, decryptSecret } from '../auth/secrets';
import { generatePluginToken, hashPluginToken, PLUGIN_USER_PREFIX } from './auth';
import { diffManifests, type PluginManifest, type ManifestDiff } from './manifest';

export type PluginRow = typeof schema.plugins.$inferSelect;

export class PluginError extends Error {
  constructor(public status: 400 | 404 | 409, message: string, public details?: unknown) {
    super(message);
  }
}

export function publicView(p: PluginRow) {
  const m = p.manifest as PluginManifest;
  return {
    id: p.id, key: p.key, name: p.name, version: p.version, description: m.description, vendor: m.vendor, baseUrl: m.baseUrl,
    enabled: p.enabled, requestedScopes: m.scopes, grantedScopes: p.grantedScopes as string[], events: m.events,
    uiPanels: m.uiPanels, config: m.config, hasToken: !!p.tokenHash, serviceUserId: p.serviceUserId,
    consecutiveFailures: p.consecutiveFailures, disabledReason: p.disabledReason, installedAt: p.installedAt, updatedAt: p.updatedAt,
  };
}

export async function getPlugin(id: number): Promise<PluginRow> {
  const [p] = await db.select().from(schema.plugins).where(eq(schema.plugins.id, id)).limit(1);
  if (!p) throw new PluginError(404, 'Plugin not found');
  return p;
}

const newSigningSecret = () => 'whsec_' + randomBytes(32).toString('hex');

export async function installPlugin(manifest: PluginManifest, installedBy: number) {
  const [dup] = await db.select({ id: schema.plugins.id }).from(schema.plugins).where(eq(schema.plugins.key, manifest.key)).limit(1);
  if (dup) throw new PluginError(409, 'A plugin with this key is already installed');

  // Service user: a non-login account the admin can put into groups/roles. Permissions are deny-by-default.
  const username = PLUGIN_USER_PREFIX + manifest.key;
  const [existing] = await db.select().from(schema.users).where(eq(schema.users.username, username)).limit(1);
  let userId: number;
  if (existing) {
    if (existing.active !== false || existing.passwordHash) throw new PluginError(409, 'A conflicting user already exists for this plugin key');
    userId = existing.id;
  } else {
    const [u] = await db.insert(schema.users).values({
      username, email: `${manifest.key}@plugins.invalid`, displayName: `Plugin: ${manifest.name}`.slice(0, 255), active: false, passwordHash: null,
    }).returning({ id: schema.users.id });
    userId = u.id;
  }

  const signingSecret = newSigningSecret();
  const [row] = await db.insert(schema.plugins).values({
    key: manifest.key, name: manifest.name, version: manifest.version, manifest, enabled: false, installedBy,
    grantedScopes: [], serviceUserId: userId, signingSecretEnc: encryptSecret(signingSecret),
  }).returning();
  return { plugin: row, signingSecret };
}

export async function uninstallPlugin(id: number) {
  const p = await getPlugin(id);
  await db.delete(schema.plugins).where(eq(schema.plugins.id, id)); // settings + deliveries cascade; token dies with the row
  if (p.serviceUserId) await db.update(schema.users).set({ active: false }).where(eq(schema.users.id, p.serviceUserId));
}

export async function enablePlugin(id: number, grantScopes: string[] | undefined) {
  const p = await getPlugin(id);
  const m = p.manifest as PluginManifest;
  if (m.scopes.length > 0) {
    if (!grantScopes) throw new PluginError(400, 'Scope approval required: pass grantScopes with the scopes you approve');
    const bad = grantScopes.filter((s) => !m.scopes.includes(s));
    if (bad.length) throw new PluginError(400, `Scopes not requested by the manifest: ${bad.join(', ')}`);
  } else if (grantScopes && grantScopes.length) {
    throw new PluginError(400, 'This plugin requests no scopes');
  }
  const missing = await missingRequiredSettings(p);
  if (missing.length) throw new PluginError(409, `Required settings missing: ${missing.join(', ')}`);

  let token: string | null = null;
  const set: Partial<typeof schema.plugins.$inferInsert> = {
    enabled: true, grantedScopes: [...new Set(grantScopes ?? [])], consecutiveFailures: 0, disabledReason: null, updatedAt: new Date(),
  };
  if (!p.tokenHash) { token = generatePluginToken(); set.tokenHash = hashPluginToken(token); }
  const [row] = await db.update(schema.plugins).set(set).where(eq(schema.plugins.id, id)).returning();
  return { plugin: row, token };
}

export async function disablePlugin(id: number) {
  await getPlugin(id);
  const [row] = await db.update(schema.plugins).set({ enabled: false, updatedAt: new Date(), disabledReason: 'Disabled by an administrator' }).where(eq(schema.plugins.id, id)).returning();
  return row;
}

export async function rotateToken(id: number) {
  await getPlugin(id);
  const token = generatePluginToken();
  await db.update(schema.plugins).set({ tokenHash: hashPluginToken(token), updatedAt: new Date() }).where(eq(schema.plugins.id, id));
  return token;
}

export async function rotateSigningSecret(id: number) {
  await getPlugin(id);
  const secret = newSigningSecret();
  await db.update(schema.plugins).set({ signingSecretEnc: encryptSecret(secret), updatedAt: new Date() }).where(eq(schema.plugins.id, id));
  return secret;
}

export function previewUpdate(p: PluginRow, next: PluginManifest): ManifestDiff {
  if (next.key !== p.key) throw new PluginError(400, 'The manifest key does not match the installed plugin');
  return diffManifests(p.manifest as PluginManifest, next);
}

/**
 * Apply an update. Scopes the admin did not explicitly approve are never granted; removed scopes are revoked.
 * If the base URL changes the plugin is disabled (events and panels would go to a new host) until re-enabled.
 */
export async function applyUpdate(p: PluginRow, next: PluginManifest, approve: string[]) {
  const diff = previewUpdate(p, next);
  const bad = approve.filter((s) => !diff.scopes.added.includes(s));
  if (bad.length) throw new PluginError(400, `Only newly requested scopes can be approved: ${bad.join(', ')}`);
  const granted = [...(p.grantedScopes as string[]).filter((s) => next.scopes.includes(s)), ...approve];
  const set: Partial<typeof schema.plugins.$inferInsert> = {
    name: next.name, version: next.version, manifest: next, grantedScopes: [...new Set(granted)], updatedAt: new Date(),
  };
  if (diff.baseUrlChanged && p.enabled) {
    set.enabled = false;
    set.disabledReason = 'Base URL changed in an update: review and enable again';
  }
  const [row] = await db.update(schema.plugins).set(set).where(eq(schema.plugins.id, p.id)).returning();
  return { plugin: row, diff };
}

/* ---------------------------- settings ---------------------------- */

export async function missingRequiredSettings(p: PluginRow): Promise<string[]> {
  const m = p.manifest as PluginManifest;
  const rows = await db.select({ key: schema.pluginSettings.key }).from(schema.pluginSettings).where(eq(schema.pluginSettings.pluginId, p.id));
  const have = new Set(rows.map((r) => r.key));
  return m.config.filter((f) => f.required && !have.has(f.key)).map((f) => f.key);
}

/** Admin view: secrets are never returned, only whether a value exists. */
export async function getSettingsView(p: PluginRow) {
  const m = p.manifest as PluginManifest;
  const rows = await db.select().from(schema.pluginSettings).where(eq(schema.pluginSettings.pluginId, p.id));
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return m.config.map((f) => {
    const r = byKey.get(f.key);
    const secret = f.type === 'secret';
    return {
      key: f.key, label: f.label, type: f.type, required: f.required, options: f.options ?? null,
      hasValue: !!r, value: r && !secret ? r.value : null,
    };
  });
}

function normalizeValue(f: PluginManifest['config'][number], v: string | number | boolean): string {
  switch (f.type) {
    case 'boolean':
      if (typeof v !== 'boolean') throw new PluginError(400, `${f.key}: must be a boolean`);
      return String(v);
    case 'number':
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new PluginError(400, `${f.key}: must be a number`);
      return String(v);
    case 'select':
      if (typeof v !== 'string' || !f.options?.includes(v)) throw new PluginError(400, `${f.key}: must be one of the options`);
      return v;
    default:
      if (typeof v !== 'string' || v.length > 4096) throw new PluginError(400, `${f.key}: must be a string of at most 4096 characters`);
      return v;
  }
}

/** `null` clears a value; omitted keys are untouched (so a secret is kept unless replaced). */
export async function putSettings(p: PluginRow, values: Record<string, string | number | boolean | null>) {
  const m = p.manifest as PluginManifest;
  const fields = new Map(m.config.map((f) => [f.key, f]));
  for (const k of Object.keys(values)) if (!fields.has(k)) throw new PluginError(400, `Unknown setting: ${k}`);
  for (const [k, v] of Object.entries(values)) {
    const f = fields.get(k)!;
    if (v === null || v === '') {
      await db.delete(schema.pluginSettings).where(and(eq(schema.pluginSettings.pluginId, p.id), eq(schema.pluginSettings.key, k)));
      continue;
    }
    const isSecret = f.type === 'secret';
    const text = normalizeValue(f, v);
    const stored = isSecret ? encryptSecret(text) : text;
    await db.insert(schema.pluginSettings).values({ pluginId: p.id, key: k, value: stored, isSecret })
      .onConflictDoUpdate({ target: [schema.pluginSettings.pluginId, schema.pluginSettings.key], set: { value: stored, isSecret } });
  }
}

/** For the plugin itself (authenticated with its token): decrypted values, typed. */
export async function getSettingsForPlugin(p: PluginRow): Promise<Record<string, string | number | boolean>> {
  const m = p.manifest as PluginManifest;
  const types = new Map(m.config.map((f) => [f.key, f.type]));
  const rows = await db.select().from(schema.pluginSettings).where(eq(schema.pluginSettings.pluginId, p.id));
  const out: Record<string, string | number | boolean> = {};
  for (const r of rows) {
    const t = types.get(r.key);
    if (!t) continue;
    const raw = r.isSecret ? decryptSecret(r.value) : r.value;
    out[r.key] = t === 'boolean' ? raw === 'true' : t === 'number' ? Number(raw) : raw;
  }
  return out;
}
