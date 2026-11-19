import { describe, test, expect } from 'bun:test'
import {
  evaluate, requiredApprovals, validateRuleSpec, pendingApprovers, computeExpiry, firstReminderAt, nextReminderAfter,
  isExpired, isReminderDue, parseAutoRule, matchesAutoRule, evaluateAutoRules, type DecisionLike,
} from './engine'

const A = (id: number): DecisionLike => ({ approverId: id, decision: 'approved' })
const D = (id: number): DecisionLike => ({ approverId: id, decision: 'declined' })

describe('requiredApprovals', () => {
  test('per rule', () => {
    expect(requiredApprovals({ rule: 'all' }, 4)).toBe(4)
    expect(requiredApprovals({ rule: 'any' }, 4)).toBe(1)
    expect(requiredApprovals({ rule: 'n_of_m', threshold: 2 }, 4)).toBe(2)
    expect(requiredApprovals({ rule: 'n_of_m', threshold: 9 }, 4)).toBe(4)
    expect(requiredApprovals({ rule: 'percentage', threshold: 50 }, 5)).toBe(3)
    expect(requiredApprovals({ rule: 'percentage', threshold: 1 }, 5)).toBe(1)
    expect(requiredApprovals({ rule: 'percentage', threshold: 100 }, 5)).toBe(5)
    expect(requiredApprovals({ rule: 'all' }, 0)).toBe(0)
  })
})

describe('evaluate', () => {
  const ids = [1, 2, 3]
  test('all: needs everybody, one decline ends it early', () => {
    expect(evaluate({ rule: 'all' }, ids, [])).toBe('pending')
    expect(evaluate({ rule: 'all' }, ids, [A(1), A(2)])).toBe('pending')
    expect(evaluate({ rule: 'all' }, ids, [A(1), A(2), A(3)])).toBe('approved')
    expect(evaluate({ rule: 'all' }, ids, [D(2)])).toBe('declined')
  })
  test('any: one approval is enough, declined only when nobody can approve', () => {
    expect(evaluate({ rule: 'any' }, ids, [A(3)])).toBe('approved')
    expect(evaluate({ rule: 'any' }, ids, [D(1)])).toBe('pending')
    expect(evaluate({ rule: 'any' }, ids, [D(1), D(2)])).toBe('pending')
    expect(evaluate({ rule: 'any' }, ids, [D(1), D(2), D(3)])).toBe('declined')
    expect(evaluate({ rule: 'any' }, ids, [D(1), D(2), A(3)])).toBe('approved')
  })
  test('n_of_m with early decline once the threshold is unreachable', () => {
    const spec = { rule: 'n_of_m', threshold: 2 } as const
    expect(evaluate(spec, ids, [A(1)])).toBe('pending')
    expect(evaluate(spec, ids, [A(1), A(2)])).toBe('approved')
    expect(evaluate(spec, ids, [D(1)])).toBe('pending') // 2 left, both could still approve
    expect(evaluate(spec, ids, [D(1), D(2)])).toBe('declined') // only 1 left, 2 needed
    expect(evaluate(spec, ids, [D(1), A(2)])).toBe('pending')
    expect(evaluate(spec, ids, [D(1), A(2), A(3)])).toBe('approved')
  })
  test('percentage', () => {
    const spec = { rule: 'percentage', threshold: 60 } as const
    const five = [1, 2, 3, 4, 5] // 3 needed
    expect(evaluate(spec, five, [A(1), A(2)])).toBe('pending')
    expect(evaluate(spec, five, [A(1), A(2), A(3)])).toBe('approved')
    expect(evaluate(spec, five, [D(1), D(2)])).toBe('pending')
    expect(evaluate(spec, five, [D(1), D(2), D(3)])).toBe('declined')
  })
  test('ignores strangers and duplicate decisions, first decision wins', () => {
    expect(evaluate({ rule: 'any' }, ids, [A(99)])).toBe('pending')
    expect(evaluate({ rule: 'all' }, [1], [D(1), A(1)])).toBe('declined')
    expect(evaluate({ rule: 'all' }, [1, 1], [A(1)])).toBe('approved') // duplicate approver ids collapse
  })
  test('no approvers is never approved', () => {
    expect(evaluate({ rule: 'any' }, [], [A(1)])).toBe('pending')
  })
  test('approved wins when the threshold is reached', () => {
    expect(evaluate({ rule: 'n_of_m', threshold: 1 }, [1, 2], [D(1), A(2)])).toBe('approved')
  })
})

describe('validateRuleSpec', () => {
  test('accepts and rejects', () => {
    expect(validateRuleSpec({ rule: 'all' }, 3)).toBeNull()
    expect(validateRuleSpec({ rule: 'all', threshold: 2 }, 3)).not.toBeNull()
    expect(validateRuleSpec({ rule: 'n_of_m', threshold: 2 }, 3)).toBeNull()
    expect(validateRuleSpec({ rule: 'n_of_m', threshold: 4 }, 3)).not.toBeNull()
    expect(validateRuleSpec({ rule: 'n_of_m' }, 3)).not.toBeNull()
    expect(validateRuleSpec({ rule: 'percentage', threshold: 0 }, 3)).not.toBeNull()
    expect(validateRuleSpec({ rule: 'percentage', threshold: 101 }, 3)).not.toBeNull()
    expect(validateRuleSpec({ rule: 'percentage', threshold: 50 }, 3)).toBeNull()
    expect(validateRuleSpec({ rule: 'bogus' as any }, 3)).not.toBeNull()
  })
})

describe('pendingApprovers', () => {
  test('lists approvers without a decision', () => {
    expect(pendingApprovers([1, 2, 3], [A(2)])).toEqual([1, 3])
  })
})

describe('reminders and expiry', () => {
  const t0 = new Date('2026-01-01T00:00:00Z')
  test('expiry and first reminder', () => {
    expect(computeExpiry(t0, 48)?.toISOString()).toBe('2026-01-03T00:00:00.000Z')
    expect(computeExpiry(t0, null)).toBeNull()
    expect(computeExpiry(t0, 0)).toBeNull()
    expect(firstReminderAt(t0, 24)?.toISOString()).toBe('2026-01-02T00:00:00.000Z')
    expect(firstReminderAt(t0, undefined)).toBeNull()
    expect(nextReminderAfter(t0, 6).toISOString()).toBe('2026-01-01T06:00:00.000Z')
  })
  test('isExpired boundary', () => {
    expect(isExpired(t0, t0)).toBe(true)
    expect(isExpired(new Date(t0.getTime() + 1), t0)).toBe(false)
    expect(isExpired(null, t0)).toBe(false)
  })
  test('isReminderDue', () => {
    const now = new Date('2026-01-02T00:00:00Z')
    const base = { status: 'pending', nextReminderAt: new Date('2026-01-02T00:00:00Z'), expiresAt: null }
    expect(isReminderDue(base, now)).toBe(true)
    expect(isReminderDue({ ...base, nextReminderAt: new Date(now.getTime() + 1000) }, now)).toBe(false)
    expect(isReminderDue({ ...base, status: 'approved' }, now)).toBe(false)
    expect(isReminderDue({ ...base, nextReminderAt: null }, now)).toBe(false)
    expect(isReminderDue({ ...base, expiresAt: new Date(now.getTime() - 1) }, now)).toBe(false)
    expect(isReminderDue({ ...base, expiresAt: new Date(now.getTime() + 1000) }, now)).toBe(true)
  })
})

describe('auto rules', () => {
  test('parseAutoRule validates untrusted input', () => {
    expect(parseAutoRule(null)).toEqual({ ok: true, rule: null })
    expect(parseAutoRule({ field: 'priority', op: 'eq', value: 'Low' })).toEqual({ ok: true, rule: { field: 'priority', op: 'eq', value: 'Low' } })
    expect(parseAutoRule({ field: 'priority', op: 'in', value: ['Low', 'Lowest'] }).ok).toBe(true)
    expect(parseAutoRule({ field: 'priority', op: 'in', value: 'Low' }).ok).toBe(false)
    expect(parseAutoRule({ field: 'summary', op: 'eq', value: 'x' }).ok).toBe(false)
    expect(parseAutoRule({ field: 'priority', op: 'regex', value: 'x' }).ok).toBe(false)
    expect(parseAutoRule({ field: 'priority', op: 'eq', value: 'x', extra: 1 }).ok).toBe(false)
    expect(parseAutoRule('x').ok).toBe(false)
    expect(parseAutoRule([]).ok).toBe(false)
  })
  test('matching is case insensitive and fails closed on missing values', () => {
    const eq = { field: 'priority', op: 'eq', value: 'low' } as const
    expect(matchesAutoRule(eq, { priority: 'Low' })).toBe(true)
    expect(matchesAutoRule(eq, { priority: 'High' })).toBe(false)
    expect(matchesAutoRule(eq, { priority: null })).toBe(false)
    expect(matchesAutoRule({ field: 'priority', op: 'neq', value: 'low' }, { priority: null })).toBe(false)
    expect(matchesAutoRule({ field: 'priority', op: 'neq', value: 'low' }, { priority: 'High' })).toBe(true)
    expect(matchesAutoRule({ field: 'issuetype', op: 'in', value: ['Task', 'Bug'] }, { issuetype: 'bug' })).toBe(true)
    expect(matchesAutoRule(null, { priority: 'Low' })).toBe(false)
  })
  test('decline wins over approve', () => {
    const low = { field: 'priority', op: 'eq', value: 'Low' } as const
    expect(evaluateAutoRules(low, null, { priority: 'Low' })).toBe('approved')
    expect(evaluateAutoRules(null, low, { priority: 'Low' })).toBe('declined')
    expect(evaluateAutoRules(low, low, { priority: 'Low' })).toBe('declined')
    expect(evaluateAutoRules(low, null, { priority: 'High' })).toBeNull()
  })
})
