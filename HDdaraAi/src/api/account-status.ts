import type { CredentialListItem } from './credentials'
import { consoleGet, consolePost } from './core/console'

/**
 * Per-account usage: remaining credits, package windows, daily check-in, and the
 * models each account can reach.
 *
 * The gateway gathers this by asking each upstream account in turn, so a single
 * call costs one round trip per credential — slow, and partial when any one of
 * them fails. Every account therefore carries its own `error` rather than the
 * whole response failing, and the screens are expected to show the accounts that
 * answered alongside the ones that did not.
 */

/** One cronet package in the account's billing window. */
export interface CreditPackage {
  capacityRemain: number | null
  capacitySize: number | null
  capacityUsed: number | null
  cycleEndTime: string | null
  cycleStartTime: string | null
  packageName: string | null
  /** `3` means expired; those are excluded from the totals below. */
  status: number | null
}

export interface AccountCredits {
  /** Usable packages joined with ` + `. */
  plan: string | null
  /**
   * Every package, including expired ones.
   *
   * Kept separate from the totals on purpose: a list that silently dropped
   * expired rows left users unable to tell a lapsed plan from a missing one.
   */
  packages: CreditPackage[]
  remaining: number | null
  /** Earliest `cycleEndTime` among the usable packages. */
  resetAt: string | null
  total: number | null
  /** Non-expired package count — what the totals below are computed over. */
  usablePackageCount: number
  used: number | null
}

/** The full upstream snapshot for one credential. */
export interface AccountStatusSnapshot {
  checkin: { claimed: boolean | null, message: string | null }
  credits: AccountCredits
  /** Present when part of the snapshot could not be gathered. */
  error: string | null
  /** Joins this snapshot to its entry in `credentials`. */
  filename: string
  models: string[]
  queriedAt: string
}

export interface AccountStatusPayload {
  credentials: CredentialListItem[]
  statuses: AccountStatusSnapshot[]
}

/** Reads every account's status. Slow: one upstream round trip per credential. */
export async function fetchAccountStatus(): Promise<AccountStatusPayload> {
  return consoleGet<AccountStatusPayload>('/admin-api/account-status')
}

/**
 * Claims the daily check-in.
 *
 * With a filename only that account is claimed; without one the server claims
 * each in turn. A claim that upstream rejects because it was already taken today
 * is reported as success, so a repeat press is harmless.
 */
export async function claimCheckin(filename?: string): Promise<AccountStatusPayload> {
  return consolePost<AccountStatusPayload>(
    '/admin-api/account-status',
    filename ? { action: 'checkin', filename } : { action: 'checkin' },
  )
}

/**
 * Formats a credit amount the way the totals read.
 *
 * The upstream reports fractional credits, and a raw `1234.5699999999999` on a
 * card is noise — two decimals is what a person compares.
 */
export function formatCredits(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return '—'
  }

  return value.toLocaleString('zh-CN', {
    maximumFractionDigits: 2,
    minimumFractionDigits: 0,
  })
}

/**
 * How much of the allowance is left, as 0–100.
 *
 * Returns null when the figure cannot be trusted — an unbounded plan reports a
 * zero total, and drawing that as an empty bar would read as "used up".
 */
export function creditPercentage(credits: AccountCredits): number | null {
  const { remaining, total } = credits

  if (remaining === null || total === null || !Number.isFinite(total) || total <= 0) {
    return null
  }

  return Math.min(100, Math.max(0, Math.round((remaining / total) * 100)))
}
