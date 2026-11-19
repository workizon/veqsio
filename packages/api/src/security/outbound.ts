import { withSpan } from '../observability/tracing';
/**
 * Egress guard for everything Veqsio fetches on behalf of a user or administrator (webhooks, automation webhooks,
 * Jira importer, OIDC discovery of a configured IdP).
 *
 * Always refused: link-local and cloud-metadata addresses, credentials in the URL, non-http(s) schemes.
 * Refused when the guard is on (cloud mode, or VEQSIO_BLOCK_PRIVATE_EGRESS=1): loopback, private, CGNAT, unique-local,
 * multicast addresses and internal host names, checked on the URL AND on every address the name resolves to, and again
 * on every redirect hop. Self-hosted installs keep delivering webhooks to internal services unless they opt in.
 * VEQSIO_ALLOW_PRIVATE_EGRESS=1 turns the private-range check off (development/tests only, ignored in cloud mode).
 *
 * Residual risk: DNS is resolved for the check and again by fetch (rebinding window); pair with a network egress policy.
 */
import { isIP } from 'net';
import { lookup } from 'dns/promises';
import { isBlockedHostname, isLinkLocalOrMetadata, isPrivateAddress } from '../plugins/ssrf';
import { isCloud } from '../cloud/mode';

export class EgressError extends Error {}
const METADATA = new Set(['metadata.google.internal', 'metadata', 'instance-data']);

export function egressGuardOn(env: NodeJS.ProcessEnv = process.env): boolean {
  if (isCloud(env)) return true;
  return env.VEQSIO_BLOCK_PRIVATE_EGRESS === '1' && env.VEQSIO_ALLOW_PRIVATE_EGRESS !== '1';
}

export function checkEgressUrl(raw: string, env: NodeJS.ProcessEnv = process.env): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new EgressError('Invalid URL'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new EgressError('Only http and https URLs are allowed');
  if (u.username || u.password) throw new EgressError('Do not put credentials in the URL');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (METADATA.has(host) || (isIP(host) && isLinkLocalOrMetadata(host))) throw new EgressError('Host is not allowed');
  if (egressGuardOn(env)) {
    if (isBlockedHostname(host) || (isIP(host) && isPrivateAddress(host))) throw new EgressError('Host is not allowed');
  }
  return u;
}

export async function assertEgressUrl(raw: string, env: NodeJS.ProcessEnv = process.env, resolve: typeof lookup = lookup): Promise<URL> {
  const u = checkEgressUrl(raw, env);
  const host = u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (isIP(host)) return u;
  // Always resolve: a public-looking name whose A record is 169.254.169.254 must be refused even when the private-range
  // guard is off. With the guard off a lookup failure is not fatal (offline installs, tests): fetch fails on its own.
  let addrs: { address: string }[];
  try { addrs = (await resolve(host, { all: true })) as { address: string }[]; }
  catch { if (egressGuardOn(env)) throw new EgressError('Host could not be resolved'); return u; }
  for (const a of addrs) {
    if (isLinkLocalOrMetadata(a.address)) throw new EgressError('Host is not allowed');
    if (egressGuardOn(env) && isPrivateAddress(a.address)) throw new EgressError('Host is not allowed');
  }
  return u;
}

/** fetch() with the guard applied to the first URL and to every redirect hop (up to 3). */
export async function outboundFetch(url: string, init: RequestInit = {}, opts: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; maxRedirects?: number } = {}): Promise<Response> {
  // A client span per outgoing call: method, host and status only, never the path, query, headers or body (they can hold tokens)
  let host = 'unknown';
  try { host = new URL(url).host; } catch { /* the guard below rejects it */ }
  const method = (init.method ?? 'GET').toUpperCase();
  return withSpan(`${method} ${host}`, { 'http.request.method': method, 'server.address': host }, () => outboundFetchUntraced(url, init, opts), {
    client: true,
    after: (r) => ({ 'http.response.status_code': r.status }),
  });
}

async function outboundFetchUntraced(url: string, init: RequestInit, opts: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; maxRedirects?: number }): Promise<Response> {
  const doFetch = opts.fetchImpl ?? fetch;
  const env = opts.env ?? process.env;
  let current = (await assertEgressUrl(url, env)).toString();
  let method = (init.method ?? 'GET').toUpperCase();
  let body = init.body;
  for (let hop = 0; hop <= (opts.maxRedirects ?? 3); hop++) {
    const res = await doFetch(current, { ...init, method, body, redirect: 'manual' });
    if (res.status < 300 || res.status >= 400 || res.status === 304) return res;
    const loc = res.headers.get('location');
    await res.body?.cancel();
    if (!loc) return res;
    current = (await assertEgressUrl(new URL(loc, current).toString(), env)).toString();
    if (res.status === 301 || res.status === 302 || res.status === 303) { method = 'GET'; body = undefined; }
  }
  throw new EgressError('Too many redirects');
}
