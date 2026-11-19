import { db } from '../db';
import * as schema from '@veqsio/db';
import { eq, sql } from 'drizzle-orm';
import { getRedisClient } from '../services/redis-client';
import { streamEntities, analyzeBackup, type BackupStats } from './parser';
export type { BackupStats };

const redis = getRedisClient();

const MIGRATION_PREFIX = 'veqsio:migration:';
const MIGRATION_TTL = 7 * 24 * 60 * 60; // 7 days

export type ConflictType =
  | 'duplicate_project_key'
  | 'duplicate_username'
  | 'duplicate_email'
  | 'missing_required_field'
  | 'duplicate_issue_key'
  | 'duplicate_group_name'
  | 'invalid_reference';

export interface MigrationConflict {
  id: string;
  type: ConflictType;
  entityType: string;
  sourceId?: string;
  sourceKey?: string;
  message: string;
  resolution?: 'skip' | 'overwrite' | 'rename';
  suggestedRename?: string;
}

export interface MigrationOptions {
  skipUsers?: boolean;
  skipGroups?: boolean;
  skipProjects?: boolean;
  skipIssues?: boolean;
  skipComments?: boolean;
  skipAttachments?: boolean;
  skipWorkflows?: boolean;
  skipCustomFields?: boolean;
  skipIssueLinks?: boolean;
  skipComponents?: boolean;
  skipVersions?: boolean;
  skipFilters?: boolean;
  skipDashboards?: boolean;
  skipPermissionSchemes?: boolean;
  conflictResolution?: Record<string, 'skip' | 'overwrite' | 'rename'>;
  onProgress?: (progress: MigrationProgress) => void | Promise<void>;
}

export interface MigrationProgress {
  sessionId: number;
  status: 'pending' | 'analyzing' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  phase: string;
  totalEntities: number;
  processedEntities: number;
  currentEntityType: string;
  errors: string[];
  conflictsResolved: number;
  conflictsTotal: number;
}

export interface MigrationResult {
  sessionId: number;
  status: 'completed' | 'failed' | 'paused' | 'cancelled';
  stats: Partial<BackupStats>;
  errors: string[];
  conflicts: MigrationConflict[];
}

interface Checkpoint {
  processedTags: Set<string>;
  entityCounts: Record<string, number>;
  idMaps: Record<string, Record<string, number>>;
  issueKeyToId: Record<string, number>;
  lastLine?: number;
}

async function getCheckpoint(sessionId: number): Promise<Checkpoint | null> {
  const raw = await redis.get(`${MIGRATION_PREFIX}checkpoint:${sessionId}`);
  if (!raw) return null;
  const parsed = JSON.parse(raw);
  return {
    processedTags: new Set(parsed.processedTags || []),
    entityCounts: parsed.entityCounts || {},
    idMaps: parsed.idMaps || {},
    issueKeyToId: parsed.issueKeyToId || {},
    lastLine: parsed.lastLine,
  };
}

async function saveCheckpoint(sessionId: number, checkpoint: Checkpoint): Promise<void> {
  await redis.setex(
    `${MIGRATION_PREFIX}checkpoint:${sessionId}`,
    MIGRATION_TTL,
    JSON.stringify({
      processedTags: Array.from(checkpoint.processedTags),
      entityCounts: checkpoint.entityCounts,
      idMaps: checkpoint.idMaps,
      issueKeyToId: checkpoint.issueKeyToId,
      lastLine: checkpoint.lastLine,
    })
  );
}

async function updateSessionProgress(
  sessionId: number,
  progress: Partial<MigrationProgress>
): Promise<void> {
  const session = await db
    .select()
    .from(schema.migrationSessions)
    .where(eq(schema.migrationSessions.id, sessionId))
    .limit(1);

  if (session.length === 0) return;

  const current = session[0];
  const merged: MigrationProgress = {
    sessionId,
    status: (progress.status ?? current.status) as MigrationProgress['status'],
    phase: progress.phase ?? 'importing',
    totalEntities: progress.totalEntities ?? current.totalEntities ?? 0,
    processedEntities: progress.processedEntities ?? current.processedEntities ?? 0,
    currentEntityType: progress.currentEntityType ?? '',
    errors: progress.errors ?? (current.errors as string[]) ?? [],
    conflictsResolved: progress.conflictsResolved ?? 0,
    conflictsTotal: progress.conflictsTotal ?? 0,
  };

  await redis.setex(`${MIGRATION_PREFIX}progress:${sessionId}`, MIGRATION_TTL, JSON.stringify(merged));

  await db
    .update(schema.migrationSessions)
    .set({
      status: merged.status,
      totalEntities: merged.totalEntities,
      processedEntities: merged.processedEntities,
      errors: merged.errors,
    })
    .where(eq(schema.migrationSessions.id, sessionId));
}

async function isPaused(sessionId: number): Promise<boolean> {
  const raw = await redis.get(`${MIGRATION_PREFIX}progress:${sessionId}`);
  if (!raw) return false;
  const p = JSON.parse(raw) as MigrationProgress;
  return p.status === 'paused';
}

async function isCancelled(sessionId: number): Promise<boolean> {
  const raw = await redis.get(`${MIGRATION_PREFIX}cancel:${sessionId}`);
  return raw === 'true';
}

async function checkPause(sessionId: number): Promise<void> {
  if (await isPaused(sessionId)) {
    throw new MigrationPauseError('Migration paused by user');
  }
  if (await isCancelled(sessionId)) {
    throw new MigrationCancelError('Migration cancelled by user');
  }
}

class MigrationPauseError extends Error {}
class MigrationCancelError extends Error {}

// Jira status category mapping to Veqsio schema
function mapStatusCategory(jiraCategory?: string): string {
  if (!jiraCategory) return 'todo';
  const normalized = jiraCategory.trim().toLowerCase().replace(/\s+/g, '_').replace(/-/g, '_');
  const map: Record<string, string> = {
    '1': 'todo',
    '2': 'in_progress',
    '3': 'done',
    'todo': 'todo',
    'in_progress': 'in_progress',
    'done': 'done',
    'to_do': 'todo',
    'complete': 'done',
    'completed': 'done',
    'resolved': 'done',
    'closed': 'done',
    'open': 'todo',
    'reopened': 'todo',
  };
  return map[normalized] || map[jiraCategory.trim().toLowerCase()] || 'todo';
}

// --- Conflict detection helpers ---

async function detectConflicts(xmlPath: string): Promise<MigrationConflict[]> {
  const conflicts: MigrationConflict[] = [];
  const seenProjectKeys = new Set<string>();
  const seenUsernames = new Set<string>();
  const seenEmails = new Set<string>();
  const seenGroupNames = new Set<string>();
  const seenIssueKeys = new Set<string>();

  const [existingProjects, existingUsers, existingGroups, existingIssues] = await Promise.all([
    db.select({ projectKey: schema.projects.projectKey }).from(schema.projects),
    db.select({ username: schema.users.username, email: schema.users.email }).from(schema.users),
    db.select({ name: schema.groups.name }).from(schema.groups),
    db.select({ issueKey: schema.issues.issueKey }).from(schema.issues),
  ]);

  const existingProjectKeys = new Set(existingProjects.map((p) => p.projectKey));
  const existingUsernames = new Set(existingUsers.map((u) => u.username));
  const existingEmails = new Set(existingUsers.map((u) => u.email));
  const existingGroupNames = new Set(existingGroups.map((g) => g.name));
  const existingIssueKeys = new Set(existingIssues.map((i) => i.issueKey));

  for await (const entity of streamEntities(xmlPath)) {
    switch (entity.tag) {
      case 'Project': {
        const key = String(entity.attributes.key || entity.attributes.pkey || '');
        if (key) {
          if (existingProjectKeys.has(key)) {
            conflicts.push({
              id: `proj-${key}`,
              type: 'duplicate_project_key',
              entityType: 'Project',
              sourceKey: key,
              message: `Project key "${key}" already exists.`,
              suggestedRename: `${key}-MIGRATED`,
            });
          } else if (seenProjectKeys.has(key)) {
            conflicts.push({
              id: `proj-dup-${key}`,
              type: 'duplicate_project_key',
              entityType: 'Project',
              sourceKey: key,
              message: `Duplicate project key "${key}" in backup.`,
              suggestedRename: `${key}-MIGRATED`,
            });
          }
          seenProjectKeys.add(key);
        }
        break;
      }
      case 'User': {
        const username = String(entity.attributes.userName || entity.attributes.username || '');
        const email = String(entity.attributes.emailAddress || entity.attributes.email || '');
        if (username) {
          if (existingUsernames.has(username)) {
            conflicts.push({
              id: `user-${username}`,
              type: 'duplicate_username',
              entityType: 'User',
              sourceKey: username,
              message: `Username "${username}" already exists.`,
              suggestedRename: `${username}-migrated`,
            });
          }
          seenUsernames.add(username);
        }
        if (email) {
          if (existingEmails.has(email)) {
            conflicts.push({
              id: `email-${email}`,
              type: 'duplicate_email',
              entityType: 'User',
              sourceKey: email,
              message: `Email "${email}" already exists.`,
            });
          }
          seenEmails.add(email);
        }
        break;
      }
      case 'Group': {
        const name = String(entity.attributes.groupName || entity.attributes.name || '');
        if (name) {
          if (existingGroupNames.has(name)) {
            conflicts.push({
              id: `group-${name}`,
              type: 'duplicate_group_name',
              entityType: 'Group',
              sourceKey: name,
              message: `Group name "${name}" already exists.`,
            });
          }
          seenGroupNames.add(name);
        }
        break;
      }
      case 'Issue': {
        const issueKey = String(entity.attributes.key || '');
        if (issueKey) {
          if (existingIssueKeys.has(issueKey)) {
            conflicts.push({
              id: `issue-${issueKey}`,
              type: 'duplicate_issue_key',
              entityType: 'Issue',
              sourceKey: issueKey,
              message: `Issue key "${issueKey}" already exists.`,
            });
          }
          seenIssueKeys.add(issueKey);
        }
        break;
      }
    }
  }

  return conflicts;
}

// --- Entity import functions ---

async function importUsers(
  xmlPath: string,
  sessionId: number,
  checkpoint: Checkpoint,
  options: MigrationOptions
): Promise<Checkpoint> {
  if (options.skipUsers) return checkpoint;
  const idMap: Record<string, number> = checkpoint.idMaps.users || {};

  for await (const entity of streamEntities(xmlPath)) {
    if (entity.tag !== 'User') continue;
    await checkPause(sessionId);

    const username = String(entity.attributes.userName || entity.attributes.username || '');
    const email = String(entity.attributes.emailAddress || entity.attributes.email || '');
    if (!username) continue;

    const conflictKey = `user-${username}`;
    const resolution = options.conflictResolution?.[conflictKey] || 'skip';

    const existing = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.username, username))
      .limit(1);

    if (existing.length > 0) {
      if (resolution === 'skip') continue;
      if (resolution === 'rename') {
        // Handled below by modifying username
      } else if (resolution === 'overwrite') {
        await db
          .update(schema.users)
          .set({
            email: email || existing[0].email,
            displayName: String(entity.attributes.displayName || entity.attributes.fullName || username),
            active: entity.attributes.active !== 'false',
            updatedAt: new Date(),
          })
          .where(eq(schema.users.id, existing[0].id));
        idMap[String(entity.attributes.id || username)] = existing[0].id;
        continue;
      }
    }

    const finalUsername = resolution === 'rename' && existing.length > 0 ? `${username}-migrated` : username;

    const [user] = await db
      .insert(schema.users)
      .values({
        username: finalUsername,
        email: email || `${finalUsername}@migrated.local`,
        displayName: String(entity.attributes.displayName || entity.attributes.fullName || finalUsername),
        passwordHash: '$2a$10$placeholder', // Users must reset password
        active: entity.attributes.active !== 'false',
        timezone: String(entity.attributes.timeZone || 'UTC'),
      })
      .returning();

    idMap[String(entity.attributes.id || username)] = user.id;
  }

  checkpoint.idMaps.users = idMap;
  return checkpoint;
}

async function importGroups(
  xmlPath: string,
  sessionId: number,
  checkpoint: Checkpoint,
  options: MigrationOptions
): Promise<Checkpoint> {
  if (options.skipGroups) return checkpoint;
  const idMap: Record<string, number> = checkpoint.idMaps.groups || {};

  for await (const entity of streamEntities(xmlPath)) {
    if (entity.tag !== 'Group') continue;
    await checkPause(sessionId);

    const name = String(entity.attributes.groupName || entity.attributes.name || '');
    if (!name) continue;

    const existing = await db.select().from(schema.groups).where(eq(schema.groups.name, name)).limit(1);
    if (existing.length > 0) {
      idMap[String(entity.attributes.id || name)] = existing[0].id;
      continue;
    }

    const [group] = await db
      .insert(schema.groups)
      .values({
        name,
        description: String(entity.attributes.description || ''),
      })
      .returning();

    idMap[String(entity.attributes.id || name)] = group.id;
  }

  checkpoint.idMaps.groups = idMap;
  return checkpoint;
}

async function importMemberships(
  xmlPath: string,
  sessionId: number,
  checkpoint: Checkpoint,
  options: MigrationOptions
): Promise<Checkpoint> {
  if (options.skipGroups || options.skipUsers) return checkpoint;
  const userMap = checkpoint.idMaps.users || {};
  const groupMap = checkpoint.idMaps.groups || {};

  for await (const entity of streamEntities(xmlPath)) {
    if (entity.tag !== 'Membership' && entity.tag !== 'GroupRelation') continue;
    await checkPause(sessionId);

    const userId = userMap[String(entity.attributes.userName || entity.attributes.userId || '')];
    const groupId = groupMap[String(entity.attributes.groupName || entity.attributes.groupId || '')];
    if (!userId || !groupId) continue;

    const existing = await db
      .select()
      .from(schema.userGroups)
      .where(eq(schema.userGroups.userId, userId))
      .limit(1);

    if (existing.find((r) => r.groupId === groupId)) continue;

    await db.insert(schema.userGroups).values({ userId, groupId });
  }

  return checkpoint;
}

async function importProjects(
  xmlPath: string,
  sessionId: number,
  checkpoint: Checkpoint,
  options: MigrationOptions
): Promise<Checkpoint> {
  if (options.skipProjects) return checkpoint;
  const idMap: Record<string, number> = checkpoint.idMaps.projects || {};
  const userMap = checkpoint.idMaps.users || {};

  for await (const entity of streamEntities(xmlPath)) {
    if (entity.tag !== 'Project') continue;
    await checkPause(sessionId);

    const key = String(entity.attributes.key || entity.attributes.pkey || '');
    const name = String(entity.attributes.pname || entity.attributes.name || key);
    if (!key) continue;

    const conflictKey = `proj-${key}`;
    const resolution = options.conflictResolution?.[conflictKey] || 'skip';
    const existing = await db.select().from(schema.projects).where(eq(schema.projects.projectKey, key)).limit(1);

    if (existing.length > 0) {
      if (resolution === 'skip') {
        idMap[String(entity.attributes.id || key)] = existing[0].id;
        continue;
      }
      if (resolution === 'overwrite') {
        await db
          .update(schema.projects)
          .set({ name, description: String(entity.attributes.description || ''), updatedAt: new Date() })
          .where(eq(schema.projects.id, existing[0].id));
        idMap[String(entity.attributes.id || key)] = existing[0].id;
        continue;
      }
    }

    const finalKey = resolution === 'rename' && existing.length > 0 ? `${key}-MIGRATED` : key;

    const leadId = userMap[String(entity.attributes.lead || '')];

    const [project] = await db
      .insert(schema.projects)
      .values({
        projectKey: finalKey,
        name,
        description: String(entity.attributes.description || ''),
        leadId,
        category: String(entity.attributes.projectCategory || ''),
      })
      .returning();

    idMap[String(entity.attributes.id || key)] = project.id;
  }

  checkpoint.idMaps.projects = idMap;
  return checkpoint;
}

async function importIssueTypes(
  xmlPath: string,
  sessionId: number,
  checkpoint: Checkpoint,
  options: MigrationOptions
): Promise<Checkpoint> {
  if (options.skipIssues) return checkpoint;
  const idMap: Record<string, number> = checkpoint.idMaps.issueTypes || {};

  for await (const entity of streamEntities(xmlPath)) {
    if (entity.tag !== 'IssueType') continue;
    await checkPause(sessionId);

    const name = String(entity.attributes.pname || entity.attributes.name || '');
    if (!name) continue;

    const existing = await db.select().from(schema.issueTypes).where(eq(schema.issueTypes.name, name)).limit(1);
    if (existing.length > 0) {
      idMap[String(entity.attributes.id || name)] = existing[0].id;
      continue;
    }

    const [issueType] = await db
      .insert(schema.issueTypes)
      .values({
        name,
        description: String(entity.attributes.description || ''),
        iconUrl: String(entity.attributes.iconUrl || ''),
        isSubtask: entity.attributes.isSubTask === 'true',
        color: String(entity.attributes.color || '#0052CC'),
      })
      .returning();

    idMap[String(entity.attributes.id || name)] = issueType.id;
  }

  checkpoint.idMaps.issueTypes = idMap;
  return checkpoint;
}

async function importStatuses(
  xmlPath: string,
  sessionId: number,
  checkpoint: Checkpoint,
  options: MigrationOptions
): Promise<Checkpoint> {
  if (options.skipIssues && options.skipWorkflows) return checkpoint;
  const idMap: Record<string, number> = checkpoint.idMaps.statuses || {};

  for await (const entity of streamEntities(xmlPath)) {
    if (entity.tag !== 'Status') continue;
    await checkPause(sessionId);

    const name = String(entity.attributes.name || '');
    if (!name) continue;

    const existing = await db.select().from(schema.statuses).where(eq(schema.statuses.name, name)).limit(1);
    if (existing.length > 0) {
      idMap[String(entity.attributes.id || name)] = existing[0].id;
      continue;
    }

    const [status] = await db
      .insert(schema.statuses)
      .values({
        name,
        description: String(entity.attributes.description || ''),
        category: mapStatusCategory(String(entity.attributes.statusCategory || '')),
        color: String(entity.attributes.color || '#666666'),
        sortOrder: parseInt(String(entity.attributes.sequence || '0'), 10),
      })
      .returning();

    idMap[String(entity.attributes.id || name)] = status.id;
  }

  checkpoint.idMaps.statuses = idMap;
  return checkpoint;
}

async function importPriorities(
  xmlPath: string,
  sessionId: number,
  checkpoint: Checkpoint,
  options: MigrationOptions
): Promise<Checkpoint> {
  if (options.skipIssues) return checkpoint;
  const idMap: Record<string, number> = checkpoint.idMaps.priorities || {};

  for await (const entity of streamEntities(xmlPath)) {
    if (entity.tag !== 'Priority') continue;
    await checkPause(sessionId);

    const name = String(entity.attributes.pname || entity.attributes.name || '');
    if (!name) continue;

    const existing = await db.select().from(schema.priorities).where(eq(schema.priorities.name, name)).limit(1);
    if (existing.length > 0) {
      idMap[String(entity.attributes.id || name)] = existing[0].id;
      continue;
    }

    const [priority] = await db
      .insert(schema.priorities)
      .values({
        name,
        description: String(entity.attributes.description || ''),
        iconUrl: String(entity.attributes.iconUrl || ''),
        color: String(entity.attributes.color || '#666666'),
        sortOrder: parseInt(String(entity.attributes.sequence || '0'), 10),
      })
      .returning();

    idMap[String(entity.attributes.id || name)] = priority.id;
  }

  checkpoint.idMaps.priorities = idMap;
  return checkpoint;
}

async function importResolutions(
  xmlPath: string,
  sessionId: number,
  checkpoint: Checkpoint,
  options: MigrationOptions
): Promise<Checkpoint> {
  if (options.skipIssues) return checkpoint;
  const idMap: Record<string, number> = checkpoint.idMaps.resolutions || {};

  for await (const entity of streamEntities(xmlPath)) {
    if (entity.tag !== 'Resolution') continue;
    await checkPause(sessionId);

    const name = String(entity.attributes.pname || entity.attributes.name || '');
    if (!name) continue;

    const existing = await db.select().from(schema.resolutions).where(eq(schema.resolutions.name, name)).limit(1);
    if (existing.length > 0) {
      idMap[String(entity.attributes.id || name)] = existing[0].id;
      continue;
    }

    const [resolution] = await db
      .insert(schema.resolutions)
      .values({
        name,
        description: String(entity.attributes.description || ''),
      })
      .returning();

    idMap[String(entity.attributes.id || name)] = resolution.id;
  }

  checkpoint.idMaps.resolutions = idMap;
  return checkpoint;
}

async function importIssues(
  xmlPath: string,
  sessionId: number,
  checkpoint: Checkpoint,
  options: MigrationOptions
): Promise<Checkpoint> {
  if (options.skipIssues) return checkpoint;
  const idMap: Record<string, number> = checkpoint.idMaps.issues || {};
  const projectMap = checkpoint.idMaps.projects || {};
  const issueTypeMap = checkpoint.idMaps.issueTypes || {};
  const statusMap = checkpoint.idMaps.statuses || {};
  const priorityMap = checkpoint.idMaps.priorities || {};
  const resolutionMap = checkpoint.idMaps.resolutions || {};
  const userMap = checkpoint.idMaps.users || {};
  // issues.reporter_id is required: an issue whose reporter was not imported is attributed to the session's creator or the first user
  const [sess] = await db.select({ createdBy: schema.migrationSessions.createdBy }).from(schema.migrationSessions).where(eq(schema.migrationSessions.id, sessionId)).limit(1);
  const fallbackReporterId = sess?.createdBy ?? Object.values(userMap)[0] ?? (await db.select({ id: schema.users.id }).from(schema.users).orderBy(schema.users.id).limit(1))[0]?.id;
  if (fallbackReporterId === undefined) throw new Error('No user available to attribute imported issues to');

  for await (const entity of streamEntities(xmlPath)) {
    if (entity.tag !== 'Issue') continue;
    await checkPause(sessionId);

    const issueKey = String(entity.attributes.key || '');
    const projectId = projectMap[String(entity.attributes.project || '')];
    const issueTypeId = issueTypeMap[String(entity.attributes.type || '')];
    const statusId = statusMap[String(entity.attributes.status || '')];
    const summary = String(entity.attributes.summary || '');

    if (!issueKey || !projectId || !issueTypeId || !statusId || !summary) {
      continue;
    }

    const conflictKey = `issue-${issueKey}`;
    const resolution = options.conflictResolution?.[conflictKey] || 'skip';
    const existing = await db.select().from(schema.issues).where(eq(schema.issues.issueKey, issueKey)).limit(1);

    if (existing.length > 0) {
      if (resolution === 'skip') {
        idMap[String(entity.attributes.id || issueKey)] = existing[0].id;
        continue;
      }
      if (resolution === 'overwrite') {
        await db
          .update(schema.issues)
          .set({
            summary,
            description: String(entity.attributes.description || ''),
            projectId,
            issueTypeId,
            statusId,
            priorityId: priorityMap[String(entity.attributes.priority || '')] || null,
            resolutionId: resolutionMap[String(entity.attributes.resolution || '')] || null,
            assigneeId: userMap[String(entity.attributes.assignee || '')] || null,
            reporterId: userMap[String(entity.attributes.reporter || '')] || undefined,
            updatedAt: new Date(),
          })
          .where(eq(schema.issues.id, existing[0].id));
        idMap[String(entity.attributes.id || issueKey)] = existing[0].id;
        continue;
      }
    }

    const [issue] = await db
      .insert(schema.issues)
      .values({
        issueKey,
        projectId,
        issueTypeId,
        statusId,
        priorityId: priorityMap[String(entity.attributes.priority || '')] || null,
        resolutionId: resolutionMap[String(entity.attributes.resolution || '')] || null,
        summary,
        description: String(entity.attributes.description || ''),
        assigneeId: userMap[String(entity.attributes.assignee || '')] || null,
        reporterId: userMap[String(entity.attributes.reporter || '')] || fallbackReporterId,
        environment: String(entity.attributes.environment || ''),
        createdAt: entity.attributes.created ? new Date(String(entity.attributes.created)) : new Date(),
        updatedAt: entity.attributes.updated ? new Date(String(entity.attributes.updated)) : new Date(),
        resolvedAt: entity.attributes.resolutionDate ? new Date(String(entity.attributes.resolutionDate)) : null,
        dueDate: entity.attributes.duedate ? new Date(String(entity.attributes.duedate)) : null,
        timeEstimate: entity.attributes.timeestimate ? parseInt(String(entity.attributes.timeestimate), 10) : null,
        timeSpent: entity.attributes.timespent ? parseInt(String(entity.attributes.timespent), 10) : null,
      })
      .returning();

    idMap[String(entity.attributes.id || issueKey)] = issue.id;
  }

  // Keep the per-project key generator ahead of imported keys so new issues never collide.
  await db.execute(sql`
    INSERT INTO project_issue_counters (project_id, current_value)
    SELECT i.project_id, max(substring(i.issue_key from '[0-9]+$')::int)
    FROM issues i GROUP BY i.project_id
    ON CONFLICT (project_id) DO UPDATE
      SET current_value = greatest(coalesce(project_issue_counters.current_value, 0), excluded.current_value)
  `);

  checkpoint.idMaps.issues = idMap;
  return checkpoint;
}

async function importComments(
  xmlPath: string,
  sessionId: number,
  checkpoint: Checkpoint,
  options: MigrationOptions
): Promise<Checkpoint> {
  if (options.skipComments) return checkpoint;
  const issueMap = checkpoint.idMaps.issues || {};
  const userMap = checkpoint.idMaps.users || {};

  for await (const entity of streamEntities(xmlPath)) {
    if (entity.tag !== 'Action') continue;
    await checkPause(sessionId);

    const issueId = issueMap[String(entity.attributes.issue || '')];
    if (!issueId) continue;

    const body = entity.children?.body || String(entity.attributes.body || '');
    if (!body) continue;

    await db.insert(schema.comments).values({
      issueId,
      body,
      authorId: userMap[String(entity.attributes.author || '')] || null,
      createdAt: entity.attributes.created ? new Date(String(entity.attributes.created)) : new Date(),
      updatedAt: entity.attributes.updated ? new Date(String(entity.attributes.updated)) : new Date(),
      isInternal: false,
    });
  }

  return checkpoint;
}

async function importAttachments(
  xmlPath: string,
  sessionId: number,
  checkpoint: Checkpoint,
  options: MigrationOptions
): Promise<Checkpoint> {
  if (options.skipAttachments) return checkpoint;
  const issueMap = checkpoint.idMaps.issues || {};
  const userMap = checkpoint.idMaps.users || {};

  for await (const entity of streamEntities(xmlPath)) {
    if (entity.tag !== 'FileAttachment') continue;
    await checkPause(sessionId);

    const issueId = issueMap[String(entity.attributes.issue || '')];
    if (!issueId) continue;

    await db.insert(schema.attachments).values({
      issueId,
      filename: String(entity.attributes.filename || 'unknown'),
      filesize: parseInt(String(entity.attributes.filesize || '0'), 10),
      mimetype: String(entity.attributes.mimetype || 'application/octet-stream'),
      storageKey: String(entity.attributes.id || entity.attributes.fileName || 'unknown'),
      authorId: userMap[String(entity.attributes.author || '')] || null,
      createdAt: entity.attributes.created ? new Date(String(entity.attributes.created)) : new Date(),
    });
  }

  return checkpoint;
}

async function importComponents(
  xmlPath: string,
  sessionId: number,
  checkpoint: Checkpoint,
  options: MigrationOptions
): Promise<Checkpoint> {
  if (options.skipComponents) return checkpoint;
  const idMap: Record<string, number> = checkpoint.idMaps.components || {};
  const projectMap = checkpoint.idMaps.projects || {};
  const userMap = checkpoint.idMaps.users || {};

  for await (const entity of streamEntities(xmlPath)) {
    if (entity.tag !== 'Component') continue;
    await checkPause(sessionId);

    const projectId = projectMap[String(entity.attributes.project || '')];
    if (!projectId) continue;

    const name = String(entity.attributes.cname || entity.attributes.name || '');
    if (!name) continue;

    const [component] = await db
      .insert(schema.components)
      .values({
        projectId,
        name,
        description: String(entity.attributes.description || ''),
        leadId: userMap[String(entity.attributes.lead || '')] || null,
      })
      .returning();

    idMap[String(entity.attributes.id || name)] = component.id;
  }

  checkpoint.idMaps.components = idMap;
  return checkpoint;
}

async function importVersions(
  xmlPath: string,
  sessionId: number,
  checkpoint: Checkpoint,
  options: MigrationOptions
): Promise<Checkpoint> {
  if (options.skipVersions) return checkpoint;
  const idMap: Record<string, number> = checkpoint.idMaps.versions || {};
  const projectMap = checkpoint.idMaps.projects || {};

  for await (const entity of streamEntities(xmlPath)) {
    if (entity.tag !== 'Version') continue;
    await checkPause(sessionId);

    const projectId = projectMap[String(entity.attributes.project || '')];
    if (!projectId) continue;

    const name = String(entity.attributes.vname || entity.attributes.name || '');
    if (!name) continue;

    const [version] = await db
      .insert(schema.versions)
      .values({
        projectId,
        name,
        description: String(entity.attributes.description || ''),
        startDate: entity.attributes.startDate ? String(entity.attributes.startDate) : null,
        releaseDate: entity.attributes.releaseDate ? String(entity.attributes.releaseDate) : null,
        archived: entity.attributes.archived === 'true',
      })
      .returning();

    idMap[String(entity.attributes.id || name)] = version.id;
  }

  checkpoint.idMaps.versions = idMap;
  return checkpoint;
}

async function importIssueLinks(
  xmlPath: string,
  sessionId: number,
  checkpoint: Checkpoint,
  options: MigrationOptions
): Promise<Checkpoint> {
  if (options.skipIssueLinks) return checkpoint;
  const issueMap = checkpoint.idMaps.issues || {};

  for await (const entity of streamEntities(xmlPath)) {
    if (entity.tag !== 'IssueLink') continue;
    await checkPause(sessionId);

    const issueId = issueMap[String(entity.attributes.source || '')];
    const linkedIssueId = issueMap[String(entity.attributes.destination || '')];
    if (!issueId || !linkedIssueId) continue;

    await db.insert(schema.issueLinks).values({
      issueId,
      linkedIssueId,
      linkTypeId: null, // Would need link type mapping
    });
  }

  return checkpoint;
}

async function importCustomFields(
  xmlPath: string,
  sessionId: number,
  checkpoint: Checkpoint,
  options: MigrationOptions
): Promise<Checkpoint> {
  if (options.skipCustomFields) return checkpoint;
  const idMap: Record<string, number> = checkpoint.idMaps.customFields || {};

  for await (const entity of streamEntities(xmlPath)) {
    if (entity.tag !== 'CustomField') continue;
    await checkPause(sessionId);

    const name = String(entity.attributes.cfname || entity.attributes.fieldName || entity.attributes.name || '');
    if (!name) continue;

    const [cf] = await db
      .insert(schema.customFields)
      .values({
        name,
        fieldType: String(entity.attributes.customFieldType || entity.attributes.fieldType || 'text'),
        description: String(entity.attributes.description || ''),
        defaultValue: String(entity.attributes.defaultValue || ''),
        searcherKey: String(entity.attributes.searcherKey || ''),
        isGlobal: entity.attributes.isGlobal !== 'false',
      })
      .returning();

    idMap[String(entity.attributes.id || name)] = cf.id;
  }

  checkpoint.idMaps.customFields = idMap;
  return checkpoint;
}

async function importCustomFieldValues(
  xmlPath: string,
  sessionId: number,
  checkpoint: Checkpoint,
  options: MigrationOptions
): Promise<Checkpoint> {
  if (options.skipCustomFields) return checkpoint;
  const issueMap = checkpoint.idMaps.issues || {};
  const cfMap = checkpoint.idMaps.customFields || {};

  for await (const entity of streamEntities(xmlPath)) {
    if (entity.tag !== 'CustomFieldValue') continue;
    await checkPause(sessionId);

    const issueId = issueMap[String(entity.attributes.issue || '')];
    const customFieldId = cfMap[String(entity.attributes.customField || '')];
    if (!issueId || !customFieldId) continue;

    const stringValue = String(entity.attributes.stringValue || entity.attributes.value || '');
    const numberValue = entity.attributes.numberValue ? String(entity.attributes.numberValue) : null;
    const dateValue = entity.attributes.dateValue ? new Date(String(entity.attributes.dateValue)) : null;

    await db.insert(schema.customFieldValues).values({
      issueId,
      customFieldId,
      stringValue: stringValue || null,
      numberValue: numberValue || null,
      dateValue,
      textValue: String(entity.attributes.textValue || ''),
      booleanValue: entity.attributes.booleanValue === 'true',
    });
  }

  return checkpoint;
}

async function importWorkflows(
  xmlPath: string,
  sessionId: number,
  checkpoint: Checkpoint,
  options: MigrationOptions
): Promise<Checkpoint> {
  if (options.skipWorkflows) return checkpoint;
  const idMap: Record<string, number> = checkpoint.idMaps.workflows || {};

  for await (const entity of streamEntities(xmlPath)) {
    if (entity.tag !== 'Workflow') continue;
    await checkPause(sessionId);

    const name = String(entity.attributes.workflowname || entity.attributes.name || '');
    if (!name) continue;

    const [wf] = await db
      .insert(schema.workflows)
      .values({
        name,
        description: String(entity.attributes.description || ''),
        isDefault: entity.attributes.isDefault === 'true',
      })
      .returning();

    idMap[String(entity.attributes.id || name)] = wf.id;
  }

  checkpoint.idMaps.workflows = idMap;
  return checkpoint;
}

async function importFilters(
  xmlPath: string,
  sessionId: number,
  checkpoint: Checkpoint,
  options: MigrationOptions
): Promise<Checkpoint> {
  if (options.skipFilters) return checkpoint;
  const userMap = checkpoint.idMaps.users || {};

  for await (const entity of streamEntities(xmlPath)) {
    if (entity.tag !== 'SearchRequest') continue;
    await checkPause(sessionId);

    const name = String(entity.attributes.reqName || entity.attributes.name || '');
    const jql = String(entity.attributes.reqContent || entity.attributes.jql || '');
    if (!name || !jql) continue;

    await db.insert(schema.filters).values({
      name,
      jql,
      authorId: userMap[String(entity.attributes.author || '')] || null,
      favourite: entity.attributes.favourite === 'true',
      shares: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  return checkpoint;
}

async function importDashboards(
  xmlPath: string,
  sessionId: number,
  checkpoint: Checkpoint,
  options: MigrationOptions
): Promise<Checkpoint> {
  if (options.skipDashboards) return checkpoint;
  const userMap = checkpoint.idMaps.users || {};

  for await (const entity of streamEntities(xmlPath)) {
    if (entity.tag !== 'PortalPage') continue;
    await checkPause(sessionId);

    const name = String(entity.attributes.ppagename || entity.attributes.name || '');
    if (!name) continue;

    const [dashboard] = await db
      .insert(schema.dashboards)
      .values({
        name,
        ownerId: userMap[String(entity.attributes.owner || '')] || null,
        shares: [],
        layout: '2-column',
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();

    // PortalPage gadgets would need separate handling
  }

  return checkpoint;
}

async function importPermissionSchemes(
  xmlPath: string,
  sessionId: number,
  checkpoint: Checkpoint,
  options: MigrationOptions
): Promise<Checkpoint> {
  if (options.skipPermissionSchemes) return checkpoint;
  const idMap: Record<string, number> = checkpoint.idMaps.permissionSchemes || {};

  for await (const entity of streamEntities(xmlPath)) {
    if (entity.tag !== 'PermissionScheme') continue;
    await checkPause(sessionId);

    const name = String(entity.attributes.schemeName || entity.attributes.name || '');
    if (!name) continue;

    const [scheme] = await db
      .insert(schema.permissionSchemes)
      .values({
        name,
        description: String(entity.attributes.description || ''),
      })
      .returning();

    idMap[String(entity.attributes.id || name)] = scheme.id;
  }

  checkpoint.idMaps.permissionSchemes = idMap;
  return checkpoint;
}

async function importPermissionEntries(
  xmlPath: string,
  sessionId: number,
  checkpoint: Checkpoint,
  options: MigrationOptions
): Promise<Checkpoint> {
  if (options.skipPermissionSchemes) return checkpoint;
  const schemeMap = checkpoint.idMaps.permissionSchemes || {};
  const userMap = checkpoint.idMaps.users || {};
  const groupMap = checkpoint.idMaps.groups || {};

  for await (const entity of streamEntities(xmlPath)) {
    if (entity.tag !== 'Permission') continue;
    await checkPause(sessionId);

    const schemeId = schemeMap[String(entity.attributes.scheme || '')];
    if (!schemeId) continue;

    const permissionKey = String(entity.attributes.permissionKey || entity.attributes.permission || '');
    if (!permissionKey) continue;

    await db.insert(schema.permissionEntries).values({
      schemeId,
      permissionKey,
      userId: userMap[String(entity.attributes.userId || '')] || null,
      groupId: groupMap[String(entity.attributes.groupId || '')] || null,
      projectRoleId: null,
    });
  }

  return checkpoint;
}

// --- Orchestration ---

const IMPORT_PHASES: {
  name: string;
  fn: (
    xmlPath: string,
    sessionId: number,
    checkpoint: Checkpoint,
    options: MigrationOptions
  ) => Promise<Checkpoint>;
}[] = [
  { name: 'users', fn: importUsers },
  { name: 'groups', fn: importGroups },
  { name: 'memberships', fn: importMemberships },
  { name: 'projects', fn: importProjects },
  { name: 'issueTypes', fn: importIssueTypes },
  { name: 'statuses', fn: importStatuses },
  { name: 'priorities', fn: importPriorities },
  { name: 'resolutions', fn: importResolutions },
  { name: 'issues', fn: importIssues },
  { name: 'comments', fn: importComments },
  { name: 'attachments', fn: importAttachments },
  { name: 'components', fn: importComponents },
  { name: 'versions', fn: importVersions },
  { name: 'issueLinks', fn: importIssueLinks },
  { name: 'customFields', fn: importCustomFields },
  { name: 'customFieldValues', fn: importCustomFieldValues },
  { name: 'workflows', fn: importWorkflows },
  { name: 'filters', fn: importFilters },
  { name: 'dashboards', fn: importDashboards },
  { name: 'permissionSchemes', fn: importPermissionSchemes },
  { name: 'permissionEntries', fn: importPermissionEntries },
];

export async function dryRun(xmlPath: string): Promise<{ stats: BackupStats; conflicts: MigrationConflict[] }> {
  const stats = await analyzeBackup(xmlPath);
  const conflicts = await detectConflicts(xmlPath);
  return { stats, conflicts };
}

export async function runMigration(
  xmlPath: string,
  sessionId: number,
  options: MigrationOptions = {}
): Promise<MigrationResult> {
  const stats = await analyzeBackup(xmlPath);
  const totalEntities = Object.values(stats).reduce((a, b) => a + b, 0);

  let checkpoint = (await getCheckpoint(sessionId)) || {
    processedTags: new Set<string>(),
    entityCounts: {},
    idMaps: {},
    issueKeyToId: {},
  };

  await updateSessionProgress(sessionId, {
    status: 'running',
    phase: 'importing',
    totalEntities,
    processedEntities: checkpoint.entityCounts.total || 0,
    currentEntityType: '',
    errors: [],
    conflictsResolved: 0,
    conflictsTotal: 0,
  });

  const errors: string[] = [];
  const conflicts: MigrationConflict[] = [];

  for (const phase of IMPORT_PHASES) {
    if (checkpoint.processedTags.has(phase.name)) continue;

    await updateSessionProgress(sessionId, {
      status: 'running',
      phase: phase.name,
      currentEntityType: phase.name,
    });

    try {
      checkpoint = await phase.fn(xmlPath, sessionId, checkpoint, options);
      checkpoint.processedTags.add(phase.name);
      checkpoint.entityCounts.total = (checkpoint.entityCounts.total || 0) + 1;

      if (options.onProgress) {
        await options.onProgress({
          sessionId,
          status: 'running',
          phase: phase.name,
          totalEntities,
          processedEntities: Object.values(checkpoint.entityCounts).reduce((a, b) => a + b, 0),
          currentEntityType: phase.name,
          errors,
          conflictsResolved: 0,
          conflictsTotal: conflicts.length,
        });
      }
    } catch (err) {
      if (err instanceof MigrationPauseError) {
        await saveCheckpoint(sessionId, checkpoint);
        await updateSessionProgress(sessionId, { status: 'paused' });
        return { sessionId, status: 'paused', stats, errors, conflicts };
      }
      if (err instanceof MigrationCancelError) {
        await saveCheckpoint(sessionId, checkpoint);
        await updateSessionProgress(sessionId, { status: 'cancelled' });
        await db
          .update(schema.migrationSessions)
          .set({ completedAt: new Date(), status: 'cancelled' })
          .where(eq(schema.migrationSessions.id, sessionId));
        return { sessionId, status: 'cancelled', stats, errors, conflicts };
      }
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`Phase ${phase.name}: ${message}`);
    }

    await saveCheckpoint(sessionId, checkpoint);
  }

  const finalStatus = errors.length > 0 ? 'failed' : 'completed';
  await updateSessionProgress(sessionId, {
    status: finalStatus,
    phase: 'done',
    processedEntities: totalEntities,
    errors,
  });

  await db
    .update(schema.migrationSessions)
    .set({ completedAt: new Date(), status: finalStatus })
    .where(eq(schema.migrationSessions.id, sessionId));

  return { sessionId, status: finalStatus, stats, errors, conflicts };
}

export async function resumeMigration(sessionId: number): Promise<MigrationResult> {
  const session = await db
    .select()
    .from(schema.migrationSessions)
    .where(eq(schema.migrationSessions.id, sessionId))
    .limit(1);

  if (session.length === 0) {
    throw new Error(`Migration session ${sessionId} not found`);
  }

  const s = session[0];
  if (!s.backupPath) {
    throw new Error(`Migration session ${sessionId} has no backup path`);
  }

  const options: MigrationOptions = (s.options as MigrationOptions) || {};

  // Reset pause state
  await updateSessionProgress(sessionId, { status: 'running' });

  return runMigration(s.backupPath, sessionId, options);
}

export async function pauseMigration(sessionId: number): Promise<void> {
  await updateSessionProgress(sessionId, { status: 'paused' });
}

export async function getMigrationLogs(sessionId: number): Promise<string[]> {
  const raw = await redis.get(`${MIGRATION_PREFIX}progress:${sessionId}`);
  if (!raw) return [];
  const p = JSON.parse(raw) as MigrationProgress;
  return p.errors || [];
}

export async function getMigrationProgress(sessionId: number): Promise<MigrationProgress | null> {
  const raw = await redis.get(`${MIGRATION_PREFIX}progress:${sessionId}`);
  if (!raw) return null;
  return JSON.parse(raw) as MigrationProgress;
}

export { analyzeBackup };
