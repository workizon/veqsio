import { createMiddleware } from 'hono/factory';
import type { AppContext } from '../auth/middleware';
import { hasGlobalPermission, hasProjectPermission } from './service';

export function requireGlobalPermission(permission: string) {
  return createMiddleware<AppContext>(async (c, next) => {
    const user = c.get('user');
    if (!user) {
      return c.json({ errorMessages: ['Authentication required'] }, 401);
    }
    const allowed = await hasGlobalPermission(user.id, permission);
    if (!allowed) {
      return c.json({ errorMessages: ['Forbidden'] }, 403);
    }
    await next();
  });
}

/**
 * The project check lives in middleware/permissions.ts (it resolves :key, checks the permission scheme and answers 404/403).
 * This used to be a stub that let every signed-in user through; it is re-exported so that nobody can pick up the open version.
 */
export { requireProjectPermission } from '../middleware/permissions';
