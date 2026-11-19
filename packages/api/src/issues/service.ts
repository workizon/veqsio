import { db } from '../db';
import * as schema from '@veqsio/db';
import { eq, and, count, isNull, inArray } from 'drizzle-orm';
import { generateIssueKey } from './key-generator';
import { setCustomFields, getCustomFields, getCustomFieldsBulk } from './custom-fields';
import { getIssueLinks, getIssueLinksBulk } from './links';
import * as cache from '../services/cache';
import { removeResolutionLabelsIfResolved } from '../labels/service';
import { priorityForNewIssue, assertPriorityAllowed } from '../priority/schemes';
import { resolveLevelForProject, defaultLevelForProject } from '../security/issue-security';
import type { CreateIssueRequest, UpdateIssueRequest, IssueResponse } from './types';

function groupBy<T, K>(items: T[], keyFn: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const list = map.get(key) ?? [];
    list.push(item);
    map.set(key, list);
  }
  return map;
}

/** Story points: finite number in [0, 1000] with at most 2 decimals. */
/** Id of the label with this name, creating it if needed. Safe under concurrency (bulk edits add the same new label from several issues at once). */
async function ensureLabelId(name: string): Promise<number> {
  const [existing] = await db.select({ id: schema.labels.id }).from(schema.labels).where(eq(schema.labels.name, name)).limit(1);
  if (existing) return existing.id;
  const [created] = await db.insert(schema.labels).values({ name }).onConflictDoNothing().returning({ id: schema.labels.id });
  if (created) return created.id;
  const [raced] = await db.select({ id: schema.labels.id }).from(schema.labels).where(eq(schema.labels.name, name)).limit(1);
  return raced.id;
}

export function validateStoryPoints(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1000) {
    throw new Error('storyPoints must be a number between 0 and 1000');
  }
  if (Math.abs(Math.round(v * 100) / 100 - v) > 1e-9) {
    throw new Error('storyPoints may have at most 2 decimal places');
  }
  return Math.round(v * 100) / 100;
}

export async function invalidateIssueKeyCache(issueKey: string): Promise<void> {
  await cache.del(`veqsio:issue:${issueKey}`);
}

export async function createIssue(data: CreateIssueRequest, userId: number): Promise<IssueResponse> {
  const project = await db.select().from(schema.projects).where(eq(schema.projects.id, data.projectId)).limit(1);
  if (project.length === 0) throw new Error('Project not found');

  const issueKey = await generateIssueKey(data.projectId, project[0].projectKey);

  // Get default status from workflow
  const workflowAssoc = await db
    .select()
    .from(schema.workflowSchemeAssociations)
    .innerJoin(
      schema.workflowSchemeItems,
      eq(schema.workflowSchemeItems.schemeId, schema.workflowSchemeAssociations.schemeId)
    )
    .where(
      and(
        eq(schema.workflowSchemeAssociations.projectId, data.projectId),
        eq(schema.workflowSchemeItems.issueTypeId, data.issueTypeId)
      )
    )
    .limit(1);

  let defaultStatusId: number;
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
  } else {
    defaultStatusId = 1;
  }

  // Workflow governance: a status can be closed for new issues (e.g. "Done" or a review step).
  const [initial] = await db.select({ name: schema.statuses.name, allow: schema.statuses.allowNewIssues }).from(schema.statuses).where(eq(schema.statuses.id, defaultStatusId)).limit(1);
  if (initial && initial.allow === false) {
    throw new Error(`New issues cannot be created in status "${initial.name}": the status is closed for new issues in the workflow settings`);
  }

  // Sub-task validation
  if (data.parentId) {
    const parentRows = await db.select().from(schema.issues).where(eq(schema.issues.id, data.parentId)).limit(1);
    if (parentRows.length === 0) throw new Error('Parent issue not found');
    const parent = parentRows[0];
    if (parent.projectId !== data.projectId) throw new Error('Parent must be in the same project');
    const parentType = await db.select().from(schema.issueTypes).where(eq(schema.issueTypes.id, parent.issueTypeId)).limit(1);
    if (parentType.length > 0 && parentType[0].isSubtask) throw new Error('Parent cannot be a sub-task');
  }

  // Security level: explicit (validated against the project's scheme), else inherited from the parent, else the scheme default.
  let securityLevelId: number | null;
  if (data.securityLevelId !== undefined) securityLevelId = await resolveLevelForProject(data.projectId, data.securityLevelId);
  else if (data.parentId) securityLevelId = (await db.select({ l: schema.issues.securityLevelId }).from(schema.issues).where(eq(schema.issues.id, data.parentId)).limit(1))[0]?.l ?? null;
  else securityLevelId = await defaultLevelForProject(data.projectId);

  const priorityId = await priorityForNewIssue(data.projectId, data.priorityId);
  const [issue] = await db
    .insert(schema.issues)
    .values({
      securityLevelId,
      issueKey,
      projectId: data.projectId,
      issueTypeId: data.issueTypeId,
      statusId: defaultStatusId,
      priorityId,
      summary: data.summary,
      description: data.description,
      assigneeId: data.assigneeId,
      reporterId: userId,
      environment: data.environment,
      dueDate: data.dueDate ? new Date(data.dueDate) : null,
      startDate: data.startDate ? new Date(data.startDate) : null,
      storyPoints: data.storyPoints === undefined || data.storyPoints === null ? null : validateStoryPoints(data.storyPoints).toFixed(2),
      parentId: data.parentId,
      timeEstimate: data.timeEstimate,
    })
    .returning();

  // Handle labels
  if (data.labels?.length) {
    for (const labelName of data.labels) {
      const labelId = await ensureLabelId(labelName);
      await db.insert(schema.issueLabels).values({ issueId: issue.id, labelId }).onConflictDoNothing();
    }
  }

  // Handle components, versions
  if (data.components?.length) {
    for (const cid of data.components) {
      await db.insert(schema.issueComponents).values({ issueId: issue.id, componentId: cid }).onConflictDoNothing();
    }
  }
  if (data.fixVersions?.length) {
    for (const vid of data.fixVersions) {
      await db.insert(schema.issueFixVersions).values({ issueId: issue.id, versionId: vid }).onConflictDoNothing();
    }
  }
  if (data.affectsVersions?.length) {
    for (const vid of data.affectsVersions) {
      await db.insert(schema.issueAffectsVersions).values({ issueId: issue.id, versionId: vid }).onConflictDoNothing();
    }
  }

  // Handle custom fields
  if (data.customFields?.length) {
    await setCustomFields(issue.id, data.customFields);
  }

  const { emitIssueCreated } = await import('../services/automation-engine');
  await emitIssueCreated(issue.id, userId);

  const response = await buildIssueResponse(issue.id);
  await cache.set(`veqsio:issue:${response.key}`, response, 'issue');
  return response;
}

export async function getIssue(idOrKey: string | number): Promise<IssueResponse | null> {
  const conditions =
    typeof idOrKey === 'number' ? eq(schema.issues.id, idOrKey) : eq(schema.issues.issueKey, idOrKey);
  const issues = await db.select().from(schema.issues).where(conditions).limit(1);
  if (issues.length === 0) return null;

  const issueKey = issues[0].issueKey;
  const cacheKey = `veqsio:issue:${issueKey}`;
  const cached = await cache.get<IssueResponse>(cacheKey);
  if (cached !== null) {
    return cached;
  }

  const response = await buildIssueResponse(issues[0].id);
  await cache.set(cacheKey, response, 'issue');
  return response;
}

export async function buildIssueResponse(issueId: number): Promise<IssueResponse> {
  const issue = (await db.select().from(schema.issues).where(eq(schema.issues.id, issueId)).limit(1))[0];
  if (!issue) throw new Error('Issue not found');

  // Batch all single-row related lookups
  const [projectRows, issueTypeRows, statusRows, priorityRows, resolutionRows, assigneeRows, reporterRows] = await Promise.all([
    db.select().from(schema.projects).where(eq(schema.projects.id, issue.projectId)).limit(1),
    db.select().from(schema.issueTypes).where(eq(schema.issueTypes.id, issue.issueTypeId)).limit(1),
    db.select().from(schema.statuses).where(eq(schema.statuses.id, issue.statusId)).limit(1),
    issue.priorityId ? db.select().from(schema.priorities).where(eq(schema.priorities.id, issue.priorityId)).limit(1) : Promise.resolve([]),
    issue.resolutionId ? db.select().from(schema.resolutions).where(eq(schema.resolutions.id, issue.resolutionId)).limit(1) : Promise.resolve([]),
    issue.assigneeId ? db.select().from(schema.users).where(eq(schema.users.id, issue.assigneeId)).limit(1) : Promise.resolve([]),
    db.select().from(schema.users).where(eq(schema.users.id, issue.reporterId)).limit(1),
  ]);

  const project = projectRows[0];
  const issueType = issueTypeRows[0];
  const status = statusRows[0];
  const priority = priorityRows[0] ?? null;
  const resolution = resolutionRows[0] ?? null;
  const assignee = assigneeRows[0] ?? null;
  const reporter = reporterRows[0];

  // Batch all collection lookups
  const [labelRows, componentRows, fixVersionRows, affectsVersionRows, subtasks, voteCount, customFields, links] = await Promise.all([
    db.select({ name: schema.labels.name, color: schema.labels.color, removeOnResolve: schema.labels.removeOnResolve }).from(schema.issueLabels).innerJoin(schema.labels, eq(schema.labels.id, schema.issueLabels.labelId)).where(eq(schema.issueLabels.issueId, issueId)).orderBy(schema.labels.name),
    db.select({ id: schema.components.id, name: schema.components.name }).from(schema.issueComponents).innerJoin(schema.components, eq(schema.components.id, schema.issueComponents.componentId)).where(eq(schema.issueComponents.issueId, issueId)),
    db.select({ id: schema.versions.id, name: schema.versions.name }).from(schema.issueFixVersions).innerJoin(schema.versions, eq(schema.versions.id, schema.issueFixVersions.versionId)).where(eq(schema.issueFixVersions.issueId, issueId)),
    db.select({ id: schema.versions.id, name: schema.versions.name }).from(schema.issueAffectsVersions).innerJoin(schema.versions, eq(schema.versions.id, schema.issueAffectsVersions.versionId)).where(eq(schema.issueAffectsVersions.issueId, issueId)),
    db.select({ id: schema.issues.id, key: schema.issues.issueKey, summary: schema.issues.summary, statusId: schema.issues.statusId }).from(schema.issues).where(eq(schema.issues.parentId, issueId)),
    db.select({ count: count() }).from(schema.votes).where(eq(schema.votes.issueId, issueId)),
    getCustomFields(issueId),
    getIssueLinks(issueId),
  ]);

  const cfMap: Record<string, any> = {};
  for (const cf of customFields) {
    cfMap[cf.id] = cf.value;
  }

  // Parent summary and current sprint (additive; used by the issue view details panel)
  const [parentRows, sprintRows] = await Promise.all([
    issue.parentId
      ? db.select({ id: schema.issues.id, key: schema.issues.issueKey, summary: schema.issues.summary }).from(schema.issues).where(eq(schema.issues.id, issue.parentId)).limit(1)
      : Promise.resolve([] as { id: number; key: string; summary: string }[]),
    db
      .select({ id: schema.sprints.id, name: schema.sprints.name, state: schema.sprints.state })
      .from(schema.sprintIssues)
      .innerJoin(schema.sprints, eq(schema.sprints.id, schema.sprintIssues.sprintId))
      .where(eq(schema.sprintIssues.issueId, issueId)),
  ]);
  const activeSprint = sprintRows.find((s) => s.state === 'active') ?? sprintRows[sprintRows.length - 1] ?? null;
  const securityRow = issue.securityLevelId
    ? (await db.select({ id: schema.issueSecurityLevels.id, name: schema.issueSecurityLevels.name, description: schema.issueSecurityLevels.description }).from(schema.issueSecurityLevels).where(eq(schema.issueSecurityLevels.id, issue.securityLevelId)).limit(1))[0]
    : undefined;

  return {
    id: issue.id,
    key: issue.issueKey,
    self: `/rest/api/2/issue/${issue.issueKey}`,
    fields: {
      summary: issue.summary,
      description: issue.description,
      status: { id: status.id, name: status.name, category: status.category, color: status.color },
      issuetype: { id: issueType.id, name: issueType.name, iconUrl: issueType.iconUrl, subtask: issueType.isSubtask },
      priority: priority ? { id: priority.id, name: priority.name, color: priority.color } : null,
      resolution: resolution ? { id: resolution.id, name: resolution.name } : null,
      assignee: assignee ? { id: assignee.id, displayName: assignee.displayName, avatarUrl: assignee.avatarUrl, ...(assignee.username.startsWith('agent:') ? { isAgent: true } : {}) } : null,
      reporter: { id: reporter.id, displayName: reporter.displayName, avatarUrl: reporter.avatarUrl },
      project: { id: project.id, key: project.projectKey, name: project.name },
      created: issue.createdAt!.toISOString(),
      updated: issue.updatedAt!.toISOString(),
      resolved: issue.resolvedAt?.toISOString() || null,
      duedate: issue.dueDate?.toISOString().split('T')[0] || null,
      startdate: issue.startDate?.toISOString().split('T')[0] || null,
      storyPoints: issue.storyPoints === null || issue.storyPoints === undefined ? null : Number(issue.storyPoints),
      flagged: issue.flagged === true,
      environment: issue.environment,
      security: securityRow ?? null,
      labels: labelRows.map((l) => l.name),
      // Additive colour data; `labels` stays Jira-compatible (array of strings).
      labelDetails: labelRows.map((l) => ({ name: l.name, color: l.color, removeOnResolve: l.removeOnResolve })),
      components: componentRows,
      fixVersions: fixVersionRows,
      versions: affectsVersionRows,
      timeestimate: issue.timeEstimate,
      timespent: issue.timeSpent,
      parent: issue.parentId ? { id: issue.parentId, key: parentRows[0]?.key, summary: parentRows[0]?.summary } : null,
      sprint: activeSprint,
      subtasks: subtasks.map((s) => ({
        id: s.id,
        key: s.key,
        summary: s.summary,
        status: { id: s.statusId },
      })),
      votes: { votes: Number(voteCount[0]?.count || 0), hasVoted: false },
      ...cfMap,
      issuelinks: [
        ...links.inward.map((l) => ({ id: l.id, type: l.type, inwardIssue: l.issue, ...(l.dependency ? { dependency: l.dependency } : {}) })),
        ...links.outward.map((l) => ({ id: l.id, type: l.type, outwardIssue: l.issue, ...(l.dependency ? { dependency: l.dependency } : {}) })),
      ],
    },
  };
}

export async function buildIssueResponses(issueIds: number[]): Promise<IssueResponse[]> {
  if (issueIds.length === 0) return [];

  const issues = await db.select().from(schema.issues).where(inArray(schema.issues.id, issueIds));
  if (issues.length === 0) return [];

  // Extract unique foreign keys
  const projectIds = [...new Set(issues.map((i) => i.projectId))];
  const issueTypeIds = [...new Set(issues.map((i) => i.issueTypeId))];
  const statusIds = [...new Set(issues.map((i) => i.statusId))];
  const priorityIds = [...new Set(issues.map((i) => i.priorityId).filter((id): id is number => id !== null))];
  const resolutionIds = [...new Set(issues.map((i) => i.resolutionId).filter((id): id is number => id !== null))];
  const assigneeIds = [...new Set(issues.map((i) => i.assigneeId).filter((id): id is number => id !== null))];
  const reporterIds = [...new Set(issues.map((i) => i.reporterId))];

  // Bulk fetch related entities
  const [projects, issueTypes, statuses, priorities, resolutions, assignees, reporters] = await Promise.all([
    db.select().from(schema.projects).where(inArray(schema.projects.id, projectIds)),
    db.select().from(schema.issueTypes).where(inArray(schema.issueTypes.id, issueTypeIds)),
    db.select().from(schema.statuses).where(inArray(schema.statuses.id, statusIds)),
    priorityIds.length > 0 ? db.select().from(schema.priorities).where(inArray(schema.priorities.id, priorityIds)) : Promise.resolve([] as any[]),
    resolutionIds.length > 0 ? db.select().from(schema.resolutions).where(inArray(schema.resolutions.id, resolutionIds)) : Promise.resolve([] as any[]),
    assigneeIds.length > 0 ? db.select().from(schema.users).where(inArray(schema.users.id, assigneeIds)) : Promise.resolve([] as any[]),
    db.select().from(schema.users).where(inArray(schema.users.id, reporterIds)),
  ]);

  const levelIds = [...new Set(issues.map((i) => i.securityLevelId).filter((id): id is number => id !== null))];
  const levelMap = new Map(
    (levelIds.length > 0
      ? await db.select({ id: schema.issueSecurityLevels.id, name: schema.issueSecurityLevels.name, description: schema.issueSecurityLevels.description }).from(schema.issueSecurityLevels).where(inArray(schema.issueSecurityLevels.id, levelIds))
      : []
    ).map((l) => [l.id, l]),
  );

  // Build lookup maps
  const projectMap = new Map(projects.map((p) => [p.id, p]));
  const issueTypeMap = new Map(issueTypes.map((t) => [t.id, t]));
  const statusMap = new Map(statuses.map((s) => [s.id, s]));
  const priorityMap = new Map(priorities.map((p) => [p.id, p]));
  const resolutionMap = new Map(resolutions.map((r) => [r.id, r]));
  const assigneeMap = new Map(assignees.map((u) => [u.id, u]));
  const reporterMap = new Map(reporters.map((u) => [u.id, u]));

  // Bulk fetch collections
  const [labelRows, componentRows, fixVersionRows, affectsVersionRows, subtaskRows, voteCounts] = await Promise.all([
    db.select({ issueId: schema.issueLabels.issueId, name: schema.labels.name, color: schema.labels.color, removeOnResolve: schema.labels.removeOnResolve })
      .from(schema.issueLabels)
      .innerJoin(schema.labels, eq(schema.labels.id, schema.issueLabels.labelId))
      .where(inArray(schema.issueLabels.issueId, issueIds)),
    db.select({ issueId: schema.issueComponents.issueId, id: schema.components.id, name: schema.components.name })
      .from(schema.issueComponents)
      .innerJoin(schema.components, eq(schema.components.id, schema.issueComponents.componentId))
      .where(inArray(schema.issueComponents.issueId, issueIds)),
    db.select({ issueId: schema.issueFixVersions.issueId, id: schema.versions.id, name: schema.versions.name })
      .from(schema.issueFixVersions)
      .innerJoin(schema.versions, eq(schema.versions.id, schema.issueFixVersions.versionId))
      .where(inArray(schema.issueFixVersions.issueId, issueIds)),
    db.select({ issueId: schema.issueAffectsVersions.issueId, id: schema.versions.id, name: schema.versions.name })
      .from(schema.issueAffectsVersions)
      .innerJoin(schema.versions, eq(schema.versions.id, schema.issueAffectsVersions.versionId))
      .where(inArray(schema.issueAffectsVersions.issueId, issueIds)),
    db.select({ id: schema.issues.id, key: schema.issues.issueKey, summary: schema.issues.summary, statusId: schema.issues.statusId, parentId: schema.issues.parentId })
      .from(schema.issues)
      .where(inArray(schema.issues.parentId, issueIds)),
    db.select({ issueId: schema.votes.issueId, count: count() })
      .from(schema.votes)
      .where(inArray(schema.votes.issueId, issueIds))
      .groupBy(schema.votes.issueId),
  ]);

  // Group collections by issueId
  const labelsByIssue = groupBy(labelRows, (r) => r.issueId);
  const componentsByIssue = groupBy(componentRows, (r) => r.issueId);
  const fixVersionsByIssue = groupBy(fixVersionRows, (r) => r.issueId);
  const affectsVersionsByIssue = groupBy(affectsVersionRows, (r) => r.issueId);
  const subtasksByIssue = groupBy(subtaskRows, (r) => r.parentId!);
  const votesByIssue = new Map(voteCounts.map((v) => [v.issueId, Number(v.count)]));

  // Custom fields and links: two bulk queries instead of two queries per issue.
  const [customFieldsByIssue, linksByIssue] = await Promise.all([getCustomFieldsBulk(issueIds), getIssueLinksBulk(issueIds)]);

  // Build responses preserving input order
  const issueMap = new Map(issues.map((i) => [i.id, i]));
  return issueIds.map((id) => {
    const issue = issueMap.get(id);
    if (!issue) return null;

    const project = projectMap.get(issue.projectId)!;
    const issueType = issueTypeMap.get(issue.issueTypeId)!;
    const status = statusMap.get(issue.statusId)!;
    const priority = issue.priorityId ? priorityMap.get(issue.priorityId) ?? null : null;
    const resolution = issue.resolutionId ? resolutionMap.get(issue.resolutionId) ?? null : null;
    const assignee = issue.assigneeId ? assigneeMap.get(issue.assigneeId) ?? null : null;
    const reporter = reporterMap.get(issue.reporterId)!;

    const cfMap: Record<string, any> = {};
    for (const cf of customFieldsByIssue.get(id) ?? []) {
      cfMap[cf.id] = cf.value;
    }

    const links = linksByIssue.get(id);

    return {
      id: issue.id,
      key: issue.issueKey,
      self: `/rest/api/2/issue/${issue.issueKey}`,
      fields: {
        summary: issue.summary,
        description: issue.description,
        status: { id: status.id, name: status.name, category: status.category, color: status.color },
        issuetype: { id: issueType.id, name: issueType.name, iconUrl: issueType.iconUrl, subtask: issueType.isSubtask },
        priority: priority ? { id: priority.id, name: priority.name, color: priority.color } : null,
        resolution: resolution ? { id: resolution.id, name: resolution.name } : null,
        assignee: assignee ? { id: assignee.id, displayName: assignee.displayName, avatarUrl: assignee.avatarUrl, ...(assignee.username.startsWith('agent:') ? { isAgent: true } : {}) } : null,
        reporter: { id: reporter.id, displayName: reporter.displayName, avatarUrl: reporter.avatarUrl },
        project: { id: project.id, key: project.projectKey, name: project.name },
        created: issue.createdAt!.toISOString(),
        updated: issue.updatedAt!.toISOString(),
        resolved: issue.resolvedAt?.toISOString() || null,
        duedate: issue.dueDate?.toISOString().split('T')[0] || null,
        startdate: issue.startDate?.toISOString().split('T')[0] || null,
        storyPoints: issue.storyPoints === null || issue.storyPoints === undefined ? null : Number(issue.storyPoints),
        flagged: issue.flagged === true,
        environment: issue.environment,
        security: issue.securityLevelId ? levelMap.get(issue.securityLevelId) ?? null : null,
        labels: (labelsByIssue.get(id) ?? []).map((l) => l.name),
        labelDetails: (labelsByIssue.get(id) ?? []).map((l) => ({ name: l.name, color: l.color, removeOnResolve: l.removeOnResolve })),
        components: componentsByIssue.get(id) ?? [],
        fixVersions: fixVersionsByIssue.get(id) ?? [],
        versions: affectsVersionsByIssue.get(id) ?? [],
        timeestimate: issue.timeEstimate,
        timespent: issue.timeSpent,
        parent: issue.parentId ? { id: issue.parentId } : null,
        subtasks: (subtasksByIssue.get(id) ?? []).map((s) => ({
          id: s.id,
          key: s.key,
          summary: s.summary,
          status: { id: s.statusId },
        })),
        votes: { votes: votesByIssue.get(id) ?? 0, hasVoted: false },
        ...cfMap,
        issuelinks: [
          ...(links?.inward ?? []).map((l: any) => ({ id: l.id, type: l.type, inwardIssue: l.issue, ...(l.dependency ? { dependency: l.dependency } : {}) })),
          ...(links?.outward ?? []).map((l: any) => ({ id: l.id, type: l.type, outwardIssue: l.issue, ...(l.dependency ? { dependency: l.dependency } : {}) })),
        ],
      },
    } as IssueResponse;
  }).filter(Boolean) as IssueResponse[];
}

export type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
export type IssueChange = { field: string; oldValue: string | null; newValue: string | null };

/**
 * The write part of an issue edit: field changes, label/component/version tables, custom fields, history rows and the
 * "remove labels on resolution" rule. Runs on `ex`, so a workflow transition can apply its screen fields in the SAME
 * transaction as the status change (same history, no second implementation). Side effects (automation, caches, the
 * response) stay in updateIssue.
 */
export async function applyIssueUpdate(ex: Executor, issueId: number, data: UpdateIssueRequest, userId: number): Promise<{ changes: IssueChange[]; issueKey: string }> {
  const issue = (await ex.select().from(schema.issues).where(eq(schema.issues.id, issueId)).limit(1))[0];
  if (!issue) throw new Error('Issue not found');

  const changes: Array<{ field: string; oldValue: string | null; newValue: string | null }> = [];
  const updateData: Partial<typeof schema.issues.$inferInsert> = { updatedAt: new Date() };

  if (data.summary !== undefined && data.summary !== issue.summary) {
    changes.push({ field: 'summary', oldValue: issue.summary, newValue: data.summary });
    updateData.summary = data.summary;
  }
  if (data.description !== undefined && data.description !== issue.description) {
    changes.push({ field: 'description', oldValue: issue.description || null, newValue: data.description || null });
    updateData.description = data.description;
  }
  if (data.priorityId !== undefined && data.priorityId !== issue.priorityId) {
    await assertPriorityAllowed(issue.projectId, data.priorityId, ex);
    const oldP = issue.priorityId
      ? (await ex.select().from(schema.priorities).where(eq(schema.priorities.id, issue.priorityId)).limit(1))[0]
      : null;
    const newP = data.priorityId
      ? (await ex.select().from(schema.priorities).where(eq(schema.priorities.id, data.priorityId)).limit(1))[0]
      : null;
    changes.push({ field: 'priority', oldValue: oldP?.name || null, newValue: newP?.name || null });
    updateData.priorityId = data.priorityId;
  }
  if (data.assigneeId !== undefined && data.assigneeId !== issue.assigneeId) {
    const oldA = issue.assigneeId
      ? (await ex.select().from(schema.users).where(eq(schema.users.id, issue.assigneeId)).limit(1))[0]
      : null;
    const newA = data.assigneeId
      ? (await ex.select().from(schema.users).where(eq(schema.users.id, data.assigneeId)).limit(1))[0]
      : null;
    changes.push({
      field: 'assignee',
      oldValue: oldA ? `${oldA.id}:${oldA.displayName}` : null,
      newValue: newA ? `${newA.id}:${newA.displayName}` : null,
    });
    updateData.assigneeId = data.assigneeId;
  }
  if (data.statusId !== undefined && data.statusId !== issue.statusId) {
    const oldS = (await ex.select().from(schema.statuses).where(eq(schema.statuses.id, issue.statusId)).limit(1))[0];
    const newS = (await ex.select().from(schema.statuses).where(eq(schema.statuses.id, data.statusId)).limit(1))[0];
    changes.push({ field: 'status', oldValue: oldS.name, newValue: newS.name });
    updateData.statusId = data.statusId;
  }
  if (data.resolutionId !== undefined && data.resolutionId !== issue.resolutionId) {
    const oldR = issue.resolutionId
      ? (await ex.select().from(schema.resolutions).where(eq(schema.resolutions.id, issue.resolutionId)).limit(1))[0]
      : null;
    const newR = data.resolutionId
      ? (await ex.select().from(schema.resolutions).where(eq(schema.resolutions.id, data.resolutionId)).limit(1))[0]
      : null;
    changes.push({ field: 'resolution', oldValue: oldR?.name || null, newValue: newR?.name || null });
    updateData.resolutionId = data.resolutionId;
    if (data.resolutionId) updateData.resolvedAt = new Date();
    else updateData.resolvedAt = null;
  }
  if (data.dueDate !== undefined) {
    const oldDue = issue.dueDate ? issue.dueDate.toISOString().split('T')[0] : null;
    const newDue = data.dueDate ? data.dueDate : null;
    if (oldDue !== newDue) {
      changes.push({ field: 'duedate', oldValue: oldDue, newValue: newDue });
      updateData.dueDate = data.dueDate ? new Date(data.dueDate) : null;
    }
  }
  if (data.startDate !== undefined) {
    const oldStart = issue.startDate ? issue.startDate.toISOString().split('T')[0] : null;
    const newStart = data.startDate ? data.startDate : null;
    if (oldStart !== newStart) {
      changes.push({ field: 'startdate', oldValue: oldStart, newValue: newStart });
      updateData.startDate = data.startDate ? new Date(data.startDate) : null;
    }
  }
  if (data.storyPoints !== undefined) {
    const next = data.storyPoints === null ? null : validateStoryPoints(data.storyPoints);
    const prev = issue.storyPoints === null ? null : Number(issue.storyPoints);
    if (next !== prev) {
      changes.push({
        field: 'storypoints',
        oldValue: prev === null ? null : String(prev),
        newValue: next === null ? null : String(next),
      });
      updateData.storyPoints = next === null ? null : next.toFixed(2);
    }
  }
  if (data.flagged !== undefined && data.flagged !== issue.flagged) {
    // History keeps Jira's wording: "Flagged" goes from empty to "Impediment" and back.
    changes.push({ field: 'flagged', oldValue: issue.flagged ? 'Impediment' : null, newValue: data.flagged ? 'Impediment' : null });
    updateData.flagged = data.flagged;
  }
  if (data.environment !== undefined && data.environment !== issue.environment) {
    changes.push({ field: 'environment', oldValue: issue.environment || null, newValue: data.environment || null });
    updateData.environment = data.environment;
  }
  if (data.timeEstimate !== undefined && data.timeEstimate !== issue.timeEstimate) {
    changes.push({
      field: 'timeestimate',
      oldValue: String(issue.timeEstimate ?? null),
      newValue: String(data.timeEstimate ?? null),
    });
    updateData.timeEstimate = data.timeEstimate;
  }
  if (data.timeSpent !== undefined && data.timeSpent !== issue.timeSpent) {
    changes.push({
      field: 'timespent',
      oldValue: String(issue.timeSpent ?? null),
      newValue: String(data.timeSpent ?? null),
    });
    updateData.timeSpent = data.timeSpent;
  }
  if (data.securityLevelId !== undefined) {
    const next = await resolveLevelForProject(issue.projectId, data.securityLevelId);
    if (next !== issue.securityLevelId) {
      const names = new Map(
        (await ex.select({ id: schema.issueSecurityLevels.id, name: schema.issueSecurityLevels.name }).from(schema.issueSecurityLevels)
          .where(inArray(schema.issueSecurityLevels.id, [issue.securityLevelId, next].filter((x): x is number => x !== null) as number[]))).map((l) => [l.id, l.name]),
      );
      changes.push({ field: 'security', oldValue: issue.securityLevelId ? names.get(issue.securityLevelId) ?? null : null, newValue: next ? names.get(next) ?? null : null });
      updateData.securityLevelId = next;
      // Sub-tasks always carry the level of their parent.
      const subs = await ex.update(schema.issues).set({ securityLevelId: next }).where(eq(schema.issues.parentId, issueId)).returning({ key: schema.issues.issueKey });
      for (const sub of subs) await invalidateIssueKeyCache(sub.key);
    }
  }
  if (data.parentId !== undefined && data.parentId !== issue.parentId) {
    if (data.parentId) {
      const parentRows = await ex.select().from(schema.issues).where(eq(schema.issues.id, data.parentId)).limit(1);
      if (parentRows.length === 0) throw new Error('Parent issue not found');
      const parent = parentRows[0];
      if (parent.projectId !== issue.projectId) throw new Error('Parent must be in the same project');
      const parentType = await ex.select().from(schema.issueTypes).where(eq(schema.issueTypes.id, parent.issueTypeId)).limit(1);
      if (parentType.length > 0 && parentType[0].isSubtask) throw new Error('Parent cannot be a sub-task');
    }
    changes.push({
      field: 'parent',
      oldValue: issue.parentId ? String(issue.parentId) : null,
      newValue: data.parentId ? String(data.parentId) : null,
    });
    updateData.parentId = data.parentId ?? null;
  }

  if (Object.keys(updateData).length > 1) {
    await ex.update(schema.issues).set(updateData).where(eq(schema.issues.id, issueId));
  }

  // Track labels changes
  if (data.labels !== undefined) {
    const currentLabelRows = await db
      .select({ name: schema.labels.name })
      .from(schema.issueLabels)
      .innerJoin(schema.labels, eq(schema.labels.id, schema.issueLabels.labelId))
      .where(eq(schema.issueLabels.issueId, issueId));
    const currentLabels = currentLabelRows.map((l) => l.name).sort();
    const newLabels = [...data.labels].sort();
    if (JSON.stringify(currentLabels) !== JSON.stringify(newLabels)) {
      await ex.delete(schema.issueLabels).where(eq(schema.issueLabels.issueId, issueId));
      for (const labelName of data.labels) {
        const labelId = await ensureLabelId(labelName);
        await ex.insert(schema.issueLabels).values({ issueId, labelId }).onConflictDoNothing();
      }
      changes.push({ field: 'labels', oldValue: currentLabels.join(','), newValue: newLabels.join(',') });
    }
  }

  // Track components changes
  if (data.components !== undefined) {
    const currentComponentRows = await db
      .select({ id: schema.components.id })
      .from(schema.issueComponents)
      .innerJoin(schema.components, eq(schema.components.id, schema.issueComponents.componentId))
      .where(eq(schema.issueComponents.issueId, issueId));
    const currentComponents = currentComponentRows.map((c) => c.id).sort((a, b) => a - b);
    const newComponents = [...data.components].sort((a, b) => a - b);
    if (JSON.stringify(currentComponents) !== JSON.stringify(newComponents)) {
      await ex.delete(schema.issueComponents).where(eq(schema.issueComponents.issueId, issueId));
      for (const cid of data.components) {
        await ex.insert(schema.issueComponents).values({ issueId, componentId: cid }).onConflictDoNothing();
      }
      changes.push({ field: 'components', oldValue: currentComponents.join(','), newValue: newComponents.join(',') });
    }
  }

  // Track fixVersions changes
  if (data.fixVersions !== undefined) {
    const currentRows = await db
      .select({ id: schema.versions.id })
      .from(schema.issueFixVersions)
      .innerJoin(schema.versions, eq(schema.versions.id, schema.issueFixVersions.versionId))
      .where(eq(schema.issueFixVersions.issueId, issueId));
    const currentIds = currentRows.map((r) => r.id).sort((a, b) => a - b);
    const newIds = [...data.fixVersions].sort((a, b) => a - b);
    if (JSON.stringify(currentIds) !== JSON.stringify(newIds)) {
      await ex.delete(schema.issueFixVersions).where(eq(schema.issueFixVersions.issueId, issueId));
      for (const vid of data.fixVersions) {
        await ex.insert(schema.issueFixVersions).values({ issueId, versionId: vid }).onConflictDoNothing();
      }
      changes.push({ field: 'fixVersions', oldValue: currentIds.join(','), newValue: newIds.join(',') });
    }
  }

  // Track affectsVersions changes
  if (data.affectsVersions !== undefined) {
    const currentRows = await db
      .select({ id: schema.versions.id })
      .from(schema.issueAffectsVersions)
      .innerJoin(schema.versions, eq(schema.versions.id, schema.issueAffectsVersions.versionId))
      .where(eq(schema.issueAffectsVersions.issueId, issueId));
    const currentIds = currentRows.map((r) => r.id).sort((a, b) => a - b);
    const newIds = [...data.affectsVersions].sort((a, b) => a - b);
    if (JSON.stringify(currentIds) !== JSON.stringify(newIds)) {
      await ex.delete(schema.issueAffectsVersions).where(eq(schema.issueAffectsVersions.issueId, issueId));
      for (const vid of data.affectsVersions) {
        await ex.insert(schema.issueAffectsVersions).values({ issueId, versionId: vid }).onConflictDoNothing();
      }
      changes.push({ field: 'versions', oldValue: currentIds.join(','), newValue: newIds.join(',') });
    }
  }

  // Track custom fields changes
  if (data.customFields !== undefined && data.customFields.length > 0) {
    const oldCustomFields = await getCustomFields(issueId);
    await setCustomFields(issueId, data.customFields, ex);
    for (const cf of data.customFields) {
      const oldCf = oldCustomFields.find((o) => o.id === `customfield_${cf.fieldId}`);
      const oldVal = oldCf ? String(oldCf.value ?? '') : '';
      const newVal = cf.value !== null && cf.value !== undefined ? String(cf.value) : '';
      if (oldVal !== newVal) {
        changes.push({ field: `customfield_${cf.fieldId}`, oldValue: oldVal, newValue: newVal });
      }
    }
  }

  // Insert history
  for (const change of changes) {
    await ex.insert(schema.issueHistory).values({
      issueId,
      fieldName: change.field,
      oldValue: change.oldValue,
      newValue: change.newValue,
      authorId: userId,
    });
  }

  // Resolving the issue (done status or resolution set) detaches labels flagged 'remove on resolution'.
  // The helper writes its own history row, after the status/resolution rows above.
  const resolutionSet = changes.some((ch) => ch.field === 'resolution' && ch.newValue);
  if (resolutionSet || changes.some((ch) => ch.field === 'status')) {
    await removeResolutionLabelsIfResolved(issueId, userId, ex, { viaResolution: resolutionSet });
  }

  return { changes, issueKey: issue.issueKey };
}

export async function updateIssue(issueId: number, data: UpdateIssueRequest, userId: number): Promise<IssueResponse> {
  const { changes, issueKey } = await applyIssueUpdate(db, issueId, data, userId);
  const { emitIssueUpdated } = await import('../services/automation-engine');
  await emitIssueUpdated(issueId, userId, changes);

  await invalidateIssueKeyCache(issueKey);
  return buildIssueResponse(issueId);
}
