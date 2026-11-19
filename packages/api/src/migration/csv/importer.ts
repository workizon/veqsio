import { and, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../../db'
import * as schema from '@veqsio/db'
import { generateIssueKey } from '../../issues/key-generator'
import { Resolver } from '../resolver'
import type { NormalizedUser } from '../rest/mapper'
import {
  cell, cells, parseCommentCell, parseDate, parseDurationSeconds, parseStoryPointsCell, splitList, validateMapping,
  type Mapping, type NumericDateOrder, type ParsedCsv,
} from './parse'

export interface CsvImportOptions {
  projectKey: string
  mapping: Mapping
  dateOrder?: NumericDateOrder
  dryRun?: boolean
  defaultIssueType?: string
  /** Existing issues with the same key: skip (default) or overwrite. */
  onExisting?: 'skip' | 'overwrite'
  userMapping?: Record<string, string>
  createMissingUsers?: boolean
}

export interface CsvRowMessage { row: number; message: string }

export interface CsvImportReport {
  dryRun: boolean
  total: number
  created: number
  updated: number
  skipped: number
  failed: number
  errors: CsvRowMessage[]
  warnings: CsvRowMessage[]
  /** Reference data that does not exist yet and would be (or was) created. */
  newValues: { issueTypes: string[]; statuses: string[]; priorities: string[]; resolutions: string[]; users: string[] }
  keys: string[]
}

const MAX_MESSAGES = 500
const DONE_RE = /done|closed|resolved|complete|finished/i
const PROGRESS_RE = /progress|review|testing|doing|active/i

function toUser(value: string | null): NormalizedUser | null {
  if (!value) return null
  const v = value.trim()
  if (v.includes('@')) {
    return { username: v.split('@')[0].slice(0, 200), email: v.toLowerCase().slice(0, 255), displayName: v.split('@')[0] }
  }
  return { username: v.slice(0, 200), email: `${v.toLowerCase().replace(/\s+/g, '.')}@migrated.invalid`.slice(0, 255), displayName: v.slice(0, 255) }
}

function categoryFor(status: string, resolved: boolean): 'todo' | 'in_progress' | 'done' {
  if (resolved || DONE_RE.test(status)) return 'done'
  if (PROGRESS_RE.test(status)) return 'in_progress'
  return 'todo'
}

interface RowData {
  rowNo: number
  summary: string
  key: string | null
  jiraId: string | null
  description: string | null
  issueType: string | null
  status: string | null
  priority: string | null
  resolution: string | null
  assignee: string | null
  reporter: string | null
  created: Date | null
  updated: Date | null
  resolved: Date | null
  dueDate: Date | null
  labels: string[]
  components: string[]
  fixVersions: string[]
  affectsVersions: string[]
  parent: string | null
  environment: string | null
  estimate: number | null
  storyPoints: number | null
  comments: Array<{ created: Date | null; author: string | null; body: string }>
}

/** Parse + validate every row; pure, no database writes. */
export function extractRows(csv: ParsedCsv, opts: CsvImportOptions, projectKey: string): { rows: RowData[]; errors: CsvRowMessage[]; warnings: CsvRowMessage[] } {
  const rows: RowData[] = []
  const errors: CsvRowMessage[] = []
  const warnings: CsvRowMessage[] = []
  const order = opts.dateOrder ?? 'dmy'
  const keyRe = new RegExp(`^${projectKey.replace(/[^A-Za-z0-9_]/g, '')}-(\\d+)$`)
  const seenKeys = new Set<string>()

  csv.rows.forEach((r, idx) => {
    const rowNo = idx + 2 // 1-based, header is row 1
    const fail = (message: string) => errors.push({ row: rowNo, message })
    const warn = (message: string) => warnings.push({ row: rowNo, message })

    let summary = cell(r, opts.mapping, 'summary')
    if (!summary) return fail('Summary is empty')
    if (summary.length > 500) { summary = summary.slice(0, 500); warn('Summary truncated to 500 characters') }

    const date = (field: 'created' | 'updated' | 'resolved' | 'dueDate'): Date | null => {
      const raw = cell(r, opts.mapping, field)
      if (!raw) return null
      const d = parseDate(raw, order)
      if (!d) warn(`Could not parse ${field} date "${raw}"; ignored`)
      return d
    }

    let key = cell(r, opts.mapping, 'issueKey')
    if (key) {
      if (!keyRe.test(key)) { warn(`Issue key "${key}" does not belong to ${projectKey}; a new key will be assigned`); key = null }
      else if (seenKeys.has(key)) return fail(`Duplicate issue key ${key} in file`)
      else seenKeys.add(key)
    }

    const estimateRaw = cell(r, opts.mapping, 'originalEstimate')
    const estimate = parseDurationSeconds(estimateRaw)
    if (estimateRaw && estimate === null) warn(`Could not parse estimate "${estimateRaw}"; ignored`)

    const pointsRaw = cell(r, opts.mapping, 'storyPoints')
    const storyPoints = parseStoryPointsCell(pointsRaw)
    if (pointsRaw && storyPoints === null) warn(`Could not parse story points "${pointsRaw}" (expected a number 0-1000); ignored`)

    rows.push({
      rowNo, summary, key,
      jiraId: cell(r, opts.mapping, 'issueId'),
      description: cell(r, opts.mapping, 'description'),
      issueType: cell(r, opts.mapping, 'issueType'),
      status: cell(r, opts.mapping, 'status'),
      priority: cell(r, opts.mapping, 'priority'),
      resolution: cell(r, opts.mapping, 'resolution'),
      assignee: cell(r, opts.mapping, 'assignee'),
      reporter: cell(r, opts.mapping, 'reporter'),
      created: date('created'), updated: date('updated'), resolved: date('resolved'), dueDate: date('dueDate'),
      labels: splitList(cells(r, opts.mapping, 'labels')).map((l) => l.replace(/\s+/g, '-')),
      components: splitList(cells(r, opts.mapping, 'components')),
      fixVersions: splitList(cells(r, opts.mapping, 'fixVersions')),
      affectsVersions: splitList(cells(r, opts.mapping, 'affectsVersions')),
      parent: cell(r, opts.mapping, 'parent'),
      environment: cell(r, opts.mapping, 'environment'),
      estimate, storyPoints,
      comments: cells(r, opts.mapping, 'comment').map((c) => parseCommentCell(c, order)),
    })
  })
  return { rows, errors, warnings }
}

const emptyReport = (dryRun: boolean, total: number): CsvImportReport => ({
  dryRun, total, created: 0, updated: 0, skipped: 0, failed: 0, errors: [], warnings: [],
  newValues: { issueTypes: [], statuses: [], priorities: [], resolutions: [], users: [] }, keys: [],
})

export async function runCsvImport(csv: ParsedCsv, opts: CsvImportOptions, actingUserId: number): Promise<CsvImportReport> {
  const mappingErrors = validateMapping(opts.mapping, csv.headers.length)
  if (mappingErrors.length) throw new Error(mappingErrors.join('; '))

  const [project] = await db.select().from(schema.projects).where(eq(schema.projects.projectKey, opts.projectKey)).limit(1)
  if (!project) throw new Error('Project not found')

  const dryRun = !!opts.dryRun
  const report = emptyReport(dryRun, csv.rows.length)
  const { rows, errors, warnings } = extractRows(csv, opts, project.projectKey)
  report.errors.push(...errors)
  report.warnings.push(...warnings)
  report.failed = errors.length

  // Which reference values are new?
  const lc = (s: string) => s.toLowerCase()
  const [types, statuses, prios, ress, users] = await Promise.all([
    db.select({ n: schema.issueTypes.name }).from(schema.issueTypes),
    db.select({ n: schema.statuses.name }).from(schema.statuses),
    db.select({ n: schema.priorities.name }).from(schema.priorities),
    db.select({ n: schema.resolutions.name }).from(schema.resolutions),
    db.select({ u: schema.users.username, e: schema.users.email, d: schema.users.displayName }).from(schema.users),
  ])
  const has = (list: Array<{ n: string }>) => new Set(list.map((x) => lc(x.n)))
  const typeSet = has(types), statusSet = has(statuses), prioSet = has(prios), resSet = has(ress)
  const userSet = new Set(users.flatMap((u) => [lc(u.u), lc(u.e), lc(u.d)]))
  const collect = (value: string | null, known: Set<string>, into: string[]) => {
    if (value && !known.has(lc(value)) && !into.includes(value)) into.push(value)
  }
  for (const r of rows) {
    collect(r.issueType, typeSet, report.newValues.issueTypes)
    collect(r.status, statusSet, report.newValues.statuses)
    collect(r.priority, prioSet, report.newValues.priorities)
    collect(r.resolution, resSet, report.newValues.resolutions)
    for (const u of [r.assignee, r.reporter, ...r.comments.map((c) => c.author)]) {
      if (u && !userSet.has(lc(u)) && !userSet.has(lc(u.split('@')[0])) && !opts.userMapping?.[u] && !report.newValues.users.includes(u)) report.newValues.users.push(u)
    }
  }

  const knownIds = new Set(rows.map((r) => r.jiraId).filter(Boolean) as string[])
  const knownKeys = new Set(rows.map((r) => r.key).filter(Boolean) as string[])
  for (const r of rows) {
    if (r.parent && !knownIds.has(r.parent) && !knownKeys.has(r.parent)) {
      const [p] = /^[A-Z][A-Z0-9_]*-\d+$/.test(r.parent)
        ? await db.select({ id: schema.issues.id }).from(schema.issues).where(eq(schema.issues.issueKey, r.parent)).limit(1)
        : []
      if (!p) report.warnings.push({ row: r.rowNo, message: `Parent "${r.parent}" not found; issue will be created without a parent` })
    }
  }

  if (dryRun) {
    report.created = rows.length
    cap(report)
    return report
  }

  const resolver = new Resolver(db, { userMapping: opts.userMapping, createMissingUsers: opts.createMissingUsers })
  const defaultType = opts.defaultIssueType || 'Task'
  const [initialStatus] = await db.select().from(schema.statuses).where(inArray(sql`lower(${schema.statuses.name})`, ['to do', 'open', 'todo', 'backlog'])).limit(1)
  const idByJiraId = new Map<string, number>()
  const idByKey = new Map<string, number>()
  const parentLinks: Array<{ child: number; parent: string; row: number }> = []
  let maxNumber = 0

  for (const r of rows) {
    try {
      const typeId = await resolver.issueType(r.issueType || defaultType, false)
      const statusName = r.status || initialStatus?.name || 'To Do'
      const statusId = await resolver.status(statusName, categoryFor(statusName, !!r.resolved || !!r.resolution))
      const [priorityId, resolutionId, assigneeId, reporterId] = await Promise.all([
        r.priority ? resolver.priority(r.priority) : null,
        r.resolution ? resolver.resolution(r.resolution) : null,
        resolver.user(toUser(r.assignee)),
        resolver.user(toUser(r.reporter)),
      ])

      let existingId: number | null = null
      let key = r.key
      if (key) {
        const [ex] = await db.select({ id: schema.issues.id }).from(schema.issues).where(eq(schema.issues.issueKey, key)).limit(1)
        if (ex) {
          if (opts.onExisting !== 'overwrite') {
            report.skipped++
            idByKey.set(key, ex.id); if (r.jiraId) idByJiraId.set(r.jiraId, ex.id)
            continue
          }
          existingId = ex.id
        }
      }
      if (!key) {
        for (;;) {
          key = await generateIssueKey(project.id, project.projectKey)
          const [clash] = await db.select({ id: schema.issues.id }).from(schema.issues).where(eq(schema.issues.issueKey, key)).limit(1)
          if (!clash) break
        }
      }

      const now = new Date()
      const values = {
        projectId: project.id, issueTypeId: typeId, statusId, priorityId, resolutionId, summary: r.summary,
        description: r.description, assigneeId, reporterId: reporterId ?? actingUserId, environment: r.environment,
        createdAt: r.created ?? now, updatedAt: r.updated ?? r.created ?? now,
        resolvedAt: r.resolved ?? (resolutionId ? (r.updated ?? now) : null), dueDate: r.dueDate, timeEstimate: r.estimate,
        storyPoints: r.storyPoints === null ? null : r.storyPoints.toFixed(2),
      }
      let issueId: number
      if (existingId) {
        await db.update(schema.issues).set(values).where(eq(schema.issues.id, existingId))
        issueId = existingId
        await db.delete(schema.issueLabels).where(eq(schema.issueLabels.issueId, issueId))
        await db.delete(schema.issueComponents).where(eq(schema.issueComponents.issueId, issueId))
        await db.delete(schema.issueFixVersions).where(eq(schema.issueFixVersions.issueId, issueId))
        await db.delete(schema.issueAffectsVersions).where(eq(schema.issueAffectsVersions.issueId, issueId))
        await db.delete(schema.comments).where(eq(schema.comments.issueId, issueId))
        report.updated++
      } else {
        const [row] = await db.insert(schema.issues).values({ ...values, issueKey: key }).returning({ id: schema.issues.id })
        issueId = row.id
        report.created++
      }
      report.keys.push(key)
      idByKey.set(key, issueId)
      if (r.jiraId) idByJiraId.set(r.jiraId, issueId)
      const num = Number(/(\d+)$/.exec(key)?.[1] ?? 0)
      if (num > maxNumber) maxNumber = num

      for (const l of r.labels) await db.insert(schema.issueLabels).values({ issueId, labelId: await resolver.label(l) }).onConflictDoNothing()
      for (const c of r.components) await db.insert(schema.issueComponents).values({ issueId, componentId: await resolver.component(project.id, c) }).onConflictDoNothing()
      for (const v of r.fixVersions) await db.insert(schema.issueFixVersions).values({ issueId, versionId: await resolver.version(project.id, v) }).onConflictDoNothing()
      for (const v of r.affectsVersions) await db.insert(schema.issueAffectsVersions).values({ issueId, versionId: await resolver.version(project.id, v) }).onConflictDoNothing()
      for (const c of r.comments) {
        await db.insert(schema.comments).values({
          issueId, body: c.body, authorId: (await resolver.user(toUser(c.author))) ?? actingUserId,
          createdAt: c.created ?? values.createdAt, updatedAt: c.created ?? values.createdAt,
        })
      }
      if (r.parent) parentLinks.push({ child: issueId, parent: r.parent, row: r.rowNo })
    } catch (e: any) {
      report.failed++
      report.errors.push({ row: r.rowNo, message: String(e?.message ?? e).slice(0, 300) })
    }
  }

  for (const p of parentLinks) {
    let parentId = idByJiraId.get(p.parent) ?? idByKey.get(p.parent)
    if (!parentId && /^[A-Z][A-Z0-9_]*-\d+$/.test(p.parent)) {
      const [ex] = await db.select({ id: schema.issues.id }).from(schema.issues).where(eq(schema.issues.issueKey, p.parent)).limit(1)
      parentId = ex?.id
    }
    if (parentId && parentId !== p.child) await db.update(schema.issues).set({ parentId }).where(eq(schema.issues.id, p.child))
  }

  await db.insert(schema.projectIssueCounters).values({ projectId: project.id, currentValue: maxNumber }).onConflictDoUpdate({
    target: schema.projectIssueCounters.projectId,
    set: { currentValue: sql`greatest(coalesce(${schema.projectIssueCounters.currentValue}, 0), ${maxNumber})` },
  })

  cap(report)
  return report
}

function cap(r: CsvImportReport) {
  r.errors = r.errors.slice(0, MAX_MESSAGES)
  r.warnings = r.warnings.slice(0, MAX_MESSAGES)
  r.keys = r.keys.slice(0, 1000)
}
