import type { PublicKeyEntry } from './verify'

/**
 * Public keys that may sign licences, oldest first. Rotation: add the new key, keep the old one until
 * every licence signed with it has expired, then remove it.
 *
 * This list is EMPTY in the repository on purpose: the vendor generates the key pair
 * (`bun scripts/license/keygen.ts`), keeps the private key offline and pastes the PUBLIC key here
 * (or provides it at deploy time through VEQSIO_LICENSE_PUBLIC_KEYS, a JSON array of {kid, pem}).
 * With no keys every licence is rejected and the instance runs as the community edition.
 */
export const LICENSE_PUBLIC_KEYS: PublicKeyEntry[] = []

export function configuredPublicKeys(env: Record<string, string | undefined> = process.env): PublicKeyEntry[] {
  const fromEnv = env.VEQSIO_LICENSE_PUBLIC_KEYS
  if (!fromEnv) return LICENSE_PUBLIC_KEYS
  try {
    const parsed = JSON.parse(fromEnv)
    if (Array.isArray(parsed) && parsed.every((k) => k && typeof k.kid === 'string' && typeof k.pem === 'string')) {
      return [...LICENSE_PUBLIC_KEYS, ...parsed]
    }
  } catch { /* ignore malformed env, fall through */ }
  return LICENSE_PUBLIC_KEYS
}
