import { z } from 'zod'
import { parseDate, parseDurationSeconds, parseStoryPointsCell } from '../csv/parse'
import { deriveKey } from './engine'
import {
  guessCategory, mapPriorityName,
  type ExtractContext, type ExtractOptions, type LinkKind, type SourceAdapter, type SourceInfo, type StatusCategory, type ToolContainer, type ToolIssue, type ToolItem, type ToolStatus, type ToolUser,
} from './model'

/**
 * Generic JSON import. The schema is documented in docs/migration-other-tools.md; in short:
 *
 *   { "version": 1, "projects": [ { "id": "web", "key": "WEB", "name": "Website", "statuses": [...], "sprints": [...],
 *       "issues": [ { "id": "1", "title": "...", "status": "To Do", "assignee": "a@example.com", "parent": "0", ... } ] } ] }
 *
 * Unknown properties never fail the import; they are reported as "not imported" warnings.
 */

export const MAX_JSON_BYTES = 50 * 1024 * 1024
export const MAX_JSON_ISSUES = 200_000

export const GENERIC_INFO: SourceInfo = {
  id: 'json',
  name: 'JSON file',
  mode: 'file',
  maps: [
    'Projects with statuses (board columns) and sprints',
    'Issues with type, status, priority, assignee, reporter, dates, labels, components, story points, time estimate and spent',
    'Parent / sub-task relations, issue links (blocks, relates, duplicates) and comments',
    'Re-uploading the same file updates the imported issues (matched by the ids in the file)',
  ],
  unsupported: ['Attachments', 'History', 'Custom fields (unknown properties are listed as warnings)'],
}

const id = z.union([z.string().min(1).max(200), z.number().int()]).transform(String)
const userObj = z.object({ id: id.optional(), email: z.string().max(255).optional(), name: z.string().max(255).optional() }).passthrough()
const userRef = z.union([z.string().max(255), userObj]).nullable()
const dateIn = z.union([z.string().max(64), z.number()]).nullable()
const statusIn = z.union([z.string().min(1).max(100), z.object({ name: z.string().min(1).max(100), category: z.enum(['todo', 'in_progress', 'done']).optional() }).passthrough()])
const duration = z.union([z.string().max(50), z.number().nonnegative()]).nullable()

const commentSchema = z.object({
  id: id.optional(), author: userRef.optional(), body: z.string().max(200_000), createdAt: dateIn.optional(),
}).passthrough()

const issueSchema = z.object({
  id: id.optional(),
  title: z.string().max(5000).optional(),
  summary: z.string().max(5000).optional(),
  description: z.string().max(1_000_000).nullable().optional(),
  type: z.string().max(100).nullable().optional(),
  status: statusIn.optional(),
  priority: z.string().max(100).nullable().optional(),
  resolution: z.string().max(100).nullable().optional(),
  assignee: userRef.optional(),
  reporter: userRef.optional(),
  creator: userRef.optional(),
  createdAt: dateIn.optional(),
  updatedAt: dateIn.optional(),
  resolvedAt: dateIn.optional(),
  dueDate: dateIn.optional(),
  startDate: dateIn.optional(),
  labels: z.array(z.string().max(100)).max(200).optional(),
  components: z.array(z.string().max(255)).max(200).optional(),
  parent: id.nullable().optional(),
  storyPoints: z.union([z.number(), z.string().max(20)]).nullable().optional(),
  timeEstimate: duration.optional(),
  timeSpent: duration.optional(),
  sprint: id.nullable().optional(),
  comments: z.array(commentSchema).max(10_000).optional(),
  links: z.array(z.object({ type: z.string().max(50).optional(), target: id }).passthrough()).max(500).optional(),
  url: z.string().max(2000).nullable().optional(),
}).passthrough()

const sprintSchema = z.object({
  id: id, name: z.string().min(1).max(255), goal: z.string().nullable().optional(),
  state: z.enum(['future', 'active', 'closed']).optional(), startDate: dateIn.optional(), endDate: dateIn.optional(), completeDate: dateIn.optional(),
}).passthrough()

const projectSchema = z.object({
  id: id,
  key: z.string().max(20).nullable().optional(),
  name: z.string().min(1).max(255),
  description: z.string().nullable().optional(),
  lead: userRef.optional(),
  statuses: z.array(statusIn).max(100).optional(),
  sprints: z.array(sprintSchema).max(2000).optional(),
  issues: z.array(z.unknown()).max(MAX_JSON_ISSUES),
}).passthrough()

export const genericFileSchema = z.object({
  version: z.number().int().optional(),
  projects: z.array(projectSchema).min(1).max(1000),
}).passthrough()

const KNOWN_ISSUE_KEYS = new Set(Object.keys(issueSchema.shape))

const toDate = (v: unknown): Date | null => {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'number') { const d = new Date(v < 1e11 ? v * 1000 : v); return Number.isNaN(d.getTime()) ? null : d }
  const iso = new Date(String(v))
  if (/^\d{4}-\d{2}-\d{2}/.test(String(v)) && !Number.isNaN(iso.getTime())) return iso
  return parseDate(String(v), 'dmy')
}

function toUser(v: z.infer<typeof userRef> | undefined): ToolUser | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'string') return v.includes('@') ? { email: v, name: null } : { name: v, externalId: v }
  return { externalId: v.id ?? null, email: v.email ?? null, name: v.name ?? null }
}

function toStatus(v: z.infer<typeof statusIn>): ToolStatus {
  if (typeof v === 'string') return { name: v.trim(), category: guessCategory(v) }
  return { name: v.name.trim(), category: (v.category as StatusCategory | undefined) ?? guessCategory(v.name) }
}

const seconds = (v: string | number | null | undefined): number | null => {
  if (v === null || v === undefined) return null
  return typeof v === 'number' ? Math.round(v) : parseDurationSeconds(v.trim())
}

function linkKind(t: string | undefined): LinkKind {
  const s = (t ?? 'relates').toLowerCase()
  if (s.startsWith('block')) return 'Blocks'
  if (s.startsWith('dup')) return 'Duplicate'
  return 'Relates'
}

export class JsonFileError extends Error {}

export class GenericJsonSource implements SourceAdapter {
  readonly data: z.infer<typeof genericFileSchema>
  constructor(text: string, private namespace = 'default') {
    if (text.length > MAX_JSON_BYTES) throw new JsonFileError('JSON file is larger than 50 MB')
    let parsed: unknown
    try { parsed = JSON.parse(text.replace(/^﻿/, '')) } catch (e: any) { throw new JsonFileError(`Invalid JSON: ${String(e.message).slice(0, 200)}`) }
    const r = genericFileSchema.safeParse(parsed)
    if (!r.success) {
      const msgs = r.error.issues.slice(0, 10).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      throw new JsonFileError(`The file does not match the import schema: ${msgs.join('; ')}`)
    }
    const total = r.data.projects.reduce((n, p) => n + p.issues.length, 0)
    if (total > MAX_JSON_ISSUES) throw new JsonFileError(`The file has more than ${MAX_JSON_ISSUES} issues`)
    const ids = new Set<string>()
    for (const p of r.data.projects) {
      if (ids.has(p.id)) throw new JsonFileError(`Duplicate project id "${p.id}"`)
      ids.add(p.id)
    }
    this.data = r.data
  }

  private ns(x: string) { return `${this.namespace}:${x}` }

  async viewer() { return { name: 'JSON file', email: null } }

  async containers(): Promise<ToolContainer[]> {
    return this.data.projects.map((p) => ({ id: this.ns(p.id), name: p.name, group: null, issueCount: p.issues.length, suggestedKey: (p.key || deriveKey(p.name)) }))
  }

  async *extract(opts: ExtractOptions, ctx: ExtractContext): AsyncGenerator<ToolItem> {
    const wanted = opts.containerIds?.length ? new Set(opts.containerIds) : null
    for (const p of this.data.projects) {
      const pid = this.ns(p.id)
      if (wanted && !wanted.has(pid)) continue
      const statuses: ToolStatus[] = []
      const addStatus = (s: ToolStatus) => { if (!statuses.some((x) => x.name.toLowerCase() === s.name.toLowerCase())) statuses.push(s) }
      for (const s of p.statuses ?? []) addStatus(toStatus(s))

      // Validate issues first so statuses used only by issues still become columns.
      const issues: ToolIssue[] = []
      const problems: string[] = []
      const seen = new Set<string>()
      p.issues.forEach((rawIssue, idx) => {
        const r = issueSchema.safeParse(rawIssue)
        if (!r.success) { problems.push(`${p.id} issue #${idx + 1} skipped: ${r.error.issues[0]?.path.join('.')} ${r.error.issues[0]?.message}`); return }
        const i = r.data
        const title = (i.title ?? i.summary ?? '').trim()
        if (!title) { problems.push(`${p.id} issue #${idx + 1} skipped: title is missing`); return }
        let iid = i.id
        if (iid === undefined) { iid = `#${idx + 1}`; ctx.unsupported.add('issues without an id (re-importing the file would not match them again)') }
        if (seen.has(iid)) { problems.push(`${p.id} issue "${iid}" skipped: duplicate id`); return }
        seen.add(iid)
        for (const k of Object.keys(i)) if (!KNOWN_ISSUE_KEYS.has(k)) ctx.unsupported.add(`unknown property "${k}"`)
        const status = i.status ? toStatus(i.status) : { name: 'To Do', category: 'todo' as StatusCategory }
        addStatus(status)
        const done = status.category === 'done'
        const dateOrNull = (v: unknown, name: string) => { const d = toDate(v); if (v !== null && v !== undefined && v !== '' && !d) ctx.unsupported.add(`unparseable ${name} dates`); return d }
        const sp = i.storyPoints === null || i.storyPoints === undefined ? null : typeof i.storyPoints === 'number' ? i.storyPoints : parseStoryPointsCell(i.storyPoints)
        issues.push({
          id: this.ns(`${p.id}/${iid}`), identifier: String(iid), projectId: pid, title: title.slice(0, 500),
          description: i.description ?? null, type: i.type ?? null, isSubtask: !!i.parent,
          status, priority: mapPriorityName(i.priority), resolution: i.resolution ?? (done ? 'Done' : null),
          assignee: toUser(i.assignee), creator: toUser(i.reporter ?? i.creator),
          createdAt: dateOrNull(i.createdAt, 'createdAt'), updatedAt: dateOrNull(i.updatedAt, 'updatedAt'), resolvedAt: dateOrNull(i.resolvedAt, 'resolvedAt'),
          dueDate: dateOrNull(i.dueDate, 'dueDate'), startDate: dateOrNull(i.startDate, 'startDate'),
          labels: i.labels ?? [], components: i.components ?? [],
          parentId: i.parent ? this.ns(`${p.id}/${i.parent}`) : null,
          storyPoints: sp, timeEstimateSeconds: seconds(i.timeEstimate), timeSpentSeconds: seconds(i.timeSpent),
          sprintId: i.sprint ? this.ns(`${p.id}/sprint/${i.sprint}`) : null,
          comments: (i.comments ?? []).map((c, ci) => ({
            id: this.ns(`${p.id}/${iid}/comment/${c.id ?? `#${ci + 1}`}`), author: toUser(c.author), body: c.body, createdAt: toDate(c.createdAt),
          })),
          links: (i.links ?? []).map((l) => ({ targetId: this.ns(`${p.id}/${l.target}`), kind: linkKind(l.type) })),
          url: i.url ?? null,
        })
      })
      if (!statuses.length) addStatus({ name: 'To Do', category: 'todo' })

      yield {
        kind: 'project',
        project: {
          id: pid, suggestedKey: p.key ?? null, name: p.name, description: p.description ?? null, lead: toUser(p.lead), statuses,
          sprints: (p.sprints ?? []).map((s) => ({
            id: this.ns(`${p.id}/sprint/${s.id}`), name: s.name, goal: s.goal ?? null, state: s.state ?? 'future',
            startDate: toDate(s.startDate), endDate: toDate(s.endDate), completeDate: toDate(s.completeDate),
          })),
          components: [],
        },
      }
      yield { kind: 'total', count: issues.length }
      for (const m of problems.slice(0, 100)) yield { kind: 'warning', message: m }
      if (problems.length > 100) yield { kind: 'warning', message: `${problems.length - 100} more issues were skipped` }
      for (const issue of issues) {
        if (await ctx.isCancelled()) return
        yield { kind: 'issue', issue }
      }
    }
  }
}
