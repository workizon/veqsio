import { applyFieldRules, defaultFor, loadFieldRuleFacts } from '../issues/field-rules';
import { Hono } from 'hono';
import { sessionMiddleware, requireAuth } from '../auth/middleware';
import { invalidateIssueKeyCache, createIssue, getIssue, updateIssue, buildIssueResponses, validateStoryPoints } from '../issues/service';
import { invalidateAgileReports } from '../agile/cache';
import { getIssueHistory } from '../issues/history';
import { linkIssues, unlinkIssues, linkProjects, LinkError } from '../issues/links';
import { cacheMiddleware, invalidateIssueCache } from '../middleware/cache';
import { requirePermission, checkProjectPermission, requireIssueAccess } from '../middleware/permissions';
import { getBrowsableProjectIds } from '../services/browse';
import { issueVisibleSql, canSeeIssue, visibleIssueIds, redactIssueResponse, redactIssueResponses, schemeOfProject, defaultLevelForProject } from '../security/issue-security';
import type { AppContext } from '../auth/middleware';
import type { CreateIssueRequest, UpdateIssueRequest } from '../issues/types';
import { db } from '../db';
import * as schema from '@veqsio/db';
import { eq, and, count, isNull, inArray, desc, sql } from 'drizzle-orm';
import { sendEmail, queueEmails } from '../services/email';
import { notifyIssueCreated, notifyIssueUpdated, notifyIssueAssigned } from '../services/notifications';
import { generateIssueKey } from '../issues/key-generator';
import { planMove, applyMove, MoveError } from '../history/move-issue';
import { recordAudit } from '../audit/log';
import { notifyRequestStatusChange } from '../servicedesk/outbound-mail';
import { customerSideUserIds } from '../servicedesk/access';
import { publishIssue } from '../realtime/publish';
import { projectPriorities } from '../priority/schemes';

const app = new Hono<AppContext>();

function extractId(value: any): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number(value);
  if (typeof value === 'object' && value.id !== undefined) return Number(value.id);
  return undefined;
}

function extractStringIds(arr: any[] | undefined): number[] | undefined {
  if (!arr) return undefined;
  return arr.map(extractId).filter((v): v is number => v !== undefined);
}

function extractStrings(arr: any[] | undefined): string[] | undefined {
  if (!arr) return undefined;
  return arr.filter((v): v is string => typeof v === 'string');
}

/** null clears; anything else must be a valid story point number (throws otherwise). */
function parseStoryPoints(v: unknown): number | null {
  if (v === null) return null;
  return validateStoryPoints(v);
}

/** undefined = not given, null = explicitly none, number = level id. */
function extractSecurity(v: unknown): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const id = extractId(v);
  if (id === undefined || !Number.isInteger(id)) throw new Error('Invalid security level');
  return id;
}

function normalizeCreateBody(body: any): CreateIssueRequest {
  const fields = body.fields || body;
  return {
    projectId: extractId(fields.project)!,
    issueTypeId: extractId(fields.issuetype)!,
    summary: fields.summary,
    description: fields.description,
    priorityId: extractId(fields.priority),
    assigneeId: extractId(fields.assignee),
    parentId: extractId(fields.parent),
    labels: extractStrings(fields.labels),
    components: extractStringIds(fields.components),
    fixVersions: extractStringIds(fields.fixVersions),
    affectsVersions: extractStringIds(fields.versions) || extractStringIds(fields.affectsVersions),
    dueDate: fields.duedate,
    startDate: fields.startdate ?? undefined,
    storyPoints: fields.storyPoints === undefined ? undefined : parseStoryPoints(fields.storyPoints),
    timeEstimate: fields.timeestimate,
    environment: fields.environment,
    customFields: fields.customFields,
    securityLevelId: extractSecurity(fields.security),
  };
}

function normalizeUpdateBody(body: any): UpdateIssueRequest {
  const fields = body.fields || body;
  const result: UpdateIssueRequest = {};
  if (fields.summary !== undefined) result.summary = fields.summary;
  if (fields.description !== undefined) result.description = fields.description;
  if (fields.priority !== undefined) result.priorityId = extractId(fields.priority);
  // null means "clear" (unassign / remove parent); extractId(null) would drop it as "not provided"
  if (fields.assignee !== undefined) result.assigneeId = fields.assignee === null ? null : extractId(fields.assignee);
  if (fields.status !== undefined) result.statusId = extractId(fields.status);
  if (fields.resolution !== undefined) result.resolutionId = extractId(fields.resolution);
  if (fields.labels !== undefined) result.labels = extractStrings(fields.labels);
  if (fields.components !== undefined) result.components = extractStringIds(fields.components);
  if (fields.fixVersions !== undefined) result.fixVersions = extractStringIds(fields.fixVersions);
  if (fields.versions !== undefined || fields.affectsVersions !== undefined) {
    result.affectsVersions = extractStringIds(fields.versions) || extractStringIds(fields.affectsVersions);
  }
  if (fields.duedate !== undefined) result.dueDate = fields.duedate;
  if (fields.startdate !== undefined) result.startDate = fields.startdate;
  if (fields.storyPoints !== undefined) result.storyPoints = parseStoryPoints(fields.storyPoints);
  if (fields.timeestimate !== undefined) result.timeEstimate = fields.timeestimate;
  if (fields.timespent !== undefined) result.timeSpent = fields.timespent;
  if (fields.environment !== undefined) result.environment = fields.environment;
  if (fields.parent !== undefined) result.parentId = fields.parent === null ? null : extractId(fields.parent);
  if (fields.flagged !== undefined) {
    if (typeof fields.flagged !== 'boolean') throw new Error('flagged must be true or false');
    result.flagged = fields.flagged;
  }
  if (fields.customFields !== undefined) result.customFields = fields.customFields;
  if (fields.security !== undefined) result.securityLevelId = extractSecurity(fields.security);
  return result;
}

app.use('/rest/api/2/issue*', sessionMiddleware);
app.use('/rest/api/2/issueLink*', sessionMiddleware);

// Create issue
app.post('/rest/api/2/issue', requireAuth, requirePermission('CREATE_ISSUES'), async (c) => {
  try {
    const body = await c.req.json();
    const user = c.get('user')!;
    const data = normalizeCreateBody(body);
    // requirePermission only saw "CREATE_ISSUES somewhere" (the project is in the body, not the URL):
    // check it against the target project so one project's grant does not open every other project.
    if (data.projectId !== undefined && Number.isInteger(data.projectId)) {
      if (!(await checkProjectPermission(user, data.projectId, 'CREATE_ISSUES'))) {
        return c.json({ errorMessages: ['Forbidden'] }, 403);
      }
    }
    if (data.securityLevelId !== undefined && !(await checkProjectPermission(user, data.projectId, 'SET_ISSUE_SECURITY'))) {
      return c.json({ errorMessages: ['You need the Set Issue Security permission to set the security level.'] }, 403);
    }
    if (data.parentId && !(await canSeeIssue(user.id, data.parentId))) return c.json({ errorMessages: ['Parent issue not found'] }, 400);
    // field configuration: defaults for the custom fields left empty, and the required ones that are still missing
    if (data.projectId !== undefined && data.issueTypeId !== undefined && Number.isInteger(data.projectId) && Number.isInteger(data.issueTypeId)) {
      const ruled = applyFieldRules(data.customFields, data.projectId, data.issueTypeId, await loadFieldRuleFacts(data.projectId, data.issueTypeId));
      if (ruled.missing.length) return c.json({ errorMessages: [`Required custom field${ruled.missing.length === 1 ? '' : 's'} missing: ${ruled.missing.join(', ')}`] }, 400);
      if (ruled.values.length) data.customFields = ruled.values as typeof data.customFields;
    }
    const issue = await createIssue(data, user.id);
    await invalidateIssueCache();
    publishIssue('issue.created', issue, user.id);

    // Notify watchers, assignee, reporter, and project lead
    try {
      await notifyIssueCreated(issue);
    } catch (e) {
      console.error('[notification] Failed to send issue created notification:', e);
    }

    return c.json({ id: issue.id, key: issue.key, self: issue.self }, 201);
  } catch (err: any) {
    return c.json({ errorMessages: [err.message || 'Failed to create issue'] }, 400);
  }
});

// Bulk create (Jira: POST /issue/bulk). Each element is created independently; failures are reported per element.
const BULK_MAX = 50;
app.post('/rest/api/2/issue/bulk', requireAuth, requirePermission('CREATE_ISSUES'), async (c) => {
  const body = await c.req.json().catch(() => null) as { issueUpdates?: unknown } | null;
  const updates = body?.issueUpdates;
  if (!Array.isArray(updates) || updates.length === 0) return c.json({ errorMessages: ['issueUpdates must be a non-empty array'] }, 400);
  if (updates.length > BULK_MAX) return c.json({ errorMessages: [`At most ${BULK_MAX} issues per request`] }, 400);
  const user = c.get('user')!;
  const issues: Array<{ id: number; key: string; self: string }> = [];
  const errors: Array<{ status: number; elementErrors: { errorMessages: string[] }; failedElementNumber: number }> = [];
  for (let i = 0; i < updates.length; i++) {
    try {
      const data = normalizeCreateBody(updates[i] ?? {});
      if (!Number.isInteger(data.projectId) || !(await checkProjectPermission(user, data.projectId, 'CREATE_ISSUES'))) {
        errors.push({ status: 403, elementErrors: { errorMessages: ['Forbidden'] }, failedElementNumber: i });
        continue;
      }
      if (data.securityLevelId !== undefined && !(await checkProjectPermission(user, data.projectId, 'SET_ISSUE_SECURITY'))) {
        errors.push({ status: 403, elementErrors: { errorMessages: ['You need the Set Issue Security permission to set the security level.'] }, failedElementNumber: i });
        continue;
      }
      if (data.parentId && !(await canSeeIssue(user.id, data.parentId))) throw new Error('Parent issue not found');
      const issue = await createIssue(data, user.id);
      publishIssue('issue.created', issue, user.id);
      try { await notifyIssueCreated(issue); } catch (e) { console.error('[notification] bulk create:', e); }
      issues.push({ id: issue.id, key: issue.key, self: issue.self });
    } catch (err: any) {
      errors.push({ status: 400, elementErrors: { errorMessages: [err.message || 'Failed to create issue'] }, failedElementNumber: i });
    }
  }
  await invalidateIssueCache();
  return c.json({ issues, errors }, errors.length && !issues.length ? 400 : 201);
});

// Metadata needed to create issues: projects the caller may create in, their issue types and fields.
app.get('/rest/api/2/issue/createmeta', requireAuth, async (c) => {
  const user = c.get('user')!;
  const list = (name: string) => (c.req.query(name) || '').split(',').map((v) => v.trim()).filter(Boolean);
  const projectIds = list('projectIds').map(Number).filter(Number.isInteger);
  const projectKeys = list('projectKeys').map((k) => k.toUpperCase());
  const typeIds = list('issuetypeIds').map(Number).filter(Number.isInteger);
  const typeNames = list('issuetypeNames').map((n) => n.toLowerCase());
  const withFields = (c.req.query('expand') || '').includes('projects.issuetypes.fields');

  let projects = await db.select().from(schema.projects).orderBy(schema.projects.projectKey);
  if (projectIds.length) projects = projects.filter((p) => projectIds.includes(p.id));
  if (projectKeys.length) projects = projects.filter((p) => projectKeys.includes(p.projectKey));
  const allowed = [];
  for (const p of projects) if (await checkProjectPermission(user, p.id, 'CREATE_ISSUES')) allowed.push(p);

  const allTypes = await db.select().from(schema.issueTypes).orderBy(schema.issueTypes.id);
  const priorities = withFields ? await db.select().from(schema.priorities).orderBy(schema.priorities.sortOrder) : [];
  const customFields = withFields ? await db.select().from(schema.customFields) : [];
  const fieldContexts = withFields ? await db.select().from(schema.customFieldContexts) : [];
  const fieldOptions = withFields ? await db.select().from(schema.customFieldOptions).where(eq(schema.customFieldOptions.archived, false)).orderBy(schema.customFieldOptions.sortOrder) : [];
  // A custom field applies when it has no contexts (and is global), or one of its contexts matches the project and type.
  const contextsFor = (f: { id: number; isGlobal: boolean | null }, projectId: number, typeId: number) => {
    const own = fieldContexts.filter((x) => x.customFieldId === f.id);
    if (own.length === 0) return f.isGlobal === false ? [] : null;
    return own.filter((x) => (x.projectId == null || x.projectId === projectId) && (x.issueTypeId == null || x.issueTypeId === typeId));
  };
  // required custom fields (field configuration per project and issue type) and defaults, for the create form
  const cfgAssocAll = withFields ? await db.select().from(schema.fieldConfigurationSchemeAssociations) : [];
  const cfgItemsAll = withFields && cfgAssocAll.length ? await db.select().from(schema.fieldConfigurationItems) : [];
  const requiredByPair = new Map<string, Set<number>>();
  for (const a of cfgAssocAll) requiredByPair.set(`${a.projectId}:${a.issueTypeId}`, new Set(cfgItemsAll.filter((i) => i.configId === a.configId && i.isRequired && i.isCustomField).map((i) => i.fieldId)));
  const ruleFacts = { requiredIds: [], fields: customFields.map((f) => ({ id: f.id, name: f.name, defaultValue: f.defaultValue })), contexts: fieldContexts.map((x) => ({ customFieldId: x.customFieldId, projectId: x.projectId, issueTypeId: x.issueTypeId, defaultValue: x.defaultValue })) };
  const assoc = await db.select().from(schema.issueTypeSchemeAssociations);
  const items = await db.select().from(schema.issueTypeSchemeItems);

  const out = [];
  for (const p of allowed) {
    const scheme = assoc.find((a) => a.projectId === p.id);
    let types = scheme ? allTypes.filter((t) => items.some((i) => i.schemeId === scheme.schemeId && i.issueTypeId === t.id)) : allTypes;
    if (typeIds.length) types = types.filter((t) => typeIds.includes(t.id));
    if (typeNames.length) types = types.filter((t) => typeNames.includes(t.name.toLowerCase()));
    const prio = await projectPriorities(p.id);
    const comps = withFields ? await db.select().from(schema.components).where(eq(schema.components.projectId, p.id)) : [];
    const vers = withFields ? await db.select().from(schema.versions).where(eq(schema.versions.projectId, p.id)) : [];
    out.push({
      id: String(p.id), key: p.projectKey, name: p.name,
      issuetypes: types.map((t) => ({
        id: String(t.id), name: t.name, description: t.description, subtask: !!t.isSubtask,
        ...(withFields ? {
          fields: {
            project: { required: true, name: 'Project', key: 'project' },
            issuetype: { required: true, name: 'Issue Type', key: 'issuetype', allowedValues: [{ id: String(t.id), name: t.name }] },
            summary: { required: true, name: 'Summary', key: 'summary', schema: { type: 'string' } },
            description: { required: false, name: 'Description', key: 'description', schema: { type: 'string' } },
            priority: { required: false, name: 'Priority', key: 'priority', allowedValues: priorities.filter((r) => !prio.allowed || prio.allowed.includes(r.id)).map((r) => ({ id: String(r.id), name: r.name })) },
            assignee: { required: false, name: 'Assignee', key: 'assignee', schema: { type: 'user' } },
            labels: { required: false, name: 'Labels', key: 'labels', schema: { type: 'array', items: 'string' } },
            components: { required: false, name: 'Components', key: 'components', allowedValues: comps.map((r) => ({ id: String(r.id), name: r.name })) },
            fixVersions: { required: false, name: 'Fix versions', key: 'fixVersions', allowedValues: vers.map((r) => ({ id: String(r.id), name: r.name })) },
            duedate: { required: false, name: 'Due date', key: 'duedate', schema: { type: 'date' } },
            storyPoints: { required: false, name: 'Story points', key: 'storyPoints', schema: { type: 'number' } },
            ...(t.isSubtask ? { parent: { required: true, name: 'Parent', key: 'parent', schema: { type: 'issuelink' } } } : {}),
            ...Object.fromEntries(customFields.flatMap((f) => {
              const ctx = contextsFor(f, p.id, t.id);
              if (ctx !== null && ctx.length === 0) return [];
              const ids = ctx === null ? null : new Set(ctx.map((x) => x.id));
              const allowed = fieldOptions.filter((o) => o.customFieldId === f.id && (ids === null || ids.has(o.contextId)));
              return [[`customfield_${f.id}`, {
                required: requiredByPair.get(`${p.id}:${t.id}`)?.has(f.id) ?? false, name: f.name, key: `customfield_${f.id}`, schema: { type: f.fieldType, customId: f.id },
                ...((defaultFor(f.id, p.id, t.id, ruleFacts) !== null) ? { defaultValue: defaultFor(f.id, p.id, t.id, ruleFacts) } : {}),
                ...(f.description ? { description: f.description } : {}),
                ...(allowed.length ? { allowedValues: allowed.map((o) => ({ id: String(o.id), value: o.value, color: o.color })) } : {}),
              }]];
            })),
          },
        } : {}),
      })),
    });
  }
  return c.json({ expand: 'projects', projects: out });
});

// Get issue list
app.get('/rest/api/2/issue', requireAuth, cacheMiddleware(300), async (c) => {
  const browsable = await getBrowsableProjectIds(c.get('user')!);
  const issues = browsable.length === 0 ? [] : await db.select({ id: schema.issues.id }).from(schema.issues)
    .where(and(inArray(schema.issues.projectId, browsable), issueVisibleSql(c.get('user')!.id)))
    .orderBy(schema.issues.createdAt, schema.issues.id)
    .limit(50);
  const responses = await redactIssueResponses(c.get('user')!.id, await buildIssueResponses(issues.map((i) => i.id)));
  return c.json({
    startAt: 0,
    maxResults: issues.length,
    total: issues.length,
    isLast: true,
    issues: responses,
  });
});

// Get issue
app.get('/rest/api/2/issue/:idOrKey', requireAuth, cacheMiddleware(300), async (c) => {
  const idOrKey = c.req.param('idOrKey');
  const issue = await getIssue(idOrKey);
  if (!issue || !(await checkProjectPermission(c.get('user')!, issue.fields.project.id, 'BROWSE_PROJECTS'))) {
    return c.json({ errorMessages: ['Issue does not exist or you do not have permission to see it.'] }, 404);
  }
  if (!(await canSeeIssue(c.get('user')!.id, issue.id))) {
    return c.json({ errorMessages: ['Issue does not exist or you do not have permission to see it.'] }, 404);
  }
  return c.json(await redactIssueResponse(c.get('user')!.id, issue));
});

// Update issue
app.put('/rest/api/2/issue/:idOrKey', requireAuth, requirePermission('EDIT_ISSUES'), async (c) => {
  const idOrKey = c.req.param('idOrKey');
  const body = await c.req.json();
  const user = c.get('user')!;
  const issue = await getIssue(idOrKey);
  if (!issue) return c.json({ errorMessages: ['Issue not found'] }, 404);
  let data: UpdateIssueRequest;
  try {
    data = normalizeUpdateBody(body);
  } catch (err: any) {
    return c.json({ errorMessages: [err.message || 'Invalid fields'] }, 400);
  }
  // Optimistic concurrency for text edits: the client says which summary/description it started from. When someone
  // else changed that text in the meantime the save is refused (409) with the current value, instead of silently
  // overwriting their change.
  const expect = body?.expect && typeof body.expect === 'object' ? (body.expect as Record<string, unknown>) : null;
  if (expect) {
    const sent = (body.fields || body) as Record<string, unknown>;
    const norm = (v: unknown) => (v === null || v === undefined ? '' : String(v));
    for (const key of ['summary', 'description'] as const) {
      if (key in expect && sent[key] !== undefined && norm(issue.fields?.[key]) !== norm(expect[key])) {
        return c.json({ errorMessages: [`Someone else changed the ${key} while you were editing it.`], conflict: { field: key, current: issue.fields?.[key] ?? null, updated: issue.fields?.updated ?? null } }, 409);
      }
    }
  }
  const prevAssigneeId = issue.fields?.assignee?.id;
  if (data.securityLevelId !== undefined && (data.securityLevelId ?? null) !== (issue.fields?.security?.id ?? null)) {
    if (!(await checkProjectPermission(user, issue.fields.project.id, 'SET_ISSUE_SECURITY'))) {
      return c.json({ errorMessages: ['You need the Set Issue Security permission to change the security level.'] }, 403);
    }
  } else {
    delete data.securityLevelId; // unchanged value (the edit form sends the whole issue): no permission needed
  }
  if (data.parentId && !(await canSeeIssue(user.id, data.parentId))) return c.json({ errorMessages: ['Parent issue not found'] }, 400);
  let updated;
  try {
    updated = await updateIssue(issue.id, data, user.id);
  } catch (err: any) {
    return c.json({ errorMessages: [err.message || 'Failed to update issue'] }, 400);
  }
  await invalidateIssueCache(issue.key);
  await invalidateAgileReports();
  publishIssue('issue.updated', updated, user.id);

  // Build changelog for notification
  const changeLog: Array<{ field: string; oldValue: string | null; newValue: string | null }> = [];
  if (data.summary !== undefined && data.summary !== issue.fields?.summary) {
    changeLog.push({ field: 'summary', oldValue: issue.fields?.summary || null, newValue: data.summary });
  }
  if (data.description !== undefined && data.description !== issue.fields?.description) {
    changeLog.push({ field: 'description', oldValue: issue.fields?.description || null, newValue: data.description || null });
  }
  if (data.priorityId !== undefined && data.priorityId !== issue.fields?.priority?.id) {
    changeLog.push({ field: 'priority', oldValue: issue.fields?.priority?.name || null, newValue: updated.fields?.priority?.name || null });
  }
  if (data.assigneeId !== undefined && (data.assigneeId ?? null) !== (prevAssigneeId ?? null)) {
    changeLog.push({ field: 'assignee', oldValue: issue.fields?.assignee?.displayName || null, newValue: updated.fields?.assignee?.displayName || null });
  }
  if (data.statusId !== undefined && data.statusId !== issue.fields?.status?.id) {
    changeLog.push({ field: 'status', oldValue: issue.fields?.status?.name || null, newValue: updated.fields?.status?.name || null });
  }
  if (data.resolutionId !== undefined && data.resolutionId !== issue.fields?.resolution?.id) {
    changeLog.push({ field: 'resolution', oldValue: issue.fields?.resolution?.name || null, newValue: updated.fields?.resolution?.name || null });
  }

  // Send notifications
  try {
    if (changeLog.length > 0) {
      // On service requests the customer side only gets the desk mails (never field-level change mails)
      const [sr] = await db.select().from(schema.serviceRequests).where(eq(schema.serviceRequests.issueId, issue.id)).limit(1);
      await notifyIssueUpdated(updated, changeLog, user.id, undefined, sr ? await customerSideUserIds(sr) : undefined);
      if (sr && changeLog.some((x) => x.field === 'status')) await notifyRequestStatusChange(issue.id, user.id);
    }
    const newAssigneeId = updated.fields?.assignee?.id;
    if (newAssigneeId && newAssigneeId !== prevAssigneeId) {
      await notifyIssueAssigned(updated, newAssigneeId, user.id);
    }
  } catch (e) {
    console.error('[notification] Failed to send update notification:', e);
  }

  return c.json(await redactIssueResponse(user.id, updated));
});

// Delete issue
app.delete('/rest/api/2/issue/:idOrKey', requireAuth, requirePermission('DELETE_ISSUES'), async (c) => {
  const user = c.get('user')!;
  const idOrKey = c.req.param('idOrKey');
  const issue = await getIssue(idOrKey);
  if (!issue) return c.json({ errorMessages: ['Issue not found'] }, 404);
  await db.delete(schema.issues).where(eq(schema.issues.id, issue.id));
  await invalidateIssueCache(issue.key);
  publishIssue('issue.deleted', issue, user.id);
  return c.json({});
});

// Get changelog/history
app.get('/rest/api/2/issue/:idOrKey/changelog', requireAuth, async (c) => {
  const idOrKey = c.req.param('idOrKey');
  const issue = await getIssue(idOrKey);
  if (!issue || !(await checkProjectPermission(c.get('user')!, issue.fields.project.id, 'BROWSE_PROJECTS'))) {
    return c.json({ errorMessages: ['Issue not found'] }, 404);
  }
  const history = await getIssueHistory(issue.id);
  return c.json(history);
});

async function invalidateLinked(issueIds: number[]) {
  const rows = await db.select({ key: schema.issues.issueKey }).from(schema.issues).where(inArray(schema.issues.id, issueIds));
  for (const r of rows) { await invalidateIssueKeyCache(r.key); await invalidateIssueCache(r.key); }
}

// Link issues. Needs LINK_ISSUES in the project of both issues; an issue the caller cannot browse does not exist for them.
app.post('/rest/api/2/issueLink', requireAuth, async (c) => {
  try {
    const body = await c.req.json();
    const user = c.get('user')!;
    const inwardId = body.inwardIssue?.id ? Number(body.inwardIssue.id) : undefined;
    const outwardId = body.outwardIssue?.id ? Number(body.outwardIssue.id) : undefined;
    const typeId = body.type?.id ? Number(body.type.id) : undefined;
    if (!inwardId || !outwardId || !typeId || ![inwardId, outwardId, typeId].every(Number.isSafeInteger)) {
      return c.json({ errorMessages: ['inwardIssue, outwardIssue and type are required'] }, 400);
    }
    // Both ends must be issues the caller can see (security levels); a hidden issue "does not exist".
    const visible = await visibleIssueIds(user.id, [inwardId, outwardId]);
    if (!visible.has(inwardId) || !visible.has(outwardId)) return c.json({ errorMessages: ['Issue not found'] }, 404);
    const rows = await db.select({ id: schema.issues.id, projectId: schema.issues.projectId }).from(schema.issues).where(inArray(schema.issues.id, [inwardId, outwardId]));
    if (rows.length !== new Set([inwardId, outwardId]).size) return c.json({ errorMessages: ['Issue not found'] }, 404);
    for (const projectId of new Set(rows.map((r) => r.projectId))) {
      if (!(await checkProjectPermission(user, projectId, 'BROWSE_PROJECTS'))) return c.json({ errorMessages: ['Issue not found'] }, 404);
      if (!(await checkProjectPermission(user, projectId, 'LINK_ISSUES'))) return c.json({ errorMessages: ['Forbidden'] }, 403);
    }
    await linkIssues(inwardId, outwardId, typeId, user.id);
    await invalidateLinked([inwardId, outwardId]);
    return c.json({}, 201);
  } catch (err: any) {
    return c.json({ errorMessages: [err.message || 'Failed to link issues'] }, err instanceof LinkError ? err.status : 400);
  }
});

// Unlink issues
app.delete('/rest/api/2/issueLink/:id', requireAuth, async (c) => {
  try {
    const user = c.get('user')!;
    const linkId = Number(c.req.param('id'));
    const projectIds = await linkProjects(linkId);
    if (!projectIds) return c.json({ errorMessages: ['Link not found'] }, 404);
    for (const projectId of projectIds) {
      if (!(await checkProjectPermission(user, projectId, 'BROWSE_PROJECTS'))) return c.json({ errorMessages: ['Link not found'] }, 404);
      if (!(await checkProjectPermission(user, projectId, 'LINK_ISSUES'))) return c.json({ errorMessages: ['Forbidden'] }, 403);
    }
    const [ends] = await db.select({ a: schema.issueLinks.issueId, b: schema.issueLinks.linkedIssueId }).from(schema.issueLinks).where(eq(schema.issueLinks.id, linkId)).limit(1);
    await unlinkIssues(linkId, user.id);
    if (ends) await invalidateLinked([ends.a, ends.b]);
    return c.json({});
  } catch (err: any) {
    return c.json({ errorMessages: [err.message || 'Failed to unlink issues'] }, 400);
  }
});

/** Level for a copy of a secured issue: same level when the target project uses the same scheme, else the target's default (never silently unsecured). */
async function levelForCopy(levelId: number | null, targetProjectId: number): Promise<number | null> {
  if (levelId === null) return await defaultLevelForProject(targetProjectId);
  const [lvl] = await db.select({ schemeId: schema.issueSecurityLevels.schemeId }).from(schema.issueSecurityLevels).where(eq(schema.issueSecurityLevels.id, levelId)).limit(1);
  const target = await schemeOfProject(targetProjectId);
  if (lvl && target && target.id === lvl.schemeId) return levelId;
  const def = target?.defaultLevelId ?? null;
  if (def === null) throw new Error('The issue has a security level that does not exist in the target project. Remove the level first.');
  return def;
}

// Clone issue
app.post('/rest/api/2/issue/:key/clone', requireAuth, requireIssueAccess('CREATE_ISSUES'), async (c) => {
  try {
    const key = c.req.param('key');
    const body = await c.req.json().catch(() => ({}));
    const user = c.get('user')!;

    const existing = await getIssue(key);
    if (!existing) return c.json({ errorMessages: ['Issue not found'] }, 404);

    const targetProjectId = body.projectId ? Number(body.projectId) : existing.fields.project.id;
    const targetProject = await db.select().from(schema.projects).where(eq(schema.projects.id, targetProjectId)).limit(1);
    if (!targetProject.length) return c.json({ errorMessages: ['Target project not found'] }, 404);
    // Creating the copy / receiving the moved issue is a CREATE_ISSUES act in the TARGET project.
    if (targetProjectId !== existing.fields.project.id && !(await checkProjectPermission(user, targetProjectId, 'CREATE_ISSUES'))) {
      return c.json({ errorMessages: ['Forbidden'] }, 403);
    }

    const newKey = await generateIssueKey(targetProjectId, targetProject[0].projectKey);

    // Determine issue type
    const targetIssueTypeId = body.issueTypeId ? Number(body.issueTypeId) : existing.fields.issuetype.id;

    // Get default status for target project/issue type
    const workflowAssoc = await db
      .select()
      .from(schema.workflowSchemeAssociations)
      .innerJoin(
        schema.workflowSchemeItems,
        eq(schema.workflowSchemeItems.schemeId, schema.workflowSchemeAssociations.schemeId)
      )
      .where(
        and(
          eq(schema.workflowSchemeAssociations.projectId, targetProjectId),
          eq(schema.workflowSchemeItems.issueTypeId, targetIssueTypeId)
        )
      )
      .limit(1);

    let defaultStatusId = 1;
    if (workflowAssoc.length > 0) {
      const workflowId = workflowAssoc[0].workflow_scheme_items.workflowId;
      const transitions = await db
        .select()
        .from(schema.workflowTransitions)
        .where(
          and(
            eq(schema.workflowTransitions.workflowId, workflowId),
            isNull(schema.workflowTransitions.fromStatusId)
          )
        )
        .limit(1);
      defaultStatusId = transitions[0]?.toStatusId || 1;
    }

    const [issue] = await db.insert(schema.issues).values({
      issueKey: newKey,
      projectId: targetProjectId,
      issueTypeId: targetIssueTypeId,
      statusId: defaultStatusId,
      priorityId: existing.fields.priority?.id ?? null,
      summary: body.summary || existing.fields.summary,
      description: existing.fields.description,
      assigneeId: body.assigneeId !== undefined ? body.assigneeId : existing.fields.assignee?.id ?? null,
      reporterId: user.id,
      environment: existing.fields.environment,
      dueDate: existing.fields.duedate ? new Date(existing.fields.duedate) : null,
      storyPoints: existing.fields.storyPoints == null ? null : Number(existing.fields.storyPoints).toFixed(2),
      timeEstimate: existing.fields.timeestimate,
      parentId: body.parentId ? Number(body.parentId) : null,
      securityLevelId: await levelForCopy(existing.fields.security?.id ?? null, targetProjectId),
    }).returning();

    // Copy labels
    const labelRows = await db.select({ name: schema.labels.name })
      .from(schema.issueLabels)
      .innerJoin(schema.labels, eq(schema.labels.id, schema.issueLabels.labelId))
      .where(eq(schema.issueLabels.issueId, existing.id));
    for (const labelRow of labelRows) {
      let label = await db.select().from(schema.labels).where(eq(schema.labels.name, labelRow.name)).limit(1);
      let labelId: number;
      if (label.length === 0) {
        const [newLabel] = await db.insert(schema.labels).values({ name: labelRow.name }).returning();
        labelId = newLabel.id;
      } else {
        labelId = label[0].id;
      }
      await db.insert(schema.issueLabels).values({ issueId: issue.id, labelId }).onConflictDoNothing();
    }

    // Copy components
    const componentRows = await db.select({ componentId: schema.issueComponents.componentId })
      .from(schema.issueComponents)
      .where(eq(schema.issueComponents.issueId, existing.id));
    for (const row of componentRows) {
      await db.insert(schema.issueComponents).values({ issueId: issue.id, componentId: row.componentId }).onConflictDoNothing();
    }

    // Copy fixVersions
    const fixVersionRows = await db.select({ versionId: schema.issueFixVersions.versionId })
      .from(schema.issueFixVersions)
      .where(eq(schema.issueFixVersions.issueId, existing.id));
    for (const row of fixVersionRows) {
      await db.insert(schema.issueFixVersions).values({ issueId: issue.id, versionId: row.versionId }).onConflictDoNothing();
    }

    // Copy custom fields
    const { getCustomFields, setCustomFields } = await import('../issues/custom-fields');
    const customFields = await getCustomFields(existing.id);
    if (customFields.length > 0) {
      await setCustomFields(issue.id, customFields.map((cf) => ({ fieldId: Number(cf.id.replace('customfield_', '')), value: cf.value })));
    }

    await invalidateIssueCache();
    const created = await getIssue(issue.id);
    return c.json(created, 201);
  } catch (err: any) {
    console.error('[clone]', err);
    return c.json({ errorMessages: [err.message || 'Failed to clone issue'] }, 400);
  }
});

// Move issue to another project
// Move to another project. ?preview=true returns the plan (workflow and status check, what is kept or dropped) without changing anything.
app.post('/rest/api/2/issue/:key/move', requireAuth, requireIssueAccess('EDIT_ISSUES'), async (c) => {
  try {
    const user = c.get('user')!;
    const existing = await getIssue(c.req.param('key'));
    if (!existing) return c.json({ errorMessages: ['Issue not found'] }, 404);
    const body = await c.req.json().catch(() => ({}));
    const input = {
      projectId: Number(body.projectId),
      issueTypeId: body.issueTypeId ? Number(body.issueTypeId) : undefined,
      statusId: body.statusId ? Number(body.statusId) : undefined,
    };
    if (!Number.isInteger(input.projectId) || input.projectId <= 0) return c.json({ errorMessages: ['projectId is required'] }, 400);
    // Receiving the moved issue is a CREATE_ISSUES act in the TARGET project.
    if (input.projectId !== existing.fields.project.id && !(await checkProjectPermission(user, input.projectId, 'CREATE_ISSUES'))) {
      return c.json({ errorMessages: ['Forbidden'] }, 403);
    }
    if (c.req.query('preview') === 'true') return c.json({ preview: true, ...(await planMove(existing.key, input)) });

    const { plan, newKey } = await applyMove(existing.key, input, user.id);
    await invalidateIssueCache(existing.key);
    await invalidateIssueCache(newKey);
    void recordAudit({
      actorId: user.id, actorName: user.username, action: 'ISSUE_MOVED', targetType: 'issue', target: newKey,
      method: 'POST', path: c.req.path, status: 200,
      details: { from: existing.key, to: newKey, workflowChanged: plan.workflow.changed, status: plan.status.target?.name ?? null, droppedFields: plan.droppedFields.map((d) => d.name) },
    });
    return c.json(await getIssue(existing.id));
  } catch (err: any) {
    if (err instanceof MoveError) return c.json({ errorMessages: [err.message] }, err.status);
    console.error('[move]', err);
    return c.json({ errorMessages: [err.message || 'Failed to move issue'] }, 400);
  }
});

// CSV import
app.post('/rest/api/2/issue/import', requireAuth, requirePermission('CREATE_ISSUES'), async (c) => {
  try {
    const body = await c.req.json();
    const rows = body.rows as any[];
    const projectKey = body.projectKey as string;
    const user = c.get('user')!;

    if (!Array.isArray(rows) || rows.length === 0) {
      return c.json({ errorMessages: ['No rows provided'] }, 400);
    }

    const project = await db.select().from(schema.projects).where(eq(schema.projects.projectKey, projectKey)).limit(1);
    if (!project.length) return c.json({ errorMessages: ['Project not found'] }, 404);

    const projectId = project[0].id;

    // Get issue types for mapping names to IDs
    const issueTypes = await db.select().from(schema.issueTypes);
    const issueTypeMap = new Map(issueTypes.map((t) => [t.name.toLowerCase(), t.id]));

    // Get priorities for mapping
    const priorities = await db.select().from(schema.priorities);
    const priorityMap = new Map(priorities.map((p) => [p.name.toLowerCase(), p.id]));

    const results: Array<{ row: number; key?: string; error?: string }> = [];
    let successCount = 0;
    let errorCount = 0;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      try {
        const summary = row.summary || row.Summary || row['Issue Summary'];
        if (!summary) {
          results.push({ row: i + 1, error: 'Summary is required' });
          errorCount++;
          continue;
        }

        const typeName = row.issuetype || row['Issue Type'] || row.type || 'Task';
        const issueTypeId = issueTypeMap.get(typeName.toLowerCase()) || issueTypeMap.get('task') || issueTypes[0]?.id;
        if (!issueTypeId) {
          results.push({ row: i + 1, error: `Unknown issue type: ${typeName}` });
          errorCount++;
          continue;
        }

        const priorityName = row.priority || row.Priority;
        const priorityId = priorityName ? priorityMap.get(priorityName.toLowerCase()) : null;

        const labels = row.labels || row.Labels || '';
        const labelList = labels
          .split(/[,;]/)
          .map((l: string) => l.trim())
          .filter(Boolean);

        const description = row.description || row.Description || '';

        const data: CreateIssueRequest = {
          projectId,
          issueTypeId,
          summary,
          description,
          priorityId: priorityId || undefined,
          labels: labelList.length > 0 ? labelList : undefined,
        };

        const issue = await createIssue(data, user.id);
        results.push({ row: i + 1, key: issue.key });
        successCount++;
      } catch (err: any) {
        results.push({ row: i + 1, error: err.message || 'Unknown error' });
        errorCount++;
      }
    }

    await invalidateIssueCache();

    return c.json({
      total: rows.length,
      success: successCount,
      errors: errorCount,
      results,
    });
  } catch (err: any) {
    console.error('[csv-import]', err);
    return c.json({ errorMessages: [err.message || 'Failed to import'] }, 400);
  }
});

export default app;
