import * as schema from '@veqsio/db';
import { eq, and } from 'drizzle-orm';
import { getOrSet, delPattern } from '../services/cache';
import { checkGlobalPermission, checkProjectPermission } from '../middleware/permissions';

import { db } from '../db';

function permissionCacheKey(userId: number, permission: string, projectId?: number): string {
  if (projectId) {
    return `veqsio:permission:${userId}:project:${projectId}:${permission}`;
  }
  return `veqsio:permission:${userId}:global:${permission}`;
}

export async function hasGlobalPermission(userId: number, permission: string): Promise<boolean> {
  return getOrSet(
    permissionCacheKey(userId, permission),
    async () => {
      const users = await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
      if (users.length === 0) return false;
      return checkGlobalPermission(users[0], permission);
    },
    'permission'
  );
}

export async function hasProjectPermission(userId: number, projectId: number, permission: string): Promise<boolean> {
  return getOrSet(
    permissionCacheKey(userId, permission, projectId),
    async () => {
      const users = await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
      if (users.length === 0) return false;
      return checkProjectPermission(users[0], projectId, permission);
    },
    'permission'
  );
}

export { checkProjectPermission as checkPermission };

export async function invalidatePermissionCache(userId?: number): Promise<void> {
  if (userId) {
    await delPattern(`veqsio:permission:${userId}:*`);
  } else {
    await delPattern(`veqsio:permission:*`);
  }
}
