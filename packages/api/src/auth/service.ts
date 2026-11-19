import { db } from '../db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import { hashPassword, verifyPassword } from './password';
import { createSession } from './session';
import { passwordLoginBlockedFor } from './oidc-service';
import { samlPasswordLoginBlockedFor } from './saml-service';
import { legacySsoPasswordLoginBlockedFor } from './password-reset';
import { ldapLogin } from './ldap-service';
import type { RegisterData, AuthResult } from './types';
import { isAgentUsername } from '../agents/logic';

// A real bcrypt hash (cost 12) of a random string, used only to equalise timing for unknown users.
const DUMMY_HASH = '$2b$12$vdM/wW9itqUYVdl5KBXUpOsLkqz7Qf9dFuR8aXUrfGTsCiYRSteXO';

export async function register(data: RegisterData): Promise<AuthResult> {
  if (isAgentUsername(data.username)) throw new Error('The agent: user name prefix is reserved for AI agents');
  if (data.username.trim().toLowerCase() === 'admin') throw new Error('This user name is reserved'); // the built-in administrator passes every check by this name
  const passwordHash = await hashPassword(data.password);
  const [user] = await db.insert(schema.users).values({
    username: data.username,
    email: data.email,
    displayName: data.displayName,
    passwordHash,
  }).returning();

  const sessionId = await createSession(user.id);
  return {
    sessionId,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      email: user.email,
    },
  };
}

async function finishLogin(user: { id: number; username: string; displayName: string | null; email: string }): Promise<AuthResult | null> {
  if (await passwordLoginBlockedFor(user.id) || await samlPasswordLoginBlockedFor(user.id) || await legacySsoPasswordLoginBlockedFor(user.id)) return null; // SSO is enforced
  const sessionId = await createSession(user.id);
  return { sessionId, user: { id: user.id, username: user.username, displayName: user.displayName as string, email: user.email } };
}

export async function login(username: string, password: string): Promise<AuthResult | null> {
  const users = await db.select().from(schema.users).where(eq(schema.users.username, username)).limit(1);
  const user = users[0];
  if (user && user.active === false) return null;

  // Directory (LDAP/AD) login: decides for users linked to a directory and for JIT users; never for other local users.
  const ldap = await ldapLogin(username, password, user ? { id: user.id, active: user.active } : null).catch((e) => {
    console.warn('LDAP login error', e instanceof Error ? e.message : 'unknown');
    return { handled: false } as { handled: boolean; userId?: number };
  });
  if (ldap.handled) {
    if (!ldap.userId) return null;
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, ldap.userId)).limit(1);
    return u && u.active !== false ? finishLogin(u) : null;
  }

  if (!user) {
    // Spend the same time as a real check so response time does not reveal which usernames exist.
    await verifyPassword(password, DUMMY_HASH);
    return null;
  }
  if (isAgentUsername(user.username) || !user.passwordHash) { // AI agents never sign in
    await verifyPassword(password, DUMMY_HASH);
    return null;
  }
  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) return null;
  return finishLogin(user);
}
