/**
 * SSRF guards for everything Veqsio fetches on behalf of a plugin (manifest download, event delivery).
 * Private, loopback, link-local and metadata addresses are refused unless PLUGINS_ALLOW_PRIVATE_HOSTS=true
 * (development and tests); link-local and cloud metadata addresses are refused even then.
 *
 * Residual risk: DNS is resolved by us for the check and again by fetch (rebinding window). Run the API behind an
 * egress policy that blocks internal ranges if plugin hosts are not fully trusted (see docs/plugins.md).
 */
import { isIP } from 'net';
import { lookup } from 'dns/promises';
import { MAX_MANIFEST_BYTES, parseManifestText, type ManifestResult } from './manifest';

export class PluginFetchError extends Error {}

const METADATA_HOSTS = new Set(['metadata.google.internal', 'metadata', 'instance-data']);

function v4Parts(ip: string): number[] | null {
  const p = ip.split('.').map(Number);
  return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? p : null;
}

export function isLinkLocalOrMetadata(ip: string): boolean {
  const lower = ip.toLowerCase();
  const v4 = v4Parts(lower.startsWith('::ffff:') ? lower.slice(7) : lower);
  if (v4) return v4[0] === 169 && v4[1] === 254;
  return /^fe[89ab][0-9a-f]:/.test(lower) || lower === 'fd00:ec2::254';
}

/** True for any address that is not a normal public unicast address. */
export function isPrivateAddress(ip: string): boolean {
  let lower = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (lower.startsWith('::ffff:')) {
    const rest = lower.slice(7);
    if (v4Parts(rest)) lower = rest;
    else {
      // ::ffff:7f00:1 hex form
      const m = rest.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
      if (m) {
        const hi = parseInt(m[1], 16), lo = parseInt(m[2], 16);
        lower = `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
      }
    }
  }
  const v4 = v4Parts(lower);
  if (v4) {
    const [a, b, c] = v4;
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (isIP(lower) === 6) {
    return (
      lower === '::' || lower === '::1' ||
      /^f[cd][0-9a-f]{2}:/.test(lower) || // fc00::/7 unique local
      /^fe[89ab][0-9a-f]:/.test(lower) || // fe80::/10 link local
      /^ff[0-9a-f]{2}:/.test(lower) || // multicast
      lower.startsWith('64:ff9b:') // NAT64 can reach IPv4 internals
    );
  }
  return false;
}

export function isBlockedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  return h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.localdomain') || METADATA_HOSTS.has(h);
}

export function privateHostsAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PLUGINS_ALLOW_PRIVATE_HOSTS === 'true';
}

/** Synchronous check on the URL text (no DNS). */
export function checkPluginUrl(raw: string, env: NodeJS.ProcessEnv = process.env): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new PluginFetchError('Invalid URL'); }
  const allowPrivate = privateHostsAllowed(env);
  if (u.protocol !== 'https:' && !(allowPrivate && u.protocol === 'http:')) throw new PluginFetchError('Plugin URLs must use https');
  if (u.username || u.password) throw new PluginFetchError('Do not put credentials in the URL');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isLinkLocalOrMetadata(host) || METADATA_HOSTS.has(host.toLowerCase())) throw new PluginFetchError('Host is not allowed');
  if (!allowPrivate) {
    if (isBlockedHostname(host)) throw new PluginFetchError('Host is not allowed');
    if (isIP(host) && isPrivateAddress(host)) throw new PluginFetchError('Host is not allowed');
  }
  return u;
}

/** Full check including DNS resolution of names to catch hosts that point at internal addresses. */
export async function assertPublicUrl(raw: string, env: NodeJS.ProcessEnv = process.env): Promise<URL> {
  const u = checkPluginUrl(raw, env);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return u;
  let addrs: { address: string }[];
  try { addrs = await lookup(host, { all: true }); } catch { throw new PluginFetchError('Host could not be resolved'); }
  for (const a of addrs) {
    if (isLinkLocalOrMetadata(a.address)) throw new PluginFetchError('Host is not allowed');
    if (!privateHostsAllowed(env) && isPrivateAddress(a.address)) throw new PluginFetchError('Host is not allowed');
  }
  return u;
}

export interface FetchManifestOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRedirects?: number;
  env?: NodeJS.ProcessEnv;
}

/** Download a manifest: https only, 10 s timeout, 64 KiB cap, redirects only within the same host. */
export async function fetchManifest(url: string, opts: FetchManifestOptions = {}): Promise<ManifestResult> {
  const env = opts.env ?? process.env;
  const doFetch = opts.fetchImpl ?? fetch;
  let current = (await assertPublicUrl(url, env)).toString();
  const originHost = new URL(current).host;
  const maxRedirects = opts.maxRedirects ?? 3;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const res = await doFetch(current, {
      redirect: 'manual',
      headers: { Accept: 'application/json', 'User-Agent': 'Veqsio-Plugin-Installer/1.0' },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      await res.body?.cancel();
      if (!loc) throw new PluginFetchError('Redirect without location');
      const next = await assertPublicUrl(new URL(loc, current).toString(), env);
      if (next.host !== originHost) throw new PluginFetchError('Redirect to a different host is not allowed');
      current = next.toString();
      continue;
    }
    if (!res.ok) { await res.body?.cancel(); throw new PluginFetchError(`Manifest URL returned HTTP ${res.status}`); }
    const text = await readCapped(res, MAX_MANIFEST_BYTES);
    return parseManifestText(text, { allowInsecure: privateHostsAllowed(env) });
  }
  throw new PluginFetchError('Too many redirects');
}

async function readCapped(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (declared > max) { await res.body?.cancel(); throw new PluginFetchError('Manifest too large'); }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel(); throw new PluginFetchError('Manifest too large'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
