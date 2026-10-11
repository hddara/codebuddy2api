import { describe, expect, it } from 'vitest'

import { formatCount, formatDate, formatDateTime, formatRelative } from '@/utils/format'

/** A fixed instant, so nothing depends on when the suite runs. */
const NOW = Date.parse('2026-10-11T12:00:00.000Z')
const ago = (ms: number): string => new Date(NOW - ms).toISOString()

const SECOND = 1_000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

describe('formatRelative', () => {
  it('counts seconds under a minute', () => {
    // "0 分钟前" for something that just happened reads as wrong, so the second
    // form is kept for this window.
    expect(formatRelative(ago(1 * SECOND), NOW)).toBe('1 秒前')
    expect(formatRelative(ago(30 * SECOND), NOW)).toBe('30 秒前')
    expect(formatRelative(ago(59 * SECOND), NOW)).toBe('59 秒前')
  })

  it('never reports less than one second', () => {
    expect(formatRelative(ago(0), NOW)).toBe('1 秒前')
  })

  it('reads a future timestamp as just now', () => {
    // Clock skew between the server and the phone is normal; "-3 秒前" would be
    // nonsense, and the honest reading is that it just happened.
    expect(formatRelative(new Date(NOW + 5 * SECOND).toISOString(), NOW)).toBe('刚刚')
  })

  it('counts minutes under an hour', () => {
    expect(formatRelative(ago(MINUTE), NOW)).toBe('1 分钟前')
    expect(formatRelative(ago(59 * MINUTE), NOW)).toBe('59 分钟前')
  })

  it('counts hours under a day', () => {
    expect(formatRelative(ago(HOUR), NOW)).toBe('1 小时前')
    expect(formatRelative(ago(23 * HOUR), NOW)).toBe('23 小时前')
  })

  it('switches to a date past a day rather than counting further', () => {
    // "1440 分钟前" is the failure this threshold exists to avoid.
    const result = formatRelative(ago(2 * DAY), NOW)

    expect(result).not.toContain('前')
    expect(result).toMatch(/^\d{4}\/\d{1,2}\/\d{1,2}$/)
  })

  it('returns an unparseable value unchanged', () => {
    // Showing the string the API sent is more useful than "Invalid Date".
    expect(formatRelative('not-a-date', NOW)).toBe('not-a-date')
    expect(formatRelative('', NOW)).toBe('')
  })
})

describe('formatDate', () => {
  it('uses the explicit Y/M/D order, not a locale one', () => {
    // `toLocaleDateString` is not guaranteed full ICU data in the App runtime
    // and can produce US order, which this asserts against.
    expect(formatDate(new Date(2026, 9, 7))).toBe('2026/10/7')
  })

  it('does not zero-pad, matching the rest of the app', () => {
    expect(formatDate(new Date(2026, 0, 5))).toBe('2026/1/5')
  })

  it('returns an unparseable value unchanged', () => {
    expect(formatDate('nonsense')).toBe('nonsense')
  })
})

describe('formatDateTime', () => {
  it('pads the clock to two digits', () => {
    expect(formatDateTime(new Date(2026, 9, 7, 5, 3, 9))).toBe('2026/10/7 05:03:09')
  })

  it('is exact, because this one is inspected rather than skimmed', () => {
    expect(formatDateTime(new Date(2026, 9, 7, 15, 30, 0))).toBe('2026/10/7 15:30:00')
  })

  it('returns an unparseable value unchanged', () => {
    expect(formatDateTime('nonsense')).toBe('nonsense')
  })
})

describe('formatCount', () => {
  it('leaves small numbers alone', () => {
    expect(formatCount(0)).toBe('0')
    expect(formatCount(999)).toBe('999')
    expect(formatCount(9_999)).toBe('9999')
  })

  it('shortens thousands into 万', () => {
    // A real session reported 517158574 tokens; the raw value wrapped the row.
    expect(formatCount(10_000)).toBe('1 万')
    expect(formatCount(15_000)).toBe('1.5 万')
    expect(formatCount(517_158)).toBe('51.7 万')
  })

  it('drops the decimal past a million so the figure stays short', () => {
    expect(formatCount(1_000_000)).toBe('100 万')
    expect(formatCount(5_171_585)).toBe('517 万')
  })

  it('shortens hundreds of millions into 亿', () => {
    expect(formatCount(100_000_000)).toBe('1 亿')
    expect(formatCount(517_158_574)).toBe('5.2 亿')
  })

  it('trims a trailing .0', () => {
    // "5.0 亿" reads worse than "5 亿".
    expect(formatCount(500_000_000)).toBe('5 亿')
  })

  it('keeps the sign', () => {
    expect(formatCount(-15_000)).toBe('-1.5 万')
  })

  it('passes through values that are not finite', () => {
    expect(formatCount(Number.NaN)).toBe('NaN')
    expect(formatCount(Number.POSITIVE_INFINITY)).toBe('Infinity')
  })
})
