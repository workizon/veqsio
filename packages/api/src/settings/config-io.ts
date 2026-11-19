/**
 * Configuration as code: export the instance configuration as one JSON document and apply it to another
 * instance (or back to this one). Covers instance settings, switched-off features, and per project the
 * feature flags, public flag, components and versions. Applying is idempotent (matching by name / key) and
 * never deletes anything.
 */
import { and, eq } from 'drizzle-orm';
import * as schema from '@veqsio/db';
import { db } from '../db';
import { FEATURES, disabledFeatures, invalidateFeatures, invalidateProjectFeatures, setFeatureEnabled } from '../features';
import { SETTINGS, getInstanceSettings, updateInstanceSettings } from './instance';

export const CONFIG_VERSION = 1;

export interface ConfigDoc {
  version: number;
  settings: Record<string, unknown>;
  disabledFeatures: string[];
  projects: Array<{
    key: string;
    isPublic?: boolean;
    disabledFeatures?: string[];
    components?: Array<{ name: string; description?: string | null }>;
    versions?: Array<{ name: string; description?: string | null; startDate?: string | null; releaseDate?: string | null; released?: boolean; archived?: boolean }>;
  }>;
}

export async function exportConfig(): Promise<ConfigDoc> {
  const settings = await getInstanceSettings();
  const projects = await db.select().from(schema.projects).orderBy(schema.projects.projectKey);
  const comps = await db.select().from(schema.components);
  const vers = await db.select().from(schema.versions);
  return {
    version: CONFIG_VERSION,
    settings: Object.fromEntries(SETTINGS.map((s) => [s.key, settings[s.key]])),
    disabledFeatures: [...(await disabledFeatures())].sort(),
    projects: projects.map((p) => ({
      key: p.projectKey,
      isPublic: p.isPublic,
      disabledFeatures: [...p.disabledFeatures].sort(),
      components: comps.filter((c) => c.projectId === p.id).map((c) => ({ name: c.name, description: c.description })),
      versions: vers.filter((v) => v.projectId === p.id).map((v) => ({ name: v.name, description: v.description, startDate: v.startDate, releaseDate: v.releaseDate, released: !!v.released, archived: !!v.archived })),
    })),
  };
}

export interface ImportReport { applied: boolean; changes: string[]; warnings: string[]; errors: string[] }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length <= max ? v : null);

/** Validates and (unless dryRun) applies a configuration document. Nothing is applied when there are errors. */
export async function importConfig(doc: unknown, dryRun: boolean): Promise<ImportReport> {
  const report: ImportReport = { applied: false, changes: [], warnings: [], errors: [] };
  if (!isObj(doc) || doc.version !== CONFIG_VERSION) { report.errors.push(`Expected a configuration document with version ${CONFIG_VERSION}`); return report; }
  const known = new Set(FEATURES.map((f) => f.id));
  const scoped = new Set(FEATURES.filter((f) => f.projectScoped).map((f) => f.id));

  const settings = isObj(doc.settings) ? doc.settings : {};
  const current = await getInstanceSettings();
  const settingsPatch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(settings)) {
    if (JSON.stringify(current[k]) !== JSON.stringify(v)) { settingsPatch[k] = v; report.changes.push(`setting ${k}`); }
  }
  // dry validation through the real validator (it throws nothing, it returns errors)
  const check = await validateSettings(settingsPatch);
  report.errors.push(...check);

  const off = Array.isArray(doc.disabledFeatures) ? doc.disabledFeatures : [];
  const wantOff = new Set<string>();
  for (const id of off) {
    if (typeof id !== 'string' || !known.has(id)) { report.errors.push(`Unknown feature: ${String(id)}`); continue; }
    wantOff.add(id);
  }
  const nowOff = await disabledFeatures();
  const featureChanges: Array<[string, boolean]> = [];
  for (const f of FEATURES) {
    if (wantOff.has(f.id) !== nowOff.has(f.id)) { featureChanges.push([f.id, !wantOff.has(f.id)]); report.changes.push(`feature ${f.id} ${wantOff.has(f.id) ? 'off' : 'on'}`); }
  }

  type Op = () => Promise<void>;
  const ops: Op[] = [];
  const projects = Array.isArray(doc.projects) ? doc.projects : [];
  for (const pr of projects) {
    if (!isObj(pr) || typeof pr.key !== 'string') { report.errors.push('Every project needs a key'); continue; }
    const [row] = await db.select().from(schema.projects).where(eq(schema.projects.projectKey, pr.key.toUpperCase())).limit(1);
    if (!row) { report.warnings.push(`Project ${pr.key} does not exist here; skipped (create it first)`); continue; }
    const patch: Partial<typeof schema.projects.$inferInsert> = {};
    if (typeof pr.isPublic === 'boolean' && pr.isPublic !== row.isPublic) {
      const [desk] = await db.select({ id: schema.serviceDesks.id }).from(schema.serviceDesks).where(eq(schema.serviceDesks.projectId, row.id)).limit(1);
      if (pr.isPublic && desk) report.warnings.push(`${row.projectKey}: service desk projects cannot be public`);
      else { patch.isPublic = pr.isPublic; report.changes.push(`${row.projectKey}: public ${pr.isPublic}`); }
    }
    if (Array.isArray(pr.disabledFeatures)) {
      const ids = pr.disabledFeatures.filter((x): x is string => typeof x === 'string');
      const bad = ids.filter((x) => !scoped.has(x));
      if (bad.length) report.errors.push(`${row.projectKey}: not a project feature: ${bad.join(', ')}`);
      else if (JSON.stringify([...ids].sort()) !== JSON.stringify([...row.disabledFeatures].sort())) { patch.disabledFeatures = ids; report.changes.push(`${row.projectKey}: features off = [${ids.join(', ')}]`); }
    }
    if (Object.keys(patch).length) ops.push(async () => { await db.update(schema.projects).set({ ...patch, updatedAt: new Date() }).where(eq(schema.projects.id, row.id)); });

    for (const c of Array.isArray(pr.components) ? pr.components : []) {
      const name = isObj(c) ? str(c.name, 255) : null;
      if (!name) { report.errors.push(`${row.projectKey}: component needs a name`); continue; }
      const [ex] = await db.select({ id: schema.components.id }).from(schema.components).where(and(eq(schema.components.projectId, row.id), eq(schema.components.name, name))).limit(1);
      if (!ex) { report.changes.push(`${row.projectKey}: component ${name}`); ops.push(async () => { await db.insert(schema.components).values({ projectId: row.id, name, description: str((c as any).description, 2000) }); }); }
    }
    for (const v of Array.isArray(pr.versions) ? pr.versions : []) {
      const name = isObj(v) ? str(v.name, 255) : null;
      if (!name) { report.errors.push(`${row.projectKey}: version needs a name`); continue; }
      const [ex] = await db.select({ id: schema.versions.id }).from(schema.versions).where(and(eq(schema.versions.projectId, row.id), eq(schema.versions.name, name))).limit(1);
      if (!ex) {
        const date = (x: unknown) => (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x) ? x : null);
        report.changes.push(`${row.projectKey}: version ${name}`);
        ops.push(async () => { await db.insert(schema.versions).values({ projectId: row.id, name, description: str((v as any).description, 2000), startDate: date((v as any).startDate), releaseDate: date((v as any).releaseDate), released: (v as any).released === true, archived: (v as any).archived === true }); });
      }
    }
  }

  if (report.errors.length || dryRun) return report;
  if (Object.keys(settingsPatch).length) await updateInstanceSettings(settingsPatch);
  for (const [id, enabled] of featureChanges) await setFeatureEnabled(id, enabled);
  for (const op of ops) await op();
  invalidateFeatures(); invalidateProjectFeatures();
  report.applied = true;
  return report;
}

async function validateSettings(patch: Record<string, unknown>): Promise<string[]> {
  const { validateSetting } = await import('./instance');
  const errors: string[] = [];
  for (const [k, v] of Object.entries(patch)) {
    const def = SETTINGS.find((s) => s.key === k);
    if (!def) { errors.push(`Unknown setting: ${k}`); continue; }
    const r = validateSetting(def, v);
    if (!r.ok) errors.push(r.error);
  }
  return errors;
}
