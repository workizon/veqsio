import bcrypt from 'bcryptjs';

const SALT_ROUNDS = 12;

// bcryptjs is pure JavaScript: a cost-12 hash occupies the single JS thread for ~300 ms, so a burst of logins
// stalls every other request. Bun.password runs the same bcrypt (hashes are interchangeable) on a native worker
// thread. bcryptjs stays as the fallback for other runtimes.
const nativeBun: { password: { hash(p: string, o: unknown): Promise<string>; verify(p: string, h: string): Promise<boolean> } } | undefined =
  typeof (globalThis as any).Bun !== 'undefined' ? (globalThis as any).Bun : undefined;

// Bun pre-hashes passwords longer than bcrypt's 72-byte limit, which bcryptjs does not (it truncates).
// Keep long passwords on bcryptjs so hashes created by either implementation stay verifiable by both.
const fitsBcrypt = (p: string) => Buffer.byteLength(p) <= 72;

export async function hashPassword(password: string): Promise<string> {
  if (nativeBun && fitsBcrypt(password)) return nativeBun.password.hash(password, { algorithm: 'bcrypt', cost: SALT_ROUNDS });
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  if (nativeBun && fitsBcrypt(password) && /^\$2[abxy]\$/.test(hash)) {
    try {
      return await nativeBun.password.verify(password, hash);
    } catch {
      return false; // malformed hash: same outcome as a mismatch
    }
  }
  return bcrypt.compare(password, hash);
}
