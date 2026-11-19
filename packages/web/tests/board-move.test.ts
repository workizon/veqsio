import { describe, test, expect } from 'bun:test'
import { planBoardMove, noRouteMessage } from '../lib/board-move'
import type { TransitionLike } from '../lib/issue-view'

const t = (id: number, name: string, toId: number, toName: string, extra: Partial<TransitionLike> = {}): TransitionLike => ({ id, name, to: { id: toId, name: toName }, ...extra })

describe('planBoardMove (dropping a card on a board column)', () => {
  const start = t(1, 'Start Progress', 2, 'In Progress')
  const resolve = t(2, 'Resolve', 3, 'Resolved', { requiresResolution: true, requiresInput: true })

  test('a transition without input runs directly', () => {
    expect(planBoardMove([start, resolve], 2)).toEqual({ kind: 'direct', transition: start })
  })

  test('a transition that needs a resolution opens the dialog instead of being refused (In Progress to Done)', () => {
    const plan = planBoardMove([resolve], 3)
    expect(plan.kind).toBe('input')
    expect((plan as { transition: TransitionLike }).transition.id).toBe(2)
  })

  test('needs-input is also detected from a comment, a screen or an extra required field', () => {
    expect(planBoardMove([t(5, 'Close', 4, 'Closed', { requiresComment: true })], 4).kind).toBe('input')
    expect(planBoardMove([t(6, 'Close', 4, 'Closed', { hasScreen: true })], 4).kind).toBe('input')
    expect(planBoardMove([t(7, 'Close', 4, 'Closed', { requiredFields: ['fixVersions'] })], 4).kind).toBe('input')
  })

  test('prefers a route without input when both exist', () => {
    const quick = t(8, 'Quick close', 3, 'Resolved')
    expect(planBoardMove([resolve, quick], 3)).toEqual({ kind: 'direct', transition: quick })
  })

  test('no transition to the column: reports where the issue can go (In Progress back to To Do)', () => {
    const plan = planBoardMove([resolve], 1)
    expect(plan).toEqual({ kind: 'none', reachable: ['Resolved'] })
  })

  test('lists each reachable status once', () => {
    const plan = planBoardMove([start, t(9, 'Start again', 2, 'In Progress'), resolve], 99)
    expect(plan).toEqual({ kind: 'none', reachable: ['In Progress', 'Resolved'] })
  })

  test('no transitions at all', () => {
    expect(planBoardMove([], 1)).toEqual({ kind: 'none', reachable: [] })
  })
})

describe('noRouteMessage', () => {
  test('names the reachable statuses', () => {
    expect(noRouteMessage('DEMO-27', 'In Progress', 'To Do', ['Resolved'])).toBe('DEMO-27 cannot move from In Progress to To Do in this workflow. From In Progress it can go to: Resolved.')
  })
  test('says so when nothing is possible', () => {
    expect(noRouteMessage('DEMO-1', 'Closed', 'To Do', [])).toBe('DEMO-1 cannot move from Closed to To Do in this workflow. No transitions are available from Closed.')
  })
})
