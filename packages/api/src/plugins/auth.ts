/**
 * Plugin API tokens (`vqp_...`) authenticate as the plugin's service user, limited to the scopes an admin granted.
 * A token works only while the plugin is installed AND enabled; lookups hit the database on every request, so
 * disabling, uninstalling or rotating takes effect immediately.
 */
import { createHash, randomBytes } from 'crypto';
import { and, eq } from 'drizzle-orm';
import * as schema from '@veqsio/db';
import { db } from '../db';

export const PLUGIN_TOKEN_PREFIX = 'vqp_';
export const PLUGIN_USER_PREFIX = 'plugin:';

export const hashPluginToken = (t: string) => createHash('sha256').update(t).digest('hex');
export const generatePluginToken = () => PLUGIN_TOKEN_PREFIX + randomBytes(32).toString('hex');
export const isPluginUser = (u: { username: string } | null | undefined) => !!u && u.username.startsWith(PLUGIN_USER_PREFIX);

export async function resolvePluginPrincipal(token: string): Promise<{ user: typeof schema.users.$inferSelect; scopes: string[]; pluginId: number } | null> {
  if (!token.startsWith(PLUGIN_TOKEN_PREFIX)) return null;
  const [pl] = await db.select().from(schema.plugins)
    .where(and(eq(schema.plugins.tokenHash, hashPluginToken(token)), eq(schema.plugins.enabled, true))).limit(1);
  if (!pl || !pl.serviceUserId) return null;
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, pl.serviceUserId)).limit(1);
  if (!user || !isPluginUser(user)) return null;
  const scopes = Array.isArray(pl.grantedScopes) ? (pl.grantedScopes as string[]) : [];
  return { user, scopes, pluginId: pl.id };
}
