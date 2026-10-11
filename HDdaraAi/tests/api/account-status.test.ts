import type { AccountCredits } from '@/api/account-status'

import { describe, expect, it } from 'vitest'
import { creditPercentage, formatCredits } from '@/api/account-status'

function credits(overrides: Partial<AccountCredits> = {}): AccountCredits {
  return {
    packages: [],
    plan: null,
    remaining: 0,
    resetAt: null,
    total: 0,
    usablePackageCount: 0,
    used: 0,
    ...overrides,
  }
}

describe('formatCredits', () => {
  it('rounds to two decimals so a card is readable', () => {
    // The upstream reports values like 1234.5699999999999; printing that raw is
    // noise on a card that exists to be compared at a glance.
    expect(formatCredits(1234.5699999999999)).toBe('1,234.57')
    expect(formatCredits(12.5)).toBe('12.5')
    expect(formatCredits(3)).toBe('3')
  })

  it('shows a dash rather than a zero when the figure is missing', () => {
    // Zero is a real reading ("nothing left"); absent is not, and rendering the
    // two the same way would report an unknown balance as an empty one.
    expect(formatCredits(null)).toBe('—')
    expect(formatCredits(Number.NaN)).toBe('—')
    expect(formatCredits(Number.POSITIVE_INFINITY)).toBe('—')
  })

  it('keeps a genuine zero', () => {
    expect(formatCredits(0)).toBe('0')
  })
})

describe('creditPercentage', () => {
  it('reports the share of the allowance still available', () => {
    expect(creditPercentage(credits({ remaining: 75, total: 100 }))).toBe(75)
    expect(creditPercentage(credits({ remaining: 1, total: 3 }))).toBe(33)
  })

  it('refuses to draw a bar it cannot trust', () => {
    // An unbounded plan reports a zero total. Drawing that as 0% would read as
    // "used up", which is the opposite of what it means — so there is no bar.
    expect(creditPercentage(credits({ remaining: 100, total: 0 }))).toBeNull()
    expect(creditPercentage(credits({ remaining: 100, total: null }))).toBeNull()
    expect(creditPercentage(credits({ remaining: null, total: 100 }))).toBeNull()
  })

  it('clamps to the range a bar can draw', () => {
    // Over-allowance happens when the plan changes mid-cycle.
    expect(creditPercentage(credits({ remaining: 150, total: 100 }))).toBe(100)
    expect(creditPercentage(credits({ remaining: -5, total: 100 }))).toBe(0)
  })
})
