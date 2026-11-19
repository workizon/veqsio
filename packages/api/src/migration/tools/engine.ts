import { and, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../../db'
import * as schema from '@veqsio/db'
import { generateIssueKey } from '../../issues/key-generator'
import { Resolver } from '../resolver'
import type { NormalizedUser } from '../rest/mapper'
import {
  UnsupportedCollector,
  type LinkKind, type ToolIssue, type ToolItem, type ToolProject, type ToolSourceId, type ToolUser,
} from './model'

/**
 * Writes the neutral import stream to Veqsio, or only counts it (dry run).
 *
 * Idempotency: every imported project, issue, comment and sprint is recorded in migration_external_refs
 * (source, entity type, external id) -> Veqsio row. Running the same import again updates the rows found there
 * (onExisting = 'update', the default) or leaves them alone ('skip'); it never creates duplicates.
 */

export interface EngineOptions {
  source: ToolSourceId
  dryRun?: boolean
  /** What to do with issues imported before: update their fields (default) or skip them. */
  onExisting?: 'update' | 'skip'
  /** Map source e-mails/usernames to existing Veqsio usernames. */
  userMapping?: Record<string, string>
  /** Create placeholder users (no password, e-mail kept) for people that do not exist yet (default true). */
  createMissingUsers?: boolean
  /** Source container id -> Veqsio project key chosen by the admin. An existing project with that key is merged into. */
  projectKeys?: Record<string, string>
  includeComments?: boolean
  /** Static "never imported" list of the source, reported once as a warning. */
  staticUnsupported?: string[]
}

export interface EngineHooks {
  sessionId?: number | null
  onProgress?: (p: { processed: number; total: number; message: string; errors: string[] }) => void | Promise<void>
  isCancelled?: () => boolean | Promise<boolean>
}

export interface ProjectStats {
  id: string
  name: string
  /** Final key (or the key that would be used for a dry run). */
  key: string
  /** Project exists already (re-run or merge) vs. created. */
  existed: boolean
  issues: number
  created: number
  updated: number
  skipped: number
  failed: number
  comments: number
  links: number
  sprints: number
  columns: number
}

export interface ToolReport {
  source: ToolSourceId
  dryRun: boolean
  cancelled: boolean
  projects: ProjectStats[]
  totals: { projects: number; issues: number; created: number; updated: number; skipped: number; failed: number; comments: number; links: number; subtasks: number; sprints: number }
  users: { matched: number; created: number; unmatched: number; sample: Array<{ name: string | null; email: string | null; action: 'matched' | 'create' | 'created' | 'unassigned' }> }
  newValues: { statuses: string[]; issueTypes: string[]; priorities: string[]; labels: string[] }
  /** Source data that exists but cannot be represented in Veqsio: field -> number of items. */
  unsupported: Record<string, number>
  warnings: string[]
  errors: string[]
}

const MAX_MESSAGES = 500
const MAX_SAMPLE = 200

export function sanitizeKey(raw: string, max = 20): string {
  let k = raw.toUpperCase().replace(/[^A-Z0-9_]/g, '')
  if (!k) k = 'PRJ'
  if (!/^[A-Z]/.test(k)) k = `P${k}`
  return k.slice(0, max)
}

/** "Website Redesign" -> WR, "Marketing" -> MARK. */
export function deriveKey(name: string): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean)
  if (words.length >= 2) return sanitizeKey(words.map((w) => w[0]).join('').slice(0, 5), 10)
  return sanitizeKey((words[0] ?? 'PRJ').slice(0, 4), 10)
}

/** Labels cannot contain spaces (same rule as the Jira CSV importer). */
const cleanLabel = (l: string) => l.trim().replace(/\s+/g, '-').slice(0, 100)

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '').slice(0, 100) || 'user'

export function toNormalizedUser(source: ToolSourceId, u: ToolUser | null | undefined): (NormalizedUser & { placeholder: boolean }) | null {
  if (!u) return null
  const email = u.email?.trim().toLowerCase()
  const name = u.name?.trim()
  if (!email && !name && !u.externalId) return null
  if (email && email.includes('@')) {
    return { username: email.split('@')[0].slice(0, 200), email: email.slice(0, 255), displayName: (name || email.split('@')[0]).slice(0, 255), placeholder: false }
  }
  const id = slug(u.externalId ? String(u.externalId) : name || 'user')
  const base = slug(name || id)
  return { username: `${source}-${base}`.slice(0, 200), email: `${source}-${id}@migrated.invalid`.slice(0, 255), displayName: (name || id).slice(0, 255), placeholder: true }
}

const LINK_TYPES: Record<LinkKind, { name: string; inward: string; outward: string }> = {
  Blocks: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
  Duplicate: { name: 'Duplicate', inward: 'is duplicated by', outward: 'duplicates' },
  Relates: { name: 'Relates', inward: 'relates to', outward: 'relates to' },
}

export function emptyReport(source: ToolSourceId, dryRun: boolean): ToolReport {
  return {
    source, dryRun, cancelled: false, projects: [],
    totals: { projects: 0, issues: 0, created: 0, updated: 0, skipped: 0, failed: 0, comments: 0, links: 0, subtasks: 0, sprints: 0 },
    users: { matched: 0, created: 0, unmatched: 0, sample: [] },
    newValues: { statuses: [], issueTypes: [], priorities: [], labels: [] },
    unsupported: {}, warnings: [], errors: [],
  }
}

interface ProjState { stats: ProjectStats; localId: number; boardId: number | null; sprintLocal: Map<string, number> }

export async function runToolImport(
  items: AsyncIterable<ToolItem>, unsupported: UnsupportedCollector, opts: EngineOptions, actingUserId: number, hooks: EngineHooks = {},
): Promise<ToolReport> {
  const dryRun = !!opts.dryRun
  const source = opts.source
  const report = emptyReport(source, dryRun)
  const resolver = new Resolver(db, { userMapping: opts.userMapping, createMissingUsers: opts.createMissingUsers })
  const createMissing = opts.createMissingUsers !== false
  const warnSet = new Set<string>()
  const warn = (m: string) => { if (!warnSet.has(m) && report.warnings.length < MAX_MESSAGES) { warnSet.add(m); report.warnings.push(m) } }
  const err = (m: string) => { if (report.errors.length < MAX_MESSAGES) report.errors.push(m.slice(0, 400)) }

  // --- reference data known to Veqsio (for "new values" in the preview) ---
  const lc = (s: string) => s.toLowerCase()
  const [stRows, tyRows, prRows, lbRows] = await Promise.all([
    db.select({ n: schema.statuses.name }).from(schema.statuses),
    db.select({ n: schema.issueTypes.name }).from(schema.issueTypes),
    db.select({ n: schema.priorities.name }).from(schema.priorities),
    db.select({ n: schema.labels.name }).from(schema.labels),
  ])
  const known = { statuses: new Set(stRows.map((r) => lc(r.n))), issueTypes: new Set(tyRows.map((r) => lc(r.n))), priorities: new Set(prRows.map((r) => lc(r.n))), labels: new Set(lbRows.map((r) => lc(r.n))) }
  const noteNew = (kind: keyof typeof known, name: string | null | undefined) => {
    if (!name) return
    const k = lc(name)
    if (!known[kind].has(k)) { known[kind].add(k); report.newValues[kind].push(name) }
  }

  // --- external reference helpers ---
  const getRef = async (type: string, externalId: string): Promise<number | null> => {
    const [r] = await db.select({ localId: schema.migrationExternalRefs.localId }).from(schema.migrationExternalRefs)
      .where(and(eq(schema.migrationExternalRefs.source, source), eq(schema.migrationExternalRefs.entityType, type), eq(schema.migrationExternalRefs.externalId, externalId))).limit(1)
    return r?.localId ?? null
  }
  const setRef = async (type: string, externalId: string, localId: number, externalKey?: string | null) => {
    await db.insert(schema.migrationExternalRefs).values({
      source, entityType: type, externalId, localId, externalKey: externalKey?.slice(0, 255) ?? null, sessionId: hooks.sessionId ?? null,
    }).onConflictDoUpdate({
      target: [schema.migrationExternalRefs.source, schema.migrationExternalRefs.entityType, schema.migrationExternalRefs.externalId],
      set: { localId, externalKey: externalKey?.slice(0, 255) ?? null, sessionId: hooks.sessionId ?? null, updatedAt: new Date() },
    })
  }

  // --- user matching ---
  const userSeen = new Map<string, 'matched' | 'created' | 'unassigned'>()
  const user = async (u: ToolUser | null | undefined): Promise<number | null> => {
    const nu = toNormalizedUser(source, u)
    if (!nu) return null
    if (!userSeen.has(nu.email)) {
      const found = await resolver.findUser(nu)
      const outcome = found !== null ? 'matched' : createMissing ? 'created' : 'unassigned'
      userSeen.set(nu.email, outcome)
      if (outcome === 'matched') report.users.matched++
      else if (outcome === 'created') report.users.created++
      else report.users.unmatched++
      if (report.users.sample.length < MAX_SAMPLE && outcome !== 'matched') {
        report.users.sample.push({ name: nu.displayName, email: nu.placeholder ? null : nu.email, action: outcome === 'created' ? (dryRun ? 'create' : 'created') : 'unassigned' })
      }
    }
    return dryRun ? null : resolver.user(nu)
  }

  // --- project keys ---
  const takenKeys = new Set<string>()
  const keyExists = async (key: string) => {
    if (takenKeys.has(key)) return true
    const [r] = await db.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.projectKey, key)).limit(1)
    return !!r
  }
  const allocateKey = async (p: ToolProject): Promise<{ key: string; merge: boolean }> => {
    const override = opts.projectKeys?.[p.id]
    if (override) {
      const key = sanitizeKey(override)
      takenKeys.add(key)
      return { key, merge: true }
    }
    const base = sanitizeKey(p.suggestedKey || deriveKey(p.name), 10)
    let key = base
    for (let n = 2; await keyExists(key); n++) key = `${base.slice(0, 10 - String(n).length)}${n}`
    takenKeys.add(key)
    return { key, merge: false }
  }

  const projects = new Map<string, ProjState>()
  const issueLocal = new Map<string, number>() // external issue id -> Veqsio id (this run)
  const seenIssues = new Set<string>()
  const parents: Array<{ child: number; parentExt: string; childExt: string }> = []
  const links: Array<{ from: number; toExt: string; kind: LinkKind; fromExt: string; proj: ProjState }> = []
  const dryIssueIds = new Set<string>()
  const dryLinks = new Set<string>()
  let processed = 0
  let total = 0

  const upsertProject = async (p: ToolProject): Promise<void> => {
    if (projects.has(p.id)) return
    let localId = 0
    let key = ''
    let existed = false
    const refId = await getRef('project', p.id)
    if (refId) {
      const [row] = await db.select().from(schema.projects).where(eq(schema.projects.id, refId)).limit(1)
      if (row) { localId = row.id; key = row.projectKey; existed = true; takenKeys.add(key) }
    }
    if (!existed) {
      const a = await allocateKey(p)
      key = a.key
      const [clash] = await db.select().from(schema.projects).where(eq(schema.projects.projectKey, key)).limit(1)
      if (clash) {
        existed = true; localId = clash.id
        warn(`${key}: a project with this key already exists; "${p.name}" will be merged into it`)
      } else if (!dryRun) {
        const lead = await user(p.lead)
        const [row] = await db.insert(schema.projects).values({
          projectKey: key, name: p.name.slice(0, 255), description: p.description ?? null, leadId: lead ?? actingUserId,
        }).returning()
        localId = row.id
        await db.insert(schema.projectIssueCounters).values({ projectId: localId, currentValue: 0 }).onConflictDoNothing()
        warn(`${key}: project created; assign permission and notification schemes in project settings`)
      }
    } else if (!dryRun && p.description) {
      await db.update(schema.projects).set({ description: p.description }).where(and(eq(schema.projects.id, localId), sql`${schema.projects.description} is null`))
    }
    if (!dryRun && localId) await setRef('project', p.id, localId, key)

    const st: ProjState = {
      localId, boardId: null, sprintLocal: new Map(),
      stats: { id: p.id, name: p.name, key, existed, issues: 0, created: 0, updated: 0, skipped: 0, failed: 0, comments: 0, links: 0, sprints: 0, columns: 0 },
    }
    projects.set(p.id, st)
    report.projects.push(st.stats)
    report.totals.projects++

    for (const s of p.statuses) noteNew('statuses', s.name)
    for (const c of p.components) if (!dryRun) await resolver.component(localId, c.slice(0, 255))

    // Board with one column per status, plus sprints/cycles.
    if (dryRun) { st.stats.columns = p.statuses.length; st.stats.sprints = p.sprints.length; report.totals.sprints += p.sprints.length; return }
    if (p.statuses.length || p.sprints.length) {
      const boardName = `${p.name} board`.slice(0, 255)
      let [board] = await db.select().from(schema.boards).where(and(eq(schema.boards.projectId, localId), eq(schema.boards.name, boardName))).limit(1)
      if (!board) {
        ;[board] = await db.insert(schema.boards).values({ name: boardName, type: p.sprints.length ? 'scrum' : 'kanban', projectId: localId, config: {} }).returning()
      }
      st.boardId = board.id
      const cols = await db.select().from(schema.boardColumns).where(eq(schema.boardColumns.boardId, board.id))
      const haveStatus = new Set(cols.map((c) => c.statusId))
      let order = cols.reduce((m, c) => Math.max(m, c.sortOrder ?? 0), -1) + 1
      const seen = new Set<string>()
      for (const s of p.statuses) {
        if (seen.has(lc(s.name))) continue
        seen.add(lc(s.name))
        const statusId = await resolver.status(s.name.slice(0, 100), s.category)
        if (haveStatus.has(statusId)) continue
        await db.insert(schema.boardColumns).values({ boardId: board.id, statusId, name: s.name.slice(0, 100), sortOrder: order++ })
        haveStatus.add(statusId)
        st.stats.columns++
      }
      for (const sp of p.sprints) {
        const dates = { state: sp.state, goal: sp.goal ?? null, startDate: sp.startDate ?? null, endDate: sp.endDate ?? null, completeDate: sp.completeDate ?? null }
        let sprintId = await getRef('sprint', sp.id)
        if (sprintId) {
          const [ex] = await db.select({ id: schema.sprints.id }).from(schema.sprints).where(eq(schema.sprints.id, sprintId)).limit(1)
          if (!ex) sprintId = null
        }
        if (sprintId) {
          await db.update(schema.sprints).set({ name: sp.name.slice(0, 255), ...dates }).where(eq(schema.sprints.id, sprintId))
        } else {
          const [row] = await db.insert(schema.sprints).values({ name: sp.name.slice(0, 255), boardId: board.id, ...dates }).returning({ id: schema.sprints.id })
          sprintId = row.id
          st.stats.sprints++
          report.totals.sprints++
        }
        await setRef('sprint', sp.id, sprintId, sp.name)
        st.sprintLocal.set(sp.id, sprintId)
      }
    }
  }

  const processIssue = async (i: ToolIssue): Promise<void> => {
    const proj = projects.get(i.projectId)
    if (!proj) throw new Error(`${i.identifier ?? i.id}: unknown project ${i.projectId}`)
    if (seenIssues.has(i.id)) { warn('Some issues appear in more than one project/list in the source; they are imported once (first occurrence)'); return }
    seenIssues.add(i.id)
    const stats = proj.stats
    stats.issues++
    report.totals.issues++
    if (i.parentId) report.totals.subtasks++

    let existingId: number | null = null
    const refId = await getRef('issue', i.id)
    if (refId) {
      const [ex] = await db.select({ id: schema.issues.id }).from(schema.issues).where(eq(schema.issues.id, refId)).limit(1)
      existingId = ex?.id ?? null
    }
    const typeName = i.type || (i.isSubtask || i.parentId ? 'Sub-task' : 'Task')
    noteNew('issueTypes', typeName)
    noteNew('statuses', i.status.name)
    noteNew('priorities', i.priority)
    for (const l of i.labels) noteNew('labels', cleanLabel(l))
    // Resolve people first so the preview counts them exactly like a real run.
    const [assigneeId, creatorId] = await Promise.all([user(i.assignee), user(i.creator)])
    if (opts.includeComments !== false) for (const c of i.comments) await user(c.author)

    if (existingId && opts.onExisting === 'skip') {
      stats.skipped++; report.totals.skipped++
      issueLocal.set(i.id, existingId)
      return
    }
    const commentCount = opts.includeComments === false ? 0 : i.comments.length
    if (dryRun) {
      if (existingId) { stats.updated++; report.totals.updated++ } else { stats.created++; report.totals.created++ }
      stats.comments += commentCount; report.totals.comments += commentCount
      dryIssueIds.add(i.id)
      if (i.parentId) parents.push({ child: 0, parentExt: i.parentId, childExt: i.id })
      for (const l of i.links) links.push({ from: 0, toExt: l.targetId, kind: l.kind, fromExt: i.id, proj })
      return
    }

    const done = i.status.category === 'done'
    const now = new Date()
    const [typeId, statusId, priorityId, resolutionId] = await Promise.all([
      resolver.issueType(typeName.slice(0, 100), !!i.isSubtask),
      resolver.status(i.status.name.slice(0, 100), i.status.category),
      i.priority ? resolver.priority(i.priority) : Promise.resolve(null),
      done && i.resolution ? resolver.resolution(i.resolution) : Promise.resolve(null),
    ])
    let summary = i.title.trim() || '(no title)'
    if (summary.length > 500) { summary = summary.slice(0, 500); warn('Some titles were longer than 500 characters and were truncated') }
    const values = {
      projectId: proj.localId, issueTypeId: typeId, statusId, priorityId, resolutionId, summary, description: i.description ?? null,
      assigneeId, reporterId: creatorId ?? actingUserId,
      createdAt: i.createdAt ?? now, updatedAt: i.updatedAt ?? i.createdAt ?? now,
      resolvedAt: done ? (i.resolvedAt ?? i.updatedAt ?? now) : null,
      dueDate: i.dueDate ?? null, startDate: i.startDate ?? null,
      timeEstimate: i.timeEstimateSeconds ?? null, timeSpent: i.timeSpentSeconds ?? null,
      storyPoints: i.storyPoints === null || i.storyPoints === undefined ? null : Math.max(0, Math.min(1000, i.storyPoints)).toFixed(2),
    }
    let issueId: number
    if (existingId) {
      await db.update(schema.issues).set(values).where(eq(schema.issues.id, existingId))
      issueId = existingId
      await db.delete(schema.issueLabels).where(eq(schema.issueLabels.issueId, issueId))
      await db.delete(schema.issueComponents).where(eq(schema.issueComponents.issueId, issueId))
      stats.updated++; report.totals.updated++
    } else {
      let key: string
      for (;;) {
        key = await generateIssueKey(proj.localId, proj.stats.key)
        const [clash] = await db.select({ id: schema.issues.id }).from(schema.issues).where(eq(schema.issues.issueKey, key)).limit(1)
        if (!clash) break
      }
      const [row] = await db.insert(schema.issues).values({ ...values, issueKey: key }).returning({ id: schema.issues.id })
      issueId = row.id
      stats.created++; report.totals.created++
    }
    await setRef('issue', i.id, issueId, i.identifier ?? null)
    issueLocal.set(i.id, issueId)

    for (const l of new Set(i.labels.map(cleanLabel).filter(Boolean))) {
      await db.insert(schema.issueLabels).values({ issueId, labelId: await resolver.label(l) }).onConflictDoNothing()
    }
    for (const c of new Set(i.components.map((x) => x.trim().slice(0, 255)).filter(Boolean))) {
      await db.insert(schema.issueComponents).values({ issueId, componentId: await resolver.component(proj.localId, c) }).onConflictDoNothing()
    }
    if (i.sprintId && proj.sprintLocal.has(i.sprintId) && proj.boardId) {
      const boardSprints = await db.select({ id: schema.sprints.id }).from(schema.sprints).where(eq(schema.sprints.boardId, proj.boardId))
      if (boardSprints.length) await db.delete(schema.sprintIssues).where(and(eq(schema.sprintIssues.issueId, issueId), inArray(schema.sprintIssues.sprintId, boardSprints.map((s) => s.id))))
      await db.insert(schema.sprintIssues).values({ sprintId: proj.sprintLocal.get(i.sprintId)!, issueId }).onConflictDoNothing()
    }
    if (opts.includeComments !== false) {
      for (const c of i.comments) {
        const authorId = (await user(c.author)) ?? actingUserId
        const body = c.body || '(empty comment)'
        let commentId = await getRef('comment', c.id)
        if (commentId) {
          const [ex] = await db.select({ id: schema.comments.id }).from(schema.comments).where(and(eq(schema.comments.id, commentId), eq(schema.comments.issueId, issueId))).limit(1)
          if (!ex) commentId = null
        }
        if (commentId) {
          await db.update(schema.comments).set({ body, authorId, updatedAt: c.updatedAt ?? c.createdAt ?? now }).where(eq(schema.comments.id, commentId))
        } else {
          const [row] = await db.insert(schema.comments).values({ issueId, body, authorId, createdAt: c.createdAt ?? values.createdAt, updatedAt: c.updatedAt ?? c.createdAt ?? values.createdAt }).returning({ id: schema.comments.id })
          commentId = row.id
        }
        await setRef('comment', c.id, commentId)
        stats.comments++; report.totals.comments++
      }
    }
    if (i.parentId) parents.push({ child: issueId, parentExt: i.parentId, childExt: i.id })
    for (const l of i.links) links.push({ from: issueId, toExt: l.targetId, kind: l.kind, fromExt: i.id, proj })
  }

  const lookupIssue = async (ext: string): Promise<number | null> => {
    const local = issueLocal.get(ext)
    if (local) return local
    const ref = await getRef('issue', ext)
    if (!ref) return null
    const [ex] = await db.select({ id: schema.issues.id }).from(schema.issues).where(eq(schema.issues.id, ref)).limit(1)
    return ex?.id ?? null
  }

  // --- main loop ---
  for await (const item of items) {
    if (hooks.isCancelled && (await hooks.isCancelled())) { report.cancelled = true; break }
    if (item.kind === 'total') { total += item.count; continue }
    if (item.kind === 'warning') { warn(item.message); continue }
    try {
      if (item.kind === 'project') { await upsertProject(item.project); continue }
      await processIssue(item.issue)
    } catch (e: any) {
      if (item.kind === 'issue') {
        const p = projects.get(item.issue.projectId)
        if (p) { p.stats.failed++ }
        report.totals.failed++
        err(`${item.issue.identifier ?? item.issue.id}: ${e?.message ?? e}`)
      } else {
        err(`Project ${item.project.name}: ${e?.message ?? e}`)
      }
    }
    if (item.kind === 'issue') {
      processed++
      if (hooks.onProgress && processed % 10 === 0) await hooks.onProgress({ processed, total: Math.max(total, processed), message: item.issue.identifier ?? item.issue.id, errors: report.errors })
    }
  }

  if (!report.cancelled && hooks.isCancelled && (await hooks.isCancelled())) report.cancelled = true

  // --- second pass: parent/sub-issue relations and links ---
  if (!report.cancelled) {
    let missingParents = 0
    let missingLinks = 0
    for (const p of parents) {
      if (dryRun) {
        if (!dryIssueIds.has(p.parentExt) && !(await lookupIssue(p.parentExt))) missingParents++
        continue
      }
      const parentId = await lookupIssue(p.parentExt)
      if (parentId && parentId !== p.child) await db.update(schema.issues).set({ parentId }).where(eq(schema.issues.id, p.child))
      else if (!parentId) missingParents++
    }
    for (const l of links) {
      if (dryRun) {
        if (!dryIssueIds.has(l.toExt) && !(await lookupIssue(l.toExt))) { missingLinks++; continue }
        // Same de-duplication as the real run: symmetric "relates" pairs count once.
        const pair = l.kind === 'Relates' ? [l.fromExt, l.toExt].sort().join('|') : `${l.fromExt}|${l.toExt}`
        if (dryLinks.has(`${l.kind}|${pair}`)) continue
        dryLinks.add(`${l.kind}|${pair}`)
        l.proj.stats.links++; report.totals.links++
        continue
      }
      const toId = await lookupIssue(l.toExt)
      if (!toId || toId === l.from) { missingLinks++; continue }
      const typeId = await resolver.linkType(LINK_TYPES[l.kind])
      const dir = (a: number, b: number) => and(eq(schema.issueLinks.issueId, a), eq(schema.issueLinks.linkedIssueId, b), eq(schema.issueLinks.linkTypeId, typeId))
      const [dup] = await db.select({ id: schema.issueLinks.id }).from(schema.issueLinks).where(l.kind === 'Relates' ? sql`(${dir(l.from, toId)}) or (${dir(toId, l.from)})` : dir(l.from, toId)).limit(1)
      if (!dup) {
        await db.insert(schema.issueLinks).values({ issueId: l.from, linkedIssueId: toId, linkTypeId: typeId })
        l.proj.stats.links++; report.totals.links++
      }
    }
    if (missingParents) warn(`${missingParents} sub-issue(s) point to a parent that was not part of this import and were imported without a parent`)
    if (missingLinks) warn(`${missingLinks} issue link(s) point to issues that were not imported and were skipped`)
  }

  // --- finish ---
  for (const [field, n] of unsupported.counts) report.unsupported[field] = n
  for (const [field, n] of unsupported.counts) warn(`Not imported: ${field} (${n} item${n === 1 ? '' : 's'})`)
  if (opts.staticUnsupported?.length) warn(`Not supported by Veqsio and never imported from ${source}: ${opts.staticUnsupported.join(', ')}`)
  if (!dryRun) {
    report.users.created = resolver.usersCreated
    warn('Imported statuses use the default workflow until a workflow scheme is assigned to the new projects (Administration > Workflows).')
  }
  if (report.cancelled) warn('Import cancelled; everything imported so far is kept and a re-run continues without duplicating it')
  if (hooks.onProgress) await hooks.onProgress({ processed, total: Math.max(total, processed), message: 'done', errors: report.errors })
  return report
}
