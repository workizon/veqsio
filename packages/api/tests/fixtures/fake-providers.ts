/**
 * Fake Linear / Asana / ClickUp backends for the importer tests. They serve the hand-written payloads next to this file
 * through an injectable fetch, so no test ever calls an external service.
 */
import linear from './linear.json';
import asana from './asana.json';
import clickup from './clickup.json';

export const TOKENS = { linear: 'lin_api_test_token', asana: 'asana-test-token', clickup: 'pk_test_token' };

export interface FakeOptions {
  /** Answer the first N requests with HTTP 429 and this Retry-After (seconds). */
  throttle?: { count: number; retryAfter: string };
  /** Answer the first request with Linear's GraphQL RATELIMITED error (HTTP 400). */
  linearRateLimited?: boolean;
  /** Awaited before every response (lets a test hold an import "in flight"). */
  gate?: () => Promise<void>;
  /** Pretend this Asana page-1 task list pointer goes to another host. */
  evilNextPage?: boolean;
}

export interface FakeFetch {
  fetch: typeof fetch;
  calls: Array<{ method: string; url: string }>;
  sleeps: number[];
  sleep: (ms: number) => Promise<void>;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

export function createFakeProviders(opts: FakeOptions = {}): FakeFetch {
  const calls: FakeFetch['calls'] = [];
  const sleeps: number[] = [];
  let throttled = 0;
  let rateLimitedSent = false;

  const handler = async (input: any, init: any = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = String(init.method ?? 'GET');
    calls.push({ method, url: url.toString() });
    if (opts.gate) await opts.gate();
    if (opts.throttle && throttled < opts.throttle.count) {
      throttled++;
      return json({ error: 'slow down' }, 429, { 'retry-after': opts.throttle.retryAfter });
    }
    const auth: string = init.headers?.Authorization ?? '';

    if (url.host === 'api.linear.app') return linearApi(url, init, auth);
    if (url.host === 'app.asana.com') return asanaApi(url, auth);
    if (url.host === 'api.clickup.com') return clickupApi(url, auth);
    throw new Error(`Unexpected host in test: ${url.host}`);
  };

  /* ---------------- Linear (GraphQL) ---------------- */
  const linearApi = (url: URL, init: any, auth: string): Response => {
    if (auth !== TOKENS.linear) return json({ errors: [{ message: 'Authentication required', extensions: { code: 'AUTHENTICATION_ERROR' } }] }, 401);
    const { query, variables } = JSON.parse(init.body) as { query: string; variables: Record<string, any> };
    if (opts.linearRateLimited && !rateLimitedSent) {
      rateLimitedSent = true;
      return json({ errors: [{ message: 'Rate limit exceeded', extensions: { code: 'RATELIMITED' } }] }, 400, { 'x-ratelimit-requests-reset': String(Date.now() + 3000) });
    }
    if (/query \{ viewer/.test(query)) return json({ data: { viewer: linear.viewer } });
    if (query.includes('teams(first')) {
      return json({ data: { teams: linear.teamPages[variables.after ? 1 : 0] } });
    }
    const m = /team\(id: \$id\) \{ (\w+)\(first: (\d+)/.exec(query);
    if (m) {
      const field = m[1];
      const id = variables.id as string;
      if (field === 'issues') {
        const pages = (linear.issuePages as any)[id];
        return json({ data: { team: { issues: pages[variables.after ? 1 : 0] } } });
      }
      const nodes = (linear as any)[field][id];
      return json({ data: { team: { [field]: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } } });
    }
    if (query.includes('issue(id')) {
      return json({ data: { issue: { comments: (linear.moreComments as any)[variables.id] } } });
    }
    return json({ errors: [{ message: 'unexpected query in fake' }] }, 400);
  };

  /* ---------------- Asana (REST) ---------------- */
  const asanaApi = (url: URL, auth: string): Response => {
    if (auth !== `Bearer ${TOKENS.asana}`) return json({ errors: [{ message: 'Not Authorized' }] }, 401);
    const p = url.pathname.replace('/api/1.0/', '');
    const wrap = (data: unknown) => json({ data });
    if (p === 'users/me') return wrap(asana.me);
    if (p === 'projects') {
      const page = asana.projectPages[url.searchParams.get('offset') ? 1 : 0];
      return json(page);
    }
    let m = /^projects\/(\w+)\/task_counts$/.exec(p);
    if (m) return wrap({ num_tasks: (asana.taskCounts as any)[m[1]] });
    m = /^projects\/(\w+)\/sections$/.exec(p);
    if (m) return json({ data: (asana.sections as any)[m[1]], next_page: null });
    m = /^projects\/(\w+)$/.exec(p);
    if (m) return wrap((asana.projectDetail as any)[m[1]]);
    if (p === 'tasks') {
      const pages = (asana.taskPages as any)[url.searchParams.get('project')!];
      const page = pages[url.searchParams.get('offset') ? 1 : 0];
      if (opts.evilNextPage && page.next_page) return json({ ...page, next_page: { uri: 'https://evil.example/steal' } });
      return json(page);
    }
    m = /^tasks\/(\w+)\/subtasks$/.exec(p);
    if (m) return json({ data: (asana.subtasks as any)[m[1]] ?? [], next_page: null });
    m = /^tasks\/(\w+)\/stories$/.exec(p);
    if (m) return json({ data: (asana.stories as any)[m[1]] ?? [], next_page: null });
    return json({ errors: [{ message: `not found: ${p}` }] }, 404);
  };

  /* ---------------- ClickUp (REST) ---------------- */
  const clickupApi = (url: URL, auth: string): Response => {
    if (auth !== TOKENS.clickup) return json({ err: 'Token invalid', ECODE: 'OAUTH_019' }, 401);
    const p = url.pathname.replace('/api/v2/', '');
    if (p === 'user') return json(clickup.user);
    if (p === 'team') return json(clickup.teams);
    let m = /^team\/(\w+)\/space$/.exec(p);
    if (m) return json((clickup.spaces as any)[m[1]]);
    m = /^space\/(\w+)\/folder$/.exec(p);
    if (m) return json((clickup.folders as any)[m[1]]);
    m = /^space\/(\w+)\/list$/.exec(p);
    if (m) return json((clickup.looseLists as any)[m[1]]);
    m = /^list\/(\w+)\/task$/.exec(p);
    if (m) return json((clickup.taskPages as any)[m[1]][Number(url.searchParams.get('page') ?? 0)] ?? { tasks: [], last_page: true });
    m = /^task\/(\w+)\/comment$/.exec(p);
    if (m) {
      const date = (n: number) => String(1609459200000 + n * 60000);
      const user = { id: 2, username: 'Bob B', email: 'bob@corp.example' };
      if (m[1] === 'c1') {
        // 26 comments with a page size of 25: the second page is requested with start/start_id
        if (!url.searchParams.get('start_id')) {
          return json({ comments: Array.from({ length: 25 }, (_, i) => ({ id: `cm${i + 1}`, comment_text: `Comment ${i + 1}`, user, date: date(i + 1) })) });
        }
        return json({ comments: [{ id: 'cm26', comment_text: 'Comment 26', user: { id: 3, username: 'Carol C', email: 'carol@corp.example' }, date: date(26) }] });
      }
      if (m[1] === 'c2') return json({ comments: [{ id: 'cm-c2', comment_text: 'Done and dusted', user, date: date(1) }] });
      return json({ comments: [] });
    }
    return json({ err: `not found: ${p}` }, 404);
  };

  return {
    fetch: handler as unknown as typeof fetch,
    calls,
    sleeps,
    sleep: async (ms: number) => { sleeps.push(ms); },
  };
}
