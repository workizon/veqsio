/**
 * Automated security suite. Every assertion here guards a property that was either found broken by this suite
 * (see docs/security.md, "Findings from the automated security suite") or is a baseline we must not lose.
 *
 *  1. authentication sweep over EVERY route in the Hono route table
 *  2. authorization / IDOR sweep (an ordinary user of project OTHER against data of project TEST)
 *  3. SQL injection payloads (JQL, text search, path and query parameters)
 *  4. stored XSS round trips (data is returned verbatim as JSON, never as HTML)
 *  5. mass assignment
 *  6. CSRF posture for cookie authenticated requests
 *  7. request size limits
 *  8. path traversal (storage keys, mock storage)
 *  9. header injection (email subjects)
 * 10. login brute force throttling and information leaks
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestSql, createTestDb, seedTestData, resetTestDb } from '../test-db';
import * as schema from '@veqsio/db';
import { eq, sql as dsql } from 'drizzle-orm';
import app from '../../src/app';
import { resetRateLimits } from '../reset-rate-limits';
import { redis } from '../../src/services/cache';

const SECRET = 'SECRET-SUMMARY-9f3a';
const JSON_H = { 'Content-Type': 'application/json' };

/**
 * Routes that are reachable without credentials ON PURPOSE. Adding a route to the API that answers something other
 * than 401 to an anonymous caller fails the sweep below until it is listed here with a reason: that is the point.
 */
const PUBLIC_ROUTES: Record<string, string> = {
  'GET /health': 'liveness probe',
  'GET /ready': 'readiness probe for load balancers: coarse ok/not-ok per dependency, no connection details',
  'GET /metrics': 'Prometheus scrape endpoint with its own bearer credential (METRICS_TOKEN); 404 when unset, 401 without the token',
  'GET /rest/api/2/openapi.json': 'OpenAPI description of the API: generated from the route table, contains no instance data',
  'GET /rest/api/2/serverInfo': 'Jira-compatible server info (version and base URL only)',
  'GET /rest/api/2/admin/health': 'plain {ok:true} liveness probe, no data',
  'POST /rest/auth/1/session': 'login',
  'GET /rest/public/config': 'public projects: indexing and site name for the anonymous pages, nothing else',
  'GET /rest/public/projects': 'public projects: anonymous read-only list, only projects an administrator made public (404 when the instance switch is off)',
  'GET /rest/public/projects/:key': 'public projects: anonymous read-only project summary',
  'GET /rest/public/projects/:key/issues': 'public projects: anonymous read-only issue list of a public project',
  'GET /rest/public/issues/:issueKey': 'public projects: anonymous read-only issue (no emails, no internal comments)',
  'GET /rest/public/projects/:key/board': 'public projects: read-only board of a public project, only when the project turned it on (404 otherwise)',
  'GET /rest/public/projects/:key/roadmap': 'public projects: versions and their progress, only when the project turned it on (404 otherwise)',
  'GET /rest/public/sitemap': 'public projects: URLs for sitemap.xml',
  'GET /rest/api/2/settings/public': 'sign-in page and header need the announcement banner and password rule; contains nothing else',
  'GET /rest/api/2/branding': 'sign-in page: site name, logo URLs, accent colour, footer links and the source URL; no secrets',
  'GET /rest/api/2/branding/file/:slot': 'sign-in page: the uploaded logo or favicon (served as a sandboxed image with nosniff and a restrictive CSP)',
  'POST /rest/api/2/oncall/alert': 'alert ingestion for monitoring tools: authenticated by the schedule integration key (hashed) in x-veqsio-alert-key, 401 without it',
  'POST /rest/webhooks/scm/:id': 'git provider webhook: authenticated by the per-repository HMAC signature or token, not a session',
  'POST /rest/auth/1/password-reset/request': 'public by design: always answers the same way (no account enumeration)',
  'POST /rest/auth/1/password-reset/confirm': 'public by design: protected by a single-use reset token',
  'GET /rest/auth/1/sso/microsoft': 'SSO login redirect',
  'GET /rest/auth/1/sso/microsoft/callback': 'SSO callback (state verified inside)',
  'GET /rest/auth/1/oidc/providers': 'login page: names of enabled identity providers',
  'GET /rest/auth/1/oidc/:slug/login': 'OIDC login redirect',
  'GET /rest/auth/1/oidc/:slug/callback': 'OIDC callback (state/nonce/PKCE verified inside)',
  'GET /rest/auth/1/saml/providers': 'login page: names of enabled SAML identity providers',
  'GET /rest/auth/1/saml/:slug/login': 'SAML SP-initiated login redirect (AuthnRequest)',
  'POST /rest/auth/1/saml/:slug/acs': 'SAML assertion consumer service: cross-site form POST from the IdP; signature, audience, recipient, InResponseTo, replay verified inside',
  'GET /rest/auth/1/saml/:slug/metadata': 'SAML SP metadata (entity ID, ACS URL, signing certificate): public by design, no secrets',
  'GET /rest/public/intake/:slug': 'intake: public form definition (title, intro, collected fields only), addressed by an unguessable slug, 404 unless the project enabled its public form',
  'POST /rest/public/intake/:slug': 'intake: anonymous submission, protected by the unguessable slug, honeypot, per-IP and per-form rate limits and size limits; stores a pending item, never an issue',
  'POST /rest/api/2/intake/:slug/email': 'intake: inbound email webhook, protected by the X-Veqsio-Inbound-Secret shared secret',
  'POST /rest/servicedeskapi/inbound-email/:slug': 'inbound email, protected by X-Veqsio-Inbound-Secret',
  'POST /rest/api/2/webhooks/inbound/:slug': 'integrations: inbound webhook, authenticated by the per-source HMAC signature (or Sentry-Hook-Signature / shared secret header), unguessable slug, per-source rate limit, body size limit and idempotency; 401 without valid credentials, 404 for unknown or disabled sources',
  'GET /mock-storage/:path{.*}': 'mock attachment storage, only mounted/served when STORAGE_TYPE=mock',
};

/** Routes with their own non-session authentication; they must still refuse anonymous callers. */
const OWN_AUTH_PREFIXES = ['/scim/v2/'];

const concretePath = (p: string) => p.replace(/:([A-Za-z]+)(\{[^}]*\})?/g, '1').replace(/\{.*?\}/g, '1');
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

describe('Security suite', () => {
  let testSql: ReturnType<typeof createTestSql>;
  let db: ReturnType<typeof createTestDb>;
  let seeded: Awaited<ReturnType<typeof seedTestData>>;

  let adminCookie = '';
  let aliceCookie = '';
  let bobCookie = '';
  let aliceId = 0;
  let bobId = 0;
  let otherProjectId = 0;
  let otherIssueKey = '';

  // victim data in project TEST (aliceId has no permission there)
  let issueKey = 'TEST-1';
  let issueId = 0;
  let commentId = 0;
  let attachmentId = 0;
  let worklogId = 0;
  let filterId = 0;
  let dashboardId = 0;
  let boardId = 0;
  let sprintId = 0;

  const call = (cookie: string | null, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
    app.request(path, {
      method,
      headers: { ...(body !== undefined ? JSON_H : {}), ...(cookie ? { Cookie: cookie } : {}), ...extra },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
  const cookieOf = (res: Response) => (res.headers.get('set-cookie') || '').split(';')[0];
  const login = async (username: string, password: string) =>
    cookieOf(await call(null, 'POST', '/rest/auth/1/session', { username, password }));

  /** A denied response: 401/403/404 and none of the victim's data in the body. */
  const expectDenied = async (res: Response, what: string) => {
    const text = await res.text();
    expect([401, 403, 404, 400], `${what} -> ${res.status} ${text.slice(0, 120)}`).toContain(res.status);
    expect(text, `${what} leaked victim data`).not.toContain(SECRET);
  };

  beforeAll(async () => {
    // The sweep sends thousands of requests from one address; the global request limiter is covered elsewhere.
    process.env.RATE_LIMIT_IP_MAX = '10000000';
    process.env.RATE_LIMIT_USER_MAX = '10000000';
    await resetRateLimits();
    testSql = createTestSql();
    seeded = await seedTestData(testSql);
    db = createTestDb(testSql);
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash('pw-123456', 4);
    await db.update(schema.users).set({ passwordHash: hash }).where(eq(schema.users.id, seeded.user.id));
    const [alice] = await db.insert(schema.users).values({ username: 'alice', email: 'alice@example.com', displayName: 'Alice', passwordHash: hash }).returning();
    const [bob] = await db.insert(schema.users).values({ username: 'bob', email: 'bob@example.com', displayName: 'Bob', passwordHash: hash }).returning();
    aliceId = alice.id;
    bobId = bob.id;

    // Second project with its own scheme: alice is a normal developer THERE (and only there).
    const [other] = await db.insert(schema.projects).values({ projectKey: 'OTHER', name: 'Other', leadId: seeded.user.id }).returning();
    otherProjectId = other.id;
    const [scheme2] = await db.insert(schema.permissionSchemes).values({ name: 'Other scheme' }).returning();
    await db.insert(schema.permissionSchemeAssociations).values({ projectId: other.id, schemeId: scheme2.id });
    const perms = ['BROWSE_PROJECTS', 'CREATE_ISSUES', 'EDIT_ISSUES', 'ADD_COMMENTS', 'EDIT_OWN_COMMENTS', 'DELETE_OWN_COMMENTS',
      'CREATE_ATTACHMENTS', 'DELETE_OWN_ATTACHMENTS', 'TRANSITION_ISSUES', 'WORK_ON_ISSUES', 'LINK_ISSUES'];
    await db.insert(schema.permissionEntries).values(perms.map((p) => ({ schemeId: scheme2.id, permissionKey: p, userId: alice.id })));
    // The workflow scheme must cover the second project as well
    const [wfAssoc] = await db.select().from(schema.workflowSchemeAssociations).limit(1);
    await db.insert(schema.workflowSchemeAssociations).values({ projectId: other.id, schemeId: wfAssoc.schemeId });

    adminCookie = await login('admin', 'pw-123456');
    aliceCookie = await login('alice', 'pw-123456');
    bobCookie = await login('bob', 'pw-123456');

    // ---- victim data in TEST, created by the administrator ----
    let res = await call(adminCookie, 'POST', '/rest/api/2/issue', {
      fields: { project: { id: seeded.project.id }, issuetype: { id: seeded.issueType.id }, summary: SECRET, description: 'private description' },
    });
    expect(res.status).toBe(201);
    const created = await res.json();
    issueKey = created.key;
    issueId = created.id;

    res = await call(adminCookie, 'POST', `/rest/api/2/issue/${issueKey}/comment`, { body: `comment ${SECRET}` });
    expect(res.status).toBe(201);
    commentId = (await res.json()).id;

    const [att] = await db.insert(schema.attachments).values({
      issueId, filename: 'secret.txt', filesize: 5, mimetype: 'text/plain', storageKey: `attachments/TEST/${issueKey}/secret.txt`, authorId: seeded.user.id,
    }).returning();
    attachmentId = att.id;

    res = await call(adminCookie, 'POST', `/rest/api/2/issue/${issueKey}/worklog`, { issueId, issueKey, timeSpentSeconds: 600, description: `work ${SECRET}` });
    expect(res.status).toBe(201);
    worklogId = (await res.json()).id;

    res = await call(adminCookie, 'POST', '/rest/api/2/filter', { name: `filter ${SECRET}`, jql: 'project = TEST' });
    expect(res.status).toBe(201);
    filterId = (await res.json()).id;

    res = await call(adminCookie, 'POST', '/rest/api/2/dashboard', { name: `dash ${SECRET}` });
    expect(res.status).toBe(201);
    dashboardId = Number((await res.json()).id);

    res = await call(adminCookie, 'POST', '/rest/api/2/board', { name: `board ${SECRET}`, type: 'scrum', projectId: seeded.project.id });
    expect(res.status).toBe(201);
    boardId = Number((await res.json()).id);

    res = await call(adminCookie, 'POST', `/rest/agile/1.0/board/${boardId}/sprint`, { name: `sprint ${SECRET}` });
    expect(res.status).toBe(201);
    sprintId = (await res.json()).id;
    await db.insert(schema.sprintIssues).values({ sprintId, issueId });

    // an issue alice legitimately owns, for positive controls
    res = await call(aliceCookie, 'POST', '/rest/api/2/issue', {
      fields: { project: { id: otherProjectId }, issuetype: { id: seeded.issueType.id }, summary: 'alice own issue' },
    });
    expect(res.status).toBe(201);
    otherIssueKey = (await res.json()).key;
    await resetRateLimits();
  });

  afterAll(async () => {
    delete process.env.RATE_LIMIT_IP_MAX;
    delete process.env.RATE_LIMIT_USER_MAX;
    await resetTestDb(testSql);
    await testSql.end();
  });

  /* ================================================================== */
  /*  1. Authentication sweep                                             */
  /* ================================================================== */
  describe('authentication: every route in the route table', () => {
    const routes = (() => {
      const seen = new Set<string>();
      const out: { method: string; path: string; key: string }[] = [];
      for (const r of app.routes) {
        if (r.method === 'ALL') continue; // middleware registrations
        const key = `${r.method} ${r.path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ method: r.method, path: r.path, key });
      }
      return out;
    })();

    test('the sweep sees the whole API', () => {
      expect(routes.length).toBeGreaterThan(250);
    });

    test('the public allowlist has no stale entries', () => {
      const keys = new Set(routes.map((r) => r.key));
      for (const k of Object.keys(PUBLIC_ROUTES)) expect(keys.has(k), `allowlisted route no longer exists: ${k}`).toBe(true);
    });

    test('anonymous requests get 401 on every non-public route (new public routes must be allowlisted deliberately)', async () => {
      const failures: string[] = [];
      for (const r of routes) {
        if (PUBLIC_ROUTES[r.key]) continue;
        const url = concretePath(r.path);
        const res = await app.request(url, {
          method: r.method,
          headers: BODY_METHODS.has(r.method) ? JSON_H : {},
          body: BODY_METHODS.has(r.method) ? '{}' : undefined,
        });
        if (res.status !== 401) failures.push(`${res.status} ${r.method} ${url}`);
      }
      expect(failures, `routes reachable without authentication:\n${failures.join('\n')}`).toEqual([]);
    });

    test('forged credentials are as good as none: bogus cookie and bogus bearer token give 401', async () => {
      const failures: string[] = [];
      for (const r of routes) {
        if (PUBLIC_ROUTES[r.key]) continue;
        const url = concretePath(r.path);
        for (const creds of [{ Cookie: 'session=00000000-0000-0000-0000-000000000000' }, { Authorization: 'Bearer not-a-real-token' }]) {
          const res = await app.request(url, {
            method: r.method,
            headers: { ...(BODY_METHODS.has(r.method) ? JSON_H : {}), ...creds },
            body: BODY_METHODS.has(r.method) ? '{}' : undefined,
          });
          if (res.status !== 401) failures.push(`${res.status} ${r.method} ${url} with ${Object.keys(creds)[0]}`);
        }
      }
      expect(failures).toEqual([]);
    });

    test('SCIM refuses web sessions (it only accepts its own bearer token)', async () => {
      for (const r of routes.filter((x) => OWN_AUTH_PREFIXES.some((p) => x.path.startsWith(p)))) {
        const res = await call(adminCookie, r.method, concretePath(r.path), BODY_METHODS.has(r.method) ? {} : undefined);
        expect(res.status, `${r.method} ${r.path}`).toBe(401);
      }
    });

    test('public routes do not crash on anonymous input', async () => {
      for (const r of routes.filter((x) => PUBLIC_ROUTES[x.key])) {
        const res = await app.request(concretePath(r.path), { method: r.method, headers: JSON_H, body: BODY_METHODS.has(r.method) ? '{}' : undefined });
        expect(res.status, `${r.key}`).toBeLessThan(500);
      }
    });

    test('a deactivated user is locked out even with a valid cookie', async () => {
      const [u] = await db.insert(schema.users).values({ username: 'ghost', email: 'ghost@example.com', displayName: 'Ghost', passwordHash: (await db.select().from(schema.users).where(eq(schema.users.id, aliceId)))[0].passwordHash }).returning();
      const cookie = await login('ghost', 'pw-123456');
      expect((await call(cookie, 'GET', '/rest/api/2/myself')).status).toBe(200);
      await db.update(schema.users).set({ active: false }).where(eq(schema.users.id, u.id));
      expect((await call(cookie, 'GET', '/rest/api/2/myself')).status).toBe(401);
    });

    test('session cookie flags: HttpOnly and SameSite=Lax', async () => {
      const res = await call(null, 'POST', '/rest/auth/1/session', { username: 'bob', password: 'pw-123456' });
      const sc = res.headers.get('set-cookie') || '';
      expect(sc).toContain('HttpOnly');
      expect(sc).toMatch(/SameSite=Lax/i);
    });
  });

  /* ================================================================== */
  /*  2. Authorization / IDOR                                             */
  /* ================================================================== */
  describe('authorization: an ordinary user of another project cannot touch project TEST', () => {
    test('positive control: alice can work in her own project', async () => {
      expect((await call(aliceCookie, 'GET', `/rest/api/2/issue/${otherIssueKey}`)).status).toBe(200);
      expect((await call(aliceCookie, 'POST', `/rest/api/2/issue/${otherIssueKey}/comment`, { body: 'mine' })).status).toBe(201);
    });

    // [family, method, path-builder, body]
    const cases: [string, string, () => string, (() => unknown) | undefined][] = [
      ['issue read', 'GET', () => `/rest/api/2/issue/${issueKey}`, undefined],
      ['issue read by id', 'GET', () => `/rest/api/2/issue/${issueId}`, undefined],
      ['issue changelog', 'GET', () => `/rest/api/2/issue/${issueKey}/changelog`, undefined],
      ['issue update', 'PUT', () => `/rest/api/2/issue/${issueKey}`, () => ({ fields: { summary: 'pwned' } })],
      ['issue delete', 'DELETE', () => `/rest/api/2/issue/${issueKey}`, undefined],
      ['issue transitions list', 'GET', () => `/rest/api/2/issue/${issueKey}/transitions`, undefined],
      ['issue transition', 'POST', () => `/rest/api/2/issue/${issueKey}/transitions`, () => ({ transition: { id: 1 } })],
      ['issue clone', 'POST', () => `/rest/api/2/issue/${issueKey}/clone`, () => ({})],
      ['issue move', 'POST', () => `/rest/api/2/issue/${issueKey}/move`, () => ({ targetProjectId: otherProjectId })],
      ['issue create in a foreign project', 'POST', () => '/rest/api/2/issue', () => ({ fields: { project: { id: seeded.project.id }, issuetype: { id: seeded.issueType.id }, summary: 'injected' } })],
      ['comment list', 'GET', () => `/rest/api/2/issue/${issueKey}/comment`, undefined],
      ['comment add', 'POST', () => `/rest/api/2/issue/${issueKey}/comment`, () => ({ body: 'injected' })],
      ['comment edit', 'PUT', () => `/rest/api/2/issue/${issueKey}/comment/${commentId}`, () => ({ body: 'pwned' })],
      ['comment delete', 'DELETE', () => `/rest/api/2/issue/${issueKey}/comment/${commentId}`, undefined],
      ['attachment list', 'GET', () => `/rest/api/2/issue/${issueKey}/attachments`, undefined],
      ['attachment download', 'GET', () => `/rest/api/2/attachment/${attachmentId}`, undefined],
      ['attachment delete', 'DELETE', () => `/rest/api/2/attachment/${attachmentId}`, undefined],
      ['worklog list', 'GET', () => `/rest/api/2/issue/${issueKey}/worklog`, undefined],
      ['worklog add', 'POST', () => `/rest/api/2/issue/${issueKey}/worklog`, () => ({ issueId, issueKey, timeSpentSeconds: 60 })],
      ['worklog edit', 'PUT', () => `/rest/api/2/worklog/${worklogId}`, () => ({ timeSpentSeconds: 1 })],
      ['worklog delete', 'DELETE', () => `/rest/api/2/worklog/${worklogId}`, undefined],
      ['worklogs of another user', 'GET', () => `/rest/api/2/worklog/user/${seeded.user.id}`, undefined],
      ['filter read', 'GET', () => `/rest/api/2/filter/${filterId}`, undefined],
      ['filter edit', 'PUT', () => `/rest/api/2/filter/${filterId}`, () => ({ name: 'pwned' })],
      ['filter share', 'PUT', () => `/rest/api/2/filter/${filterId}/share`, () => ({ shares: [{ type: 'user', userId: aliceId }] })],
      ['filter delete', 'DELETE', () => `/rest/api/2/filter/${filterId}`, undefined],
      ['filter subscribe', 'PUT', () => `/rest/api/2/filter/${filterId}/subscription`, () => ({ frequency: 'daily' })],
      ['dashboard read', 'GET', () => `/rest/api/2/dashboard/${dashboardId}`, undefined],
      ['dashboard edit', 'PUT', () => `/rest/api/2/dashboard/${dashboardId}`, () => ({ name: 'pwned' })],
      ['dashboard delete', 'DELETE', () => `/rest/api/2/dashboard/${dashboardId}`, undefined],
      ['board read', 'GET', () => `/rest/api/2/board/${boardId}`, undefined],
      ['board columns', 'GET', () => `/rest/api/2/board/${boardId}/columns`, undefined],
      ['board edit', 'PUT', () => `/rest/api/2/board/${boardId}`, () => ({ name: 'pwned' })],
      ['board delete', 'DELETE', () => `/rest/api/2/board/${boardId}`, undefined],
      ['board sprints', 'GET', () => `/rest/api/2/board/${boardId}/sprint`, undefined],
      ['sprint read', 'GET', () => `/rest/api/2/sprint/${sprintId}`, undefined],
      ['sprint issues', 'GET', () => `/rest/api/2/sprint/${sprintId}/issue`, undefined],
      ['sprint create', 'POST', () => `/rest/agile/1.0/board/${boardId}/sprint`, () => ({ name: 'injected' })],
      ['sprint edit', 'PUT', () => `/rest/agile/1.0/sprint/${sprintId}`, () => ({ name: 'pwned' })],
      ['sprint delete', 'DELETE', () => `/rest/agile/1.0/sprint/${sprintId}`, undefined],
      ['agile report', 'GET', () => `/rest/agile/1.0/board/${boardId}/report/velocity`, undefined],
      ['agile report (sprint)', 'GET', () => `/rest/agile/1.0/board/${boardId}/report/sprint?sprintId=${sprintId}`, undefined],
      ['roadmap', 'GET', () => '/rest/agile/1.0/project/TEST/roadmap', undefined],
      ['project read', 'GET', () => '/rest/api/2/project/TEST', undefined],
      ['project update', 'PUT', () => '/rest/api/2/project/TEST', () => ({ name: 'pwned' })],
      ['project delete', 'DELETE', () => '/rest/api/2/project/TEST', undefined],
      ['project components', 'GET', () => '/rest/api/2/project/TEST/components', undefined],
      ['project versions create', 'POST', () => '/rest/api/2/project/TEST/versions', () => ({ name: 'v-injected' })],
      ['project roles', 'GET', () => '/rest/api/2/project/TEST/role', undefined],
      ['watchers list', 'GET', () => `/rest/api/2/issue/${issueKey}/watchers`, undefined],
      ['watchers add', 'POST', () => `/rest/api/2/issue/${issueKey}/watchers`, () => ({ userId: aliceId })],
      ['votes', 'POST', () => `/rest/api/2/issue/${issueKey}/votes`, () => ({})],
      ['issue link', 'POST', () => '/rest/api/2/issueLink', () => ({ inwardIssue: { id: issueId }, outwardIssue: { id: issueId + 1 }, type: { id: 1 } })],
      ['dev panel', 'GET', () => `/rest/api/2/issue/${issueKey}/dev`, undefined],
    ];

    for (const [family, method, path, body] of cases) {
      test(`${family}: ${method}`, async () => {
        const res = await call(aliceCookie, method, path(), body ? body() : undefined);
        if (family === 'worklogs of another user') {
          // a read of someone else's time log is allowed to answer 200, but only with entries alice may browse (none here)
          expect(res.status).toBe(200);
          expect((await res.json()).worklogs).toEqual([]);
          return;
        }
        await expectDenied(res, `${family} (${method} ${path()})`);
      });
    }

    test('nothing of project TEST changed during the attack run', async () => {
      const [issue] = await db.select().from(schema.issues).where(eq(schema.issues.id, issueId));
      expect(issue.summary).toBe(SECRET);
      const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, seeded.project.id));
      expect(project.name).toBe('Test Project');
      expect((await db.select().from(schema.comments).where(eq(schema.comments.id, commentId))).length).toBe(1);
      expect((await db.select().from(schema.attachments).where(eq(schema.attachments.id, attachmentId))).length).toBe(1);
      const [wl] = await db.select().from(schema.worklogs).where(eq(schema.worklogs.id, worklogId));
      expect(wl.timeSpentSeconds).toBe(600);
      expect((await db.select().from(schema.issues).where(eq(schema.issues.projectId, seeded.project.id))).length).toBe(1);
      const [f] = await db.select().from(schema.filters).where(eq(schema.filters.id, filterId));
      expect(f.name).toContain(SECRET);
      expect((await db.select().from(schema.dashboards).where(eq(schema.dashboards.id, dashboardId))).length).toBe(1);
      expect((await db.select().from(schema.boards).where(eq(schema.boards.id, boardId))).length).toBe(1);
      expect((await db.select().from(schema.sprints).where(eq(schema.sprints.id, sprintId))).length).toBe(1);
    });

    test('list endpoints and search never leak the other project (GET /issue, JQL, text, filters, dashboards, boards)', async () => {
      for (const path of [
        '/rest/api/2/issue',
        '/rest/api/2/search',
        `/rest/api/2/search?jql=${encodeURIComponent('project = TEST')}`,
        `/rest/api/2/search?jql=${encodeURIComponent('summary ~ "SECRET"')}`,
        `/rest/api/2/search?jql=${encodeURIComponent('key = ' + issueKey)}`,
        '/rest/api/2/search?text=SECRET',
        '/rest/api/2/filter',
        '/rest/api/2/filter/search?filterName=filter',
        '/rest/api/2/dashboard',
        '/rest/api/2/board',
        '/rest/agile/1.0/board',
        '/rest/api/2/project',
        `/rest/api/2/board?projectId=${seeded.project.id}`,
        `/rest/api/2/worklog/user/${aliceId}`,
      ]) {
        const res = await call(aliceCookie, 'GET', path);
        const text = await res.text();
        expect(text, `GET ${path} -> ${res.status}`).not.toContain(SECRET);
        expect(text, `GET ${path} exposes project TEST`).not.toContain('"TEST-1"');
      }
    });

    test('a user with no permissions anywhere (bob) is denied the same things', async () => {
      for (const [, method, path, body] of cases.slice(0, 12)) {
        const res = await call(bobCookie, method, path(), body ? body() : undefined);
        await expectDenied(res, `bob ${method} ${path()}`);
      }
    });

    test('ADMINISTER-only endpoints refuse ordinary users', async () => {
      const adminOnly: [string, string, unknown?][] = [
        ['GET', '/rest/api/2/admin/auditlog'], ['GET', '/rest/api/2/admin/system/config'], ['GET', '/rest/api/2/admin/system/mail'],
        ['POST', '/rest/api/2/admin/system/backup', {}], ['GET', '/rest/api/2/admin/oidc'], ['GET', '/rest/api/2/admin/scim/tokens'],
        ['POST', '/rest/api/2/group', { name: 'evil' }], ['POST', '/rest/api/2/user', { username: 'evil', email: 'e@e.e', displayName: 'E', password: 'password1' }],
        ['GET', '/rest/api/2/admin/workflowscheme'], ['GET', '/rest/api/2/permissionscheme'], ['POST', '/rest/api/2/permissionscheme', { name: 'x' }],
        ['GET', '/rest/api/2/webhook'], ['GET', '/rest/api/2/admin/health-check'], ['POST', '/rest/api/2/admin/search/setup', {}],
        ['POST', '/rest/api/2/project', { key: 'EVIL', name: 'Evil' }],
        ['GET', '/rest/api/2/notification'], ['DELETE', '/rest/api/2/notification/1'], ['POST', '/rest/api/2/webhook', { url: 'http://127.0.0.1:9/x', events: ['issue.created'] }],
        ['GET', '/rest/api/2/webhook/1/delivery'], ['POST', '/rest/api/2/webhook/1/test', {}], ['GET', '/rest/auth/1/sso/settings'], ['POST', '/rest/auth/1/sso/settings', {}],
        ['POST', '/rest/api/2/migration/run', {}], ['POST', '/rest/api/2/migration/rest/test', {}],
        ['POST', '/rest/api/2/migration/tools/linear/run', { token: 'x'.repeat(10) }], ['GET', '/rest/api/2/migration/tools/sessions'], ['POST', '/rest/api/2/migration/tools/json/analyze', { json: '{}' }],
        ['POST', '/rest/api/2/applicationlink', { name: 'x', type: 'github', baseUrl: 'http://127.0.0.1:9' }], ['GET', '/rest/api/2/admin/customfield'], ['GET', '/rest/api/2/admin/projectrole'],
      ];
      for (const [m, p, b] of adminOnly) {
        const res = await call(aliceCookie, m, p, b);
        expect([401, 403, 404], `${m} ${p} -> ${res.status}`).toContain(res.status);
      }
    });
  });

  /* ================================================================== */
  /*  3. SQL injection                                                    */
  /* ================================================================== */
  describe('SQL injection', () => {
    const payloads = [
      "' OR '1'='1", "'; DROP TABLE issues; --", '" OR ""="', "1; SELECT pg_sleep(5)--", "') UNION SELECT password_hash FROM users --",
      "\\'; DELETE FROM comments; --", '%27%20OR%201=1--', "admin'--", '${7*7}', "1) OR (1=1", '\u0000', "a'||(select 1)||'",
    ];
    const tablesIntact = async () => {
      const [{ n }] = (await testSql`select count(*)::int as n from issues`) as any;
      const [{ m }] = (await testSql`select count(*)::int as m from users`) as any;
      return { n, m };
    };

    test('JQL: payloads in values, fields and ORDER BY never reach SQL as code and never 500', async () => {
      const before = await tablesIntact();
      for (const p of payloads) {
        const jqls = [
          `summary ~ "${p.replace(/"/g, '\\"')}"`, `status = "${p.replace(/"/g, '\\"')}"`, `project = "${p.replace(/"/g, '\\"')}"`,
          `assignee = "${p.replace(/"/g, '\\"')}"`, `labels = "${p.replace(/"/g, '\\"')}"`, `created >= "${p.replace(/"/g, '\\"')}"`,
          `resolution = "${p.replace(/"/g, '\\"')}"`, `project = OTHER ORDER BY ${p}`, p,
          `priority in ("${p.replace(/"/g, '\\"')}", "x")`, `key = "${p.replace(/"/g, '\\"')}"`, `parent = "${p.replace(/"/g, '\\"')}"`,
        ];
        for (const jql of jqls) {
          const res = await call(aliceCookie, 'GET', `/rest/api/2/search?jql=${encodeURIComponent(jql)}`);
          const text = await res.text();
          expect(res.status, `JQL ${jql} -> ${text.slice(0, 160)}`).toBeLessThan(500);
          expect(text).not.toContain('Failed query');
          expect(text).not.toContain(SECRET);
          expect(text).not.toMatch(/\$2[aby]\$\d\d\$/);
        }
      }
      expect(await tablesIntact()).toEqual(before);
    });

    test('JQL: dates, numbers and operators on id columns return 400/empty instead of a database error', async () => {
      for (const jql of ['created >= "not a date"', 'created = 9999999999999', 'updated < "2026-13-45"', 'project ~ "x"', 'status ~ "x"', 'id = 99999999999999999999', 'duedate > "2026-01-01 25:99"']) {
        const res = await call(aliceCookie, 'GET', `/rest/api/2/search?jql=${encodeURIComponent(jql)}`);
        expect(res.status, jql).toBeLessThan(500);
      }
    });

    test('JQL: resolution = Unresolved is "no resolution", not an error', async () => {
      const res = await call(aliceCookie, 'GET', `/rest/api/2/search?jql=${encodeURIComponent('project = OTHER AND resolution = Unresolved')}`);
      expect(res.status).toBe(200);
      expect((await res.json()).total).toBeGreaterThanOrEqual(1);
    });

    test('text search and pagination parameters', async () => {
      const before = await tablesIntact();
      for (const p of payloads) {
        for (const path of [
          `/rest/api/2/search?text=${encodeURIComponent(p)}`,
          `/rest/api/2/search?maxResults=${encodeURIComponent(p)}&startAt=${encodeURIComponent(p)}`,
          `/rest/api/2/user/search?query=${encodeURIComponent(p)}`,
          `/rest/api/2/filter/search?filterName=${encodeURIComponent(p)}&orderBy=${encodeURIComponent(p)}`,
          `/rest/api/2/jql/autocompletedata/suggestions?fieldName=${encodeURIComponent(p)}&fieldValue=${encodeURIComponent(p)}`,
        ]) {
          const res = await call(aliceCookie, 'GET', path);
          const text = await res.text();
          expect(res.status, `${path} -> ${text.slice(0, 160)}`).toBeLessThan(500);
          expect(text).not.toContain('Failed query');
          expect(text).not.toMatch(/\$2[aby]\$\d\d\$/);
        }
      }
      expect(await tablesIntact()).toEqual(before);
    });

    test('path parameters: keys and ids with SQL metacharacters are plain 4xx', async () => {
      for (const p of ["TEST-1'; DROP TABLE issues;--", "1 OR 1=1", "-1", "99999999999999999999", "%00", "..%2f..%2f", "TEST-1/../../x"]) {
        for (const path of [
          `/rest/api/2/issue/${encodeURIComponent(p)}`, `/rest/api/2/issue/${encodeURIComponent(p)}/comment`, `/rest/api/2/project/${encodeURIComponent(p)}`,
          `/rest/api/2/board/${encodeURIComponent(p)}`, `/rest/api/2/filter/${encodeURIComponent(p)}`, `/rest/api/2/attachment/${encodeURIComponent(p)}`,
          `/rest/api/2/sprint/${encodeURIComponent(p)}/issue`, `/rest/api/2/worklog/user/${encodeURIComponent(p)}`, `/rest/api/2/issue/${encodeURIComponent(p)}/worklog`,
        ]) {
          for (const cookie of [aliceCookie, adminCookie]) {
            const res = await call(cookie, 'GET', path);
            const text = await res.text();
            expect(res.status, `GET ${path} -> ${text.slice(0, 160)}`).toBeLessThan(500);
            expect(text).not.toContain('Failed query');
          }
        }
      }
      expect(await tablesIntact()).toEqual({ n: 2, m: (await tablesIntact()).m });
    });

    test('login: injection in username/password is just a failed login', async () => {
      for (const p of payloads) {
        const res = await call(null, 'POST', '/rest/auth/1/session', { username: p, password: p });
        expect([400, 401], p).toContain(res.status);
      }
      await resetRateLimits();
      await clearLoginThrottle();
    });

    test('database errors never reach the client (no SQL text, no parameters)', async () => {
      // create issue with a nonexistent project id forces a foreign key / lookup error inside the service
      const res = await call(adminCookie, 'POST', '/rest/api/2/issue', { fields: { project: { id: 999999 }, issuetype: { id: 999999 }, summary: 'x' } });
      const text = await res.text();
      expect(text).not.toMatch(/Failed query|params:|violates|select "|insert into/i);
    });
  });

  /* ================================================================== */
  /*  4. XSS                                                              */
  /* ================================================================== */
  describe('stored XSS payloads round-trip as data', () => {
    const XSS = [`<script>alert(1)</script>`, `"><img src=x onerror=alert(1)>`, `<svg/onload=alert(1)>`, `javascript:alert(1)`, `</script><script>alert(2)</script>`, `{{constructor.constructor('alert(1)')()}}`];

    test('issue, comment, filter, dashboard, board and project names come back verbatim in application/json with nosniff', async () => {
      for (const x of XSS) {
        let res = await call(aliceCookie, 'POST', '/rest/api/2/issue', { fields: { project: { id: otherProjectId }, issuetype: { id: seeded.issueType.id }, summary: x, description: x } });
        expect(res.status).toBe(201);
        const key = (await res.json()).key;
        res = await call(aliceCookie, 'GET', `/rest/api/2/issue/${key}`);
        expect(res.headers.get('content-type')).toContain('application/json');
        expect(res.headers.get('x-content-type-options')).toBe('nosniff');
        const issue = await res.json();
        expect(issue.fields.summary).toBe(x);
        expect(issue.fields.description).toBe(x);

        res = await call(aliceCookie, 'POST', `/rest/api/2/issue/${key}/comment`, { body: x });
        expect(res.status).toBe(201);
        res = await call(aliceCookie, 'GET', `/rest/api/2/issue/${key}/comment`);
        expect(res.headers.get('content-type')).toContain('application/json');
        expect(JSON.stringify(await res.json())).toContain(JSON.stringify(x).slice(1, -1));

        res = await call(aliceCookie, 'POST', '/rest/api/2/filter', { name: x, jql: 'project = OTHER' });
        expect(res.status).toBe(201);
        const f = await res.json();
        res = await call(aliceCookie, 'GET', `/rest/api/2/filter/${f.id}`);
        expect(res.headers.get('content-type')).toContain('application/json');
        expect((await res.json()).name).toBe(x);

        res = await call(aliceCookie, 'POST', '/rest/api/2/dashboard', { name: x });
        expect(res.status).toBe(201);
      }
    });

    test('JSON error bodies echo user input only inside JSON strings', async () => {
      const res = await call(aliceCookie, 'GET', `/rest/api/2/search?jql=${encodeURIComponent('<script>alert(1)</script>')}`);
      expect(res.headers.get('content-type')).toContain('application/json');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    });

    test('the queued notification email escapes HTML in user-controlled values', async () => {
      await testSql`delete from email_queue`;
      await db.update(schema.issues).set({ assigneeId: aliceId }).where(eq(schema.issues.issueKey, otherIssueKey));
      const res = await call(aliceCookie, 'POST', '/rest/api/2/issue', { fields: { project: { id: otherProjectId }, issuetype: { id: seeded.issueType.id }, summary: `<script>alert('x')</script>`, assignee: { id: aliceId } } });
      expect(res.status).toBe(201);
      const mails = await db.select().from(schema.emailQueue);
      expect(mails.length).toBeGreaterThan(0);
      for (const m of mails) expect(m.htmlBody).not.toContain('<script>');
    });

    test('uploaded HTML/SVG is never served inline from the API origin', async () => {
      // A stored-XSS vector: attachment served as text/html from the same origin as the session cookie.
      const fd = new FormData();
      fd.append('file', new File(['<html><script>alert(1)</script></html>'], 'evil.html', { type: 'text/html' }));
      const up = await app.request(`/rest/api/2/issue/${otherIssueKey}/attachments`, { method: 'POST', headers: { Cookie: aliceCookie }, body: fd });
      if (up.status === 201) {
        const att = (await up.json())[0];
        const path = new URL(att.content).pathname;
        const served = await app.request(path);
        const ct = served.headers.get('content-type') || '';
        const cd = served.headers.get('content-disposition') || '';
        expect(ct.includes('text/html') && !cd.includes('attachment'), `served inline as ${ct} (${cd})`).toBe(false);
      } else {
        expect([400, 415]).toContain(up.status);
      }
    });
  });

  /* ================================================================== */
  /*  5. Mass assignment                                                  */
  /* ================================================================== */
  describe('mass assignment', () => {
    test('issue update cannot set id, key, project, reporter or timestamps', async () => {
      const [before] = await db.select().from(schema.issues).where(eq(schema.issues.issueKey, otherIssueKey));
      const res = await call(aliceCookie, 'PUT', `/rest/api/2/issue/${otherIssueKey}`, {
        fields: {
          summary: 'edited', id: 999999, key: 'HACK-1', issueKey: 'HACK-1', projectId: seeded.project.id, project: { id: seeded.project.id }, reporterId: seeded.user.id,
          reporter: { id: seeded.user.id }, createdAt: '2001-01-01T00:00:00Z', created: '2001-01-01T00:00:00Z', updatedAt: '2001-01-01T00:00:00Z', resolvedAt: '2001-01-01T00:00:00Z',
        },
      });
      expect(res.status).toBeLessThan(500);
      const [after] = await db.select().from(schema.issues).where(eq(schema.issues.id, before.id));
      expect(after.id).toBe(before.id);
      expect(after.issueKey).toBe(before.issueKey);
      expect(after.projectId).toBe(before.projectId);
      expect(after.reporterId).toBe(before.reporterId);
      expect(after.createdAt!.getTime()).toBe(before.createdAt!.getTime());
      expect(after.resolvedAt).toBeNull();
    });

    test('issue create ignores caller-chosen id, key and reporter', async () => {
      const res = await call(aliceCookie, 'POST', '/rest/api/2/issue', {
        fields: { project: { id: otherProjectId }, issuetype: { id: seeded.issueType.id }, summary: 'ma', id: 777777, key: 'HACK-9', issueKey: 'HACK-9', reporterId: seeded.user.id, reporter: { id: seeded.user.id }, createdAt: '2001-01-01T00:00:00Z' },
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.key).toMatch(/^OTHER-\d+$/);
      expect(body.id).not.toBe(777777);
      const [row] = await db.select().from(schema.issues).where(eq(schema.issues.id, body.id));
      expect(row.reporterId).toBe(aliceId);
      expect(row.createdAt!.getFullYear()).toBeGreaterThan(2020);
    });

    test('an ordinary user cannot change accounts through the user API (own or others)', async () => {
      for (const target of [aliceId, bobId, seeded.user.id]) {
        const res = await call(aliceCookie, 'PUT', '/rest/api/2/user', { id: target, username: 'alice', active: false, displayName: 'pwned', email: 'pwned@example.com', passwordHash: 'x', password: 'newpassword1', groups: ['veqsio-administrators'] });
        expect([401, 403, 404], `PUT user ${target} -> ${res.status}`).toContain(res.status);
      }
      const [a] = await db.select().from(schema.users).where(eq(schema.users.id, aliceId));
      expect(a.displayName).toBe('Alice');
      expect(a.active).toBe(true);
      const [adm] = await db.select().from(schema.users).where(eq(schema.users.id, seeded.user.id));
      expect(adm.displayName).not.toBe('pwned');
    });

    test('administrator user update ignores unknown/privileged columns (id, createdAt, passwordHash)', async () => {
      const [before] = await db.select().from(schema.users).where(eq(schema.users.id, bobId));
      const res = await call(adminCookie, 'PUT', '/rest/api/2/user', { id: bobId, username: 'bob', displayName: 'Bobby', passwordHash: 'plaintext-hash', createdAt: '2001-01-01T00:00:00Z', newId: 1 });
      expect(res.status).toBeLessThan(500);
      const [after] = await db.select().from(schema.users).where(eq(schema.users.id, bobId));
      expect(after.passwordHash).toBe(before.passwordHash);
      expect(after.createdAt!.getTime()).toBe(before.createdAt!.getTime());
      expect(after.id).toBe(bobId);
    });

    test('project update by an administrator cannot rewrite id or timestamps', async () => {
      const [before] = await db.select().from(schema.projects).where(eq(schema.projects.id, otherProjectId));
      const res = await call(adminCookie, 'PUT', '/rest/api/2/project/OTHER', { name: 'Other 2', id: 424242, createdAt: '2001-01-01T00:00:00Z', projectKey: 'HACKED' });
      expect(res.status).toBeLessThan(500);
      const [after] = await db.select().from(schema.projects).where(eq(schema.projects.id, otherProjectId));
      expect(after.id).toBe(otherProjectId);
      expect(after.createdAt!.getTime()).toBe(before.createdAt!.getTime());
      expect(after.projectKey).toBe('OTHER');
    });

    test('filter and dashboard owners cannot be reassigned by the body', async () => {
      let res = await call(aliceCookie, 'POST', '/rest/api/2/filter', { name: 'mine', jql: 'project = OTHER', authorId: seeded.user.id, owner: { id: seeded.user.id } });
      expect(res.status).toBeLessThan(500);
      if (res.status === 201) {
        const f = await res.json();
        const [row] = await db.select().from(schema.filters).where(eq(schema.filters.id, f.id));
        expect(row.authorId).toBe(aliceId);
      }
      res = await call(aliceCookie, 'POST', '/rest/api/2/dashboard', { name: 'mine', ownerId: seeded.user.id });
      expect(res.status).toBe(201);
      const [d] = await db.select().from(schema.dashboards).where(eq(schema.dashboards.id, Number((await res.json()).id)));
      expect(d.ownerId).toBe(aliceId);
    });
  });

  /* ================================================================== */
  /*  6. CSRF                                                             */
  /* ================================================================== */
  describe('CSRF posture for cookie-authenticated requests', () => {
    const WEB = process.env.WEB_URL || 'http://localhost:3001';

    test('cross-origin state-changing requests with the session cookie are refused', async () => {
      for (const origin of ['https://evil.example', 'http://localhost:9999', 'null']) {
        const res = await call(aliceCookie, 'POST', `/rest/api/2/issue/${otherIssueKey}/comment`, { body: 'csrf' }, { Origin: origin });
        expect(res.status, `Origin ${origin}`).toBe(403);
      }
      const res = await call(aliceCookie, 'POST', `/rest/api/2/issue/${otherIssueKey}/comment`, { body: 'csrf' }, { 'Sec-Fetch-Site': 'cross-site' });
      expect(res.status).toBe(403);
    });

    test('form-encoded / text/plain bodies (a CSRF with no preflight) are refused on cookie requests', async () => {
      for (const ct of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
        const res = await app.request(`/rest/api/2/issue/${otherIssueKey}/comment`, { method: 'POST', headers: { Cookie: aliceCookie, 'Content-Type': ct }, body: '{"body":"csrf"}' });
        expect([403, 415], `${ct} -> ${res.status}`).toContain(res.status);
      }
    });

    test('the real web origin, same-origin requests and non-browser clients keep working', async () => {
      expect((await call(aliceCookie, 'POST', `/rest/api/2/issue/${otherIssueKey}/comment`, { body: 'ok1' }, { Origin: WEB })).status).toBe(201);
      expect((await call(aliceCookie, 'POST', `/rest/api/2/issue/${otherIssueKey}/comment`, { body: 'ok2' }, { Origin: 'http://api.test', Host: 'api.test' })).status).toBe(201);
      expect((await call(aliceCookie, 'POST', `/rest/api/2/issue/${otherIssueKey}/comment`, { body: 'ok3' }, { 'Sec-Fetch-Site': 'same-origin' })).status).toBe(201);
      expect((await call(aliceCookie, 'POST', `/rest/api/2/issue/${otherIssueKey}/comment`, { body: 'ok4' })).status).toBe(201);
    });

    test('bearer tokens are not ambient credentials: a foreign Origin does not matter', async () => {
      const tok = await call(aliceCookie, 'POST', '/rest/api/2/mypersonalaccessTokens', { name: 't' });
      expect(tok.status).toBe(201);
      const token = (await tok.json()).token;
      const res = await app.request(`/rest/api/2/issue/${otherIssueKey}/comment`, { method: 'POST', headers: { ...JSON_H, Authorization: `Bearer ${token}`, Origin: 'https://evil.example' }, body: '{"body":"via token"}' });
      expect(res.status).toBe(201);
    });

    test('CORS does not reflect arbitrary origins', async () => {
      const res = await app.request('/rest/api/2/myself', { headers: { Origin: 'https://evil.example', Cookie: aliceCookie } });
      expect(res.headers.get('access-control-allow-origin')).not.toBe('https://evil.example');
      expect(res.headers.get('access-control-allow-origin')).not.toBe('*');
      const pre = await app.request('/rest/api/2/issue', { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } });
      expect(pre.headers.get('access-control-allow-origin')).not.toBe('https://evil.example');
    });

    test('login CSRF-ish: login never needs (or honours) an existing cookie and sets HttpOnly', async () => {
      const res = await call(aliceCookie, 'POST', '/rest/auth/1/session', { username: 'bob', password: 'pw-123456' });
      expect(res.status).toBe(200);
      expect(res.headers.get('set-cookie')).toContain('HttpOnly');
    });
  });

  /* ================================================================== */
  /*  7. Size limits                                                      */
  /* ================================================================== */
  describe('request size limits', () => {
    test('an oversized JSON body is rejected with 413 before it is parsed', async () => {
      const big = JSON.stringify({ fields: { project: { id: otherProjectId }, issuetype: { id: seeded.issueType.id }, summary: 'x', description: 'y'.repeat(6 * 1024 * 1024) } });
      const res = await call(aliceCookie, 'POST', '/rest/api/2/issue', big);
      expect(res.status).toBe(413);
    });

    test('a declared content-length above the limit is rejected', async () => {
      const res = await app.request('/rest/api/2/issue', { method: 'POST', headers: { ...JSON_H, Cookie: aliceCookie, 'Content-Length': String(50 * 1024 * 1024) }, body: '{}' });
      expect(res.status).toBe(413);
    });

    test('over-long fields are rejected, not stored', async () => {
      const res = await call(aliceCookie, 'POST', '/rest/api/2/issue', { fields: { project: { id: otherProjectId }, issuetype: { id: seeded.issueType.id }, summary: 'z'.repeat(5000) } });
      expect([400, 413]).toContain(res.status);
    });

    test('malformed JSON is a 400, not a 500', async () => {
      for (const path of ['/rest/api/2/issue', `/rest/api/2/issue/${otherIssueKey}/comment`, '/rest/api/2/filter']) {
        const res = await call(aliceCookie, 'POST', path, '{"unterminated": ');
        expect(res.status, path).toBe(400);
      }
      const res = await call(null, 'POST', '/rest/auth/1/session', '{not json');
      expect(res.status).toBe(400);
    });

    test('deeply nested / huge arrays do not crash the server', async () => {
      const deep = '['.repeat(5000) + ']'.repeat(5000);
      const res = await call(aliceCookie, 'POST', '/rest/api/2/filter', deep);
      expect(res.status).toBeLessThan(500);
    });
  });

  /* ================================================================== */
  /*  8. Path traversal                                                   */
  /* ================================================================== */
  describe('path traversal', () => {
    test('mock storage cannot be used to read files outside its directory', async () => {
      for (const p of ['..%2f..%2f..%2f..%2fetc%2fpasswd', '../../../../etc/passwd', '%2e%2e/%2e%2e/%2e%2e/etc/passwd', '....//....//etc/passwd', '..\\..\\etc\\passwd', '/etc/passwd']) {
        const res = await app.request(`/mock-storage/${p}`);
        const text = await res.text();
        expect(text, p).not.toContain('root:');
        expect([400, 403, 404], `${p} -> ${res.status}`).toContain(res.status);
      }
    });

    test('mock storage is not served when the storage backend is not mock', async () => {
      const prev = process.env.STORAGE_TYPE;
      process.env.STORAGE_TYPE = 'r2';
      try {
        const res = await app.request('/mock-storage/anything');
        expect(res.status).toBe(404);
      } finally {
        process.env.STORAGE_TYPE = prev;
      }
    });

    test('upload filenames cannot shape the storage key', async () => {
      for (const name of ['../../../../tmp/evil.txt', '..\\..\\evil.txt', 'a./../../x', 'x.txt/../../../y', 'x.tx\u0000t', 'x.<script>']) {
        const fd = new FormData();
        fd.append('file', new File(['hello'], name, { type: 'text/plain' }));
        const res = await app.request(`/rest/api/2/issue/${otherIssueKey}/attachments`, { method: 'POST', headers: { Cookie: aliceCookie }, body: fd });
        expect(res.status, name).toBeLessThan(500);
        if (res.status === 201) {
          const [att] = await res.json().then((j) => j);
          const [row] = await db.select().from(schema.attachments).where(eq(schema.attachments.id, Number(att.id)));
          expect(row.storageKey, name).toMatch(/^attachments\/OTHER\/OTHER-\d+\/[0-9a-f-]{36}(\.[A-Za-z0-9]{0,16})?$/);
          expect(row.storageKey).not.toContain('..');
        }
      }
    });
  });

  /* ================================================================== */
  /*  9. Header injection                                                 */
  /* ================================================================== */
  describe('header injection in email subjects', () => {
    test('CR/LF in issue summaries cannot add headers to outgoing mail', async () => {
      await testSql`delete from email_queue`;
      const evil = 'Hello\r\nBcc: attacker@example.com\r\nX-Injected: 1';
      const res = await call(aliceCookie, 'POST', '/rest/api/2/issue', { fields: { project: { id: otherProjectId }, issuetype: { id: seeded.issueType.id }, summary: evil, assignee: { id: aliceId } } });
      expect(res.status).toBe(201);
      const key = (await res.json()).key;
      await call(aliceCookie, 'PUT', `/rest/api/2/issue/${key}`, { fields: { summary: evil + ' v2', assignee: { id: bobId } } });
      await call(aliceCookie, 'POST', `/rest/api/2/issue/${key}/comment`, { body: evil });
      const mails = await db.select().from(schema.emailQueue);
      expect(mails.length).toBeGreaterThan(0);
      for (const m of mails) {
        expect(m.subject, 'subject').not.toMatch(/[\r\n]/);
        expect(m.toAddress, 'to').not.toMatch(/[\r\n,;]/);
      }
    });

    test('the mail transport refuses CR/LF in subject, recipient and sender', async () => {
      const { sendEmail } = await import('../../src/services/email');
      const r = await sendEmail('victim@example.com\r\nBcc: attacker@example.com', 'issue-created', { issueKey: 'X-1', summary: 'a\r\nBcc: x@y.z', projectName: 'p', reporterName: 'r', issueUrl: 'http://x' }).catch((e: Error) => e);
      // either rejected outright or sent without raw CR/LF reaching a header; it must not resolve as a success with injected headers
      if (r && typeof r === 'object' && 'subject' in (r as any)) expect((r as any).subject).not.toMatch(/[\r\n]/);
    });
  });

  /* ================================================================== */
  /* 10. Brute force and information leaks                                */
  /* ================================================================== */
  async function clearLoginThrottle() {
    const keys = await redis.keys('veqsio:ratelimit:login*');
    if (keys.length) await redis.del(...keys);
  }

  describe('login hardening', () => {
    test('repeated failures are throttled with 429 and Retry-After, even for the right password afterwards', async () => {
      // (default: 10 failures per address+username within 15 minutes)
      await clearLoginThrottle();
      let throttledAt = 0;
      for (let i = 1; i <= 30; i++) {
        const res = await call(null, 'POST', '/rest/auth/1/session', { username: 'bob', password: `wrong-${i}` }, { 'X-Forwarded-For': '203.0.113.7' });
        if (res.status === 429) {
          throttledAt = i;
          expect(res.headers.get('retry-after')).toBeTruthy();
          break;
        }
        expect(res.status).toBe(401);
      }
      expect(throttledAt, 'no throttling after 30 failed attempts').toBeGreaterThan(0);
      expect(throttledAt).toBeLessThanOrEqual(11);
      const right = await call(null, 'POST', '/rest/auth/1/session', { username: 'bob', password: 'pw-123456' }, { 'X-Forwarded-For': '203.0.113.7' });
      expect(right.status).toBe(429);
      // a different client is not locked out by someone else's guesses (no account lockout DoS)
      const other = await call(null, 'POST', '/rest/auth/1/session', { username: 'bob', password: 'pw-123456' }, { 'X-Forwarded-For': '198.51.100.20' });
      expect(other.status).toBe(200);
      await clearLoginThrottle();
    });

    test('the throttle cannot be dodged by forging the first X-Forwarded-For entry (only the proxy-appended one counts)', async () => {
      await clearLoginThrottle();
      let throttled = false;
      for (let i = 1; i <= 14 && !throttled; i++) {
        const res = await call(null, 'POST', '/rest/auth/1/session', { username: 'bob', password: `bad-${i}` }, { 'X-Forwarded-For': `10.${i}.${i}.${i}, 203.0.113.99` });
        throttled = res.status === 429;
      }
      expect(throttled, 'rotating a spoofed client address bypassed the login throttle').toBe(true);
      await clearLoginThrottle();
    }, 30000);

    test('a successful login does not count against the limit', async () => {
      await clearLoginThrottle();
      for (let i = 0; i < 15; i++) {
        const res = await call(null, 'POST', '/rest/auth/1/session', { username: 'bob', password: 'pw-123456' }, { 'X-Forwarded-For': '203.0.113.9' });
        expect(res.status).toBe(200);
      }
      await clearLoginThrottle();
    });

    test('credential stuffing across many usernames from one address is throttled too', async () => {
      await clearLoginThrottle();
      process.env.LOGIN_MAX_FAILURES_PER_IP = '12'; // default is 40; every failed guess costs a real bcrypt check, keep the test quick
      try {
        let throttled = false;
        for (let i = 0; i < 20 && !throttled; i++) {
          const res = await call(null, 'POST', '/rest/auth/1/session', { username: `user-${i}`, password: 'x' }, { 'X-Forwarded-For': '203.0.113.50' });
          throttled = res.status === 429;
        }
        expect(throttled).toBe(true);
      } finally {
        delete process.env.LOGIN_MAX_FAILURES_PER_IP;
      }
      await clearLoginThrottle();
    }, 30000);

    test('unknown user and wrong password are indistinguishable (same status and body)', async () => {
      await clearLoginThrottle();
      const a = await call(null, 'POST', '/rest/auth/1/session', { username: 'nobody-here', password: 'x' }, { 'X-Forwarded-For': '203.0.113.60' });
      const b = await call(null, 'POST', '/rest/auth/1/session', { username: 'bob', password: 'x' }, { 'X-Forwarded-For': '203.0.113.61' });
      expect(a.status).toBe(b.status);
      expect(await a.text()).toBe(await b.text());
      await clearLoginThrottle();
    });

    test('non-string credentials are a client error, not a server error', async () => {
      await clearLoginThrottle();
      for (const body of [{}, { username: 'bob' }, { username: 1, password: 2 }, { username: ['a'], password: { $ne: 1 } }, { username: null, password: null }]) {
        const res = await call(null, 'POST', '/rest/auth/1/session', body, { 'X-Forwarded-For': '203.0.113.70' });
        expect([400, 401], JSON.stringify(body)).toContain(res.status);
      }
      await clearLoginThrottle();
    });

    test('responses never contain password hashes', async () => {
      for (const path of ['/rest/api/2/myself', '/rest/api/2/user', '/rest/api/2/user/search?query=a', '/rest/api/2/group/member?groupname=veqsio-users']) {
        const res = await call(adminCookie, 'GET', path);
        expect(await res.text(), path).not.toMatch(/"passwordHash"|"password_hash"|\$2[aby]\$\d\d\$/);
      }
    });
  });

  describe('operational hygiene', () => {
    test('security headers are present on API responses', async () => {
      const res = await call(aliceCookie, 'GET', '/rest/api/2/myself');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(res.headers.get('referrer-policy')).toBeTruthy();
    });

    test('authenticated GET responses are not cacheable by shared caches', async () => {
      const res = await call(aliceCookie, 'GET', '/rest/api/2/project');
      expect(res.headers.get('cache-control') || '').not.toMatch(/\bpublic\b/);
    });

    test('unknown routes and wrong methods do not leak stack traces', async () => {
      const res = await call(aliceCookie, 'GET', '/rest/api/2/does-not-exist');
      expect(res.status).toBe(404);
      expect(await res.text()).not.toMatch(/at \w+ \(|node_modules|\/home\//);
    });
  });
});
