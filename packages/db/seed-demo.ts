/**
 * Demo data for a public demo or screenshots: a team of users, four projects (scrum and kanban),
 * epics with children, sprints (closed, active, future), versions, components, labels, comments,
 * worklogs, links, watchers, status history, saved filters and dashboards.
 *
 * Run after `seed.ts` (needs the DEMO project and the default schemes):
 *   cd packages/db && bun seed-demo.ts
 *
 * It is deterministic (same data every run, dates relative to "now"), adds only rows and refuses to
 * run on a database that already has issues. All demo users share the password `demo12345`
 * (override with DEMO_PASSWORD). Do not run it against production data.
 */
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import bcrypt from 'bcryptjs'
import { eq } from 'drizzle-orm'
import * as schema from './schema'

const sql = postgres(process.env.DATABASE_URL || 'postgresql://veqsio:veqsio@localhost:5460/veqsio')
const db = drizzle(sql, { schema })
const DAY = 86_400_000
const ago = (days: number, hour = 10) => {
  const d = new Date(Date.now() - days * DAY)
  d.setUTCHours(hour, (days * 7) % 60, 0, 0)
  return d
}

// Small seeded PRNG so every run produces the same data.
let seedState = 20260101
const rnd = () => {
  seedState = (seedState * 1664525 + 1013904223) >>> 0
  return seedState / 2 ** 32
}
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]
const chance = (p: number) => rnd() < p

const PEOPLE = [
  ['anna', 'Anna Petrova'], ['marcus', 'Marcus Lee'], ['sofia', 'Sofia Rossi'], ['liam', 'Liam O\'Connor'],
  ['yuki', 'Yuki Tanaka'], ['omar', 'Omar Haddad'], ['elena', 'Elena Novak'], ['david', 'David Kim'],
  ['priya', 'Priya Nair'], ['tom', 'Tom Becker'],
] as const

type Kind = 'Bug' | 'Task' | 'Story'
interface Template { summary: string; type: Kind; labels?: string[] }

interface ProjectSpec {
  key: string
  name: string
  description: string
  category: string
  board: 'scrum' | 'kanban'
  epics: string[]
  components: string[]
  versions: Array<{ name: string; released: boolean; start: number; release: number }>
  items: Template[]
}

const PROJECTS: ProjectSpec[] = [
  {
    key: 'DEMO', name: 'Demo Project', description: 'Core product: the platform itself', category: 'Software', board: 'scrum',
    epics: ['Platform 2.0', 'Enterprise single sign-on', 'Reporting overhaul'],
    components: ['Backend', 'Web UI', 'Search', 'Integrations'],
    versions: [{ name: '1.8', released: true, start: 90, release: 60 }, { name: '1.9', released: true, start: 59, release: 28 }, { name: '2.0', released: false, start: 27, release: -21 }],
    items: [
      { summary: 'Login page throws 500 for SSO users', type: 'Bug' }, { summary: 'Add CSV export to issue search', type: 'Story' },
      { summary: 'Board column WIP limits are ignored on drag', type: 'Bug' }, { summary: 'Customer portal: attach files to requests', type: 'Story' },
      { summary: 'Write migration guide for Jira Cloud', type: 'Task' }, { summary: 'Sprint burndown shows wrong remaining work', type: 'Bug' },
      { summary: 'Dark mode: unreadable gadget titles', type: 'Bug' }, { summary: 'Keyboard shortcut help dialog', type: 'Task' },
      { summary: 'Password reset emails', type: 'Story' }, { summary: 'Audit log export', type: 'Story' },
      { summary: 'Webhook retries use fixed delay', type: 'Bug' }, { summary: 'Improve JQL error messages', type: 'Task' },
      { summary: 'Attachment thumbnails for PDFs', type: 'Story' }, { summary: 'Slow query on backlog with 10k issues', type: 'Bug' },
      { summary: 'Rename "Resolved" status per team', type: 'Task' }, { summary: 'Notification scheme preview', type: 'Story' },
      { summary: 'Fix typo on 404 page', type: 'Bug' }, { summary: 'Upgrade Next.js to latest patch', type: 'Task' },
      { summary: 'Org-wide SLA report', type: 'Story' }, { summary: 'Duplicate comments after reconnect', type: 'Bug' },
      { summary: 'Support Microsoft Entra group sync', type: 'Story' }, { summary: 'Reindex button gives no feedback', type: 'Bug' },
      { summary: 'Saved filter sharing by group', type: 'Story' }, { summary: 'Bulk edit loses custom field values', type: 'Bug' },
      { summary: 'Inline edit for story points on the backlog', type: 'Story' }, { summary: 'Rate limit headers on the REST API', type: 'Task' },
      { summary: 'Timezone shown wrong in due date picker', type: 'Bug' }, { summary: 'Add OpenAPI spec download', type: 'Task' },
      { summary: 'Mentions in comments notify the wrong user', type: 'Bug' }, { summary: 'Roadmap export to PNG', type: 'Story' },
      { summary: 'Email digest for watched issues', type: 'Story' }, { summary: 'Clean up unused database indexes', type: 'Task' },
    ],
  },
  {
    key: 'WEB', name: 'Website Redesign', description: 'Marketing site and documentation', category: 'Marketing', board: 'kanban',
    epics: ['New landing page', 'Docs site migration'],
    components: ['Landing', 'Docs', 'Blog'],
    versions: [{ name: 'Launch', released: false, start: 30, release: -14 }],
    items: [
      { summary: 'Hero section copy and illustration', type: 'Task' }, { summary: 'Pricing page with plan comparison', type: 'Story' },
      { summary: 'Cookie banner covers the footer on mobile', type: 'Bug' }, { summary: 'Migrate docs to the new static generator', type: 'Task' },
      { summary: 'Add search to the docs', type: 'Story' }, { summary: 'Open Graph images for blog posts', type: 'Task' },
      { summary: 'Broken anchor links in the API reference', type: 'Bug' }, { summary: 'Customer logos carousel', type: 'Story' },
      { summary: 'Lighthouse score below 90 on the home page', type: 'Bug' }, { summary: 'Write the "Getting started" tutorial', type: 'Task' },
      { summary: 'Newsletter sign-up form validation', type: 'Bug' }, { summary: 'Dark mode for the docs', type: 'Story' },
      { summary: 'Redirect map for old URLs', type: 'Task' }, { summary: 'Changelog page generated from releases', type: 'Story' },
      { summary: 'Case study: migration from a hosted tracker', type: 'Task' }, { summary: 'Fix sitemap lastmod values', type: 'Bug' },
    ],
  },
  {
    key: 'MOB', name: 'Mobile App', description: 'iOS and Android client', category: 'Software', board: 'scrum',
    epics: ['Offline mode', 'Push notifications'],
    components: ['iOS', 'Android', 'API client'],
    versions: [{ name: '0.9 beta', released: true, start: 60, release: 20 }, { name: '1.0', released: false, start: 19, release: -30 }],
    items: [
      { summary: 'Crash when opening an issue with no assignee', type: 'Bug' }, { summary: 'Offline queue for comments', type: 'Story' },
      { summary: 'Push notification for @mentions', type: 'Story' }, { summary: 'Biometric unlock', type: 'Story' },
      { summary: 'Android back button closes the app on the board', type: 'Bug' }, { summary: 'Pull to refresh on the issue list', type: 'Task' },
      { summary: 'Attach photos from the camera', type: 'Story' }, { summary: 'Dark theme follows system setting', type: 'Task' },
      { summary: 'Slow scrolling on lists above 500 items', type: 'Bug' }, { summary: 'Deep links to issues', type: 'Task' },
      { summary: 'Accessibility pass: VoiceOver labels', type: 'Task' }, { summary: 'Swipe actions on backlog rows', type: 'Story' },
      { summary: 'Token refresh fails after airplane mode', type: 'Bug' }, { summary: 'Localise date formats', type: 'Task' },
      { summary: 'Tablet layout for the board', type: 'Story' }, { summary: 'App store screenshots', type: 'Task' },
    ],
  },
  {
    key: 'OPS', name: 'Platform Operations', description: 'Infrastructure, deployments and incidents', category: 'Operations', board: 'kanban',
    epics: ['Zero-downtime deploys'],
    components: ['Database', 'CI/CD', 'Monitoring'],
    versions: [],
    items: [
      { summary: 'Rotate database credentials', type: 'Task' }, { summary: 'Backups failing on the replica', type: 'Bug' },
      { summary: 'Alert on queue depth above threshold', type: 'Task' }, { summary: 'Blue/green switch for the API', type: 'Story' },
      { summary: 'TLS certificate renewal job missed a run', type: 'Bug' }, { summary: 'Reduce Docker image size', type: 'Task' },
      { summary: 'Runbook for failover', type: 'Task' }, { summary: 'High memory use on the worker nodes', type: 'Bug' },
      { summary: 'Move logs to cheaper storage after 30 days', type: 'Story' }, { summary: 'Upgrade PostgreSQL minor version', type: 'Task' },
      { summary: 'Load test before the 2.0 release', type: 'Task' }, { summary: 'Status page automation', type: 'Story' },
    ],
  },
]

const DESCRIPTIONS = [
  'Steps to reproduce:\n1. Open the page\n2. Perform the action\n3. Observe the result\n\nExpected: it works. Actual: it does not.',
  'We need this for the next release. Acceptance criteria are listed below.\n\n- Works on desktop and mobile\n- Covered by tests\n- Documented',
  'Raised by a customer in a support ticket. Low risk, but visible.',
  'Follow-up from the retrospective. Keep it small and ship it this sprint.',
  'Technical debt: the current approach works but is hard to extend. Needs a short design note first.',
]
const COMMENTS = [
  'Reproduced on the latest build.', 'I can take this one.', 'Blocked until the API change lands.', 'Fix is in review, please have a look.',
  'Verified on staging, closing.', 'Moving this to the next sprint, capacity is tight.', 'Added a test that fails without the change.',
  'Customer confirmed this is fixed on their side too.', 'Could we split this into two issues?', 'Thanks, that explains the behaviour.',
  'Updated the estimate after looking at the code.', 'Related to the earlier incident, linking it.',
]
const LABELS: Array<[string, string]> = [
  ['customer', 'orange'], ['regression', 'red'], ['security', 'purple'], ['performance', 'yellow'], ['ux', 'pink'],
  ['tech-debt', 'gray'], ['quick-win', 'green'], ['needs-design', 'blue'],
]
const POINTS = [1, 2, 3, 5, 5, 8, 13]

async function main() {
  const [demo] = await db.select().from(schema.projects).where(eq(schema.projects.projectKey, 'DEMO')).limit(1)
  if (!demo) throw new Error('Run seed.ts first (DEMO project missing)')
  const existing = await db.select({ id: schema.issues.id }).from(schema.issues).limit(1)
  if (existing.length) { console.log('Demo data already present (the database has issues). Skipping.'); await sql.end(); return }

  // ---- users -------------------------------------------------------------------------------
  const hash = await bcrypt.hash(process.env.DEMO_PASSWORD || 'demo12345', 10)
  const people = await db.insert(schema.users)
    .values(PEOPLE.map(([username, displayName]) => ({ username, email: `${username}@example.com`, displayName, passwordHash: hash })))
    .returning()
  const [admin] = await db.select().from(schema.users).where(eq(schema.users.username, 'admin')).limit(1)
  const team = [admin, ...people].filter(Boolean)
  const [usersGroup, devGroup] = await Promise.all([
    db.select().from(schema.groups).where(eq(schema.groups.name, 'veqsio-users')).limit(1),
    db.select().from(schema.groups).where(eq(schema.groups.name, 'veqsio-developers')).limit(1),
  ])
  const memberships = people.flatMap((u, i) => [
    ...(usersGroup[0] ? [{ userId: u.id, groupId: usersGroup[0].id }] : []),
    ...(devGroup[0] && i % 3 !== 2 ? [{ userId: u.id, groupId: devGroup[0].id }] : []),
  ])
  if (memberships.length) await db.insert(schema.userGroups).values(memberships).onConflictDoNothing()

  // ---- reference data --------------------------------------------------------------------------
  const statuses = await db.select().from(schema.statuses)
  const st = (n: string) => statuses.find((s) => s.name === n)!.id
  const types = await db.select().from(schema.issueTypes)
  const typeId = (n: string) => types.find((t) => t.name === n)!.id
  const priorities = await db.select().from(schema.priorities)
  const prioId = (n: string) => priorities.find((p) => p.name === n)!.id
  const [fixed] = await db.select().from(schema.resolutions).where(eq(schema.resolutions.name, 'Fixed')).limit(1)
  const linkTypes = await db.select().from(schema.linkTypes)
  const labelRows = await db.insert(schema.labels).values(LABELS.map(([name, color]) => ({ name, color }))).onConflictDoNothing().returning()
  const allLabels = labelRows.length ? labelRows : await db.select().from(schema.labels)

  // ---- projects --------------------------------------------------------------------------------
  const projectRows = new Map<string, typeof demo>([['DEMO', demo]])
  await db.update(schema.projects).set({ description: PROJECTS[0].description, leadId: admin.id, isPublic: true }).where(eq(schema.projects.id, demo.id))
  const [adminRole] = await db.select().from(schema.projectRoles).limit(1)
  for (const spec of PROJECTS.slice(1)) {
    const [p] = await db.insert(schema.projects).values({
      projectKey: spec.key, name: spec.name, description: spec.description, category: spec.category, leadId: pick(team).id, isPublic: true,
    }).returning()
    projectRows.set(spec.key, p)
    // Reuse the schemes DEMO already has so permissions, workflow and fields behave the same.
    const [perm] = await db.select().from(schema.permissionSchemeAssociations).where(eq(schema.permissionSchemeAssociations.projectId, demo.id)).limit(1)
    if (perm) await db.insert(schema.permissionSchemeAssociations).values({ projectId: p.id, schemeId: perm.schemeId }).onConflictDoNothing()
    const [wf] = await db.select().from(schema.workflowSchemeAssociations).where(eq(schema.workflowSchemeAssociations.projectId, demo.id)).limit(1)
    if (wf) await db.insert(schema.workflowSchemeAssociations).values({ projectId: p.id, schemeId: wf.schemeId }).onConflictDoNothing()
    const [it] = await db.select().from(schema.issueTypeSchemeAssociations).where(eq(schema.issueTypeSchemeAssociations.projectId, demo.id)).limit(1)
    if (it) await db.insert(schema.issueTypeSchemeAssociations).values({ projectId: p.id, schemeId: it.schemeId }).onConflictDoNothing()
    const fcs = await db.select().from(schema.fieldConfigurationSchemeAssociations).where(eq(schema.fieldConfigurationSchemeAssociations.projectId, demo.id))
    if (fcs.length) await db.insert(schema.fieldConfigurationSchemeAssociations).values(fcs.map((r) => ({ projectId: p.id, issueTypeId: r.issueTypeId, configId: r.configId }))).onConflictDoNothing()
    if (adminRole) await db.insert(schema.projectRoleActors).values({ projectId: p.id, roleId: adminRole.id, userId: p.leadId!, groupId: null })
  }

  // ---- per project ---------------------------------------------------------------------------
  const summaryByKey: string[] = []
  let totalIssues = 0, totalComments = 0, totalWorklogs = 0

  for (const spec of PROJECTS) {
    const project = projectRows.get(spec.key)!
    const compRows = await db.insert(schema.components).values(spec.components.map((name) => ({ projectId: project.id, name, leadId: pick(team).id }))).returning()
    const versionRows = spec.versions.length
      ? await db.insert(schema.versions).values(spec.versions.map((v) => ({
          projectId: project.id, name: v.name, released: v.released,
          startDate: ago(v.start).toISOString().slice(0, 10), releaseDate: ago(v.release).toISOString().slice(0, 10),
        }))).returning()
      : []

    // Board, columns and sprints
    const [board] = await db.insert(schema.boards).values({ name: `${spec.key} board`, type: spec.board, projectId: project.id }).returning()
    await db.insert(schema.boardColumns).values([['To Do', 'Open'], ['In Progress', 'In Progress'], ['Done', 'Resolved']]
      .map(([name, status], i) => ({ boardId: board.id, statusId: st(status), name, sortOrder: i })))
    const sprints = spec.board === 'scrum'
      ? await db.insert(schema.sprints).values([
          { name: 'Sprint 10', goal: 'Stabilise the release branch', state: 'closed', startDate: ago(35), endDate: ago(21), completeDate: ago(21), boardId: board.id },
          { name: 'Sprint 11', goal: 'Performance and polish', state: 'closed', startDate: ago(21), endDate: ago(7), completeDate: ago(7), boardId: board.id },
          { name: 'Sprint 12', goal: 'Ship the headline features', state: 'active', startDate: ago(6), endDate: ago(-8), boardId: board.id },
          { name: 'Sprint 13', goal: null, state: 'future', boardId: board.id },
        ]).returning()
      : []

    // Epics first so children can point at them
    const epics: Array<{ id: number; key: string }> = []
    let n = 0
    const nextKey = () => `${spec.key}-${++n}`
    for (const title of spec.epics) {
      const key = nextKey()
      const [e] = await db.insert(schema.issues).values({
        issueKey: key, projectId: project.id, issueTypeId: typeId('Epic'), statusId: st('In Progress'), priorityId: prioId('High'),
        summary: title, description: 'Umbrella for the related stories and tasks.', assigneeId: pick(team).id, reporterId: admin.id,
        createdAt: ago(60), updatedAt: ago(2),
      }).returning()
      epics.push({ id: e.id, key })
      totalIssues++
    }

    const projectIssues: Array<{ id: number; key: string; resolved: boolean; type: Kind; createdDays: number }> = []
    const count = spec.items.length
    for (let i = 0; i < count; i++) {
      const t = spec.items[i]
      // Spread creation over ~75 days; older issues are more likely to be finished.
      const createdDays = Math.max(1, Math.round(75 - (i / count) * 72 + rnd() * 3))
      const roll = rnd()
      const age = createdDays / 75
      const status = roll < 0.18 + age * 0.45 ? (chance(0.5) ? 'Closed' : 'Resolved') : roll < 0.62 + age * 0.1 ? 'In Progress' : 'Open'
      const resolved = status === 'Resolved' || status === 'Closed'
      const resolvedDays = resolved ? Math.max(0, createdDays - 1 - Math.floor(rnd() * Math.min(14, createdDays))) : null
      const assignee = chance(0.88) ? pick(team) : null
      const reporter = pick(team)
      const priority = t.type === 'Bug' ? pick(['Highest', 'High', 'High', 'Medium', 'Medium', 'Low']) : pick(['High', 'Medium', 'Medium', 'Low', 'Lowest'])
      const key = nextKey()
      const epic = t.type !== 'Bug' && chance(0.55) ? pick(epics) : null
      const [issue] = await db.insert(schema.issues).values({
        issueKey: key, projectId: project.id, issueTypeId: typeId(t.type), statusId: st(status), priorityId: prioId(priority),
        resolutionId: resolved ? fixed?.id : null, summary: t.summary, description: pick(DESCRIPTIONS),
        assigneeId: assignee?.id ?? null, reporterId: reporter.id, parentId: epic?.id ?? null,
        storyPoints: t.type === 'Bug' && chance(0.5) ? null : String(pick(POINTS)),
        dueDate: !resolved && chance(0.3) ? ago(chance(0.35) ? 2 : -Math.ceil(rnd() * 20)) : null,
        backlogRank: i,
        createdAt: ago(createdDays), updatedAt: ago(resolvedDays ?? Math.floor(rnd() * Math.min(createdDays, 6))),
        resolvedAt: resolvedDays !== null ? ago(resolvedDays) : null,
      }).returning()
      totalIssues++
      projectIssues.push({ id: issue.id, key, resolved, type: t.type, createdDays })

      // Labels, components, versions, watchers
      const picked = new Set<number>()
      for (const l of allLabels) if (chance(0.14)) picked.add(l.id)
      if (picked.size) await db.insert(schema.issueLabels).values([...picked].map((labelId) => ({ issueId: issue.id, labelId })))
      await db.insert(schema.issueComponents).values({ issueId: issue.id, componentId: pick(compRows).id })
      if (versionRows.length && chance(0.6)) await db.insert(schema.issueFixVersions).values({ issueId: issue.id, versionId: pick(versionRows).id })
      if (chance(0.4)) await db.insert(schema.watchers).values({ issueId: issue.id, userId: pick(team).id }).onConflictDoNothing()

      // Status history (drives the activity feed and created-vs-resolved style charts)
      const history = [{ issueId: issue.id, fieldName: 'created', oldValue: null, newValue: key, authorId: reporter.id, createdAt: ago(createdDays) }]
      if (status !== 'Open') history.push({ issueId: issue.id, fieldName: 'status', oldValue: 'Open', newValue: 'In Progress', authorId: assignee?.id ?? reporter.id, createdAt: ago(Math.max(0, createdDays - 1)) })
      if (resolved) history.push({ issueId: issue.id, fieldName: 'status', oldValue: 'In Progress', newValue: status, authorId: assignee?.id ?? reporter.id, createdAt: ago(resolvedDays!) })
      await db.insert(schema.issueHistory).values(history)

      // Comments (some threaded)
      const commentCount = chance(0.25) ? 0 : 1 + Math.floor(rnd() * 3)
      let firstComment: number | null = null
      for (let c = 0; c < commentCount; c++) {
        const [row] = await db.insert(schema.comments).values({
          issueId: issue.id, body: pick(COMMENTS), authorId: pick(team).id,
          parentCommentId: c > 0 && chance(0.4) ? firstComment : null,
          createdAt: ago(Math.max(0, createdDays - 1 - c)),
        }).returning()
        if (c === 0) firstComment = row.id
        totalComments++
      }

      // Worklogs on work that was started
      if (status !== 'Open' && assignee) {
        const logs = 1 + Math.floor(rnd() * 3)
        let spent = 0
        for (let w = 0; w < logs; w++) {
          const seconds = pick([1800, 3600, 5400, 7200, 10800, 14400])
          spent += seconds
          await db.insert(schema.worklogs).values({
            issueId: issue.id, issueKey: key, authorId: assignee.id, authorName: assignee.displayName, authorEmail: assignee.email,
            description: pick(['Investigation', 'Implementation', 'Code review', 'Testing', 'Pairing']),
            timeSpentSeconds: seconds, started: ago(Math.max(0, createdDays - 1 - w), 9 + w),
          })
          totalWorklogs++
        }
        await db.update(schema.issues).set({ timeSpent: spent, timeEstimate: spent + (resolved ? 0 : 7200) }).where(eq(schema.issues.id, issue.id))
      }
    }

    // Sprints: closed ones get the older finished work, the active one the newest, the future one a few open items.
    if (sprints.length) {
      const [s10, s11, s12, s13] = sprints
      const finished = projectIssues.filter((x) => x.resolved)
      const open = projectIssues.filter((x) => !x.resolved)
      const rows: Array<{ sprintId: number; issueId: number; sortOrder: number; addedAt: Date }> = []
      finished.forEach((x, idx) => {
        const s = idx % 3 === 0 ? s10 : idx % 3 === 1 ? s11 : s12
        rows.push({ sprintId: s.id, issueId: x.id, sortOrder: idx, addedAt: s.startDate ?? ago(10) })
      })
      open.forEach((x, idx) => {
        const s = idx < Math.ceil(open.length * 0.55) ? s12 : idx < Math.ceil(open.length * 0.75) ? s13 : null
        if (s) rows.push({ sprintId: s.id, issueId: x.id, sortOrder: idx, addedAt: s.startDate ?? new Date() })
      })
      if (rows.length) await db.insert(schema.sprintIssues).values(rows).onConflictDoNothing()
    }

    // A few links between issues of the same project
    const linkable = projectIssues.slice(0, 12)
    for (let l = 0; l + 1 < linkable.length; l += 4) {
      const lt = pick(linkTypes)
      if (lt) await db.insert(schema.issueLinks).values({ issueId: linkable[l].id, linkedIssueId: linkable[l + 1].id, linkTypeId: lt.id })
    }

    await db.insert(schema.projectIssueCounters).values({ projectId: project.id, currentValue: n })
      .onConflictDoUpdate({ target: schema.projectIssueCounters.projectId, set: { currentValue: n } })
    summaryByKey.push(`${spec.key}: ${n} issues`)
  }

  // ---- saved filters and dashboards ------------------------------------------------------------
  await db.insert(schema.filters).values([
    { name: 'My open issues', jql: 'assignee = currentUser() AND resolution = Unresolved ORDER BY priority DESC', authorId: admin.id, favourite: true },
    { name: 'Critical bugs', jql: 'type = Bug AND priority in (Highest, High) AND resolution = Unresolved', authorId: admin.id, favourite: true },
    { name: 'Created this week', jql: 'created >= -7d ORDER BY created DESC', authorId: admin.id, favourite: false },
    { name: 'Overdue', jql: 'duedate < now() AND resolution = Unresolved ORDER BY duedate', authorId: admin.id, favourite: false },
    { name: 'DEMO: Sprint 12', jql: 'project = DEMO AND sprint = "Sprint 12" ORDER BY priority DESC', authorId: admin.id, favourite: false },
  ])

  const gadget = (dashboardId: number, gadgetType: string, columnIndex: number, rowIndex: number, config: Record<string, unknown> = {}) =>
    ({ dashboardId, gadgetType, columnIndex, rowIndex, config })
  const [overview] = await db.insert(schema.dashboards).values({ name: 'Team overview', ownerId: admin.id, description: 'Health of the whole workspace' }).returning()
  await db.insert(schema.dashboardGadgets).values([
    gadget(overview.id, 'pie-chart', 0, 0, { title: 'Issues by status' }),
    gadget(overview.id, 'created-vs-resolved', 1, 0, { title: 'Created vs resolved' }),
    gadget(overview.id, 'average-age', 0, 1, { title: 'Average age', period: 'weekly', count: 8 }),
    gadget(overview.id, 'resolution-time', 1, 1, { title: 'Resolution time', period: 'weekly', count: 8 }),
  ])
  const [mine] = await db.insert(schema.dashboards).values({ name: 'Priorities', ownerId: admin.id, description: 'Where the work is concentrated' }).returning()
  await db.insert(schema.dashboardGadgets).values([
    gadget(mine.id, 'pie-chart', 0, 0, { title: 'By priority', field: 'priority' }),
    gadget(mine.id, 'pie-chart', 1, 0, { title: 'By assignee', field: 'assignee' }),
  ])

  // Quick reminder of what was created; read the sign-in hint from here.
  console.log(`Demo data created: ${totalIssues} issues (${summaryByKey.join(', ')}), ${totalComments} comments, ${totalWorklogs} worklogs, ${people.length} extra users.`)
  console.log(`Sign in as admin, or as ${PEOPLE.map(([u]) => u).join(', ')} with password "${process.env.DEMO_PASSWORD || 'demo12345'}".`)
  await sql.end()
}

main().catch((e) => { console.error(e); process.exit(1) })
