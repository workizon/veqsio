/**
 * Pure helpers for the backlog / sprint planning page. No React and no network so the rules
 * (totals, optimistic moves, filters, completion split, form validation) are unit-testable.
 */
import { getIntlLocale } from '@/lib/i18n'

export type IssueKind = 'bug' | 'task' | 'story' | 'epic' | 'sub-task'
export type StatusCategory = 'todo' | 'in_progress' | 'done'
export type SprintState = 'future' | 'active' | 'closed'

export interface PlanIssue {
  id: number
  key: string
  summary: string
  type: IssueKind
  typeName: string
  status: string
  category: StatusCategory
  priority: string
  assignee?: { name: string; initials: string }
  storyPoints: number | null
  flagged?: boolean
}

export interface PlanSprint {
  id: number
  name: string
  goal?: string | null
  state: SprintState
  startDate?: string
  endDate?: string
  completeDate?: string
  issueCount: number
  storyPoints: number
  /** Undefined for closed sprints (counts only). */
  issues: PlanIssue[]
}

export interface PlanBacklog {
  total: number
  storyPoints: number
  issues: PlanIssue[]
}

export interface PlanningData {
  board: { id: number; name: string; type: string; projectId: number; allowParallelSprints: boolean; sprintAutomation?: { autoCreateNext: boolean; durationDays: number; autoMoveIncomplete: 'next' | 'backlog' } }
  sprints: PlanSprint[]
  backlog: PlanBacklog
}

export type MoveTarget = { kind: 'backlog' } | { kind: 'sprint'; id: number }

/* ---------------- mapping from the API ---------------- */

interface ApiRow {
  id: string
  key: string
  fields: {
    summary: string
    status: { name: string; statusCategory?: { key?: string } }
    priority: { name: string } | null
    issuetype: { name: string; subtask?: boolean }
    assignee: { displayName: string } | null
    storyPoints: number | null
    flagged?: boolean
  }
}

export function normalizeIssueKind(name?: string, subtask?: boolean): IssueKind {
  const n = (name || '').toLowerCase()
  if (subtask || n.includes('sub')) return 'sub-task'
  if (n.includes('bug')) return 'bug'
  if (n.includes('story')) return 'story'
  if (n.includes('epic')) return 'epic'
  return 'task'
}

export function initialsOf(name: string): string {
  return name.split(/\s+/).filter(Boolean).map((p) => p[0]).join('').toUpperCase().slice(0, 2)
}

export function mapRow(r: ApiRow): PlanIssue {
  const cat = r.fields.status.statusCategory?.key
  return {
    id: Number(r.id),
    key: r.key,
    summary: r.fields.summary,
    type: normalizeIssueKind(r.fields.issuetype?.name, r.fields.issuetype?.subtask),
    typeName: r.fields.issuetype?.name ?? 'Task',
    status: r.fields.status.name,
    category: cat === 'done' || cat === 'cancelled' ? 'done' : cat === 'in_progress' ? 'in_progress' : 'todo',
    priority: r.fields.priority?.name ?? 'Medium',
    assignee: r.fields.assignee ? { name: r.fields.assignee.displayName, initials: initialsOf(r.fields.assignee.displayName) } : undefined,
    storyPoints: r.fields.storyPoints ?? null,
    flagged: r.fields.flagged === true,
  }
}

export function mapPlanning(raw: any): PlanningData {
  return {
    board: raw.board,
    sprints: (raw.sprints ?? []).map((s: any): PlanSprint => ({
      id: s.id,
      name: s.name,
      goal: s.goal ?? null,
      state: s.state === 'active' || s.state === 'closed' ? s.state : 'future',
      startDate: s.startDate,
      endDate: s.endDate,
      completeDate: s.completeDate,
      issueCount: s.issueCount ?? 0,
      storyPoints: s.storyPoints ?? 0,
      issues: (s.issues ?? []).map(mapRow),
    })),
    backlog: {
      total: raw.backlog?.total ?? 0,
      storyPoints: raw.backlog?.storyPoints ?? 0,
      issues: (raw.backlog?.issues ?? []).map(mapRow),
    },
  }
}

/* ---------------- totals ---------------- */

export function sumPoints(issues: ReadonlyArray<{ storyPoints: number | null }>): number {
  let t = 0
  for (const i of issues) t += i.storyPoints ?? 0
  return Math.round(t * 100) / 100
}

export function pointsByCategory(issues: ReadonlyArray<PlanIssue>): Record<StatusCategory, number> {
  const out: Record<StatusCategory, number> = { todo: 0, in_progress: 0, done: 0 }
  for (const i of issues) out[i.category] += i.storyPoints ?? 0
  return { todo: round(out.todo), in_progress: round(out.in_progress), done: round(out.done) }
}
const round = (n: number) => Math.round(n * 100) / 100

export const formatPoints = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1))
export const pluralize = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/* ---------------- filtering ---------------- */

export interface PlanFilters {
  text: string
  assignee: string | null // display name, 'unassigned' or null
  type: IssueKind | null
  onlyMine?: string | null // current user's display name
}

export const emptyFilters: PlanFilters = { text: '', assignee: null, type: null, onlyMine: null }

export function hasActiveFilters(f: PlanFilters): boolean {
  return !!(f.text.trim() || f.assignee || f.type || f.onlyMine)
}

export function matchesFilters(i: PlanIssue, f: PlanFilters): boolean {
  const t = f.text.trim().toLowerCase()
  if (t && !i.key.toLowerCase().includes(t) && !i.summary.toLowerCase().includes(t)) return false
  if (f.type && i.type !== f.type) return false
  if (f.assignee === 'unassigned' && i.assignee) return false
  if (f.assignee && f.assignee !== 'unassigned' && i.assignee?.name !== f.assignee) return false
  if (f.onlyMine && i.assignee?.name !== f.onlyMine) return false
  return true
}

export const filterIssues = (issues: PlanIssue[], f: PlanFilters) => (hasActiveFilters(f) ? issues.filter((i) => matchesFilters(i, f)) : issues)

/* ---------------- optimistic moves ---------------- */

const withTotals = (s: PlanSprint, issues: PlanIssue[]): PlanSprint => ({ ...s, issues, issueCount: issues.length, storyPoints: sumPoints(issues) })

/** Which keys move when `draggedKey` is dragged: the whole selection if it contains the dragged issue. */
export function keysToMove(selected: ReadonlySet<string>, draggedKey: string): string[] {
  return selected.has(draggedKey) ? [...selected] : [draggedKey]
}

export function locate(data: PlanningData, key: string): { kind: 'backlog' } | { kind: 'sprint'; id: number } | null {
  if (data.backlog.issues.some((i) => i.key === key)) return { kind: 'backlog' }
  for (const s of data.sprints) if (s.state !== 'closed' && s.issues.some((i) => i.key === key)) return { kind: 'sprint', id: s.id }
  return null
}

/**
 * Applies a move locally (used for optimistic updates). Issues keep their relative order and are
 * inserted before `beforeKey` in the target when given, otherwise appended. Closed sprints are
 * never touched; moving into one is ignored.
 */
export function applyMove(data: PlanningData, keys: readonly string[], target: MoveTarget, beforeKey?: string | null): PlanningData {
  if (target.kind === 'sprint') {
    const t = data.sprints.find((s) => s.id === target.id)
    if (!t || t.state === 'closed') return data
  }
  const wanted = new Set(keys)
  const moving: PlanIssue[] = []
  const take = (list: PlanIssue[]) => list.filter((i) => {
    if (wanted.has(i.key)) { if (!moving.some((m) => m.key === i.key)) moving.push(i); return false }
    return true
  })
  let backlogIssues = take(data.backlog.issues)
  let sprints = data.sprints.map((s) => (s.state === 'closed' ? s : withTotals(s, take(s.issues))))
  if (moving.length === 0) return data
  // keep the order the caller asked for
  moving.sort((a, b) => keys.indexOf(a.key) - keys.indexOf(b.key))

  const insert = (list: PlanIssue[]) => {
    const at = beforeKey ? list.findIndex((i) => i.key === beforeKey) : -1
    return at >= 0 ? [...list.slice(0, at), ...moving, ...list.slice(at)] : [...list, ...moving]
  }
  const fromBacklog = data.backlog.issues.filter((i) => wanted.has(i.key)).length
  if (target.kind === 'backlog') backlogIssues = insert(backlogIssues)
  else sprints = sprints.map((s) => (s.id === target.id ? withTotals(s, insert(s.issues)) : s))

  const total = data.backlog.total - fromBacklog + (target.kind === 'backlog' ? moving.length : 0)
  return {
    ...data,
    sprints,
    backlog: { total: Math.max(total, backlogIssues.length), storyPoints: data.backlog.storyPoints - sumPoints(data.backlog.issues.filter((i) => wanted.has(i.key))) + (target.kind === 'backlog' ? sumPoints(moving) : 0), issues: backlogIssues },
  }
}

/** Issue added by the inline create row, in the backlog or at the end of a sprint. */
export function applyCreate(data: PlanningData, issue: PlanIssue, target: MoveTarget): PlanningData {
  if (target.kind === 'backlog') {
    return { ...data, backlog: { total: data.backlog.total + 1, storyPoints: data.backlog.storyPoints + (issue.storyPoints ?? 0), issues: [issue, ...data.backlog.issues] } }
  }
  return { ...data, sprints: data.sprints.map((s) => (s.id === target.id && s.state !== 'closed' ? withTotals(s, [...s.issues, issue]) : s)) }
}

/* ---------------- drag and drop ids ---------------- */

export const sprintDropId = (id: number) => `sprint-${id}`
export const BACKLOG_DROP_ID = 'backlog'
export const issueDragId = (key: string) => `issue:${key}`

export function parseDropId(id: string | number | null | undefined): { target: MoveTarget; beforeKey?: string } | null {
  const s = String(id ?? '')
  if (s === BACKLOG_DROP_ID) return { target: { kind: 'backlog' } }
  const sp = /^sprint-(\d+)$/.exec(s)
  if (sp) return { target: { kind: 'sprint', id: Number(sp[1]) } }
  return null
}

/* ---------------- sprint completion ---------------- */

export function splitCompletion(issues: ReadonlyArray<PlanIssue>) {
  const done = issues.filter((i) => i.category === 'done')
  const incomplete = issues.filter((i) => i.category !== 'done')
  return { done, incomplete, donePoints: sumPoints(done), incompletePoints: sumPoints(incomplete) }
}

/* ---------------- sprint forms ---------------- */

export interface SprintForm { name: string; goal: string; startDate: string; endDate: string }
export type SprintFormErrors = Partial<Record<keyof SprintForm, string>>

/** `requireDates` is true when starting a sprint. Dates are `YYYY-MM-DD` from date inputs. */
export function validateSprintForm(f: SprintForm, opts: { requireDates?: boolean } = {}): SprintFormErrors {
  const errors: SprintFormErrors = {}
  if (!f.name.trim()) errors.name = 'Sprint name is required'
  else if (f.name.trim().length > 255) errors.name = 'Sprint name must be at most 255 characters'
  if (f.goal.length > 2000) errors.goal = 'Goal must be at most 2000 characters'
  if (opts.requireDates && !f.startDate) errors.startDate = 'Start date is required'
  if (opts.requireDates && !f.endDate) errors.endDate = 'End date is required'
  if (f.startDate && f.endDate && f.endDate <= f.startDate) errors.endDate = 'End date must be after the start date'
  return errors
}

/** Local date input value (YYYY-MM-DD) to an ISO timestamp: start of day, or end of day for end dates. */
export function dateInputToIso(value: string, edge: 'start' | 'end'): string | null {
  if (!value) return null
  const d = new Date(`${value}T${edge === 'start' ? '00:00:00' : '23:59:00'}`)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/** ISO timestamp to the value of a date input, in local time. */
export function isoToDateInput(iso?: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** "Sprint 4" when the board already has "Sprint 3"; "Sprint 1" otherwise. */
export function suggestSprintName(sprints: ReadonlyArray<{ name: string }>): string {
  let max = 0
  for (const s of sprints) {
    const m = /(\d+)\s*$/.exec(s.name.trim())
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `Sprint ${max + 1}`
}

export function addDays(dateInput: string, days: number): string {
  const d = new Date(`${dateInput}T12:00:00`)
  d.setDate(d.getDate() + days)
  return isoToDateInput(d.toISOString())
}

export function formatSprintDates(start?: string, end?: string): string {
  const f = (iso?: string) => (iso ? new Date(iso).toLocaleDateString(getIntlLocale(), { day: 'numeric', month: 'short' }) : null)
  const a = f(start)
  const b = f(end)
  if (a && b) return `${a} – ${b}`
  return a || b || 'No dates set'
}
