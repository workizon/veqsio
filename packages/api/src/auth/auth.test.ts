import { describe, test, expect } from 'bun:test';
import { hashPassword, verifyPassword } from './password';

process.env.REDIS_URL = 'memory:';

const { createSession, getSession, deleteSession, refreshSession } = await import('./session');

describe('Auth Password', () => {
  test('hashPassword returns a non-empty string', async () => {
    const hash = await hashPassword('password123');
    expect(typeof hash).toBe('string');
    expect(hash.length).toBeGreaterThan(0);
  });

  test('verifyPassword returns true for correct password', async () => {
    const hash = await hashPassword('password123');
    const valid = await verifyPassword('password123', hash);
    expect(valid).toBe(true);
  });

  test('verifyPassword returns false for incorrect password', async () => {
    const hash = await hashPassword('password123');
    const valid = await verifyPassword('wrongpassword', hash);
    expect(valid).toBe(false);
  });

  test('verifyPassword returns false for empty password', async () => {
    const hash = await hashPassword('password123');
    const valid = await verifyPassword('', hash);
    expect(valid).toBe(false);
  });
});

describe('Auth Session', () => {
  test('createSession returns a UUID string', async () => {
    const sessionId = await createSession(1);
    expect(typeof sessionId).toBe('string');
    expect(sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  test('getSession returns session data after creation', async () => {
    const sessionId = await createSession(42);
    const session = await getSession(sessionId);
    expect(session).not.toBeNull();
    expect(session!.userId).toBe(42);
    expect(typeof session!.createdAt).toBe('string');
  });

  test('getSession returns null for unknown session', async () => {
    const session = await getSession('nonexistent-session-id');
    expect(session).toBeNull();
  });

  test('deleteSession removes session', async () => {
    const sessionId = await createSession(99);
    expect(await getSession(sessionId)).not.toBeNull();
    await deleteSession(sessionId);
    expect(await getSession(sessionId)).toBeNull();
  });

  test('refreshSession extends TTL', async () => {
    const sessionId = await createSession(77);
    await refreshSession(sessionId);
    const session = await getSession(sessionId);
    expect(session).not.toBeNull();
    expect(session!.userId).toBe(77);
  });
});
