import { Hono } from 'hono'
import { and, asc, eq, inArray, isNotNull, or } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db'
import * as schema from '@veqsio/db'
import { requireAuth, type AppContext } from '../auth/middleware'
import { checkProjectPermission } from '../middleware/permissions'
import { invalidateIssueCache } from '../middleware/cache'
import { issueVisibleSql } from '../security/issue-security'
import { updateIssue } from '../issues/service'
import type { Category } from '../reports/agile'
import { reportCategory } from '../workflow/status-groups'
import { disabledFeatures, projectDisabledFeatures } from '../features'
import { milestoneProgress } from '../milestones/rules'
import { buildRoadmap, parseWindowDate, validateDates, type RoadmapIssue, type RoadmapLinkKind } from '../reports/roadmap'

const app = new Hono<AppContext>()
const notFound = (c: any) => c.json({ errorMessages: ['Not found'] }, 404)
const DAY = 86_400_000
const MAX_ISSUES = 10_000
const MAX_WINDOW_DAYS = 365 * 6

const toCategory = (c: string | null | undefined): Category => reportCategory(c)

app.get('/rest/agile/1.0/project/:key/roadmap', requireAuth, async (c) => {
  const key = c.req.param('key')
  const [project] = await db.select().from(schema.projects).where(eq(schema.projects.projectKey, key)).limit(1)
  if (!project || !(await checkProjectPermission(c.get('user'), project.id, 'BROWSE_PROJECTS'))) return notFound(c)

  const fromRaw = c.req.query('from')
  const toRaw = c.req.query('to')
  const from = parseWindowDate(fromRaw)
  const to = parseWindowDate(toRaw)
  if ((fromRaw && from === null) || (toRaw && to === null)) return c.json({ errorMessages: ['from/to must be dates (yyyy-mm-dd)'] }, 400)
  if (from !== null && to !== null && (to < from || (to - from) / DAY > MAX_WINDOW_DAYS)) {
    return c.json({ errorMessages: ['to must not be before from, and the window may span at most 6 years'] }, 400)
  }
  const includeOrphans = c.req.query('includeOrphans') === 'true'

  const rows = await db.select({
    issue: schema.issues, type: schema.issueTypes.name, subtask: schema.issueTypes.isSubtask,
    category: schema.statuses.category,
  })
    .from(schema.issues)
    .innerJoin(schema.issueTypes, eq(schema.issueTypes.id, schema.issues.issueTypeId))
    .innerJoin(schema.statuses, eq(schema.statuses.id, schema.issues.statusId))
    .where(and(eq(schema.issues.projectId, project.id), issueVisibleSql(c.get('user')!.id))).limit(MAX_ISSUES)

  const epicIds = new Set(rows.filter((r) => r.type.toLowerCase() === 'epic').map((r) => r.issue.id))
  // Only top-level candidates (epics, optional orphans) and their direct children matter.
  const relevant = rows.filter((r) =>
    epicIds.has(r.issue.id) || (r.issue.parentId !== null) ||
    (includeOrphans && !r.subtask))
  const candidateIds = relevant
    .filter((r) => epicIds.has(r.issue.id) || (includeOrphans && !r.subtask && (r.issue.parentId === null || !epicIds.has(r.issue.parentId))))
    .map((r) => r.issue.id)

  const [versionRows, history, fixRows, statusRows, linkRows] = await Promise.all([
    db.select().from(schema.versions).where(and(eq(schema.versions.projectId, project.id), eq(schema.versions.archived, false))).orderBy(asc(schema.versions.id)),
    candidateIds.length
      ? db.select().from(schema.issueHistory)
        .where(and(inArray(schema.issueHistory.issueId, candidateIds), eq(schema.issueHistory.fieldName, 'status')))
        .orderBy(asc(schema.issueHistory.createdAt))
      : Promise.resolve([]),
    candidateIds.length
      ? db.select().from(schema.issueFixVersions).where(inArray(schema.issueFixVersions.issueId, candidateIds))
      : Promise.resolve([]),
    db.select({ name: schema.statuses.name, category: schema.statuses.category }).from(schema.statuses),
    // The issue on the outward side ("blocks", "starts before", "finishes before") is the predecessor.
    db.select({ fromId: schema.issueLinks.linkedIssueId, toId: schema.issueLinks.issueId, name: schema.linkTypes.name, scheduling: schema.linkTypes.scheduling })
      .from(schema.issueLinks)
      .innerJoin(schema.linkTypes, eq(schema.linkTypes.id, schema.issueLinks.linkTypeId))
      .where(or(eq(schema.linkTypes.name, 'Blocks'), isNotNull(schema.linkTypes.scheduling))),
  ])

  const catByName = new Map(statusRows.map((s) => [s.name, toCategory(s.category)]))
  const firstProgress = new Map<number, number>()
  for (const h of history) {
    if (firstProgress.has(h.issueId) || !h.newValue || !h.createdAt) continue
    if (catByName.get(h.newValue) === 'in_progress') firstProgress.set(h.issueId, h.createdAt.getTime())
  }
  const fixByIssue = new Map<number, number[]>()
  for (const f of fixRows) fixByIssue.set(f.issueId, [...(fixByIssue.get(f.issueId) ?? []), f.versionId])

  const issues: RoadmapIssue[] = relevant.map((r) => ({
    id: r.issue.id, key: r.issue.issueKey, summary: r.issue.summary, issueType: r.type, category: toCategory(r.category),
    createdAt: r.issue.createdAt!.getTime(),
    startDate: r.issue.startDate?.getTime() ?? null,
    dueDate: r.issue.dueDate?.getTime() ?? null,
    parentId: r.issue.parentId, isEpic: epicIds.has(r.issue.id), isSubtask: !!r.subtask,
    storyPoints: r.issue.storyPoints === null ? null : Number(r.issue.storyPoints),
    firstInProgressAt: firstProgress.get(r.issue.id) ?? null,
    fixVersionIds: fixByIssue.get(r.issue.id) ?? [],
  }))

  const roadmap = buildRoadmap({
    issues,
    versions: versionRows.map((v) => ({ id: v.id, name: v.name, startDate: v.startDate, releaseDate: v.releaseDate, released: !!v.released })),
    links: linkRows.map((l) => ({ fromId: l.fromId, toId: l.toId, kind: (l.scheduling ?? 'blocks') as RoadmapLinkKind })),
    from, to, includeOrphans,
  })
  // Milestones with a target date are drawn as markers (feature switch `milestones`).
  const milestonesOn = !(await disabledFeatures()).has('milestones') && !(await projectDisabledFeatures(project.projectKey)).has('milestones')
  let milestones: Array<{ id: number; name: string; targetDate: string; state: string; percent: number; issueCount: number }> = []
  if (milestonesOn) {
    const ms = await db.select().from(schema.milestones).where(eq(schema.milestones.projectId, project.id)).orderBy(asc(schema.milestones.targetDate), asc(schema.milestones.id))
    const dated = ms.filter((m) => m.targetDate)
    const links = dated.length
      ? await db.select({ milestoneId: schema.milestoneIssues.milestoneId, category: schema.statuses.category })
        .from(schema.milestoneIssues)
        .innerJoin(schema.issues, eq(schema.issues.id, schema.milestoneIssues.issueId))
        .innerJoin(schema.statuses, eq(schema.statuses.id, schema.issues.statusId))
        .where(inArray(schema.milestoneIssues.milestoneId, dated.map((m) => m.id)))
      : []
    milestones = dated.map((m) => {
      const p = milestoneProgress(links.filter((l) => l.milestoneId === m.id))
      return { id: m.id, name: m.name, targetDate: m.targetDate!, state: m.state, percent: p.percentDone, issueCount: p.issueCount }
    })
  }
  return c.json({ project: { id: project.id, key: project.projectKey, name: project.name }, ...roadmap, milestones })
})

const dateOrNull = z.string().max(10).nullable()
const datesBody = z.object({ startDate: dateOrNull.optional(), dueDate: dateOrNull.optional() }).strict()
  .refine((b) => b.startDate !== undefined || b.dueDate !== undefined, { message: 'startDate or dueDate is required' })

app.put('/rest/agile/1.0/roadmap/issue/:key/dates', requireAuth, async (c) => {
  const user = c.get('user')!
  const [issue] = await db.select().from(schema.issues).where(eq(schema.issues.issueKey, c.req.param('key'))).limit(1)
  if (!issue || !(await checkProjectPermission(user, issue.projectId, 'BROWSE_PROJECTS'))) return notFound(c)
  if (!(await checkProjectPermission(user, issue.projectId, 'EDIT_ISSUES'))) {
    return c.json({ errorMessages: ['You do not have permission to edit this issue'] }, 403)
  }

  let parsed: z.infer<typeof datesBody>
  try {
    const result = datesBody.safeParse(await c.req.json())
    if (!result.success) return c.json({ errorMessages: result.error.issues.map((i) => i.message) }, 400)
    parsed = result.data
  } catch {
    return c.json({ errorMessages: ['Invalid JSON body'] }, 400)
  }

  const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null)
  const startDate = parsed.startDate !== undefined ? parsed.startDate : day(issue.startDate)
  const dueDate = parsed.dueDate !== undefined ? parsed.dueDate : day(issue.dueDate)
  const error = validateDates(startDate, dueDate)
  if (error) return c.json({ errorMessages: [error] }, 400)

  await updateIssue(issue.id, {
    ...(parsed.startDate !== undefined ? { startDate: parsed.startDate } : {}),
    ...(parsed.dueDate !== undefined ? { dueDate: parsed.dueDate } : {}),
  }, user.id)
  await invalidateIssueCache(issue.issueKey)
  return c.json({ key: issue.issueKey, startDate, dueDate })
})

export default app
