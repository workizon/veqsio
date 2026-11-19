import { describe, test, expect } from 'bun:test';
import { validateManifest, parseManifestText, diffManifests, scopeForEvent, scopeSatisfies, PLUGIN_EVENTS, PLUGIN_SCOPES, MAX_MANIFEST_BYTES } from './manifest';
import { signPayload, verifySignature, REPLAY_WINDOW_SECONDS } from './signing';
import { isPrivateAddress, isBlockedHostname, checkPluginUrl, fetchManifest, PluginFetchError } from './ssrf';
import { buildPluginPayload } from './events';
import { ALL_EVENTS } from '../services/webhooks';

const good = () => ({
  schemaVersion: 1,
  key: 'com.acme.foo',
  name: 'Foo',
  version: '1.2.3',
  description: 'Does foo',
  vendor: { name: 'Acme', url: 'https://acme.example' },
  baseUrl: 'https://foo.acme.example',
  scopes: ['read:issues'],
  events: ['issue.created'],
  webhookPath: '/hook',
  config: [{ key: 'apiKey', label: 'API key', type: 'secret', required: true }],
  uiPanels: [{ location: 'issue.sidebar', title: 'Foo', path: '/panel' }],
});
const errs = (m: unknown, o?: { allowInsecure?: boolean }) => {
  const r = validateManifest(m, o);
  return r.ok ? [] : r.errors.join('\n');
};

describe('manifest validation', () => {
  test('accepts a good manifest and applies defaults', () => {
    expect(validateManifest(good()).ok).toBe(true);
    const r = validateManifest({ schemaVersion: 1, key: 'com.acme.min', name: 'M', version: '0.0.1', vendor: { name: 'A', url: 'https://a.example' }, baseUrl: 'https://m.example' });
    expect(r.ok && r.manifest.scopes).toEqual([]);
  });
  test('event names stay in sync with webhooks and scopes reuse token scopes', () => {
    expect([...PLUGIN_EVENTS].sort()).toEqual([...ALL_EVENTS].sort());
    expect(PLUGIN_SCOPES).toEqual(['read:issues', 'write:issues', 'read:projects', 'write:projects']);
  });
  test.each(['foo', 'com.acme', 'Com.Acme.Foo', 'com.acme.foo!', 'com..acme.foo', '.com.acme.foo', 'com.acme.-foo', 'com.acme.1foo', 'com.acme.foo/../x', '', 'com.acme.' + 'a'.repeat(40)])('bad key %p', (key) => {
    expect(errs({ ...good(), key })).toContain('key');
  });
  test.each(['1', '1.2', 'v1.2.3', '01.2.3', '1.2.3.4', 'latest'])('bad version %p', (version) => {
    expect(errs({ ...good(), version })).toContain('version');
  });
  test('semver prerelease is fine', () => {
    expect(validateManifest({ ...good(), version: '1.0.0-beta.1+build.5' }).ok).toBe(true);
  });
  test('baseUrl must be https without credentials/query', () => {
    expect(errs({ ...good(), baseUrl: 'http://foo.example' })).toContain('https');
    expect(errs({ ...good(), baseUrl: 'ftp://foo.example' })).toContain('https');
    expect(errs({ ...good(), baseUrl: 'https://u:p@foo.example' })).toContain('credentials');
    expect(errs({ ...good(), baseUrl: 'https://foo.example/?a=1' })).toContain('query');
    expect(errs({ ...good(), baseUrl: 'nonsense' })).toContain('valid URL');
    expect(errs({ ...good(), vendor: { name: 'A', url: 'http://a.example' } })).toContain('https');
  });
  test('http allowed only with allowInsecure (dev)', () => {
    expect(validateManifest({ ...good(), baseUrl: 'http://127.0.0.1:9' }, { allowInsecure: true }).ok).toBe(true);
  });
  test('unknown scopes, wildcards and admin are rejected', () => {
    for (const s of ['admin', '*', 'read:*', 'write:*', 'read:everything', 'read']) expect(errs({ ...good(), scopes: [s] })).toContain('scopes');
  });
  test('unknown events and duplicates are rejected', () => {
    expect(errs({ ...good(), events: ['issue.exploded'] })).toContain('events');
    expect(errs({ ...good(), events: ['issue.created', 'issue.created'] })).toContain('duplicate');
    expect(errs({ ...good(), scopes: ['read:issues', 'read:issues'] })).toContain('duplicate');
  });
  test('events need a webhookPath; paths are constrained', () => {
    const { webhookPath, ...rest } = good();
    expect(errs(rest)).toContain('webhookPath');
    for (const p of ['hook', '//evil.example/x', '/a/../b', '/a?x=1', '/a#f', '/a\\b', '/%2e%2e/x', '/a b']) {
      expect(errs({ ...good(), webhookPath: p })).toContain('webhookPath');
    }
  });
  test('unknown panel location and bad panel paths', () => {
    expect(errs({ ...good(), uiPanels: [{ location: 'global.header', title: 'x', path: '/p' }] })).toContain('uiPanels');
    expect(errs({ ...good(), uiPanels: [{ location: 'issue.tab', title: 'x', path: '//x.example' }] })).toContain('path');
    expect(errs({ ...good(), uiPanels: [{ location: 'issue.tab', title: '', path: '/p' }] })).toContain('title');
  });
  test('config fields: types, select options, duplicates, key format', () => {
    expect(errs({ ...good(), config: [{ key: 'a', label: 'A', type: 'select' }] })).toContain('options');
    expect(errs({ ...good(), config: [{ key: 'a', label: 'A', type: 'text', options: ['x'] }] })).toContain('options');
    expect(errs({ ...good(), config: [{ key: 'a', label: 'A', type: 'file' }] })).toContain('config');
    expect(errs({ ...good(), config: [{ key: 'A b', label: 'A', type: 'text' }] })).toContain('key');
    const dup = [{ key: 'a', label: 'A', type: 'text' }, { key: 'a', label: 'B', type: 'text' }];
    expect(errs({ ...good(), config: dup })).toContain('duplicate');
    expect(validateManifest({ ...good(), config: [{ key: 's', label: 'S', type: 'select', options: ['x', 'y'] }] }).ok).toBe(true);
  });
  test('strict: unknown top-level and nested fields are rejected', () => {
    expect(validateManifest({ ...good(), extra: 1 }).ok).toBe(false);
    expect(validateManifest({ ...good(), vendor: { name: 'A', url: 'https://a.example', x: 1 } }).ok).toBe(false);
    expect(validateManifest({ ...good(), schemaVersion: 2 }).ok).toBe(false);
  });
  test('oversize manifests are rejected', () => {
    expect(errs({ ...good(), description: 'x'.repeat(1001) })).toContain('description');
    const big = { ...good(), uiPanels: Array.from({ length: 21 }, (_, i) => ({ location: 'issue.tab', title: 't', path: `/p${i}` })) };
    expect(validateManifest(big).ok).toBe(false);
    expect(errs({ ...good(), padding: 'x'.repeat(MAX_MANIFEST_BYTES) })).toContain('exceeds');
    expect(parseManifestText('x'.repeat(MAX_MANIFEST_BYTES + 1)).ok).toBe(false);
    expect(parseManifestText('{nope').ok).toBe(false);
  });
});

describe('manifest diff and scope helpers', () => {
  test('diff reports added/removed scopes and events and approval need', () => {
    const a = validateManifest(good());
    const b = validateManifest({ ...good(), version: '2.0.0', scopes: ['write:issues', 'read:projects'], events: ['comment.added'] });
    if (!a.ok || !b.ok) throw new Error('setup');
    const d = diffManifests(a.manifest, b.manifest);
    expect(d.scopes).toEqual({ added: ['write:issues', 'read:projects'], removed: ['read:issues'] });
    expect(d.events).toEqual({ added: ['comment.added'], removed: ['issue.created'] });
    expect(d.needsApproval).toBe(true);
    expect(diffManifests(a.manifest, a.manifest).needsApproval).toBe(false);
    const c = validateManifest({ ...good(), baseUrl: 'https://other.example' });
    if (!c.ok) throw new Error('setup');
    expect(diffManifests(a.manifest, c.manifest)).toMatchObject({ baseUrlChanged: true, needsApproval: true });
  });
  test('event scope requirements', () => {
    expect(scopeForEvent('issue.created')).toBe('read:issues');
    expect(scopeForEvent('sprint.started')).toBe('read:projects');
    expect(scopeSatisfies(['write:issues'], 'read:issues')).toBe(true);
    expect(scopeSatisfies(['read:projects'], 'read:issues')).toBe(false);
    expect(scopeSatisfies([], 'read:issues')).toBe(false);
  });
});

describe('signatures', () => {
  const secret = 'whsec_test';
  const body = '{"event":"issue.created"}';
  const now = 1_800_000_000;
  test('sign/verify roundtrip with documented format', () => {
    const sig = signPayload(secret, now, body);
    expect(sig).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(verifySignature(secret, String(now), body, sig, now)).toEqual({ ok: true });
  });
  test('tampered body, secret, timestamp or signature fail', () => {
    const sig = signPayload(secret, now, body);
    expect(verifySignature(secret, String(now), body + ' ', sig, now)).toEqual({ ok: false, reason: 'mismatch' });
    expect(verifySignature('other', String(now), body, sig, now)).toEqual({ ok: false, reason: 'mismatch' });
    expect(verifySignature(secret, String(now + 1), body, sig, now)).toEqual({ ok: false, reason: 'mismatch' });
    expect(verifySignature(secret, String(now), body, sig.slice(0, -1) + (sig.endsWith('0') ? '1' : '0'), now)).toEqual({ ok: false, reason: 'mismatch' });
    expect(verifySignature(secret, String(now), body, 'v1=short', now)).toEqual({ ok: false, reason: 'mismatch' });
  });
  test('replay window', () => {
    const old = now - REPLAY_WINDOW_SECONDS - 1;
    expect(verifySignature(secret, String(old), body, signPayload(secret, old, body), now)).toEqual({ ok: false, reason: 'stale' });
    const edge = now - REPLAY_WINDOW_SECONDS;
    expect(verifySignature(secret, String(edge), body, signPayload(secret, edge, body), now).ok).toBe(true);
    const future = now + REPLAY_WINDOW_SECONDS + 1;
    expect(verifySignature(secret, String(future), body, signPayload(secret, future, body), now)).toEqual({ ok: false, reason: 'stale' });
  });
  test('malformed inputs', () => {
    expect(verifySignature(secret, 'abc', body, 'v1=x', now)).toEqual({ ok: false, reason: 'malformed' });
    expect(verifySignature(secret, String(now), body, 'sha256=abc', now)).toEqual({ ok: false, reason: 'malformed' });
    expect(verifySignature(secret, '', body, 'v1=x', now)).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('SSRF checks', () => {
  test.each(['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '224.0.0.1', '255.255.255.255', '::1', '::', 'fc00::1', 'fd12::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', 'ff02::1'])('private %p', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });
  test.each(['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '100.63.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])('public %p', (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });
  test('blocked hostnames', () => {
    for (const h of ['localhost', 'a.localhost', 'printer.local', 'db.internal', 'metadata.google.internal', 'LOCALHOST.']) expect(isBlockedHostname(h)).toBe(true);
    expect(isBlockedHostname('plugins.example.com')).toBe(false);
  });
  test('checkPluginUrl', () => {
    const env = {} as NodeJS.ProcessEnv;
    for (const u of ['http://example.com/m.json', 'https://localhost/m', 'https://127.0.0.1/m', 'https://[::1]/m', 'https://10.0.0.5/m', 'https://169.254.169.254/latest', 'https://user:pw@example.com/m', 'file:///etc/passwd', 'https://2130706433/m', 'not a url']) {
      expect(() => checkPluginUrl(u, env)).toThrow(PluginFetchError);
    }
    expect(checkPluginUrl('https://example.com/m.json', env).host).toBe('example.com');
  });
  test('private-hosts override allows loopback http but never link-local/metadata', () => {
    const env = { PLUGINS_ALLOW_PRIVATE_HOSTS: 'true' } as NodeJS.ProcessEnv;
    expect(checkPluginUrl('http://127.0.0.1:8080/m', env).port).toBe('8080');
    expect(() => checkPluginUrl('http://169.254.169.254/', env)).toThrow(PluginFetchError);
    expect(() => checkPluginUrl('http://metadata.google.internal/', env)).toThrow(PluginFetchError);
  });
  test('fetchManifest: size cap, cross-host redirect and http errors', async () => {
    const env = {} as NodeJS.ProcessEnv;
    const ok = async () => new Response(JSON.stringify(good()), { status: 200 });
    // example.com resolves publicly in real DNS, but tests must not need network: use a literal public IP.
    const r = await fetchManifest('https://8.8.8.8/m.json', { fetchImpl: ok as any, env });
    expect(r.ok).toBe(true);
    const huge = async () => new Response('x'.repeat(MAX_MANIFEST_BYTES + 10), { status: 200 });
    await expect(fetchManifest('https://8.8.8.8/m.json', { fetchImpl: huge as any, env })).rejects.toThrow('too large');
    const cross = async () => new Response(null, { status: 302, headers: { location: 'https://1.1.1.1/m.json' } });
    await expect(fetchManifest('https://8.8.8.8/m.json', { fetchImpl: cross as any, env })).rejects.toThrow('different host');
    const internal = async () => new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/m.json' } });
    await expect(fetchManifest('https://8.8.8.8/m.json', { fetchImpl: internal as any, env })).rejects.toThrow('not allowed');
    const loop = async () => new Response(null, { status: 302, headers: { location: '/m.json' } });
    await expect(fetchManifest('https://8.8.8.8/m.json', { fetchImpl: loop as any, env })).rejects.toThrow('Too many redirects');
    const nf = async () => new Response('no', { status: 404 });
    await expect(fetchManifest('https://8.8.8.8/m.json', { fetchImpl: nf as any, env })).rejects.toThrow('HTTP 404');
    await expect(fetchManifest('https://127.0.0.1/m.json', { fetchImpl: ok as any, env })).rejects.toThrow('not allowed');
  });
});

describe('event payload minimisation', () => {
  test('only whitelisted lightweight fields survive; comment bodies and summaries are dropped', () => {
    const p = buildPluginPayload('comment.added', {
      issueKey: 'A-1', issueId: 1, projectId: 2, commentId: 3, commentBody: 'secret internal text', summary: 'S', authorName: 'Ann',
      issueUrl: 'x', changes: [{ field: 'status', oldValue: 'a', newValue: 'b' }],
    });
    expect(p).toEqual({ issueKey: 'A-1', issueId: 1, projectId: 2, commentId: 3, actor: { displayName: 'Ann' }, changedFields: ['status'], type: 'comment.added' });
    expect(JSON.stringify(p)).not.toContain('secret internal text');
  });
});
