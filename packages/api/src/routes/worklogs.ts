import { issueVisibleSql } from '../security/issue-security'
import { Hono, type Context } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { eq, desc, and, inArray } from 'drizzle-orm'
import { db } from '../db'
import { worklogs, issues } from '@veqsio/db'
import { createWorklog, updateWorklog, deleteWorklog, WorklogError } from '../services/worklogs'
import { requireAuth } from '../auth/middleware'
import { requireIssueAccess, checkProjectPermission, checkGlobalPermission } from '../middleware/permissions'
import { getBrowsableProjectIds } from '../services/browse'

const app = new Hono()

/**
 * Edit/delete rights: the author, a project administrator, or a holder of Edit All Worklogs / Delete All Worklogs
 * (for example a team lead who is not a project administrator). Anyone who cannot browse the project sees a 404.
 */
async function worklogAccess(c: any, existing: { issueId: number; authorId: number | null }, action: 'edit' | 'delete'): Promise<'ok' | 'notfound' | 'forbidden'> {
  const user = c.get('user') as { id: number; username: string } | undefined
  if (!user) return 'notfound'
  const [issue] = await db.select({ projectId: issues.projectId }).from(issues).where(eq(issues.id, existing.issueId)).limit(1)
  if (!issue) return 'notfound'
  if (!(await checkProjectPermission(user as any, issue.projectId, 'BROWSE_PROJECTS'))) return 'notfound'
  if (existing.authorId === user.id) return 'ok'
  if (await checkProjectPermission(user as any, issue.projectId, 'PROJECT_ADMIN')) return 'ok'
  if (await checkProjectPermission(user as any, issue.projectId, action === 'edit' ? 'EDIT_ALL_WORKLOGS' : 'DELETE_ALL_WORKLOGS')) return 'ok'
  return 'forbidden'
}

const createSchema = z.object({
  issueId: z.number().int(),
  issueKey: z.string().min(1),
  description: z.string().optional(),
  timeSpentSeconds: z.number().int().min(1),
  started: z.string().datetime().optional(),
})

const updateSchema = z.object({
  description: z.string().optional(),
  timeSpentSeconds: z.number().int().min(1).optional(),
  started: z.string().datetime().optional(),
})

// Helper: format seconds to Jira-style duration string
function formatDuration(seconds: number): string {
  const weeks = Math.floor(seconds / 144000)
  const days = Math.floor((seconds % 144000) / 28800)
  const hours = Math.floor((seconds % 28800) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const parts: string[] = []
  if (weeks > 0) parts.push(`${weeks}w`)
  if (days > 0) parts.push(`${days}d`)
  if (hours > 0) parts.push(`${hours}h`)
  if (minutes > 0) parts.push(`${minutes}m`)
  return parts.join(' ') || '0m'
}

// Parse Jira-style duration to seconds
function parseDuration(input: string): number | null {
  const regex = /^(?:(\d+)w)?\s*(?:(\d+)d)?\s*(?:(\d+)h)?\s*(?:(\d+)m)?\s*$/i
  const match = input.match(regex)
  if (!match) return null
  const [, w, d, h, m] = match
  let seconds = 0
  if (w) seconds += parseInt(w) * 144000
  if (d) seconds += parseInt(d) * 28800
  if (h) seconds += parseInt(h) * 3600
  if (m) seconds += parseInt(m) * 60
  return seconds || null
}

// List worklogs for an issue
app.get('/rest/api/2/issue/:key/worklog', requireAuth, requireIssueAccess(), async (c) => {
  const issueKey = c.req.param('key')
  const rows = await db.select().from(worklogs)
    .where(eq(worklogs.issueKey, issueKey))
    .orderBy(desc(worklogs.started))

  const totalSeconds = rows.reduce((sum, w) => sum + (w.timeSpentSeconds || 0), 0)

  return c.json({
    startAt: 0,
    maxResults: rows.length,
    total: rows.length,
    worklogs: rows.map((w) => ({
      id: w.id,
      issueId: w.issueId,
      issueKey: w.issueKey,
      author: {
        id: w.authorId,
        displayName: w.authorName,
        emailAddress: w.authorEmail,
      },
      comment: w.description,
      timeSpent: formatDuration(w.timeSpentSeconds),
      timeSpentSeconds: w.timeSpentSeconds,
      started: w.started ? new Date(w.started).toISOString() : null,
      created: w.createdAt ? new Date(w.createdAt).toISOString() : null,
      updated: w.updatedAt ? new Date(w.updatedAt).toISOString() : null,
    })),
    totalTimeSpentSeconds: totalSeconds,
    totalTimeSpent: formatDuration(totalSeconds),
  })
})

function serialize(wl: typeof worklogs.$inferSelect) {
  return {
    id: wl.id,
    issueId: wl.issueId,
    issueKey: wl.issueKey,
    author: { id: wl.authorId, displayName: wl.authorName, emailAddress: wl.authorEmail },
    comment: wl.description,
    timeSpent: formatDuration(wl.timeSpentSeconds),
    timeSpentSeconds: wl.timeSpentSeconds,
    started: wl.started ? new Date(wl.started).toISOString() : null,
    created: wl.createdAt ? new Date(wl.createdAt).toISOString() : null,
    updated: wl.updatedAt ? new Date(wl.updatedAt).toISOString() : null,
  }
}

function failure(c: Context, e: unknown) {
  if (e instanceof WorklogError) return c.json({ errorMessages: [e.message] }, e.status)
  throw e
}

// Create worklog for an issue. All writes go through services/worklogs (veto hooks, issue time-spent).
app.post('/rest/api/2/issue/:key/worklog', requireAuth, requireIssueAccess('WORK_ON_ISSUES'), zValidator('json', createSchema), async (c) => {
  const issueKey = c.req.param('key')
  const body = c.req.valid('json')
  const user = c.get('user') as { id: number; displayName?: string; email?: string } | undefined
  try {
    const wl = await createWorklog({
      issueKey, actor: user, description: body.description, timeSpentSeconds: body.timeSpentSeconds,
      started: body.started ? new Date(body.started) : undefined,
    })
    return c.json(serialize(wl), 201)
  } catch (e) { return failure(c, e) }
})

// Update worklog
app.put('/rest/api/2/worklog/:id', requireAuth, zValidator('json', updateSchema), async (c) => {
  const id = parseInt(c.req.param('id'))
  const body = c.req.valid('json')
  const user = c.get('user') as { id: number } | undefined
  const [existing] = await db.select().from(worklogs).where(eq(worklogs.id, id)).limit(1)
  if (!existing) return c.json({ errorMessages: ['Worklog not found'] }, 404)
  const access = await worklogAccess(c, existing, 'edit')
  if (access === 'notfound') return c.json({ errorMessages: ['Worklog not found'] }, 404)
  if (access === 'forbidden') return c.json({ errorMessages: ['Forbidden'] }, 403)
  try {
    const wl = await updateWorklog(id, user, {
      description: body.description, timeSpentSeconds: body.timeSpentSeconds,
      started: body.started ? new Date(body.started) : undefined,
    })
    return c.json(serialize(wl))
  } catch (e) { return failure(c, e) }
})

// Delete worklog
app.delete('/rest/api/2/worklog/:id', requireAuth, async (c) => {
  const id = parseInt(c.req.param('id'))
  const user = c.get('user') as { id: number } | undefined
  const [existing] = await db.select().from(worklogs).where(eq(worklogs.id, id)).limit(1)
  if (!existing) return c.json({ errorMessages: ['Worklog not found'] }, 404)
  const access = await worklogAccess(c, existing, 'delete')
  if (access === 'notfound') return c.json({ errorMessages: ['Worklog not found'] }, 404)
  if (access === 'forbidden') return c.json({ errorMessages: ['Forbidden'] }, 403)
  try {
    await deleteWorklog(id, user)
    return c.json({ success: true })
  } catch (e) { return failure(c, e) }
})

// Get worklogs by user (my worklogs)
app.get('/rest/api/2/worklog/user/:userId', requireAuth, async (c) => {
  const userId = parseInt(c.req.param('userId'))
  if (!Number.isInteger(userId)) return c.json({ errorMessages: ['Invalid user id'] }, 400)
  const viewer = c.get('user') as any
  // Someone else's time log only shows entries on issues the viewer can browse themselves.
  const browsable = await getBrowsableProjectIds(viewer)
  const rows = browsable.length === 0 ? [] : await db.select({ w: worklogs }).from(worklogs)
    .innerJoin(issues, eq(issues.id, worklogs.issueId))
    .where(and(eq(worklogs.authorId, userId), inArray(issues.projectId, browsable), issueVisibleSql(viewer.id)))
    .orderBy(desc(worklogs.started))
    .then((r) => r.map((x) => x.w))

  return c.json({
    startAt: 0,
    maxResults: rows.length,
    total: rows.length,
    worklogs: rows.map((w) => ({
      id: w.id,
      issueId: w.issueId,
      issueKey: w.issueKey,
      author: {
        id: w.authorId,
        displayName: w.authorName,
        emailAddress: w.authorEmail,
      },
      comment: w.description,
      timeSpent: formatDuration(w.timeSpentSeconds),
      timeSpentSeconds: w.timeSpentSeconds,
      started: w.started ? new Date(w.started).toISOString() : null,
      created: w.createdAt ? new Date(w.createdAt).toISOString() : null,
      updated: w.updatedAt ? new Date(w.updatedAt).toISOString() : null,
    })),
  })
})

export default app
