/**
 * Import of Jira Service Management configuration over REST: service desks, request types with their forms, request
 * type groups, queues, customer organizations and their customers. Issues themselves come from the normal Jira REST
 * import; run that first for the project (a desk needs its project).
 *
 * What JSM does NOT expose over REST, and therefore cannot be imported: SLA definitions (only per-request SLA values
 * are readable), automation rules, portal customisation and knowledge base links. These are reported as warnings.
 * Re-running is safe: desks, request types, queues and organizations are matched by name and updated, not duplicated.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../db';
import * as schema from '@veqsio/db';
import { JiraClient } from './client';
import { Resolver } from '../resolver';
import { normalizeUser } from './mapper';
import { isSafeFieldKey, validateFormDefinition, type FieldDef, type FieldType } from '../../servicedesk/form';
import { parseJQLSafe } from '../../jql';

export interface JsmOptions {
  /** Project keys of the desks to import (the project must already exist in Veqsio). Empty = every desk whose project exists. */
  projectKeys?: string[];
  userMapping?: Record<string, string>;
  createMissingUsers?: boolean;
}

export interface JsmReport {
  desks: Record<string, { created: boolean; requestTypes: number; groups: number; queues: number; organizations: number; customers: number }>;
  warnings: string[];
  errors: string[];
  usersCreated: number;
}

/* ---------------------------- pure mapping (tested) ---------------------------- */

interface JsmField {
  fieldId: string; name?: string; description?: string; required?: boolean; visible?: boolean
  validValues?: { value?: string; label?: string; children?: unknown[] }[]
  jiraSchema?: { type?: string; items?: string; system?: string; custom?: string }
}

/** Fields that exist on every JSM form but are not something a customer answers (or that Veqsio sets itself). */
const SKIP = new Set(['reporter', 'issuetype', 'project', 'attachment', 'request-participants', 'organizations', 'components', 'labels', 'assignee']);

const slugKey = (id: string) => {
  const k = id.replace(/[^A-Za-z0-9_]/g, '_').replace(/^[^a-z]+/, (m) => (m ? 'f' + m.replace(/[^A-Za-z0-9]/g, '') : ''));
  return (/^[a-z]/.test(k) ? k : `f${k}`).slice(0, 50);
};

/** One JSM request type field -> a Veqsio form field, or null when it should not be imported. */
export function mapField(f: JsmField): FieldDef | null {
  if (!f || typeof f.fieldId !== 'string' || SKIP.has(f.fieldId) || f.visible === false) return null;
  const label = (f.name || f.fieldId).slice(0, 200);
  const t = f.jiraSchema?.type ?? 'string';
  const items = f.jiraSchema?.items;
  const options = (f.validValues ?? []).map((v) => String(v.label ?? v.value ?? '').trim()).filter(Boolean);
  const uniq = [...new Set(options)].slice(0, 100);
  const base = { label, required: !!f.required, ...(f.description ? { helpText: String(f.description).slice(0, 500) } : {}) };
  const key = f.fieldId === 'summary' ? 'summary' : f.fieldId === 'description' ? 'description' : f.fieldId === 'priority' ? 'priority' : f.fieldId === 'duedate' ? 'duedate' : slugKey(f.fieldId);
  let type: FieldType = 'text';
  if (f.fieldId === 'description') type = 'textarea';
  else if (t === 'number') type = 'number';
  else if (t === 'date') type = 'date';
  else if (t === 'datetime') type = 'datetime';
  else if (t === 'user') type = 'user';
  else if ((t === 'option' || t === 'priority' || uniq.length > 0) && uniq.length > 0) type = t === 'array' || items === 'option' ? 'multiselect' : 'select';
  else if (t === 'array' && uniq.length > 0) type = 'multiselect';
  else if (/textarea|multiline/i.test(f.jiraSchema?.custom ?? '')) type = 'textarea';
  const def: FieldDef = { key, type, ...base, ...(type === 'select' || type === 'multiselect' ? { options: uniq } : {}) };
  if (f.fieldId === 'summary') def.mapping = { target: 'summary' };
  else if (f.fieldId === 'description') def.mapping = { target: 'description' };
  else if (f.fieldId === 'priority' && type === 'select') def.mapping = { target: 'priority' };
  else if (f.fieldId === 'duedate' && type === 'date') def.mapping = { target: 'dueDate' };
  return def;
}

/** Maps all fields of a request type and makes sure the result is a valid Veqsio form (drops what would break it, with warnings). */
export function mapForm(fields: JsmField[], typeName: string): { defs: FieldDef[]; warnings: string[] } {
  const warnings: string[] = [];
  const defs: FieldDef[] = [];
  const seen = new Set<string>();
  for (const f of fields ?? []) {
    const d = mapField(f);
    if (!d) continue;
    if (!isSafeFieldKey(d.key) || seen.has(d.key)) { warnings.push(`${typeName}: skipped the field "${d.label}" (its key is not usable)`); continue; }
    seen.add(d.key);
    defs.push(d);
  }
  let problems = validateFormDefinition(defs);
  if (problems.length) {
    // retry without mappings, then drop fields that are still invalid
    for (const d of defs) delete d.mapping;
    problems = validateFormDefinition(defs);
    if (problems.length) {
      const bad = new Set(defs.filter((d) => (d.type === 'select' || d.type === 'multiselect') && !(d.options ?? []).length).map((d) => d.key));
      const kept = defs.filter((d) => !bad.has(d.key));
      for (const d of defs) if (bad.has(d.key)) warnings.push(`${typeName}: skipped the choice field "${d.label}" (it has no options)`);
      defs.length = 0; defs.push(...kept);
    }
  }
  const final = validateFormDefinition(defs);
  if (final.length) { warnings.push(`${typeName}: the form could not be validated (${final[0]}); it was imported empty`); return { defs: [], warnings }; }
  return { defs, warnings };
}

/** A URL-safe, unique-able slug from a name. */
export const slugOf = (s: string) => (s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'desk').slice(0, 90).replace(/^([^a-z0-9])/, 'd$1').padEnd(2, 'x');

/* ------------------------------ the import itself ------------------------------ */

async function paged(client: JiraClient, path: string): Promise<any[]> {
  const out: any[] = [];
  for (let start = 0, guard = 0; guard < 200; guard++) {
    const page = await client.get(path, { start, limit: 50 });
    const values = Array.isArray(page?.values) ? page.values : [];
    out.push(...values);
    if (page?.isLastPage !== false || values.length === 0) break;
    start += values.length;
  }
  return out;
}

/** GET that treats "not found / not allowed" as an empty result so one missing feature does not stop the whole import. */
async function optional<T>(fn: () => Promise<T>, fallback: T, onFail: (m: string) => void, what: string): Promise<T> {
  try { return await fn(); } catch (e) { onFail(`${what}: ${(e instanceof Error ? e.message : 'failed').slice(0, 160)}`); return fallback; }
}

export async function importServiceDesks(client: JiraClient, options: JsmOptions = {}, progress?: (msg: string) => void): Promise<JsmReport> {
  const report: JsmReport = { desks: {}, warnings: [], errors: [], usersCreated: 0 };
  const resolver = new Resolver(db, { userMapping: options.userMapping, createMissingUsers: options.createMissingUsers });
  const wanted = options.projectKeys?.length ? new Set(options.projectKeys.map((k) => k.toUpperCase())) : null;

  let desks: any[];
  try { desks = await paged(client, '/rest/servicedeskapi/servicedesk'); } catch (e) {
    report.errors.push(`Could not list service desks (is Jira Service Management installed and are you an agent?): ${(e instanceof Error ? e.message : 'failed').slice(0, 160)}`);
    return report;
  }
  const warn = (m: string) => { if (report.warnings.length < 200) report.warnings.push(m); };

  for (const d of desks) {
    const key = String(d.projectKey ?? '').toUpperCase();
    if (!key || (wanted && !wanted.has(key))) continue;
    const [project] = await db.select().from(schema.projects).where(eq(schema.projects.projectKey, key)).limit(1);
    if (!project) { warn(`${key}: the project is not in Veqsio yet. Import it with the Jira import first, then run this again.`); continue; }
    progress?.(`Service desk ${key}`);
    const entry = { created: false, requestTypes: 0, groups: 0, queues: 0, organizations: 0, customers: 0 };
    report.desks[key] = entry;
    try {
      // ---- desk
      let [desk] = await db.select().from(schema.serviceDesks).where(eq(schema.serviceDesks.projectId, project.id)).limit(1);
      if (!desk) {
        let slug = slugOf(String(d.projectName || key));
        for (let i = 2; (await db.select({ id: schema.serviceDesks.id }).from(schema.serviceDesks).where(eq(schema.serviceDesks.slug, slug)).limit(1)).length; i++) slug = `${slugOf(String(d.projectName || key)).slice(0, 80)}-${i}`;
        [desk] = await db.insert(schema.serviceDesks).values({ projectId: project.id, name: String(d.projectName || key).slice(0, 255), slug }).returning();
        entry.created = true;
      }

      // ---- request type groups (id -> name)
      const groups = await optional(() => paged(client, `/rest/servicedeskapi/servicedesk/${d.id}/requesttypegroup`), [] as any[], warn, `${key} request type groups`);
      const groupName = new Map(groups.map((g) => [String(g.id), String(g.name ?? '')]));
      entry.groups = groups.length;

      // ---- request types
      const types = await optional(() => paged(client, `/rest/servicedeskapi/servicedesk/${d.id}/requesttype`), [] as any[], warn, `${key} request types`);
      let order = 0;
      for (const rt of types) {
        const name = String(rt.name ?? '').trim().slice(0, 255);
        if (!name) continue;
        const detail = await optional(() => client.get(`/rest/servicedeskapi/servicedesk/${d.id}/requesttype/${rt.id}/field`), { requestTypeFields: [] as any[] }, warn, `${key} / ${name}: form`);
        const { defs, warnings } = mapForm(detail.requestTypeFields ?? [], name);
        warnings.forEach(warn);
        const issueTypeName = await optional(async () => String((await client.get(`/rest/api/2/issuetype/${rt.issueTypeId}`)).name ?? 'Service Request'), 'Service Request', () => {}, 'issue type');
        const issueTypeId = await resolver.issueType(issueTypeName, false);
        const gName = (Array.isArray(rt.groupIds) ? rt.groupIds : []).map((g: unknown) => groupName.get(String(g))).find(Boolean) ?? null;
        const values = {
          serviceDeskId: desk.id, name, description: rt.description ? String(rt.description).slice(0, 2000) : null,
          helpText: rt.helpText ? String(rt.helpText).slice(0, 2000) : null, groupName: gName ? gName.slice(0, 100) : null,
          issueTypeId, fields: defs as unknown as object, sortOrder: order++, enabled: true,
        };
        const [existing] = await db.select({ id: schema.requestTypes.id }).from(schema.requestTypes)
          .where(and(eq(schema.requestTypes.serviceDeskId, desk.id), eq(sql`lower(${schema.requestTypes.name})`, name.toLowerCase()))).limit(1);
        if (existing) await db.update(schema.requestTypes).set(values).where(eq(schema.requestTypes.id, existing.id));
        else await db.insert(schema.requestTypes).values(values);
        entry.requestTypes++;
      }

      // ---- queues (JSM queue JQL -> a Veqsio queue; invalid JQL is reported, not imported)
      const queues = await optional(() => paged(client, `/rest/servicedeskapi/servicedesk/${d.id}/queue`), [] as any[], warn, `${key} queues`);
      let qo = 0;
      for (const q of queues) {
        const name = String(q.name ?? '').trim().slice(0, 255);
        if (!name) continue;
        const jql = typeof q.jql === 'string' ? q.jql.trim() : '';
        if (jql) {
          const parsed = parseJQLSafe(jql, undefined as never);
          if (!parsed.success) { warn(`${key} queue "${name}": its JQL could not be translated, imported without a filter (${parsed.error.slice(0, 100)})`); }
        }
        const usable = jql && parseJQLSafe(jql, undefined as never).success ? jql : null;
        const [existing] = await db.select({ id: schema.serviceQueues.id }).from(schema.serviceQueues)
          .where(and(eq(schema.serviceQueues.serviceDeskId, desk.id), eq(sql`lower(${schema.serviceQueues.name})`, name.toLowerCase()))).limit(1);
        if (existing) await db.update(schema.serviceQueues).set({ jql: usable, sortOrder: qo++ }).where(eq(schema.serviceQueues.id, existing.id));
        else await db.insert(schema.serviceQueues).values({ serviceDeskId: desk.id, name, jql: usable, sortOrder: qo++ });
        entry.queues++;
      }

      // ---- organizations and their customers
      const orgs = await optional(() => paged(client, `/rest/servicedeskapi/servicedesk/${d.id}/organization`), [] as any[], warn, `${key} organizations`);
      for (const o of orgs) {
        const name = String(o.name ?? '').trim().slice(0, 255);
        if (!name) continue;
        let [org] = await db.select().from(schema.customerOrganizations)
          .where(and(eq(schema.customerOrganizations.serviceDeskId, desk.id), eq(sql`lower(${schema.customerOrganizations.name})`, name.toLowerCase()))).limit(1);
        if (!org) [org] = await db.insert(schema.customerOrganizations).values({ serviceDeskId: desk.id, name }).returning();
        entry.organizations++;
        const members = await optional(() => paged(client, `/rest/servicedeskapi/organization/${o.id}/user`), [] as any[], warn, `${key} organization ${name}: users`);
        for (const m of members) {
          const nu = normalizeUser({ name: m.name, key: m.key, accountId: m.accountId, emailAddress: m.emailAddress, displayName: m.displayName });
          if (!nu) continue;
          const userId = await resolver.user(nu);
          if (!userId) continue;
          await db.insert(schema.serviceDeskCustomers).values({ serviceDeskId: desk.id, userId, organizationId: org.id })
            .onConflictDoUpdate({ target: [schema.serviceDeskCustomers.serviceDeskId, schema.serviceDeskCustomers.userId], set: { organizationId: org.id } });
          entry.customers++;
        }
      }
    } catch (e) {
      report.errors.push(`${key}: ${(e instanceof Error ? e.message : 'failed').slice(0, 200)}`);
    }
  }
  report.usersCreated = resolver.usersCreated;
  if (Object.keys(report.desks).length) warn('SLA definitions, automation rules, portal branding and knowledge base links are not available over the Jira REST API and were not imported. Recreate SLAs in Veqsio (Service desk → SLAs).');
  return report;
}
