/** Sprint automation (board.config.sprintAutomation): create the next sprint and carry unfinished work over when a sprint is completed. */

export interface SprintAutomation {
  autoCreateNext: boolean
  /** Length of an automatically created sprint in days. */
  durationDays: number
  /** Where unfinished issues go when the caller does not say: the next sprint or the backlog. */
  autoMoveIncomplete: 'next' | 'backlog'
}

export const DEFAULT_AUTOMATION: SprintAutomation = { autoCreateNext: false, durationDays: 14, autoMoveIncomplete: 'backlog' }

export function parseSprintAutomation(config: unknown): SprintAutomation {
  const raw = config && typeof config === 'object' ? (config as Record<string, unknown>).sprintAutomation : undefined
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_AUTOMATION }
  const r = raw as Record<string, unknown>
  const days = Number(r.durationDays)
  return {
    autoCreateNext: r.autoCreateNext === true,
    durationDays: Number.isInteger(days) && days >= 1 && days <= 90 ? days : DEFAULT_AUTOMATION.durationDays,
    autoMoveIncomplete: r.autoMoveIncomplete === 'next' ? 'next' : 'backlog',
  }
}

/** "Sprint 12" -> "Sprint 13"; a name without a trailing number gets " 2" appended; empty -> "Sprint 1". */
export function nextSprintName(lastName: string | null | undefined): string {
  const name = (lastName ?? '').trim()
  if (!name) return 'Sprint 1'
  const m = /^(.*?)(\d+)\s*$/.exec(name)
  if (m) return `${m[1]}${Number(m[2]) + 1}`
  return `${name} 2`
}

export const DAY_MS = 86_400_000

/** Dates of the next sprint: it starts when the previous one was completed and lasts `durationDays`. */
export function nextSprintDates(from: Date, durationDays: number): { startDate: Date; endDate: Date } {
  const start = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()))
  return { startDate: start, endDate: new Date(start.getTime() + durationDays * DAY_MS) }
}
