import { describe, test, expect } from 'bun:test';
import { applyMapping, mappingSchema, cleanLabel } from './mapping';
import { normalizeSentry } from './sentry';
import { hmacHex, verifyHmac, providedSecret, headerIdempotencyKey } from './verify';
import { redactPayload } from './redact';
import { buildChatMessage, chatEventFor, formatSlack, formatTeams, slackEscape, teamsEscape } from './chat';

const grafana = {
  status: 'firing',
  alerts: [{ status: 'firing', labels: { alertname: 'HighCPU', severity: 'critical', team: 'platform ops' }, annotations: { summary: 'CPU > 90%', description: 'Node a1 is hot' }, fingerprint: 'fp-1' }],
};

const mapping = {
  summary: '[{{alerts[0].labels.alertname}}] {{alerts[0].annotations.summary}}',
  description: '{{alerts[0].annotations.description}}\nTeam: {{alerts[0].labels.team}}',
  priority: '{{alerts[0].labels.severity}}',
  priorityMap: { critical: 'Highest', warning: 'Medium' },
  labels: ['alert', '{{alerts[0].labels.team}}'],
  dedupKey: '{{alerts[0].fingerprint}}',
  resolvedWhen: { path: 'status', equals: ['resolved', 'ok'] },
};

describe('mapping', () => {
  test('maps a Grafana style payload', () => {
    const n = applyMapping(mapping, grafana);
    expect(n.summary).toBe('[HighCPU] CPU > 90%');
    expect(n.description).toContain('Node a1 is hot');
    expect(n.priority).toBe('Highest');
    expect(n.labels).toEqual(['alert', 'platform-ops']);
    expect(n.dedupKey).toBe('fp-1');
    expect(n.resolved).toBe(false);
  });
  test('resolvedWhen is case-insensitive and supports lists', () => {
    expect(applyMapping(mapping, { ...grafana, status: 'RESOLVED' }).resolved).toBe(true);
    expect(applyMapping(mapping, { ...grafana, status: 'ok' }).resolved).toBe(true);
    expect(applyMapping(mapping, { ...grafana, status: 'pending' }).resolved).toBe(false);
  });
  test('unmapped severities do not become priorities when a priorityMap exists; without a map the raw value is used', () => {
    expect(applyMapping(mapping, { ...grafana, alerts: [{ ...grafana.alerts[0], labels: { severity: 'info' } }] }).priority).toBeNull();
    expect(applyMapping({ priority: '{{sev}}' }, { sev: 'High' }).priority).toBe('high');
  });
  test('empty mapping falls back to title / message', () => {
    const n = applyMapping({}, { title: 'Hello', message: 'World' });
    expect(n.summary).toBe('Hello');
    expect(n.description).toBe('World');
    expect(n.dedupKey).toBeNull();
    expect(applyMapping({}, {}).summary).toBe('Webhook event');
  });
  test('summary is a single line of at most 255 characters', () => {
    expect(applyMapping({ summary: '{{t}}' }, { t: 'a\nb' }).summary).toBe('a');
    expect(applyMapping({ summary: '{{t}}' }, { t: 'x'.repeat(2000) }).summary.length).toBeLessThanOrEqual(255);
  });
  test('schema rejects unknown keys, bad templates and bad paths', () => {
    expect(mappingSchema.safeParse({ summary: 'ok', evil: 1 }).success).toBe(false);
    expect(mappingSchema.safeParse({ summary: '{{a | exec}}' }).success).toBe(false);
    expect(mappingSchema.safeParse({ resolvedWhen: { path: 'a..b', equals: 'x' } }).success).toBe(false);
    expect(mappingSchema.safeParse(mapping).success).toBe(true);
  });
  test('labels are cleaned', () => {
    expect(cleanLabel('Hello World!')).toBe('Hello-World');
  });
});

describe('sentry', () => {
  const alert = {
    action: 'triggered',
    data: { event: { issue_id: '123456', title: 'TypeError: x is undefined', culprit: 'app/main.js in handler', level: 'error', web_url: 'https://sentry.io/organizations/o/issues/123456/events/abc/', environment: 'production', platform: 'javascript' }, triggered_rule: 'Prod errors' },
  };
  test('issue alert payload', () => {
    const n = normalizeSentry(alert)!;
    expect(n.summary).toBe('TypeError: x is undefined');
    expect(n.dedupKey).toBe('sentry:123456');
    expect(n.priority).toBe('High');
    expect(n.description).toContain('app/main.js in handler');
    expect(n.description).toContain('https://sentry.io/organizations/o/issues/123456/events/abc/');
    expect(n.labels).toContain('sentry-error');
    expect(n.resolved).toBe(false);
  });
  test('level to priority', () => {
    const lvl = (level: string) => normalizeSentry({ ...alert, data: { ...alert.data, event: { ...alert.data.event, level } } })!.priority;
    expect([lvl('fatal'), lvl('error'), lvl('warning'), lvl('info'), lvl('debug')]).toEqual(['Highest', 'High', 'Medium', 'Low', 'Lowest']);
  });
  test('issue webhook: created, resolved, others ignored', () => {
    const issue = { id: '9', title: 'Boom', culprit: 'x', level: 'fatal', permalink: 'https://sentry.io/i/9/', status: 'unresolved', project: { slug: 'web' } };
    expect(normalizeSentry({ action: 'created', data: { issue } })!.dedupKey).toBe('sentry:9');
    expect(normalizeSentry({ action: 'resolved', data: { issue: { ...issue, status: 'resolved' } } })!.resolved).toBe(true);
    expect(normalizeSentry({ action: 'assigned', data: { issue } })).toBeNull();
  });
  test('unknown shapes and unsafe links', () => {
    expect(normalizeSentry({ action: 'created', installation: { uuid: 'u' } })).toBeNull();
    expect(normalizeSentry(null)).toBeNull();
    const n = normalizeSentry({ ...alert, data: { ...alert.data, event: { ...alert.data.event, web_url: 'javascript:alert(1)' } } })!;
    expect(n.description).not.toContain('javascript:');
  });
});

describe('signatures', () => {
  const body = '{"a":1}';
  test('HMAC accepts sha256= prefix and bare hex, rejects tampering', () => {
    const sig = hmacHex('s3cret', body);
    expect(verifyHmac('s3cret', body, sig)).toBe(true);
    expect(verifyHmac('s3cret', body, `sha256=${sig}`)).toBe(true);
    expect(verifyHmac('s3cret', body, sig.toUpperCase())).toBe(true);
    expect(verifyHmac('s3cret', body + ' ', sig)).toBe(false);
    expect(verifyHmac('other', body, sig)).toBe(false);
    expect(verifyHmac('s3cret', body, undefined)).toBe(false);
    expect(verifyHmac('s3cret', body, 'sha256=zz')).toBe(false);
    expect(verifyHmac('s3cret', body, '')).toBe(false);
  });
  test('shared secret extraction', () => {
    expect(providedSecret((n) => ({ 'x-veqsio-secret': 'abc' } as any)[n])).toBe('abc');
    expect(providedSecret((n) => ({ authorization: 'Bearer tok' } as any)[n])).toBe('tok');
    expect(providedSecret(() => undefined)).toBe('');
  });
  test('idempotency key headers', () => {
    expect(headerIdempotencyKey((n) => ({ 'idempotency-key': 'k1' } as any)[n], 'generic')).toBe('k1');
    expect(headerIdempotencyKey((n) => ({ 'x-github-delivery': 'g1' } as any)[n], 'generic')).toBe('g1');
    expect(headerIdempotencyKey((n) => ({ 'request-id': 'r1' } as any)[n], 'generic')).toBeNull();
    expect(headerIdempotencyKey((n) => ({ 'request-id': 'r1' } as any)[n], 'sentry')).toBe('r1');
  });
});

describe('redaction', () => {
  test('removes credentials by key and by value pattern, and caps size', () => {
    const out = redactPayload(JSON.stringify({ user: 'bob', password: 'hunter2', headers: { Authorization: 'Bearer abcdefghijkl' }, note: 'token ghp_abcdefghijklmnopqrstuvwxyz0123', big: 'x'.repeat(5000) }), 600);
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('abcdefghijkl');
    expect(out).not.toContain('ghp_');
    expect(out).toContain('bob');
    expect(out.length).toBeLessThanOrEqual(700);
    expect(out).toContain('truncated');
  });
  test('non-JSON text is handled', () => {
    expect(redactPayload('hello Bearer abcdefghijklmnop')).not.toContain('abcdefghijklmnop');
  });
});

describe('chat formatters', () => {
  const payload = { issueKey: 'APP-1', summary: 'Login <b>broken</b> & <!channel>', projectName: 'App', issueUrl: 'https://x.test/issues/APP-1', priority: 'High', assignee: 'Ann', reporterName: 'Bob' };
  test('event mapping', () => {
    expect(chatEventFor('issue.created', {})).toBe('issue.created');
    expect(chatEventFor('issue.updated', { assignedTo: 3 })).toBe('issue.assigned');
    expect(chatEventFor('issue.updated', {})).toBeNull();
    expect(chatEventFor('sprint.closed', {})).toBe('sprint.completed');
    expect(chatEventFor('sla.breached', {})).toBeNull();
  });
  test('Slack blocks escape control characters and link the title', () => {
    const msg = formatSlack(buildChatMessage('issue.created', payload)) as any;
    const text = JSON.stringify(msg);
    expect(msg.blocks[0].type).toBe('header');
    expect(msg.blocks[1].text.text).toContain('<https://x.test/issues/APP-1|APP-1: Login &lt;b&gt;broken&lt;/b&gt; &amp; &lt;!channel&gt;>');
    expect(text).not.toContain('<!channel>');
    expect(msg.text).toContain('Issue created');
    expect(msg.blocks.some((b: any) => b.fields?.some((f: any) => f.text.includes('High')))).toBe(true);
  });
  test('Teams adaptive card and MessageCard', () => {
    const m = buildChatMessage('comment.added', { ...payload, authorName: 'Eve', commentBody: 'see [link](http://evil) *bold*' });
    const adaptive = formatTeams(m, 'adaptive') as any;
    expect(adaptive.attachments[0].contentType).toBe('application/vnd.microsoft.card.adaptive');
    const card = adaptive.attachments[0].content;
    expect(card.type).toBe('AdaptiveCard');
    expect(card.actions[0].url).toBe('https://x.test/issues/APP-1');
    expect(JSON.stringify(card)).not.toContain('[link](http://evil)');
    const legacy = formatTeams(m, 'messagecard') as any;
    expect(legacy['@type']).toBe('MessageCard');
    expect(legacy.potentialAction[0].targets[0].uri).toBe('https://x.test/issues/APP-1');
  });
  test('unsafe URLs are dropped and long text is cut', () => {
    const m = buildChatMessage('comment.added', { ...payload, issueUrl: 'javascript:alert(1)', commentBody: 'x'.repeat(5000) });
    expect(m.url).toBeUndefined();
    expect(m.quote!.length).toBeLessThanOrEqual(300);
  });
  test('escape helpers', () => {
    expect(slackEscape('<a>&')).toBe('&lt;a&gt;&amp;');
    expect(teamsEscape('*x*')).toBe('\\*x\\*');
  });
  test('status change fact for transitions', () => {
    const m = buildChatMessage('issue.transitioned', { ...payload, authorName: 'Ann', changes: [{ field: 'status', oldValue: 'To Do', newValue: 'Done' }] });
    expect(m.facts[0]).toEqual({ label: 'Status', value: 'To Do → Done' });
  });
});
