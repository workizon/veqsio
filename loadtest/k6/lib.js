// Shared helpers for the k6 scenarios. Not executed on its own.
//
// Environment (k6 run -e NAME=value ...):
//   BASE_URL   API base URL                         (default http://localhost:3000)
//   PASSWORD   password of perfuser1..N             (default perf12345)
//   USERS      number of seeded perfuserN accounts  (default 200)
//   PROJECTS   number of PRFnn projects             (default 20)
//   ISSUES_PER_PROJECT  keys PRFnn-1..M exist       (default 4500)
//   VUS / DURATION / RAMP  load shape               (defaults 100 / 60s / 10s)
//
// Seed the database first: bun scripts/perf/seed-large.ts   (see docs/performance.md)
import http from 'k6/http';
import { check } from 'k6';
import { Trend } from 'k6/metrics';

export const BASE = __ENV.BASE_URL || 'http://localhost:3000';
export const PASSWORD = __ENV.PASSWORD || 'perf12345';
export const USERS = Number(__ENV.USERS || 200);
export const PROJECTS = Number(__ENV.PROJECTS || 20);
export const ISSUES_PER_PROJECT = Number(__ENV.ISSUES_PER_PROJECT || 4500);

export const VUS = Number(__ENV.VUS || 100);
export const DURATION = __ENV.DURATION || '60s';
export const RAMP = __ENV.RAMP || '10s';

/** Standard ramp-up / hold / ramp-down profile with the thresholds used as pass/fail criteria. */
export function loadOptions(extra) {
  return Object.assign(
    {
      scenarios: {
        load: {
          executor: 'ramping-vus',
          startVUs: 0,
          stages: [
            { duration: RAMP, target: VUS },
            { duration: DURATION, target: VUS },
            { duration: '5s', target: 0 },
          ],
          gracefulRampDown: '10s',
        },
      },
      thresholds: {
        http_req_failed: ['rate<0.01'],
        http_req_duration: ['p(95)<800', 'p(99)<2000'],
      },
    },
    extra || {},
  );
}

const pad2 = (n) => (n < 10 ? '0' + n : String(n));
export const rnd = (n) => Math.floor(Math.random() * n);
export const pick = (a) => a[rnd(a.length)];
export const projectKey = () => 'PRF' + pad2(1 + rnd(PROJECTS));
export const issueKey = () => projectKey() + '-' + (1 + rnd(ISSUES_PER_PROJECT));

const WORDS = ['login', 'search', 'board', 'sprint', 'report', 'payment', 'timeout', 'cache', 'query', 'crash', 'latency'];

export function jql() {
  const p = projectKey();
  return pick([
    'project = ' + p + ' ORDER BY created DESC',
    'project = ' + p + ' AND status = "In Progress" ORDER BY updated DESC',
    'project = ' + p + ' AND assignee = perfuser' + (1 + rnd(USERS)) + ' ORDER BY priority DESC',
    'status = Open AND priority = High ORDER BY created DESC',
    'project in (PRF01, PRF02, PRF03) AND created >= "2026-01-01" ORDER BY created DESC',
    'summary ~ "' + pick(WORDS) + '" AND project = ' + p,
    'labels = label-' + (1 + rnd(200)) + ' AND project = ' + p,
    'assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC',
    'issuetype = Bug AND status != Closed ORDER BY priority DESC, created ASC',
  ]);
}

export const loginTime = new Trend('login_duration', true);

/** Log in as perfuser<n>; returns { headers } carrying the session cookie, or null on failure. */
export function login(n) {
  const res = http.post(
    BASE + '/rest/auth/1/session',
    JSON.stringify({ username: 'perfuser' + n, password: PASSWORD }),
    { headers: { 'Content-Type': 'application/json' }, tags: { name: 'login' } },
  );
  loginTime.add(res.timings.duration);
  const ok = check(res, { 'login 200': (r) => r.status === 200 });
  if (!ok) return null;
  return { headers: { Cookie: 'session=' + res.json('session.value') } };
}

/** Per-VU session cache: log in once per VU, not once per iteration. */
let mine = null;
export function session() {
  if (!mine) mine = login(1 + ((__VU - 1) % USERS));
  return mine;
}

export function get(name, path, s) {
  const res = http.get(BASE + path, { headers: s.headers, tags: { name } });
  check(res, { [name + ' 200']: (r) => r.status === 200 });
  return res;
}

export function post(name, path, body, s) {
  const res = http.post(BASE + path, JSON.stringify(body), {
    headers: Object.assign({ 'Content-Type': 'application/json' }, s.headers),
    tags: { name },
  });
  check(res, { [name + ' 2xx']: (r) => r.status >= 200 && r.status < 300 });
  return res;
}

// ---- scenario bodies, shared by the single-scenario files and mixed.js ----
export const scenarios = {
  login() {
    login(1 + rnd(USERS));
  },
  search(s) {
    get('search', '/rest/api/2/search?maxResults=50&startAt=' + rnd(5) * 50 + '&jql=' + encodeURIComponent(jql()), s);
  },
  detail(s) {
    const key = issueKey();
    get('issue_detail', '/rest/api/2/issue/' + key, s);
    get('issue_comments', '/rest/api/2/issue/' + key + '/comment', s);
  },
  board(s) {
    const boards = get('board_list', '/rest/api/2/board', s).json('values') || [];
    if (!boards.length) return;
    const b = pick(boards);
    get('board_config', '/rest/api/2/board/' + b.id, s);
    get('board_columns', '/rest/api/2/board/' + b.id + '/columns', s);
    get('board_issues', '/rest/api/2/search?maxResults=100&jql=' + encodeURIComponent('project = ' + projectKey() + ' AND status != Closed ORDER BY created DESC'), s);
  },
  create(s) {
    const projects = get('projects', '/rest/api/2/project', s).json() || [];
    const list = Array.isArray(projects) ? projects : projects.values || [];
    const p = list.find((x) => (x.key || x.projectKey) === projectKey()) || list[0];
    if (!p) return;
    post('issue_create', '/rest/api/2/issue', { fields: { project: { id: p.id }, issuetype: { id: 2 }, summary: 'k6 issue ' + Date.now() + '-' + rnd(1e6) } }, s);
  },
  comment(s) {
    post('comment_add', '/rest/api/2/issue/' + issueKey() + '/comment', { body: 'k6 comment ' + rnd(1e9) }, s);
  },
  dashboard(s) {
    get('dashboards', '/rest/api/2/dashboard', s);
    get('gadget_search', '/rest/api/2/search?maxResults=10&jql=' + encodeURIComponent('assignee = currentUser() AND resolution = Unresolved'), s);
    const boards = get('board_list', '/rest/agile/1.0/board', s).json('values') || [];
    if (boards.length) get('report_velocity', '/rest/agile/1.0/board/' + pick(boards).id + '/report/velocity', s);
  },
};
