import { describe, test, expect } from 'bun:test';
import { randomBytes } from 'crypto';
import { encryptSecret, decryptSecret, getEncryptionKey, SecretsConfigError, SecretDecryptionError, secretsConfigured } from './secrets';

const key = randomBytes(32);

describe('secrets', () => {
  test('round trips and never contains the plaintext', () => {
    const env = encryptSecret('super-secret-value', key);
    expect(env.startsWith('v1.')).toBe(true);
    expect(env).not.toContain('super-secret-value');
    expect(decryptSecret(env, key)).toBe('super-secret-value');
  });

  test('uses a fresh IV each time', () => {
    expect(encryptSecret('x', key)).not.toBe(encryptSecret('x', key));
  });

  test('detects tampering of ciphertext, tag, iv and version', () => {
    const [v, iv, tag, ct] = encryptSecret('hello world', key).split('.');
    const flip = (s: string) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
    expect(() => decryptSecret([v, iv, tag, flip(ct)].join('.'), key)).toThrow(SecretDecryptionError);
    expect(() => decryptSecret([v, iv, flip(tag), ct].join('.'), key)).toThrow(SecretDecryptionError);
    expect(() => decryptSecret([v, flip(iv), tag, ct].join('.'), key)).toThrow(SecretDecryptionError);
    expect(() => decryptSecret(['v2', iv, tag, ct].join('.'), key)).toThrow(SecretDecryptionError);
    expect(() => decryptSecret('garbage', key)).toThrow(SecretDecryptionError);
  });

  test('wrong key fails', () => {
    const env = encryptSecret('hello', key);
    expect(() => decryptSecret(env, randomBytes(32))).toThrow(SecretDecryptionError);
  });

  test('production requires a valid key; dev falls back', () => {
    expect(() => getEncryptionKey({ NODE_ENV: 'production' } as any)).toThrow(SecretsConfigError);
    expect(() => getEncryptionKey({ NODE_ENV: 'production', SECRETS_ENCRYPTION_KEY: Buffer.alloc(16).toString('base64') } as any)).toThrow(SecretsConfigError);
    expect(getEncryptionKey({ NODE_ENV: 'production', SECRETS_ENCRYPTION_KEY: key.toString('base64') } as any).equals(key)).toBe(true);
    expect(getEncryptionKey({ NODE_ENV: 'test' } as any).length).toBe(32);
    expect(secretsConfigured({ NODE_ENV: 'production' } as any)).toBe(false);
    expect(secretsConfigured({ NODE_ENV: 'development' } as any)).toBe(true);
  });
});
