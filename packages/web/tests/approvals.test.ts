import { describe, test, expect } from 'bun:test'
import { emptyTemplateForm, ruleLabel, templateBody, validateTemplateForm, STATUS_LABEL } from '../lib/approvals'

describe('approvals UI helpers', () => {
  test('rule labels', () => {
    expect(ruleLabel('all')).toContain('All')
    expect(ruleLabel('n_of_m', 2)).toBe('2 approvers must approve')
    expect(ruleLabel('percentage', 60)).toBe('60% of approvers must approve')
  })
  test('template form validation', () => {
    const f = emptyTemplateForm()
    expect(Object.keys(validateTemplateForm(f)).sort()).toEqual(['approvers', 'name'])
    const ok = { ...f, name: 'Manager', approverUserIds: [1] }
    expect(validateTemplateForm(ok)).toEqual({})
    expect(validateTemplateForm({ ...ok, rule: 'n_of_m' }).ruleThreshold).toBeDefined()
    expect(validateTemplateForm({ ...ok, rule: 'percentage', ruleThreshold: '150' }).ruleThreshold).toBeDefined()
    expect(validateTemplateForm({ ...ok, expiryHours: 'abc' }).expiryHours).toBeDefined()
    expect(validateTemplateForm({ ...ok, autoApproveField: 'priority' }).autoApproveValue).toBeDefined()
  })
  test('request body drops empty values and unused thresholds', () => {
    const b = templateBody({ ...emptyTemplateForm(), name: ' M ', approverUserIds: [3], ruleThreshold: '2', expiryHours: '48', autoApproveField: 'priority', autoApproveValue: 'Low' })
    expect(b.name).toBe('M')
    expect(b.ruleThreshold).toBeNull() // rule is "all"
    expect(b.expiryHours).toBe(48)
    expect(b.reminderIntervalHours).toBeNull()
    expect(b.autoApproveWhen).toEqual({ field: 'priority', op: 'eq', value: 'Low' })
    expect(b.autoDeclineWhen).toBeNull()
  })
  test('every status has a label', () => {
    expect(Object.keys(STATUS_LABEL).sort()).toEqual(['approved', 'cancelled', 'declined', 'expired', 'pending'])
  })
})
