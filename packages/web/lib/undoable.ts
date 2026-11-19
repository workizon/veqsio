/**
 * Undo support without any React or DOM: a pausable countdown and an undo state machine/controller.
 * `hooks/use-undoable.ts` wires these to the toast UI.
 *
 * Two patterns are supported:
 *  - deferred commit (`commit` runs after the undo window, `revert` rolls the optimistic UI back); used for
 *    destructive calls that cannot be inverted, such as deleting an issue.
 *  - immediate commit with an inverse (`undo` runs when the user clicks Undo); used for reversible edits.
 */

export interface Scheduler {
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
  now: () => number
}

export const realScheduler: Scheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
}

/** Countdown that can be paused (hover, focus) and resumed without losing elapsed time. */
export class Countdown {
  private remaining: number
  private startedAt = 0
  private handle: unknown = null
  private done = false

  constructor(
    private readonly total: number,
    private readonly onDone: () => void,
    private readonly scheduler: Scheduler = realScheduler,
  ) {
    this.remaining = total
  }

  get running() { return this.handle !== null }
  get finished() { return this.done }

  start() {
    if (this.done || this.handle !== null) return
    this.startedAt = this.scheduler.now()
    this.handle = this.scheduler.setTimeout(() => {
      this.handle = null
      this.remaining = 0
      this.done = true
      this.onDone()
    }, this.remaining)
  }

  pause() {
    if (this.handle === null) return
    this.scheduler.clearTimeout(this.handle)
    this.handle = null
    this.remaining = Math.max(0, this.remaining - (this.scheduler.now() - this.startedAt))
  }

  resume() { this.start() }

  cancel() {
    if (this.handle !== null) this.scheduler.clearTimeout(this.handle)
    this.handle = null
    this.done = true
  }

  /** Fraction of time left, 0..1, for the progress bar. */
  fraction(): number {
    const left = this.handle === null ? this.remaining : Math.max(0, this.remaining - (this.scheduler.now() - this.startedAt))
    return this.total <= 0 ? 0 : Math.min(1, left / this.total)
  }
}

/* ------------------------------------------------------------------ */
/*  State machine                                                      */
/* ------------------------------------------------------------------ */

export type UndoState = 'pending' | 'committing' | 'committed' | 'undone' | 'failed'
export type UndoEvent = 'undo' | 'expire' | 'dismiss' | 'commit-ok' | 'commit-fail'

/**
 * pending --undo--> undone
 * pending --expire|dismiss--> committing --commit-ok--> committed
 *                                        --commit-fail--> failed
 * Undo after the commit started is ignored (too late); every other combination is a no-op.
 */
export function undoReducer(state: UndoState, event: UndoEvent): UndoState {
  switch (state) {
    case 'pending':
      if (event === 'undo') return 'undone'
      if (event === 'expire' || event === 'dismiss') return 'committing'
      return state
    case 'committing':
      if (event === 'commit-ok') return 'committed'
      if (event === 'commit-fail') return 'failed'
      return state
    default:
      return state
  }
}

export interface UndoableAction {
  /** Short sentence for the toast, for example "Issue VEQ-12 deleted". */
  message: string
  /** Optimistic UI change, run immediately (deferred mode). */
  apply?: () => void | Promise<void>
  /** Deferred mode: the real call, run once the window closes. */
  commit?: () => void | Promise<void>
  /** Deferred mode: roll the optimistic UI back when the user clicks Undo or the commit fails. */
  revert?: () => void | Promise<void>
  /** Immediate mode: inverse operation, run when the user clicks Undo. */
  undo?: () => void | Promise<void>
  /** Called when the whole thing ended (committed, undone or failed). */
  onSettled?: (state: UndoState) => void
  /** Called when commit or undo throws. */
  onError?: (error: unknown, phase: 'commit' | 'undo') => void
  delayMs?: number
}

export const DEFAULT_UNDO_MS = 6000

interface Entry {
  id: number
  action: UndoableAction
  state: UndoState
  countdown: Countdown
}

/** Owns the undo windows. UI code only calls start/undo/expire/dismiss/pause/resume/flushAll. */
export class UndoController {
  private entries = new Map<number, Entry>()
  private seq = 0

  constructor(private readonly scheduler: Scheduler = realScheduler) {}

  get pendingCount(): number {
    return [...this.entries.values()].filter((e) => e.state === 'pending').length
  }

  stateOf(id: number): UndoState | undefined { return this.entries.get(id)?.state }

  fraction(id: number): number { return this.entries.get(id)?.countdown.fraction() ?? 0 }

  /**
   * Runs `apply` right away and opens the undo window. Returns the entry id.
   * With `external` the caller (the toast, which pauses on hover) owns the clock and calls `expire`.
   */
  start(action: UndoableAction, opts: { external?: boolean } = {}): number {
    const id = ++this.seq
    const countdown = new Countdown(action.delayMs ?? DEFAULT_UNDO_MS, () => void this.send(id, 'expire'), this.scheduler)
    this.entries.set(id, { id, action, state: 'pending', countdown })
    void Promise.resolve(action.apply?.()).catch((e) => action.onError?.(e, 'commit'))
    if (!opts.external) countdown.start()
    return id
  }

  pause(id: number) { this.entries.get(id)?.countdown.pause() }
  resume(id: number) { const e = this.entries.get(id); if (e?.state === 'pending') e.countdown.resume() }

  undo(id: number) { return this.send(id, 'undo') }
  expire(id: number) { return this.send(id, 'expire') }
  dismiss(id: number) { return this.send(id, 'dismiss') }

  /** Commits everything still pending (page is closing or the user navigated away). */
  async flushAll() {
    const pending = [...this.entries.values()].filter((e) => e.state === 'pending')
    await Promise.all(pending.map((e) => this.send(e.id, 'dismiss')))
  }

  private async send(id: number, event: UndoEvent) {
    const entry = this.entries.get(id)
    if (!entry) return
    const next = undoReducer(entry.state, event)
    if (next === entry.state) return
    entry.state = next
    const { action } = entry
    entry.countdown.cancel()

    if (next === 'undone') {
      try {
        await (action.undo ?? action.revert)?.()
      } catch (e) {
        action.onError?.(e, 'undo')
      }
      this.finish(entry)
      return
    }

    if (next === 'committing') {
      try {
        await action.commit?.()
        entry.state = undoReducer(entry.state, 'commit-ok')
      } catch (e) {
        entry.state = undoReducer(entry.state, 'commit-fail')
        action.onError?.(e, 'commit')
        try { await action.revert?.() } catch { /* the UI refetches anyway */ }
      }
      this.finish(entry)
    }
  }

  private finish(entry: Entry) {
    this.entries.delete(entry.id)
    entry.action.onSettled?.(entry.state)
  }
}

/** Bulk edits: undo is only offered for small batches; larger ones ask for confirmation first. */
export const BULK_UNDO_LIMIT = 10

export function bulkEditMode(count: number, limit = BULK_UNDO_LIMIT): 'undo' | 'confirm' {
  return count <= limit ? 'undo' : 'confirm'
}
