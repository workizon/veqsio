import { generateKeyPairSync, sign } from 'node:crypto';
import { refreshLicense, setLicensePublicKeysForTests } from '../src/license';

/**
 * Test licensing: the production public-key list is empty on purpose, so tests generate their own key pair and
 * inject its public half. The key is handed to the API through VEQSIO_LICENSE_KEY (never written to the database).
 */
const pair = generateKeyPairSync('ed25519');
const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function mintTestLicense(over: Record<string, unknown> = {}): string {
  const payload = {
    v: 1, kid: 'it', id: 'lic-test', customer: 'Test Ltd', plan: 'enterprise', features: [],
    issuedAt: new Date(Date.now() - 86_400_000).toISOString(),
    expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString(), ...over,
  };
  const head = `VQL1.${b64u(JSON.stringify(payload))}`;
  return `${head}.${b64u(sign(null, Buffer.from(head), pair.privateKey))}`;
}

/** Trust the test key and (optionally) activate a licence from the environment. */
export async function useTestLicense(over: Record<string, unknown> | null = {}): Promise<void> {
  setLicensePublicKeysForTests([{ kid: 'it', pem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() }]);
  if (over === null) delete process.env.VEQSIO_LICENSE_KEY;
  else process.env.VEQSIO_LICENSE_KEY = mintTestLicense(over);
  await refreshLicense();
}

/** Back to a plain community instance. */
export async function clearTestLicense(): Promise<void> {
  delete process.env.VEQSIO_LICENSE_KEY;
  delete process.env.VEQSIO_LICENSE_FILE;
  setLicensePublicKeysForTests(null);
  await refreshLicense();
}
