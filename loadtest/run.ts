/**
 * Zero-dependency load runner (Bun). Runs the same scenarios as loadtest/k6/*.js with concurrent fetch.
 *
 *   bun loadtest/run.ts --base http://localhost:3100 --scenario mixed --vus 150 --duration 60 --ramp 10
 *
 * Options (all optional):
 *   --base URL          API base URL                      (default http://localhost:3000)
 *   --scenario NAME     login|search|detail|board|create|comment|dashboard|mixed   (default mixed)
 *   --vus N             virtual users at full load        (default 100; the headline target is 1000)
 *   --duration S        seconds at full load              (default 60)
 *   --ramp S            seconds to ramp 0 -> vus          (default 10)
 *   --think MS          mean think time between requests  (default 300)
 *   --users N           distinct perfuser accounts to log in as (default min(vus, 200))
 *   --password P        password of perfuserN             (default perf12345)
 *   --issues N          issues per project to draw keys from (default: discovered from the API)
 *   --json FILE         also write the summary as JSON
 *
 * Prerequisite: a database seeded with scripts/perf/seed-large.ts (users perfuser1..N, projects PRF01..).
 * The server should run with RATE_LIMIT_USER_MAX / RATE_LIMIT_IP_MAX raised, otherwise the built-in
 * limiter (100 req/min/user, 1000 req/min/IP) answers 429, which is reported as its own counter.
 */

const argv = process.argv.slice(2);
const opt = (name: string, def: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
// --base accepts a comma separated list: users are spread round-robin over the instances (client side load balancing).
const BASES = opt('base', process.env.BASE_URL || 'http://localhost:3000').split(',').map((b) => b.trim().replace(/\/$/, ''));
const BASE = BASES[0];
const SCENARIO = opt('scenario', 'mixed');
const VUS = Number(opt('vus', '100'));
const DURATION = Number(opt('duration', '60'));
const RAMP = Number(opt('ramp', '10'));
const THINK = Number(opt('think', '300'));
const USERS = Number(opt('users', String(Math.min(VUS, 200))));
const PASSWORD = opt('password', 'perf12345');
const JSON_OUT = opt('json', '');

type Session = { cookie: string; userId: number; base: string };
type Sample = { ms: number; status: number };

const samples = new Map<string, Sample[]>();
const rateLimited = new Map<string, number>();
const netErrors = new Map<string, number>();
let started = 0;

function record(name: string, ms: number, status: number) {
  let a = samples.get(name);
  if (!a) samples.set(name, (a = []));
  a.push({ ms, status });
  if (status === 429) rateLimited.set(name, (rateLimited.get(name) || 0) + 1);
}

async function call(name: string, s: Session | null, method: string, path: string, body?: unknown): Promise<any> {
  const t = performance.now();
  try {
    const res = await fetch((s?.base ?? BASE) + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(s ? { Cookie: s.cookie } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text(); // read the full body: serialisation cost is part of the latency
    record(name, performance.now() - t, res.status);
    try { return { status: res.status, json: JSON.parse(text), res }; } catch { return { status: res.status, json: null, res }; }
  } catch {
    netErrors.set(name, (netErrors.get(name) || 0) + 1);
    record(name, performance.now() - t, 0);
    return { status: 0, json: null, res: null };
  }
}

async function login(n: number, name = 'login'): Promise<Session | null> {
  const t = performance.now();
  try {
    const base = BASES[n % BASES.length];
    const res = await fetch(`${base}/rest/auth/1/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: `perfuser${n}`, password: PASSWORD }),
    });
    const body: any = await res.json().catch(() => null);
    record(name, performance.now() - t, res.status);
    if (res.status !== 200 || !body?.session?.value) return null;
    return { cookie: `session=${body.session.value}`, userId: n, base };
  } catch {
    netErrors.set(name, (netErrors.get(name) || 0) + 1);
    record(name, performance.now() - t, 0);
    return null;
  }
}

/* ---------------- test data discovery ---------------- */
const rnd = (n: number) => Math.floor(Math.random() * n);
const pick = <T,>(a: T[]) => a[rnd(a.length)];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const think = () => sleep(THINK <= 0 ? 0 : THINK * (0.5 + Math.random()));

let projectKeys: string[] = [];
let projectIdByKey = new Map<string, number>();
let taskTypeId = 2;
let issuesPerProject = Number(opt('issues', '0'));
let boards: { id: string; projectId: number }[] = [];
let sprintsByBoard = new Map<string, string[]>();

const WORDS = ['login', 'search', 'board', 'sprint', 'report', 'payment', 'timeout', 'cache', 'query', 'crash', 'latency'];

function jqlVariant(): string {
  const p = pick(projectKeys);
  const variants = [
    `project = ${p} ORDER BY created DESC`,
    `project = ${p} AND status = "In Progress" ORDER BY updated DESC`,
    `project = ${p} AND assignee = perfuser${1 + rnd(USERS)} ORDER BY priority DESC`,
    `status = Open AND priority = High ORDER BY created DESC`,
    `project in (${projectKeys.slice(0, 3).join(', ')}) AND created >= "2026-01-01" ORDER BY created DESC`,
    `summary ~ "${pick(WORDS)}" AND project = ${p}`,
    `labels = label-${1 + rnd(200)} AND project = ${p}`,
    `assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC`,
    `issuetype = Bug AND status != Closed ORDER BY priority DESC, created ASC`,
  ];
  return pick(variants);
}

function issuePath(): string {
  const p = pick(projectKeys);
  return `/rest/api/2/issue/${p}-${1 + rnd(Math.max(1, issuesPerProject))}`;
}

/* ---------------- scenarios (one iteration each) ---------------- */
type Step = (s: Session) => Promise<void>;
const steps: Record<string, Step> = {
  async search(s) {
    const j = jqlVariant();
    await call('search', s, 'GET', `/rest/api/2/search?jql=${encodeURIComponent(j)}&maxResults=50&startAt=${rnd(5) * 50}`);
  },
  async searchText(s) {
    await call('search_text', s, 'GET', `/rest/api/2/search?text=${pick(WORDS)}&maxResults=50`);
  },
  async detail(s) {
    const path = issuePath();
    await call('issue_detail', s, 'GET', path);
    await call('issue_comments', s, 'GET', path + '/comment');
  },
  async board(s) {
    if (boards.length === 0) return;
    const b = pick(boards);
    await call('board_config', s, 'GET', `/rest/api/2/board/${b.id}`);
    await call('board_columns', s, 'GET', `/rest/api/2/board/${b.id}/columns`);
    const sp = sprintsByBoard.get(b.id);
    if (sp && sp.length) await call('sprint_issues', s, 'GET', `/rest/api/2/sprint/${pick(sp)}/issue?maxResults=50`);
    else await call('board_search', s, 'GET', `/rest/api/2/search?jql=${encodeURIComponent(`project = ${pick(projectKeys)} AND status != Closed ORDER BY created DESC`)}&maxResults=100`);
  },
  async create(s) {
    const p = pick(projectKeys);
    await call('issue_create', s, 'POST', '/rest/api/2/issue', {
      fields: { project: { id: projectIdByKey.get(p) }, issuetype: { id: taskTypeId }, summary: `Load test issue ${Date.now()}-${rnd(1e6)}`, description: 'created by loadtest/run.ts' },
    });
  },
  async comment(s) {
    await call('comment_add', s, 'POST', issuePath() + '/comment', { body: `load test comment ${rnd(1e9)}` });
  },
  async dashboard(s) {
    await call('dashboards', s, 'GET', '/rest/api/2/dashboard');
    if (boards.length) {
      const b = pick(boards);
      await call('report_velocity', s, 'GET', `/rest/agile/1.0/board/${b.id}/report/velocity`);
      if (Math.random() < 0.3) await call('report_cfd', s, 'GET', `/rest/agile/1.0/board/${b.id}/report/cfd?days=30`);
    }
    await call('gadget_search', s, 'GET', `/rest/api/2/search?jql=${encodeURIComponent('assignee = currentUser() AND resolution = Unresolved')}&maxResults=10`);
  },
  async login() {
    await login(1 + rnd(USERS), 'login');
  },
};

// Mixed workload weights (percent), roughly the read-heavy profile of a ticketing tool.
const MIX: [string, number][] = [
  ['detail', 30], ['search', 25], ['board', 12], ['dashboard', 8], ['comment', 8], ['create', 5], ['searchText', 5], ['login', 2], ['list', 5],
];
steps.list = async (s) => {
  await call('issue_list_default', s, 'GET', `/rest/api/2/search?maxResults=50&startAt=${rnd(20) * 50}`);
};

function chooseStep(): string {
  if (SCENARIO !== 'mixed') return SCENARIO;
  let r = rnd(100);
  for (const [n, w] of MIX) { if ((r -= w) < 0) return n; }
  return 'detail';
}

/* ---------------- main ---------------- */
async function setup(): Promise<Session[]> {
  console.log(`Logging in ${USERS} users against ${BASE} ...`);
  const sessions: Session[] = [];
  let next = 1;
  const worker = async () => {
    while (next <= USERS) {
      const n = next++;
      const s = await login(n, 'setup_login');
      if (s) sessions.push(s);
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, USERS) }, worker));
  samples.delete('setup_login');
  if (sessions.length === 0) throw new Error('no user could log in (is the DB seeded with scripts/perf/seed-large.ts?)');
  const s = sessions[0];
  const proj = await call('setup', s, 'GET', '/rest/api/2/project');
  const list: any[] = Array.isArray(proj.json) ? proj.json : proj.json?.values || proj.json?.projects || [];
  projectKeys = list.map((p) => p.key || p.projectKey).filter((k: string) => /^PRF/.test(k));
  if (projectKeys.length === 0) throw new Error('no PRF* projects visible; seed the DB first');
  projectIdByKey = new Map(list.filter((p) => /^PRF/.test(p.key || p.projectKey)).map((p) => [p.key || p.projectKey, p.id]));
  const types = await call('setup', s, 'GET', '/rest/api/2/issuetype');
  taskTypeId = (Array.isArray(types.json) ? types.json : types.json?.values || []).find((t: any) => t.name === 'Task')?.id ?? 2;
  if (!issuesPerProject) {
    const probe = await call('setup', s, 'GET', `/rest/api/2/search?jql=${encodeURIComponent(`project = ${projectKeys[0]}`)}&maxResults=1`);
    issuesPerProject = Math.floor((probe.json?.total || 1000) * 0.9);
  }
  const bs = await call('setup', s, 'GET', '/rest/api/2/board');
  boards = (bs.json?.values || []).filter((b: any) => projectKeys.length && b.projectId);
  for (const b of boards.slice(0, 40)) {
    const sp = await call('setup', s, 'GET', `/rest/api/2/board/${b.id}/sprint`);
    sprintsByBoard.set(b.id, (sp.json?.values || []).map((x: any) => x.id));
  }
  samples.delete('setup');
  console.log(`Projects: ${projectKeys.length}, issues/project ~${issuesPerProject}, boards: ${boards.length}`);
  return sessions;
}

function pct(sorted: number[], p: number) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function main() {
  const sessions = await setup();
  const tStart = performance.now();
  const endAt = tStart + (RAMP + DURATION) * 1000;
  let stop = false;
  const vu = async (i: number) => {
    // linear ramp: VU i starts at i/VUS * RAMP seconds
    await sleep((i / VUS) * RAMP * 1000);
    started++;
    const s = sessions[i % sessions.length];
    while (!stop && performance.now() < endAt) {
      const name = chooseStep();
      try { await steps[name](s); } catch { /* counted via netErrors */ }
      await think();
    }
  };
  console.log(`Scenario ${SCENARIO}: ramp ${RAMP}s to ${VUS} VUs, then ${DURATION}s (think ~${THINK}ms)`);
  const ticker = setInterval(() => {
    const total = [...samples.values()].reduce((a, b) => a + b.length, 0);
    const t = Math.round((performance.now() - tStart) / 1000);
    if (t % 10 === 0) console.log(`  t=${t}s vus=${started} requests=${total}`);
  }, 1000);
  await Promise.all(Array.from({ length: VUS }, (_, i) => vu(i)));
  stop = true;
  clearInterval(ticker);
  const wall = (performance.now() - tStart) / 1000;
  process.stdout.write('\n');

  const rows: any[] = [];
  const all: Sample[] = [];
  for (const [name, arr] of [...samples.entries()].sort()) {
    all.push(...arr);
    const ms = arr.map((x) => x.ms).sort((a, b) => a - b);
    const errs = arr.filter((x) => x.status === 0 || x.status >= 500 || (x.status >= 400 && x.status !== 429 && x.status !== 404 && x.status !== 401)).length;
    rows.push({
      name, count: arr.length, rps: +(arr.length / wall).toFixed(1),
      avg: +(ms.reduce((a, b) => a + b, 0) / ms.length).toFixed(1), p50: +pct(ms, 50).toFixed(1), p95: +pct(ms, 95).toFixed(1), p99: +pct(ms, 99).toFixed(1),
      max: +ms[ms.length - 1].toFixed(1), errors: errs, errorRate: +((errs / arr.length) * 100).toFixed(2), rateLimited429: rateLimited.get(name) || 0,
    });
  }
  const ms = all.map((x) => x.ms).sort((a, b) => a - b);
  const errs = rows.reduce((a, r) => a + r.errors, 0);
  const total = {
    name: 'ALL', count: all.length, rps: +(all.length / wall).toFixed(1),
    avg: +(ms.reduce((a, b) => a + b, 0) / Math.max(1, ms.length)).toFixed(1), p50: +pct(ms, 50).toFixed(1), p95: +pct(ms, 95).toFixed(1), p99: +pct(ms, 99).toFixed(1),
    max: +(ms[ms.length - 1] || 0).toFixed(1), errors: errs, errorRate: +((errs / Math.max(1, all.length)) * 100).toFixed(2),
    rateLimited429: [...rateLimited.values()].reduce((a, b) => a + b, 0),
  };
  rows.push(total);
  const pad = (v: any, n: number) => String(v).padStart(n);
  console.log(`\n${'endpoint'.padEnd(22)}${pad('count', 8)}${pad('req/s', 8)}${pad('avg', 8)}${pad('p50', 8)}${pad('p95', 8)}${pad('p99', 8)}${pad('max', 9)}${pad('err%', 7)}${pad('429', 7)}`);
  for (const r of rows) console.log(`${r.name.padEnd(22)}${pad(r.count, 8)}${pad(r.rps, 8)}${pad(r.avg, 8)}${pad(r.p50, 8)}${pad(r.p95, 8)}${pad(r.p99, 8)}${pad(r.max, 9)}${pad(r.errorRate, 7)}${pad(r.rateLimited429, 7)}`);
  console.log(`\nlatencies in ms; err% counts network errors, 5xx and unexpected 4xx (429 reported separately). wall=${wall.toFixed(1)}s`);
  if (JSON_OUT) await Bun.write(JSON_OUT, JSON.stringify({ base: BASE, scenario: SCENARIO, vus: VUS, duration: DURATION, ramp: RAMP, think: THINK, wall, rows }, null, 2));
  process.exit(0);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
