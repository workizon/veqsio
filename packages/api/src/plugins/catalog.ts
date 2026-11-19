/**
 * Plugin marketplace: a curated catalog is a JSON file an administrator points the instance at (their own list, a
 * vendor's, or a company-internal one). It only lists manifest URLs; installing still goes through the normal
 * install path (manifest validation, no auto-enable, explicit scope approval). Nothing is fetched until an
 * administrator opens the marketplace, and the catalog URL gets the same SSRF guard as manifest URLs.
 */
import { z } from 'zod';
import { assertPublicUrl, PluginFetchError, privateHostsAllowed } from './ssrf';

const MAX_CATALOG_BYTES = 256 * 1024;

const entry = z.object({
  key: z.string().min(3).max(128),
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  version: z.string().max(40).optional(),
  author: z.string().max(100).optional(),
  homepage: z.string().url().max(2048).optional(),
  manifestUrl: z.string().url().max(2048),
});
const catalogSchema = z.object({ plugins: z.array(z.unknown()).max(500) });

export type CatalogEntry = z.infer<typeof entry>;
export interface Catalog { entries: CatalogEntry[]; skipped: number }

/** Entries that do not validate are skipped (counted), so one bad row does not hide the rest. http URLs are refused unless private hosts are allowed. */
export function parseCatalog(text: string, env: NodeJS.ProcessEnv = process.env): Catalog {
  let json: unknown;
  try { json = JSON.parse(text); } catch { throw new PluginFetchError('The catalog is not valid JSON'); }
  const top = catalogSchema.safeParse(json);
  if (!top.success) throw new PluginFetchError('The catalog must be an object with a "plugins" list');
  const secureOnly = !privateHostsAllowed(env);
  const entries: CatalogEntry[] = []; let skipped = 0;
  const seen = new Set<string>();
  for (const raw of top.data.plugins) {
    const e = entry.safeParse(raw);
    if (!e.success || (secureOnly && !e.data.manifestUrl.startsWith('https://')) || (e.data.homepage && !/^https?:\/\//.test(e.data.homepage)) || seen.has(e.data.key)) { skipped++; continue; }
    seen.add(e.data.key);
    entries.push(e.data);
  }
  return { entries, skipped };
}

export async function fetchCatalog(url: string, opts: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv } = {}): Promise<Catalog> {
  const env = opts.env ?? process.env;
  const doFetch = opts.fetchImpl ?? fetch;
  let current = (await assertPublicUrl(url, env)).toString();
  const origin = new URL(current).host;
  for (let hop = 0; hop <= 3; hop++) {
    const res = await doFetch(current, { redirect: 'manual', headers: { Accept: 'application/json', 'User-Agent': 'Veqsio-Plugin-Catalog/1.0' }, signal: AbortSignal.timeout(10_000) });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      await res.body?.cancel();
      if (!loc) throw new PluginFetchError('Redirect without location');
      const next = await assertPublicUrl(new URL(loc, current).toString(), env);
      if (next.host !== origin) throw new PluginFetchError('Redirect to a different host is not allowed');
      current = next.toString();
      continue;
    }
    if (!res.ok) { await res.body?.cancel(); throw new PluginFetchError(`The catalog returned HTTP ${res.status}`); }
    const declared = Number(res.headers.get('content-length'));
    if (declared > MAX_CATALOG_BYTES) { await res.body?.cancel(); throw new PluginFetchError('The catalog is too large'); }
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > MAX_CATALOG_BYTES) throw new PluginFetchError('The catalog is too large');
    return parseCatalog(new TextDecoder().decode(buf), env);
  }
  throw new PluginFetchError('Too many redirects');
}
