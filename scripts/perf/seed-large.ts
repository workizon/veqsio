/**
 * Large-volume seed generator for performance testing.
 *
 *   DATABASE_URL=postgresql://veqsio:veqsio@localhost:5432/veqsio_perf \
 *     bun scripts/perf/seed-large.ts [--issues 100000] [--projects 20] [--users 500] \
 *       [--comments-per-issue 1.5] [--history-per-issue 3] [--links-per-issue 0.3] \
 *       [--labels 200] [--seed 42] [--force]
 *
 * Everything is generated inside PostgreSQL with INSERT ... SELECT generate_series(), so there is no
 * client round trip per row. Output is a pure function of --seed (hash based, no random()).
 * Safety: refuses to run unless the database name contains "perf" or "test".
 * The schema must already exist (drizzle-kit push). Base metadata (statuses, priorities, workflows,
 * permission scheme, admin user) is created by packages/db/seed.ts when missing.
 */
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';

// Dependencies live in packages/api/node_modules; resolve them from there so the script runs from any cwd.
const apiModules = resolve(dirname(new URL(import.meta.url).pathname), '../../packages/api/node_modules');
const postgres = (await import(resolve(apiModules, 'postgres'))).default as typeof import('postgres').default;
const bcrypt = (await import(resolve(apiModules, 'bcryptjs'))).default as typeof import('bcryptjs');

function arg(name: string, def: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = Number(process.argv[i + 1]);
  if (!Number.isFinite(v) || v < 0) throw new Error(`--${name} must be a non-negative number`);
  return v;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const url = process.env.DATABASE_URL || '';
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(2);
}
const dbName = new URL(url).pathname.replace(/^\//, '');
if (!/perf|test/i.test(dbName)) {
  console.error(`Refusing to seed database "${dbName}": its name must contain "perf" or "test".`);
  process.exit(2);
}

const ISSUES = Math.floor(arg('issues', 100_000));
const PROJECTS = Math.max(1, Math.floor(arg('projects', 20)));
const USERS = Math.max(1, Math.floor(arg('users', 500)));
const LABELS = Math.max(1, Math.floor(arg('labels', 200)));
const COMMENTS_PER = arg('comments-per-issue', 1.5);
const HISTORY_PER = arg('history-per-issue', 3);
const LINKS_PER = arg('links-per-issue', 0.3);
const SEED = Math.floor(arg('seed', 42));
const FORCE = flag('force');

const sql = postgres(url, { max: 1, onnotice: () => {} });
const t0 = Date.now();
const step = async (label: string, fn: () => Promise<unknown>) => {
  const s = Date.now();
  await fn();
  console.log(`  ${label.padEnd(28)} ${((Date.now() - s) / 1000).toFixed(1)}s`);
};

// Deterministic pseudo-random integer in [0, n) from (seed, salt, i).
const R = (salt: number, i: string, n: string) => `(abs(hashtextextended(${i}::text || '/${salt}', ${SEED})) % ${n})`;

async function main() {
  console.log(`Seeding ${dbName}: ${ISSUES} issues, ${PROJECTS} projects, ${USERS} users (seed ${SEED})`);

  const [{ n: baseCount }] = await sql`select count(*)::int as n from statuses`;
  if (baseCount === 0) {
    console.log('Base metadata missing, running packages/db/seed.ts');
    const here = dirname(new URL(import.meta.url).pathname);
    const r = spawnSync('bun', [resolve(here, '../../packages/db/seed.ts')], { env: process.env, stdio: 'inherit' });
    if (r.status !== 0) throw new Error('base seed failed');
  }
  const [{ n: existing }] = await sql`select count(*)::int as n from issues`;
  if (existing > 0) {
    if (!FORCE) throw new Error(`issues table already has ${existing} rows; pass --force to wipe it first`);
    console.log('--force: truncating issue data');
    await sql.unsafe(`truncate issues, labels, comments, issue_history, issue_links, sprints, boards, worklogs,
      project_issue_counters restart identity cascade`);
    await sql`delete from permission_scheme_associations where project_id in (select id from projects where project_key like 'PRF%')`;
    await sql`delete from projects where project_key like 'PRF%'`;
    await sql`delete from users where username like 'perfuser%'`;
  }

  await sql.unsafe('set synchronous_commit = off');

  const [userGroup] = await sql`select id from groups where name = 'veqsio-users'`;
  const [scheme] = await sql`select id from permission_schemes order by id limit 1`;
  const [{ id: adminId }] = await sql`select id from users where username = 'admin'`;
  const statuses = await sql`select id, category from statuses order by sort_order, id`;
  const types = await sql`select id from issue_types where is_subtask = false order by id`;
  const prios = await sql`select id from priorities order by sort_order, id`;
  const resolutions = await sql`select id from resolutions order by id`;
  const doneIds = statuses.filter((s) => s.category === 'done').map((s) => s.id);

  // ---- users ----
  await step('users', async () => {
    const hash = await bcrypt.hash('perf12345', 10);
    await sql`insert into users (username, email, display_name, password_hash, active)
      select 'perfuser' || g, 'perfuser' || g || '@perf.local', 'Perf User ' || g, ${hash}, true
      from generate_series(1, ${USERS}) g on conflict do nothing`;
    if (userGroup) {
      await sql`insert into user_groups (user_id, group_id)
        select id, ${userGroup.id} from users where username like 'perfuser%' on conflict do nothing`;
    }
  });
  const userIds = (await sql`select id from users where username like 'perfuser%' order by id`).map((r) => r.id as number);
  const U0 = userIds[0], UN = userIds.length;

  // ---- projects, boards, sprints ----
  await step('projects/boards/sprints', async () => {
    await sql`insert into projects (project_key, name, description, lead_id, category)
      select 'PRF' || lpad(g::text, 2, '0'), 'Perf Project ' || g, 'Generated load-test project', ${adminId}, 'Perf'
      from generate_series(1, ${PROJECTS}) g on conflict do nothing`;
    if (scheme) {
      await sql`insert into permission_scheme_associations (project_id, scheme_id)
        select id, ${scheme.id} from projects where project_key like 'PRF%' on conflict do nothing`;
    }
    await sql`insert into boards (name, type, project_id)
      select 'Board ' || project_key, case when id % 2 = 0 then 'scrum' else 'kanban' end, id
      from projects where project_key like 'PRF%'`;
    await sql`insert into board_columns (board_id, status_id, name, sort_order)
      select b.id, s.id, s.name, s.sort_order from boards b cross join statuses s
      where b.project_id in (select id from projects where project_key like 'PRF%')`;
    await sql`insert into sprints (name, state, board_id, start_date, end_date)
      select 'Sprint ' || g, case when g < 4 then 'closed' when g = 4 then 'active' else 'future' end, b.id,
        now() - ((6 - g) || ' weeks')::interval, now() - ((4 - g) || ' weeks')::interval
      from boards b cross join generate_series(1, 5) g
      where b.type = 'scrum' and b.project_id in (select id from projects where project_key like 'PRF%')`;
  });
  const projIds = (await sql`select id from projects where project_key like 'PRF%' order by id`).map((r) => r.id as number);
  const P0 = projIds[0];

  // ---- labels ----
  await step('labels', async () => {
    await sql`insert into labels (name) select 'label-' || g from generate_series(1, ${LABELS}) g on conflict do nothing`;
  });
  const [{ l0 }] = await sql`select min(id)::int as l0 from labels where name like 'label-%'`;

  // ---- issues ----
  const [{ b }] = await sql`select coalesce(max(id), 0)::int as b from issues`;
  const base = b as number;
  const words = `login search board sprint backlog report export import payment invoice email notification timeout cache index query
    migration upgrade dashboard widget filter permission workflow comment attachment label release version epic story bug crash
    memory latency throughput retry webhook token session password profile avatar theme layout mobile api sdk cli docs`
    .split(/\s+/).filter(Boolean);
  const wordsSql = `array[${words.map((x) => `'${x}'`).join(',')}]`;
  const nStat = statuses.length, nType = types.length, nPrio = prios.length;
  const statusArr = `array[${statuses.map((s) => s.id).join(',')}]`;
  const typeArr = `array[${types.map((t) => t.id).join(',')}]`;
  const prioArr = `array[${prios.map((p) => p.id).join(',')}]`;
  const resArr = `array[${resolutions.map((r) => r.id).join(',')}]`;
  const doneArr = `array[${doneIds.join(',')}]::int[]`;
  const w = (salt: number, i: string) => `(${wordsSql})[1 + ${R(salt, i, String(words.length))}]`;

  await step('issues', async () => {
    // Batches of 50k rows keep WAL and memory modest at 1M issues.
    const BATCH = 50_000;
    for (let from = 1; from <= ISSUES; from += BATCH) {
      const to = Math.min(ISSUES, from + BATCH - 1);
      await sql.unsafe(`
        insert into issues (id, issue_key, project_id, issue_type_id, status_id, priority_id, resolution_id, summary, description,
          assignee_id, reporter_id, created_at, updated_at, resolved_at, due_date, story_points)
        select ${base} + g,
          'PRF' || lpad((1 + (g - 1) % ${PROJECTS})::text, 2, '0') || '-' || (1 + (g - 1) / ${PROJECTS}),
          ${P0} + (g - 1) % ${PROJECTS},
          (${typeArr})[1 + ${R(1, 'g', String(nType))}],
          st.sid,
          (${prioArr})[1 + ${R(3, 'g', String(nPrio))}],
          case when st.sid = any(${doneArr}) then (${resArr})[1 + ${R(4, 'g', String(resolutions.length || 1))}] end,
          initcap(${w(5, 'g')}) || ' ' || ${w(6, 'g')} || ' ' || ${w(7, 'g')} || ' fails on ' || ${w(8, 'g')} || ' #' || g,
          'When using ' || ${w(9, 'g')} || ' with ' || ${w(10, 'g')} || ' the ' || ${w(11, 'g')} || ' step ' || ${w(12, 'g')}
            || E' is slow.\\nSteps: open ' || ${w(13, 'g')} || ', click ' || ${w(14, 'g')} || ', observe ' || ${w(15, 'g')} || '.',
          case when ${R(16, 'g', '10')} = 0 then null else ${U0} + ${R(17, 'g', String(UN))} end,
          ${U0} + ${R(18, 'g', String(UN))},
          ts.c,
          least(ts.c + ((${R(20, 'g', '5000000')}) || ' seconds')::interval, now()),
          case when st.sid = any(${doneArr}) then ts.c + ((${R(21, 'g', '3000000')}) || ' seconds')::interval end,
          case when ${R(22, 'g', '3')} = 0 then ts.c + ((${R(23, 'g', '10000000')}) || ' seconds')::interval end,
          case when ${R(24, 'g', '2')} = 0 then (array[1,2,3,5,8,13])[1 + ${R(25, 'g', '6')}] end
        from generate_series(${from}, ${to}) g
        cross join lateral (select (${statusArr})[1 + ${R(2, 'g', String(nStat))}] as sid) st
        cross join lateral (select now() - ((${R(26, 'g', String(2 * 365 * 86400))}) || ' seconds')::interval as c) ts`);
    }
    await sql`select setval(pg_get_serial_sequence('issues', 'id'), ${base + ISSUES}) where ${ISSUES} > 0`;
    await sql.unsafe(`
      insert into project_issue_counters (project_id, current_value)
      select project_id, count(*) from issues where project_id between ${P0} and ${P0 + PROJECTS - 1} group by 1
      on conflict (project_id) do update set current_value = excluded.current_value`);
  });

  const nComments = Math.floor(ISSUES * COMMENTS_PER);
  const nHistory = Math.floor(ISSUES * HISTORY_PER);
  const nLinks = Math.floor(ISSUES * LINKS_PER);

  await step(`comments (${nComments})`, async () => {
    await sql.unsafe(`
      insert into comments (issue_id, body, author_id, created_at, updated_at)
      select ${base} + 1 + ${R(30, 'g', String(ISSUES))},
        'Looks like ' || ${w(31, 'g')} || ' is the cause, see ' || ${w(32, 'g')} || '. ' || ${w(33, 'g')} || ' needs another look.',
        ${U0} + ${R(34, 'g', String(UN))}, now() - ((${R(35, 'g', '60000000')}) || ' seconds')::interval, now()
      from generate_series(1, ${nComments}) g`);
  });
  await step(`history (${nHistory})`, async () => {
    await sql.unsafe(`
      insert into issue_history (issue_id, field_name, old_value, new_value, author_id, created_at)
      select ${base} + 1 + ${R(40, 'g', String(ISSUES))},
        (array['status','assignee','priority','summary','labels'])[1 + ${R(41, 'g', '5')}],
        'old-' || ${R(42, 'g', '100')}, 'new-' || ${R(43, 'g', '100')},
        ${U0} + ${R(44, 'g', String(UN))}, now() - ((${R(45, 'g', '60000000')}) || ' seconds')::interval
      from generate_series(1, ${nHistory}) g`);
  });
  await step('issue_labels', async () => {
    await sql.unsafe(`
      insert into issue_labels (issue_id, label_id)
      select distinct ${base} + g, ${l0} + ${R(50, "(g::text || '/' || k)", String(LABELS))}
      from generate_series(1, ${ISSUES}) g cross join generate_series(1, 2) k
      where ${R(51, 'g', '10')} < 6 and (k = 1 or ${R(52, 'g', '2')} = 0)`);
  });
  await step(`issue_links (${nLinks})`, async () => {
    const [lt] = await sql`select id from link_types order by id limit 1`;
    await sql.unsafe(`
      insert into issue_links (issue_id, linked_issue_id, link_type_id)
      select ${base} + 1 + ${R(60, 'g', String(ISSUES))}, ${base} + 1 + ${R(61, 'g', String(ISSUES))}, ${lt?.id ?? 'null'}
      from generate_series(1, ${nLinks}) g`);
  });
  await step('sprint_issues', async () => {
    await sql.unsafe(`
      insert into sprint_issues (sprint_id, issue_id)
      select s.id, i.id from (
        select s.id, row_number() over (partition by s.board_id order by s.id) rn, b.project_id
        from sprints s join boards b on b.id = s.board_id where b.project_id between ${P0} and ${P0 + PROJECTS - 1}
      ) s join issues i on i.project_id = s.project_id and i.id > ${base} and (i.id % 5) + 1 = s.rn
      where i.id % 3 = 0
      on conflict do nothing`);
  });
  await step('worklogs', async () => {
    await sql.unsafe(`
      insert into worklogs (issue_id, issue_key, author_id, time_spent_seconds, started)
      select i.id, i.issue_key, ${U0} + ${R(70, 'i.id', String(UN))}, 900 * (1 + ${R(71, 'i.id', '16')}),
        now() - ((${R(72, 'i.id', '30000000')}) || ' seconds')::interval
      from issues i where i.id > ${base} and i.id % 5 = 0`);
  });
  await step('permissions (ADD_COMMENTS)', async () => {
    // Older databases seeded before ADD_COMMENTS was part of the default scheme: ordinary users could not comment.
    if (scheme && userGroup) {
      await sql`insert into permission_entries (scheme_id, permission_key, group_id)
        select ${scheme.id}, 'ADD_COMMENTS', ${userGroup.id}
        where not exists (select 1 from permission_entries where scheme_id = ${scheme.id} and permission_key = 'ADD_COMMENTS' and group_id = ${userGroup.id})`;
    }
  });
  await step('full-text index (tsvector)', async () => {
    // Same routine the admin endpoint POST /rest/api/2/admin/search/setup runs (column, GIN index, trigger, backfill).
    process.env.REDIS_URL = 'memory:'; // the API modules open a Redis client on import; not needed here
    const mod = await import(resolve(dirname(new URL(import.meta.url).pathname), '../../packages/api/src/search/fulltext.ts'));
    await mod.setupFullTextSearch();
  });
  await step('analyze', () => sql.unsafe('analyze'));

  const counts = await sql`select (select count(*) from issues) issues, (select count(*) from comments) comments,
    (select count(*) from issue_history) history, (select count(*) from issue_labels) issue_labels,
    (select count(*) from issue_links) links, (select count(*) from users) users, (select count(*) from projects) projects,
    pg_size_pretty(pg_database_size(current_database())) size`;
  console.log('Done in', ((Date.now() - t0) / 1000).toFixed(1) + 's', JSON.stringify(counts[0]));
  console.log('Login as perfuser1 / perf12345 (ordinary user) or admin / admin123.');
}

// process.exit: the API modules imported for the full-text setup keep pools open.
main().then(() => process.exit(0)).catch((e) => { console.error(e.message || e); process.exit(1); });
