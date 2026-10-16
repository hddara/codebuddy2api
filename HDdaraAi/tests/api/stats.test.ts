import { describe, expect, it } from 'vitest'

import { maxUsageCount, toUsageRows, usageShare } from '@/api/stats'

/**
 * The gateway returns counts keyed by credential filename and model id, in
 * whatever order it walked its files. Everything here is about turning that into
 * something a person can read: an order they can act on, and bar widths that do
 * not vanish on a quiet week.
 */

describe('toUsageRows', () => {
  it('sorts by count, largest first', () => {
    // Insertion order is the server's file-walk order, which is meaningless to
    // a reader — sorting by count is the only ordering anyone can act on.
    const rows = toUsageRows({ alpha: 3, beta: 40, gamma: 12 })

    expect(rows.map(row => row.label)).toEqual(['beta', 'gamma', 'alpha'])
    expect(rows[0].count).toBe(40)
  })

  it('breaks ties by label, so the list does not reshuffle between loads', () => {
    const rows = toUsageRows({ zebra: 5, apple: 5 })

    expect(rows.map(row => row.label)).toEqual(['apple', 'zebra'])
  })

  it('returns an empty list for a missing map', () => {
    expect(toUsageRows(undefined)).toEqual([])
  })

  it('returns an empty list for an empty map', () => {
    expect(toUsageRows({})).toEqual([])
  })
})

describe('maxUsageCount', () => {
  it('finds the largest count', () => {
    expect(maxUsageCount([{ count: 2, label: 'a' }, { count: 9, label: 'b' }])).toBe(9)
  })

  it('is zero for an empty list, so nothing divides by zero', () => {
    expect(maxUsageCount([])).toBe(0)
  })
})

describe('usageShare', () => {
  it('scales a row against the largest one', () => {
    // Relative rather than absolute: an absolute scale would make every bar
    // invisible on a quiet week, which is exactly when the page gets opened.
    expect(usageShare(50, 100)).toBe(50)
    expect(usageShare(100, 100)).toBe(100)
  })

  it('rounds to whole percentages', () => {
    expect(usageShare(1, 3)).toBe(33)
  })

  it('returns zero when there is nothing to scale against', () => {
    expect(usageShare(0, 0)).toBe(0)
    expect(usageShare(5, 0)).toBe(0)
  })
})
