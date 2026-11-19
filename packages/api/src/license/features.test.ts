import { describe, expect, test } from 'bun:test'
import { ENTERPRISE_FEATURES, FEATURE_LABELS, PLAN_FEATURES, featureLabel, isEnterpriseFeature, requiredPlan } from './features'

describe('feature catalogue', () => {
  test('every enterprise feature has a label and no duplicates', () => {
    expect(new Set(ENTERPRISE_FEATURES).size).toBe(ENTERPRISE_FEATURES.length)
    for (const f of ENTERPRISE_FEATURES) expect(FEATURE_LABELS[f]).toBeTruthy()
    expect(Object.keys(FEATURE_LABELS).sort()).toEqual([...ENTERPRISE_FEATURES].sort())
  })

  test('branding (hiding the Powered by credit) is enterprise only', () => {
    expect(isEnterpriseFeature('branding')).toBe(true)
    expect(PLAN_FEATURES.enterprise).toContain('branding')
    expect(PLAN_FEATURES.team).not.toContain('branding')
    expect(PLAN_FEATURES.community).not.toContain('branding')
    expect(requiredPlan('branding')).toBe('enterprise')
    expect(featureLabel('branding')).toMatch(/branding/i)
  })

  test('the enterprise plan grants every listed feature', () => {
    expect([...PLAN_FEATURES.enterprise].sort()).toEqual([...ENTERPRISE_FEATURES].sort())
  })
})
