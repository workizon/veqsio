/** Pure helpers for the SLA screens (durations, condition catalogue, display state). */

/** "4h 30m", "90m", "1d 2h", "2:30" or a bare number (minutes) -> minutes; null if not understood. */
export function parseDuration(input: string): number | null {
  const text = input.trim().toLowerCase()
  if (!text) return null
  if (/^\d+$/.test(text)) return Number(text) || null
  const clock = /^(\d+):([0-5]\d)$/.exec(text)
  if (clock) return Number(clock[1]) * 60 + Number(clock[2]) || null
  const m = /^(?:(\d+)\s*d)?\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?$/.exec(text)
  if (!m || (m[1] === undefined && m[2] === undefined && m[3] === undefined)) return null
  const total = Number(m[1] ?? 0) * 1440 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)
  return total > 0 ? total : null
}

/** 270 -> "4h 30m", 45 -> "45m", 120 -> "2h". */
export function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h === 0) return `${m}m`
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

export type Block = 'start' | 'pause' | 'stop'

export type ConditionEvent =
  | 'issue_created' | 'status_entered' | 'status_exited' | 'comment_customer' | 'comment_agent'
  | 'resolution_set' | 'resolution_cleared' | 'assignee_set' | 'assignee_cleared' | 'priority_changed'
  | 'waiting_for_customer'

export interface Condition { event: ConditionEvent; statusIds?: number[]; restart?: boolean }

export const NEEDS_STATUSES: ConditionEvent[] = ['status_entered', 'status_exited']

/** Options per block. Start/stop are events, pause conditions are states (the clock is paused while they hold). */
export const CONDITION_OPTIONS: Record<Block, Array<{ event: ConditionEvent; label: string }>> = {
  start: [
    { event: 'issue_created', label: 'Issue created' },
    { event: 'status_entered', label: 'Status: entered' },
    { event: 'status_exited', label: 'Status: exited' },
    { event: 'comment_customer', label: 'Comment: by customer (public)' },
    { event: 'comment_agent', label: 'Comment: by agent, public reply to customer' },
    { event: 'resolution_set', label: 'Resolution: set' },
    { event: 'resolution_cleared', label: 'Resolution: cleared' },
    { event: 'assignee_set', label: 'Assignee: set' },
    { event: 'assignee_cleared', label: 'Assignee: cleared' },
    { event: 'priority_changed', label: 'Priority: changed' },
  ],
  pause: [
    { event: 'status_entered', label: 'Status: in one of' },
    { event: 'waiting_for_customer', label: 'Status: Waiting for customer' },
    { event: 'status_exited', label: 'Status: not in any of' },
    { event: 'assignee_cleared', label: 'Assignee: unassigned' },
    { event: 'assignee_set', label: 'Assignee: assigned' },
    { event: 'resolution_set', label: 'Resolution: set' },
    { event: 'resolution_cleared', label: 'Resolution: not set' },
    { event: 'comment_agent', label: 'Comment: agent replied, until the customer replies' },
    { event: 'comment_customer', label: 'Comment: customer replied, until an agent replies' },
  ],
  stop: [
    { event: 'status_entered', label: 'Status: entered' },
    { event: 'status_exited', label: 'Status: exited' },
    { event: 'comment_agent', label: 'Comment: by agent, public reply to customer' },
    { event: 'comment_customer', label: 'Comment: by customer (public)' },
    { event: 'resolution_set', label: 'Resolution: set' },
    { event: 'resolution_cleared', label: 'Resolution: cleared' },
    { event: 'assignee_set', label: 'Assignee: set' },
    { event: 'assignee_cleared', label: 'Assignee: cleared' },
    { event: 'priority_changed', label: 'Priority: changed' },
    { event: 'waiting_for_customer', label: 'Entering "Waiting for customer"' },
  ],
}

export function conditionLabel(block: Block, event: ConditionEvent): string {
  return CONDITION_OPTIONS[block].find((o) => o.event === event)?.label ?? event
}

export const BLOCK_TEXT: Record<Block, { title: string; hint: string }> = {
  start: { title: 'Start counting time on', hint: 'The clock starts the first time any of these happens.' },
  pause: { title: 'Pause counting time while', hint: 'The clock is paused as long as any of these is true.' },
  stop: { title: 'Stop counting time on', hint: 'The clock stops the first time any of these happens after it started.' },
}

/** Validation messages for one block (empty when valid). */
export function validateConditions(block: Block, list: Condition[]): string[] {
  const errs: string[] = []
  if (block !== 'pause' && list.length === 0) errs.push(`Add at least one ${block} condition`)
  for (const c of list) {
    if (NEEDS_STATUSES.includes(c.event) && !c.statusIds?.length) errs.push(`${conditionLabel(block, c.event)}: pick at least one status`)
  }
  return errs
}

export interface SlaLike {
  status: 'running' | 'paused' | 'warning' | 'met' | 'breached'
  breached: boolean
  elapsedMs: number
  targetMs: number
  remainingMs: number
}

export type SlaTone = 'ok' | 'warning' | 'danger' | 'muted' | 'met'

export function slaTone(s: SlaLike): SlaTone {
  if (s.status === 'met') return 'met'
  if (s.status === 'breached' || s.breached) return 'danger'
  if (s.status === 'warning') return 'warning'
  if (s.status === 'paused') return 'muted'
  return 'ok'
}

/** Percent of the goal used, clamped to 0-100. */
export function slaProgress(s: Pick<SlaLike, 'elapsedMs' | 'targetMs'>): number {
  if (s.targetMs <= 0) return 100
  return Math.max(0, Math.min(100, (s.elapsedMs / s.targetMs) * 100))
}
