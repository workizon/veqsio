import { describe, it, expect } from 'bun:test'
import { makeCheck, summarize } from './health-check'

describe('health check helpers', () => {
  const base = { id: 'x', severity: 'warning' as const, title: 't', detail: 'bad', okDetail: 'good' }
  it('is ok when there are no offenders and limits examples to 10', () => {
    expect(makeCheck(base, [])).toMatchObject({ severity: 'ok', detail: 'good', count: 0, items: [] })
    const c = makeCheck(base, Array.from({ length: 25 }, (_, i) => `K-${i}`))
    expect(c).toMatchObject({ severity: 'warning', detail: 'bad', count: 25 })
    expect(c.items).toHaveLength(10)
  })
  it('summarizes by worst severity', () => {
    const mk = (severity: any) => ({ id: 'i', severity, title: '', detail: '', count: 0, items: [] })
    expect(summarize([mk('ok'), mk('info')])).toMatchObject({ status: 'info' })
    expect(summarize([mk('warning'), mk('critical'), mk('ok')])).toMatchObject({ status: 'critical', counts: { ok: 1, info: 0, warning: 1, critical: 1 } })
    expect(summarize([]).status).toBe('ok')
  })
})
