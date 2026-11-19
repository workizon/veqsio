/**
 * Release channel: a signed manifest (releases.json) lists published versions. Instances and the control plane trust
 * only a manifest whose Ed25519 signature verifies against a configured public key (VEQSIO_RELEASE_PUBLIC_KEYS, a JSON
 * array of {kid, pem}; falls back to the licence public keys). An unsigned or wrongly signed manifest is never used.
 *
 * Document:  { "kid": "2026a", "payload": "<base64url(JSON)>", "signature": "<base64url(Ed25519 over 'VQR1.' + payload)>" }
 * Payload:   { "v": 1, "latest": "1.4.0", "releases": [{ "version": "1.4.0", "date": "2026-11-01", "security": false, "notes": "...", "minFrom": "1.2.0" }] }
 */
import { createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { configuredPublicKeys } from '../license/public-keys';
import type { PublicKeyEntry } from '../license/verify';
import { VERSION } from '../version';
import { outboundFetch } from '../security/outbound';

export interface ReleaseEntry { version: string; date?: string; security: boolean; notes: string; minFrom?: string }
export interface ReleaseManifest { latest: string; releases: ReleaseEntry[] }
export type ManifestResult = { ok: true; manifest: ReleaseManifest } | { ok: false; reason: 'malformed' | 'unknown_kid' | 'bad_signature' }

const b64u = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

export function releaseKeys(env: NodeJS.ProcessEnv = process.env): PublicKeyEntry[] {
  try {
    const parsed = JSON.parse(env.VEQSIO_RELEASE_PUBLIC_KEYS ?? 'null');
    if (Array.isArray(parsed) && parsed.every((k) => k && typeof k.kid === 'string' && typeof k.pem === 'string')) return parsed;
  } catch { /* fall back */ }
  return configuredPublicKeys(env);
}

/** Dotted numeric compare: 1 if a > b, -1 if a < b, 0 if equal (pre-release suffixes are ignored). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('-')[0].split('.').map((n) => parseInt(n, 10) || 0), pb = b.split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

export function verifyManifest(doc: unknown, keys: readonly PublicKeyEntry[]): ManifestResult {
  const d = doc as { kid?: unknown; payload?: unknown; signature?: unknown } | null;
  if (!d || typeof d.kid !== 'string' || typeof d.payload !== 'string' || typeof d.signature !== 'string') return { ok: false, reason: 'malformed' };
  const key = keys.find((k) => k.kid === d.kid);
  if (!key) return { ok: false, reason: 'unknown_kid' };
  let ok = false;
  try { ok = cryptoVerify(null, Buffer.from(`VQR1.${d.payload}`, 'utf8'), createPublicKey(key.pem), b64u(d.signature)); } catch { ok = false; }
  if (!ok) return { ok: false, reason: 'bad_signature' };
  try {
    const p = JSON.parse(b64u(d.payload).toString('utf8'));
    if (p?.v !== 1 || typeof p.latest !== 'string' || !Array.isArray(p.releases)) return { ok: false, reason: 'malformed' };
    const releases: ReleaseEntry[] = p.releases
      .filter((r: any) => r && typeof r.version === 'string' && /^\d+\.\d+\.\d+/.test(r.version))
      .map((r: any) => ({ version: r.version, date: typeof r.date === 'string' ? r.date : undefined, security: r.security === true, notes: typeof r.notes === 'string' ? r.notes.slice(0, 2000) : '', minFrom: typeof r.minFrom === 'string' ? r.minFrom : undefined }));
    return { ok: true, manifest: { latest: p.latest, releases } };
  } catch { return { ok: false, reason: 'malformed' }; }
}

export type UpdateStatus =
  | { status: 'not_configured' }
  | { status: 'untrusted'; reason: string }
  | { status: 'unreachable'; error: string }
  | { status: 'ok'; current: string; latest: string; updateAvailable: boolean; securityUpdate: boolean; notes: ReleaseEntry[]; canUpgradeDirectly: boolean };

/** Pure: what the manifest means for the running version. */
export function assess(manifest: ReleaseManifest, current: string): Extract<UpdateStatus, { status: 'ok' }> {
  const newer = manifest.releases.filter((r) => compareVersions(r.version, current) > 0).sort((a, b) => compareVersions(b.version, a.version));
  const target = manifest.releases.find((r) => r.version === manifest.latest);
  return {
    status: 'ok', current, latest: manifest.latest,
    updateAvailable: compareVersions(manifest.latest, current) > 0,
    securityUpdate: newer.some((r) => r.security),
    notes: newer,
    canUpgradeDirectly: !target?.minFrom || compareVersions(current, target.minFrom) >= 0,
  };
}

let cache: { at: number; status: UpdateStatus } | null = null;
const TTL = 15 * 60_000;
export function resetReleaseCache() { cache = null; }

export async function updateStatus(opts: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; now?: number } = {}): Promise<UpdateStatus> {
  const env = opts.env ?? process.env;
  const url = (env.VEQSIO_RELEASES_URL ?? '').trim();
  if (!url) return { status: 'not_configured' };
  const now = opts.now ?? Date.now();
  if (cache && now - cache.at < TTL) return cache.status;
  let status: UpdateStatus;
  try {
    const res = await outboundFetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) }, { env, fetchImpl: opts.fetchImpl });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > 256 * 1024) throw new Error('manifest too large');
    const v = verifyManifest(JSON.parse(text), releaseKeys(env));
    status = v.ok ? assess(v.manifest, VERSION) : { status: 'untrusted', reason: v.reason };
  } catch (e) {
    status = { status: 'unreachable', error: String((e as Error).message || e).slice(0, 200) };
  }
  cache = { at: now, status };
  return status;
}
