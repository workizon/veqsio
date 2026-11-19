import { db } from '../db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import { getRedisClient } from '../services/redis-client';
import {
  analyzeBackup,
  dryRun,
  runMigration,
  resumeMigration,
  pauseMigration,
  getMigrationProgress,
  getMigrationLogs,
  type MigrationOptions,
  type MigrationProgress,
  type MigrationResult,
  type MigrationConflict,
  type BackupStats,
} from './engine';

const redis = getRedisClient();
const MIGRATION_PREFIX = 'veqsio:migration:';
const MIGRATION_TTL = 7 * 24 * 60 * 60; // 7 days

// Jira status category mapping to Veqsio schema categories
const JIRA_STATUS_CATEGORY_MAP: Record<string, string> = {
  '1': 'todo',
  '2': 'in_progress',
  '3': 'done',
  'todo': 'todo',
  'in progress': 'in_progress',
  'in_progress': 'in_progress',
  'done': 'done',
  'to do': 'todo',
  'to_do': 'todo',
  'complete': 'done',
  'completed': 'done',
  'resolved': 'done',
  'closed': 'done',
  'open': 'todo',
  'reopened': 'todo',
};

export function mapJiraStatusCategory(jiraCategory?: string): string {
  if (!jiraCategory) return 'todo';
  const normalized = jiraCategory.trim().toLowerCase().replace(/\s+/g, '_').replace(/-/g, '_');
  return JIRA_STATUS_CATEGORY_MAP[normalized] || JIRA_STATUS_CATEGORY_MAP[jiraCategory.trim().toLowerCase()] || 'todo';
}

export interface MigrationSessionDetails {
  id: number;
  status: string;
  startedAt: Date | null;
  completedAt: Date | null;
  totalEntities: number;
  processedEntities: number;
  errors: string[];
  backupPath: string;
  options: Record<string, unknown>;
  createdBy: number | null;
  progress: MigrationProgress | null;
}

export async function createMigrationSession(
  backupPath: string,
  createdBy: number,
  options?: MigrationOptions
): Promise<{ id: number; status: string }> {
  const [session] = await db
    .insert(schema.migrationSessions)
    .values({
      status: 'pending',
      backupPath,
      options: options || {},
      createdBy,
    })
    .returning();

  return { id: session.id, status: session.status };
}

export async function getMigrationSession(sessionId: number): Promise<MigrationSessionDetails | null> {
  const rows = await db
    .select()
    .from(schema.migrationSessions)
    .where(eq(schema.migrationSessions.id, sessionId))
    .limit(1);

  if (rows.length === 0) return null;

  const session = rows[0];
  const progress = await getMigrationProgress(sessionId);

  return {
    id: session.id,
    status: session.status,
    startedAt: session.startedAt,
    completedAt: session.completedAt,
    totalEntities: session.totalEntities ?? 0,
    processedEntities: session.processedEntities ?? 0,
    errors: (session.errors as string[]) ?? [],
    backupPath: session.backupPath,
    options: (session.options as Record<string, unknown>) ?? {},
    createdBy: session.createdBy,
    progress,
  };
}

export async function cancelMigration(sessionId: number): Promise<void> {
  await redis.setex(
    `${MIGRATION_PREFIX}cancel:${sessionId}`,
    MIGRATION_TTL,
    'true'
  );

  await db
    .update(schema.migrationSessions)
    .set({ status: 'cancelled', completedAt: new Date() })
    .where(eq(schema.migrationSessions.id, sessionId));
}

export async function isCancelled(sessionId: number): Promise<boolean> {
  const raw = await redis.get(`${MIGRATION_PREFIX}cancel:${sessionId}`);
  return raw === 'true';
}

export async function clearCancellation(sessionId: number): Promise<void> {
  await redis.del(`${MIGRATION_PREFIX}cancel:${sessionId}`);
}

// User mapping helper: find or create a user from Jira username
export async function mapJiraUser(
  jiraUsername: string,
  jiraEmail: string,
  jiraDisplayName: string,
  createIfMissing: boolean = true
): Promise<number | null> {
  const existing = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.username, jiraUsername))
    .limit(1);

  if (existing.length > 0) {
    return existing[0].id;
  }

  if (!createIfMissing) return null;

  const [user] = await db
    .insert(schema.users)
    .values({
      username: jiraUsername,
      email: jiraEmail || `${jiraUsername}@migrated.local`,
      displayName: jiraDisplayName || jiraUsername,
      passwordHash: '$2a$10$placeholder',
      active: true,
      timezone: 'UTC',
    })
    .returning();

  return user.id;
}

// Project key conflict resolver
export async function resolveProjectKeyConflict(key: string): Promise<string> {
  const existing = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.projectKey, key))
    .limit(1);

  if (existing.length === 0) return key;

  let suffix = 1;
  let candidate = `${key}-${suffix}`;
  while (true) {
    const check = await db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.projectKey, candidate))
      .limit(1);
    if (check.length === 0) return candidate;
    suffix++;
    candidate = `${key}-${suffix}`;
  }
}

// Re-export engine functions for convenience
export {
  analyzeBackup,
  dryRun,
  runMigration,
  resumeMigration,
  pauseMigration,
  getMigrationProgress,
  getMigrationLogs,
};

export type {
  MigrationOptions,
  MigrationProgress,
  MigrationResult,
  MigrationConflict,
  BackupStats,
};
