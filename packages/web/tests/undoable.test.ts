import { describe, test, expect } from 'bun:test'
import { Countdown, UndoController, undoReducer, bulkEditMode, type Scheduler } from '../lib/undoable'

/** Manual clock so tests never wait. */
function fakeScheduler() {
  let now = 0
  let nextHandle = 1
  const timers = new Map<number, { at: number; fn: () => void }>()
  const scheduler: Scheduler = {
    now: () => now,
    setTimeout: (fn, ms) => { const h = nextHandle++; timers.set(h, { at: now + ms, fn }); return h },
    clearTimeout: (h) => { timers.delete(h as number) },
  }
  const advance = (ms: number) => {
    const target = now + ms
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      timers.delete(due[0])
      now = due[1].at
      due[1].fn()
    }
    now = target
  }
  return { scheduler, advance, timerCount: () => timers.size }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('undoReducer', () => {
  test('pending can be undone or start committing', () => {
    expect(undoReducer('pending', 'undo')).toBe('undone')
    expect(undoReducer('pending', 'expire')).toBe('committing')
    expect(undoReducer('pending', 'dismiss')).toBe('committing')
  })
  test('commit outcome', () => {
    expect(undoReducer('committing', 'commit-ok')).toBe('committed')
    expect(undoReducer('committing', 'commit-fail')).toBe('failed')
  })
  test('undo is ignored once the commit started, and terminal states are sticky', () => {
    expect(undoReducer('committing', 'undo')).toBe('committing')
    expect(undoReducer('committed', 'undo')).toBe('committed')
    expect(undoReducer('undone', 'expire')).toBe('undone')
    expect(undoReducer('failed', 'undo')).toBe('failed')
  })
})

describe('Countdown', () => {
  test('fires after the duration', () => {
    const f = fakeScheduler()
    let done = 0
    const c = new Countdown(1000, () => { done++ }, f.scheduler)
    c.start()
    f.advance(999)
    expect(done).toBe(0)
    f.advance(1)
    expect(done).toBe(1)
    expect(c.finished).toBe(true)
  })
  test('pause keeps the remaining time and resume continues from it', () => {
    const f = fakeScheduler()
    let done = 0
    const c = new Countdown(1000, () => { done++ }, f.scheduler)
    c.start()
    f.advance(400)
    c.pause()
    expect(c.fraction()).toBeCloseTo(0.6, 5)
    f.advance(10_000)
    expect(done).toBe(0)
    c.resume()
    f.advance(599)
    expect(done).toBe(0)
    f.advance(1)
    expect(done).toBe(1)
  })
  test('cancel stops it', () => {
    const f = fakeScheduler()
    let done = 0
    const c = new Countdown(500, () => { done++ }, f.scheduler)
    c.start()
    c.cancel()
    f.advance(1000)
    expect(done).toBe(0)
    expect(f.timerCount()).toBe(0)
  })
})

describe('UndoController deferred commit', () => {
  test('applies at once, commits after the window and settles as committed', async () => {
    const f = fakeScheduler()
    const log: string[] = []
    const c = new UndoController(f.scheduler)
    const id = c.start({
      message: 'deleted',
      apply: () => { log.push('apply') },
      commit: () => { log.push('commit') },
      revert: () => { log.push('revert') },
      onSettled: (s) => { log.push(`settled:${s}`) },
    })
    expect(log).toEqual(['apply'])
    expect(c.pendingCount).toBe(1)
    f.advance(5999)
    await tick()
    expect(log).toEqual(['apply'])
    f.advance(1)
    await tick()
    expect(log).toEqual(['apply', 'commit', 'settled:committed'])
    expect(c.stateOf(id)).toBeUndefined()
  })

  test('undo before the window closes reverts and never commits', async () => {
    const f = fakeScheduler()
    const log: string[] = []
    const c = new UndoController(f.scheduler)
    const id = c.start({ message: 'x', apply: () => { log.push('apply') }, commit: () => { log.push('commit') }, revert: () => { log.push('revert') }, onSettled: (s) => { log.push(s) } })
    f.advance(2000)
    await c.undo(id)
    f.advance(60_000)
    await tick()
    expect(log).toEqual(['apply', 'revert', 'undone'])
  })

  test('a failing commit reverts the optimistic change and reports the error', async () => {
    const f = fakeScheduler()
    const log: string[] = []
    const c = new UndoController(f.scheduler)
    c.start({
      message: 'x',
      commit: () => { throw new Error('boom') },
      revert: () => { log.push('revert') },
      onError: (e, phase) => { log.push(`${phase}:${(e as Error).message}`) },
      onSettled: (s) => { log.push(s) },
    })
    f.advance(6000)
    await tick()
    expect(log).toEqual(['commit:boom', 'revert', 'failed'])
  })

  test('dismiss and flushAll commit immediately', async () => {
    const f = fakeScheduler()
    const log: string[] = []
    const c = new UndoController(f.scheduler)
    const a = c.start({ message: 'a', commit: () => { log.push('a') } })
    c.start({ message: 'b', commit: () => { log.push('b') } })
    await c.dismiss(a)
    expect(log).toEqual(['a'])
    await c.flushAll()
    expect(log).toEqual(['a', 'b'])
    expect(c.pendingCount).toBe(0)
  })

  test('pause stops the timer, resume restarts it, undo after commit is ignored', async () => {
    const f = fakeScheduler()
    const log: string[] = []
    const c = new UndoController(f.scheduler)
    const id = c.start({ message: 'x', commit: () => { log.push('commit') }, revert: () => { log.push('revert') }, delayMs: 1000 })
    f.advance(500)
    c.pause(id)
    f.advance(5000)
    await tick()
    expect(log).toEqual([])
    c.resume(id)
    f.advance(500)
    await tick()
    expect(log).toEqual(['commit'])
    await c.undo(id)
    expect(log).toEqual(['commit'])
  })
})

describe('UndoController external clock', () => {
  test('does not expire on its own; expire() commits', async () => {
    const f = fakeScheduler()
    const log: string[] = []
    const c = new UndoController(f.scheduler)
    const id = c.start({ message: 'x', commit: () => { log.push('commit') } }, { external: true })
    f.advance(60_000)
    await tick()
    expect(log).toEqual([])
    await c.expire(id)
    expect(log).toEqual(['commit'])
  })
})

describe('UndoController immediate mode', () => {
  test('undo runs the inverse; letting it expire does nothing more', async () => {
    const f = fakeScheduler()
    const log: string[] = []
    const c = new UndoController(f.scheduler)
    const id = c.start({ message: 'unassigned', undo: () => { log.push('reassign') } })
    await c.undo(id)
    expect(log).toEqual(['reassign'])

    const id2 = c.start({ message: 'unassigned', undo: () => { log.push('reassign2') } })
    f.advance(6000)
    await tick()
    expect(log).toEqual(['reassign'])
    expect(c.stateOf(id2)).toBeUndefined()
  })
  test('an inverse that throws is reported', async () => {
    const f = fakeScheduler()
    const errors: string[] = []
    const c = new UndoController(f.scheduler)
    const id = c.start({ message: 'x', undo: () => { throw new Error('nope') }, onError: (e, p) => { errors.push(`${p}:${(e as Error).message}`) } })
    await c.undo(id)
    expect(errors).toEqual(['undo:nope'])
  })
})

describe('bulkEditMode', () => {
  test('small batches get undo, larger ones a confirmation', () => {
    expect(bulkEditMode(1)).toBe('undo')
    expect(bulkEditMode(10)).toBe('undo')
    expect(bulkEditMode(11)).toBe('confirm')
    expect(bulkEditMode(3, 2)).toBe('confirm')
  })
})
