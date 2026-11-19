import { describe, expect, test } from 'bun:test'
import { assertSchemaUpToDate, evaluateSchemaState, guardEnabled, readAppliedMigrations } from './schema-guard'

describe('schema guard', () => {
  test('no ledger or empty ledger is refused with guidance', () => {
    for (const applied of [null, 0]) {
      const s = evaluateSchemaState(applied, 3)
      expect(s.ok).toBe(false)
      if (!s.ok) { expect(s.reason).toBe('no-history'); expect(s.message).toContain('migrate') }
    }
  })

  test('fewer applied than expected is outdated', () => {
    const s = evaluateSchemaState(2, 3)
    expect(s.ok).toBe(false)
    if (!s.ok) { expect(s.reason).toBe('outdated'); expect(s.message).toContain('2 of 3') }
  })

  test('equal or newer database passes', () => {
    expect(evaluateSchemaState(3, 3).ok).toBe(true)
    expect(evaluateSchemaState(5, 3).ok).toBe(true)
  })

  test('guard is on in production or when requested, off for dev, tests and SKIP_SCHEMA_CHECK', () => {
    expect(guardEnabled({ NODE_ENV: 'production' })).toBe(true)
    expect(guardEnabled({ REQUIRE_MIGRATIONS: '1' })).toBe(true)
    expect(guardEnabled({})).toBe(false)
    expect(guardEnabled({ NODE_ENV: 'production', SKIP_SCHEMA_CHECK: '1' })).toBe(false)
  })

  test('assertSchemaUpToDate does not touch the database when disabled', async () => {
    let calls = 0
    const r = await assertSchemaUpToDate(async () => { calls++; return [] }, {})
    expect(r).toBeNull()
    expect(calls).toBe(0)
  })

  test('assertSchemaUpToDate throws on a database without a ledger when enabled', async () => {
    await expect(assertSchemaUpToDate(async () => [], { NODE_ENV: 'production' })).rejects.toThrow('[schema]')
  })

  test('readAppliedMigrations returns null without the ledger table and the count with it', async () => {
    expect(await readAppliedMigrations(async () => [])).toBeNull()
    const answers = [[{ x: 1 }], [{ n: 4 }]]
    expect(await readAppliedMigrations(async () => answers.shift()!)).toBe(4)
  })
})
