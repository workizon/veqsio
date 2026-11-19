import { Hono } from 'hono'
import { requireIssueAccess } from '../middleware/permissions'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { eq, and } from 'drizzle-orm'
import { db } from '../db'
import { applicationLinks, devCommits, devBranches, devPullRequests } from '@veqsio/db'
import { requireAuth } from '../auth/middleware'
import { requireGlobalPermission } from '../rbac/middleware'

const app = new Hono()

const createSchema = z.object({
  name: z.string().min(1).max(255),
  type: z.enum(['github', 'gitlab', 'bitbucket', 'confluence', 'bamboo', 'jenkins', 'custom']),
  baseUrl: z.string().url().max(500),
  displayUrl: z.string().url().max(500).optional(),
  authType: z.enum(['none', 'basic', 'bearer', 'oauth']).default('none'),
  credentials: z.record(z.any()).default({}),
  config: z.record(z.any()).default({}),
  isPrimary: z.boolean().default(false),
  active: z.boolean().default(true),
})

// List application links
app.get('/rest/api/2/applicationlink', requireAuth, async (c) => {
  const links = await db.select().from(applicationLinks).where(eq(applicationLinks.active, true))
  return c.json({
    startAt: 0,
    maxResults: links.length,
    total: links.length,
    isLast: true,
    values: links.map((l) => ({
      id: l.id,
      name: l.name,
      type: l.type,
      baseUrl: l.baseUrl,
      displayUrl: l.displayUrl,
      authType: l.authType,
      config: l.config,
      isPrimary: l.isPrimary,
      active: l.active,
      createdAt: l.createdAt,
    })),
  })
})

// Create application link (admin only)
app.post('/rest/api/2/applicationlink', requireAuth, requireGlobalPermission('ADMINISTER'), zValidator('json', createSchema), async (c) => {
  const body = c.req.valid('json')
  const [link] = await db.insert(applicationLinks).values({
    name: body.name,
    type: body.type,
    baseUrl: body.baseUrl,
    displayUrl: body.displayUrl,
    authType: body.authType,
    credentials: body.credentials,
    config: body.config,
    isPrimary: body.isPrimary,
    active: body.active,
  }).returning()
  return c.json({ id: link.id, ...body, createdAt: link.createdAt }, 201)
})

// Update application link
app.put('/rest/api/2/applicationlink/:id', requireAuth, requireGlobalPermission('ADMINISTER'), zValidator('json', createSchema.partial()), async (c) => {
  const id = parseInt(c.req.param('id'))
  const body = c.req.valid('json')
  const [link] = await db.update(applicationLinks).set({
    ...body,
    updatedAt: new Date(),
  }).where(eq(applicationLinks.id, id)).returning()
  if (!link) return c.json({ errorMessages: ['Link not found'] }, 404)
  return c.json(link)
})

// Delete application link
app.delete('/rest/api/2/applicationlink/:id', requireAuth, requireGlobalPermission('ADMINISTER'), async (c) => {
  const id = parseInt(c.req.param('id'))
  await db.delete(applicationLinks).where(eq(applicationLinks.id, id))
  return c.json({ success: true })
})

/* ------------------------------------------------------------------ */
/*  Development Data                                                    */
/* ------------------------------------------------------------------ */

// Get development data for an issue
app.get('/rest/api/2/issue/:key/dev', requireAuth, requireIssueAccess(), async (c) => {
  const issueKey = c.req.param('key')

  const [commits, branches, prs] = await Promise.all([
    db.select().from(devCommits).where(eq(devCommits.issueKey, issueKey)).orderBy(devCommits.committedAt),
    db.select().from(devBranches).where(eq(devBranches.issueKey, issueKey)).orderBy(devBranches.lastCommitAt),
    db.select().from(devPullRequests).where(eq(devPullRequests.issueKey, issueKey)).orderBy(devPullRequests.updatedAt),
  ])

  return c.json({
    commits: commits.map((c) => ({
      id: c.id,
      commitId: c.commitId,
      message: c.message,
      authorName: c.authorName,
      url: c.url,
      branch: c.branch,
      committedAt: c.committedAt,
    })),
    branches: branches.map((b) => ({
      id: b.id,
      name: b.name,
      isDefault: b.isDefault,
      aheadBy: b.aheadBy,
      behindBy: b.behindBy,
      lastCommitAt: b.lastCommitAt,
      url: b.url,
    })),
    pullRequests: prs.map((p) => ({
      id: p.id,
      prId: p.prId,
      title: p.title,
      authorName: p.authorName,
      status: p.status,
      sourceBranch: p.sourceBranch,
      targetBranch: p.targetBranch,
      url: p.url,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    })),
  })
})

// Create dev commit (admin/internal)
app.post('/rest/api/2/dev/commits', requireAuth, requireGlobalPermission('ADMINISTER'), async (c) => {
  const body = await c.req.json()
  const [commit] = await db.insert(devCommits).values({
    applicationLinkId: body.applicationLinkId,
    issueKey: body.issueKey,
    commitId: body.commitId,
    message: body.message,
    authorName: body.authorName,
    authorEmail: body.authorEmail,
    url: body.url,
    branch: body.branch,
    committedAt: body.committedAt ? new Date(body.committedAt) : new Date(),
  }).returning()
  return c.json(commit, 201)
})

// Create dev branch (admin/internal)
app.post('/rest/api/2/dev/branches', requireAuth, requireGlobalPermission('ADMINISTER'), async (c) => {
  const body = await c.req.json()
  const [branch] = await db.insert(devBranches).values({
    applicationLinkId: body.applicationLinkId,
    issueKey: body.issueKey,
    name: body.name,
    isDefault: body.isDefault ?? false,
    aheadBy: body.aheadBy ?? 0,
    behindBy: body.behindBy ?? 0,
    lastCommitAt: body.lastCommitAt ? new Date(body.lastCommitAt) : new Date(),
    url: body.url,
  }).returning()
  return c.json(branch, 201)
})

// Create dev PR (admin/internal)
app.post('/rest/api/2/dev/pull-requests', requireAuth, requireGlobalPermission('ADMINISTER'), async (c) => {
  const body = await c.req.json()
  const [pr] = await db.insert(devPullRequests).values({
    applicationLinkId: body.applicationLinkId,
    issueKey: body.issueKey,
    prId: body.prId,
    title: body.title,
    authorName: body.authorName,
    status: body.status,
    sourceBranch: body.sourceBranch,
    targetBranch: body.targetBranch,
    url: body.url,
  }).returning()
  return c.json(pr, 201)
})

// Sync development data from GitHub
app.post('/rest/api/2/dev/sync/:linkId', requireAuth, requireGlobalPermission('ADMINISTER'), async (c) => {
  const linkId = parseInt(c.req.param('linkId'))
  const link = await db.select().from(applicationLinks).where(eq(applicationLinks.id, linkId)).limit(1)
  if (!link.length) return c.json({ errorMessages: ['Application link not found'] }, 404)

  const config = link[0].config as any
  const credentials = link[0].credentials as any

  if (link[0].type === 'github' && config?.owner && config?.repo) {
    const token = credentials?.token
    const headers: Record<string, string> = { Accept: 'application/vnd.github+json' }
    if (token) headers['Authorization'] = `Bearer ${token}`

    // Fetch commits mentioning issue keys
    const commitsRes = await fetch(
      `https://api.github.com/repos/${config.owner}/${config.repo}/commits?per_page=50`,
      { headers }
    )
    if (commitsRes.ok) {
      const commits = await commitsRes.json()
      const issueKeyPattern = /[A-Z]+-\d+/g
      for (const commit of commits) {
        const message = commit.commit?.message || ''
        const keys: string[] = [...new Set<string>(message.match(issueKeyPattern) || [])]
        for (const issueKey of keys) {
          const existing = await db.select().from(devCommits).where(
            and(eq(devCommits.applicationLinkId, linkId), eq(devCommits.commitId, commit.sha))
          ).limit(1)
          if (existing.length === 0) {
            await db.insert(devCommits).values({
              applicationLinkId: linkId,
              issueKey,
              commitId: commit.sha,
              message,
              authorName: commit.commit?.author?.name,
              authorEmail: commit.commit?.author?.email,
              url: commit.html_url,
              committedAt: commit.commit?.author?.date ? new Date(commit.commit.author.date) : undefined,
            })
          }
        }
      }
    }

    // Fetch pull requests
    const prsRes = await fetch(
      `https://api.github.com/repos/${config.owner}/${config.repo}/pulls?state=all&per_page=50`,
      { headers }
    )
    if (prsRes.ok) {
      const prs = await prsRes.json()
      for (const pr of prs) {
        const title = pr.title || ''
        const bodyText = pr.body || ''
        const keys = [...new Set([...(title.match(/[A-Z]+-\d+/g) || []), ...(bodyText.match(/[A-Z]+-\d+/g) || [])])]
        for (const issueKey of keys) {
          const existing = await db.select().from(devPullRequests).where(
            and(eq(devPullRequests.applicationLinkId, linkId), eq(devPullRequests.prId, String(pr.number)))
          ).limit(1)
          if (existing.length === 0) {
            await db.insert(devPullRequests).values({
              applicationLinkId: linkId,
              issueKey,
              prId: String(pr.number),
              title: pr.title,
              authorName: pr.user?.login,
              status: pr.state === 'closed' ? (pr.merged ? 'merged' : 'closed') : 'open',
              sourceBranch: pr.head?.ref,
              targetBranch: pr.base?.ref,
              url: pr.html_url,
            })
          }
        }
      }
    }
  }

  return c.json({ success: true })
})

export default app
