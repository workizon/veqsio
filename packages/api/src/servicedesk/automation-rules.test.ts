import { describe, test, expect } from 'bun:test'
import { validateRule, slaPercentReached, waitingExpired, renderRuleText, conditionsMatch, type RuleInput } from './automation-rules'

const base: RuleInput = { name: 'r', trigger: 'sla_breached', threshold: null, action: 'notify', params: {} }

describe('validateRule', () => {
  test('thresholds', () => {
    expect(validateRule({ ...base, trigger: 'sla_percent', threshold: 80 })).toBeNull()
    expect(validateRule({ ...base, trigger: 'sla_percent', threshold: 100 })).toContain('1 to 99')
    expect(validateRule({ ...base, trigger: 'sla_percent', threshold: null })).toContain('threshold')
    expect(validateRule({ ...base, trigger: 'waiting_days', threshold: 7, action: 'transition', params: { status: 'Closed' } })).toBeNull()
    expect(validateRule({ ...base, trigger: 'waiting_days', threshold: 0 })).toContain('days')
    expect(validateRule({ ...base, threshold: 5 })).toContain('no threshold')
  })
  test('actions need their parameters', () => {
    expect(validateRule({ ...base, action: 'reassign' })).toContain('reassign')
    expect(validateRule({ ...base, action: 'reassign', params: { userId: 3 } })).toBeNull()
    expect(validateRule({ ...base, action: 'priority' })).toContain('priority')
    expect(validateRule({ ...base, action: 'transition', params: { status: ' ' } })).toContain('status')
    expect(validateRule({ ...base, action: 'comment', params: {} })).toContain('comment')
  })
  test('after a customer reply only transition, notify or comment make sense', () => {
    expect(validateRule({ ...base, trigger: 'customer_reply', action: 'reassign', params: { userId: 1 } })).toContain('customer reply')
    expect(validateRule({ ...base, trigger: 'customer_reply', action: 'transition', params: { status: 'Reopened' } })).toBeNull()
  })
})

describe('due tests', () => {
  test('SLA percentage', () => {
    expect(slaPercentReached(80, 100, 80)).toBe(true)
    expect(slaPercentReached(79, 100, 80)).toBe(false)
    expect(slaPercentReached(10, 0, 50)).toBe(false)
  })
  test('waiting for the customer', () => {
    const now = Date.UTC(2026, 10, 12)
    expect(waitingExpired(now - 7 * 86_400_000, now, 7)).toBe(true)
    expect(waitingExpired(now - 6 * 86_400_000, now, 7)).toBe(false)
  })
  test('placeholders', () => {
    expect(renderRuleText('{{issue.key}} closed after {{days}} days {{x}}', { key: 'SD-1', days: 7 })).toBe('SD-1 closed after 7 days {{x}}')
  })
})

describe('new request rules', () => {
  const rule: RuleInput = { name: 'Printers', trigger: 'request_created', threshold: null, action: 'priority', params: { priorityId: 2 }, conditions: { contains: ['printer'] } }
  test('validation', () => {
    expect(validateRule(rule)).toBeNull()
    expect(validateRule({ ...rule, threshold: 3 })).toContain('no threshold')
    expect(validateRule({ ...rule, action: 'label', params: {} })).toContain('label')
    expect(validateRule({ ...rule, action: 'label', params: { labels: ['has space'] } })).toContain('label')
    expect(validateRule({ ...rule, action: 'label', params: { labels: ['printers'] } })).toBeNull()
    expect(validateRule({ ...rule, action: 'request_type', params: {} })).toContain('request type')
    expect(validateRule({ ...rule, trigger: 'sla_breached', action: 'label', params: { labels: ['x'] } })).toContain('new requests')
    expect(validateRule({ ...rule, trigger: 'sla_breached' })).toContain('Conditions')
    expect(validateRule({ ...rule, conditions: { contains: new Array(21).fill('a') } })).toContain('20 keywords')
  })
  test('conditions', () => {
    const req = { summary: 'Printer on floor 3 jams', description: 'paper', channel: 'email', requestTypeId: 5 }
    expect(conditionsMatch({ contains: ['PRINTER', 'scanner'] }, req)).toBe(true)
    expect(conditionsMatch({ contains: ['vpn'] }, req)).toBe(false)
    expect(conditionsMatch({ channel: 'portal' }, req)).toBe(false)
    expect(conditionsMatch({ requestTypeId: 5, contains: ['paper'] }, req)).toBe(true)
    expect(conditionsMatch({}, req)).toBe(true)
    expect(conditionsMatch(null, req)).toBe(true)
  })
})
