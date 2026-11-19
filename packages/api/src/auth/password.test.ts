import { test, expect } from 'bun:test';
import bcrypt from 'bcryptjs';
import { hashPassword, verifyPassword } from './password';

// Hashes written by bcryptjs (existing users) and by the native Bun implementation must verify with both.
test('native and bcryptjs hashes are interchangeable', async () => {
  const native = await hashPassword('secret123');
  expect(await bcrypt.compare('secret123', native)).toBe(true);
  const js = await bcrypt.hash('secret123', 10);
  expect(await verifyPassword('secret123', js)).toBe(true);
  expect(await verifyPassword('wrong', js)).toBe(false);
});

test('malformed hashes never verify', async () => {
  expect(await verifyPassword('x', '$2a$12$dummyhashfordemopurposesonlynotreal')).toBe(false);
  expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
});

test('passwords over 72 bytes keep bcryptjs semantics (truncation, no pre-hash)', async () => {
  const long = 'x'.repeat(100);
  expect(await verifyPassword(long, await bcrypt.hash(long, 8))).toBe(true);
  expect(await bcrypt.compare(long, await hashPassword(long))).toBe(true);
});
