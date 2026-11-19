import { describe, expect, it } from 'bun:test'
import { movingAverage } from '../components/charts/bar-trend'

describe('movingAverage', () => {
  it('averages a trailing window, shorter at the start', () => {
    const d = [{ v: 2 }, { v: 4 }, { v: 6 }, { v: 8 }]
    expect(movingAverage(d, 'v', 2)).toEqual([2, 3, 5, 7])
    expect(movingAverage(d, 'v', 10)).toEqual([2, 3, 4, 5])
  })
  it('treats a missing key as zero', () => {
    expect(movingAverage([{ a: 1 }, {}], 'a', 2)).toEqual([1, 0.5])
  })
})
