/**
 * The `ctx.core` facade handed to modules (see CoreServices in @veqsio/sdk). Keeps modules away from core internals:
 * a module asks for "the role of this user on this desk" or "start this approval", the host does it with the real
 * services, so rules such as separation of duties and permission checks stay in one place.
 */
import { and, eq } from 'drizzle-orm'
import * as schema from '@veqsio/db'
import type { CoreServices, ModuleNotice } from '@veqsio/sdk'
import { db } from '../db'
import { getDeskRole, isStaff } from '../servicedesk/service'
import { queueEmails } from '../services/email'
import { deliverWebhook, ALL_EVENTS, type WebhookEvent } from '../services/webhooks'
import { createApproval } from '../approvals/service'
import { createIssue, getIssue, invalidateIssueKeyCache } from '../issues/service'
import { invalidateIssueCache } from '../middleware/cache'
import { publishIssue } from '../realtime/publish'
import { doTransition } from '../workflow/engine'

const webUrl = () => (process.env.WEB_URL || 'http://localhost:3001').replace(/\/+$/, '')

async function loadUser(userId: number) {
  const [u] = await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1)
  return u ?? null
}

export const coreServices: CoreServices = {
  async deskRole(userId, deskId) {
    const [user, desk] = await Promise.all([
      loadUser(userId),
      db.select().from(schema.serviceDesks).where(eq(schema.serviceDesks.id, deskId)).limit(1).then((r) => r[0]),
    ])
    if (!user || !desk) return 'none'
    return getDeskRole(user, desk)
  },

  async staffDeskIds(userId) {
    const user = await loadUser(userId)
    if (!user) return []
    const desks = await db.select().from(schema.serviceDesks)
    const out: number[] = []
    for (const d of desks) if (isStaff(await getDeskRole(user, d))) out.push(d.id)
    return out
  },

  async queueNotice(tos: string[], n: ModuleNotice) {
    const unique = [...new Set(tos.map((t) => t.trim()).filter((t) => /^[^\s@<>,;]+@[^\s@<>,;]+$/.test(t)))]
    if (!unique.length) return
    await queueEmails(unique, 'module-notice', { ...n })
  },

  async emitEvent(event, payload) {
    if (!(ALL_EVENTS as string[]).includes(event)) return
    // Webhook delivery retries with back-off for up to ~30 s: never make the caller's request wait for it.
    void deliverWebhook(event as WebhookEvent, payload).catch((e) => console.error('[modules] webhook delivery failed', e))
  },

  async requestApproval({ issueId, userId, templateName }) {
    const [issue] = await db.select({ projectId: schema.issues.projectId }).from(schema.issues).where(eq(schema.issues.id, issueId)).limit(1)
    if (!issue) throw new Error('Issue not found')
    const [tpl] = await db.select().from(schema.approvalTemplates)
      .where(and(eq(schema.approvalTemplates.projectId, issue.projectId), eq(schema.approvalTemplates.name, templateName))).limit(1)
    if (!tpl) throw new Error(`Approval template '${templateName}' does not exist in this project`)
    const r = await db.transaction((tx) => createApproval(tx, { issueId, createdBy: userId, template: tpl, onDuplicate: 'skip' }))
    for (const fn of r.after) { try { await fn() } catch (e) { console.error('[modules] approval after-commit failed', e) } }
    return r.approval ? { approvalId: r.approval.id } : null
  },

  async createIssue(p, userId) {
    const issue = await createIssue({
      projectId: p.projectId, issueTypeId: p.issueTypeId, summary: p.summary,
      ...(p.description ? { description: p.description } : {}),
      ...(p.priorityId ? { priorityId: p.priorityId } : {}),
      ...(p.assigneeId ? { assigneeId: p.assigneeId } : {}),
    } as never, userId)
    const [row] = await db.select({ id: schema.issues.id }).from(schema.issues).where(eq(schema.issues.issueKey, issue.key)).limit(1)
    return { id: row.id, key: issue.key }
  },

  async transition({ issueId, transitionId, userId, comment }) {
    await doTransition(issueId, transitionId, userId, {}, comment ? { comment } : {})
    // Same follow-ups as the REST transition route: caches, realtime and automation.
    const issue = await getIssue(issueId)
    if (issue) {
      await coreServices.invalidateIssue(issue.key)
      publishIssue('issue.transitioned', issue, userId)
      const { emitIssueTransitioned } = await import('../services/automation-engine')
      await emitIssueTransitioned(issue.id, userId, transitionId)
    }
  },

  async invalidateIssue(issueKey) {
    await invalidateIssueKeyCache(issueKey)
    await invalidateIssueCache(issueKey)
  },

  webUrl,
}

