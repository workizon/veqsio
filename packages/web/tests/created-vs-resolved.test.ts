import { describe, expect, test } from 'bun:test'
import { bucketByPeriod } from '../components/gadgets/created-vs-resolved'

const day = (date: string, created: number, resolved = 0) => ({ date, created, resolved })

describe('bucketByPeriod', () => {
  test('daily leaves the days alone', () => {
    const d = [day('11-01', 1), day('11-02', 2)]
    expect(bucketByPeriod(d, 'daily')).toEqual(d)
  })
  test('weekly sums 7 days from the start and labels with the first day', () => {
    const d = Array.from({ length: 15 }, (_, i) => day(`11-${String(i + 1).padStart(2, '0')}`, 1, i === 0 ? 3 : 0))
    expect(bucketByPeriod(d, 'weekly')).toEqual([
      { date: '11-01', created: 7, resolved: 3 },
      { date: '11-08', created: 7, resolved: 0 },
      { date: '11-15', created: 1, resolved: 0 },
    ])
  })
  test('monthly starts a bucket whenever the month changes', () => {
    const d = [day('10-30', 2), day('10-31', 3), day('11-01', 4), day('11-02', 5, 1)]
    expect(bucketByPeriod(d, 'monthly')).toEqual([
      { date: '10-30', created: 5, resolved: 0 },
      { date: '11-01', created: 9, resolved: 1 },
    ])
  })
  test('empty input', () => { expect(bucketByPeriod([], 'weekly')).toEqual([]) })
})
