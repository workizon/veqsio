import { describe, it, expect } from 'bun:test';
import { parseCatalog, fetchCatalog } from './catalog';

const ok = { key: 'com.acme.foo', name: 'Foo', manifestUrl: 'https://acme.example/m.json', description: 'x' };

describe('plugin catalog', () => {
  it('parses entries and skips bad, insecure and duplicate ones', () => {
    const c = parseCatalog(JSON.stringify({ plugins: [ok, ok, { name: 'no key' }, { ...ok, key: 'com.acme.bar', manifestUrl: 'http://acme.example/m.json' }, 7] }), {});
    expect(c.entries.map((e) => e.key)).toEqual(['com.acme.foo']);
    expect(c.skipped).toBe(4);
  });
  it('allows http manifests only when private hosts are allowed', () => {
    const c = parseCatalog(JSON.stringify({ plugins: [{ ...ok, manifestUrl: 'http://localhost:9/m.json' }] }), { PLUGINS_ALLOW_PRIVATE_HOSTS: 'true' });
    expect(c.entries.length).toBe(1);
  });
  it('rejects non-catalog JSON and invalid JSON', () => {
    expect(() => parseCatalog('{"x":1}')).toThrow();
    expect(() => parseCatalog('nope')).toThrow();
  });
  it('refuses private addresses and cross-host redirects', async () => {
    await expect(fetchCatalog('https://127.0.0.1/c.json')).rejects.toThrow();
    const redirect = (async () => new Response(null, { status: 302, headers: { location: 'https://evil.example.org/c.json' } })) as unknown as typeof fetch;
    await expect(fetchCatalog('https://1.1.1.1/c.json', { fetchImpl: redirect })).rejects.toThrow();
  });
  it('fetches and parses a catalog', async () => {
    const f = (async () => new Response(JSON.stringify({ plugins: [ok] }), { status: 200 })) as unknown as typeof fetch;
    const c = await fetchCatalog('https://1.1.1.1/c.json', { fetchImpl: f });
    expect(c.entries[0].name).toBe('Foo');
  });
});
