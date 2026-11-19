/**
 * Encryption of secrets at rest (OIDC client secrets).
 *
 * AES-256-GCM, random 96-bit IV per value, envelope: `v1.<iv>.<tag>.<ciphertext>` (base64url).
 * The key comes from SECRETS_ENCRYPTION_KEY (32 random bytes, base64). Outside production a key derived
 * from a constant is used so dev and test work without setup. In production a missing or malformed key
 * is a hard error: nothing is ever stored in the clear.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

export class SecretsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretsConfigError';
  }
}

export class SecretDecryptionError extends Error {
  constructor() {
    super('Stored secret could not be decrypted (wrong key or tampered data)');
    this.name = 'SecretDecryptionError';
  }
}

const VERSION = 'v1';
const DEV_KEY = createHash('sha256').update('veqsio-insecure-dev-secrets-key').digest();

export function getEncryptionKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env.SECRETS_ENCRYPTION_KEY;
  if (!raw) {
    if (env.NODE_ENV !== 'production') return DEV_KEY;
    throw new SecretsConfigError('SECRETS_ENCRYPTION_KEY is required in production to store secrets');
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new SecretsConfigError('SECRETS_ENCRYPTION_KEY must be 32 bytes, base64 encoded');
  }
  return key;
}

/** True when secrets can be stored (a key is configured, or we are not in production). */
export function secretsConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    getEncryptionKey(env);
    return true;
  } catch {
    return false;
  }
}

export function encryptSecret(plaintext: string, key: Buffer = getEncryptionKey()): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

export function decryptSecret(envelope: string, key: Buffer = getEncryptionKey()): string {
  const parts = envelope.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) throw new SecretDecryptionError();
  try {
    const iv = Buffer.from(parts[1], 'base64url');
    const tag = Buffer.from(parts[2], 'base64url');
    const ct = Buffer.from(parts[3], 'base64url');
    if (iv.length !== 12 || tag.length !== 16) throw new SecretDecryptionError();
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    throw new SecretDecryptionError();
  }
}
