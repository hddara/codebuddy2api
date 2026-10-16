import { consoleGet } from './core/console'

/**
 * Gateway-side call counts, per credential and per model.
 *
 * A different question from the one `account-status` answers: that one asks the
 * upstream how much allowance is left, this one counts how much traffic this
 * gateway has actually served. The app showed only the first, so a user could
 * see their remaining credits but not which account was carrying the load or
 * which model was being used — the two facts that explain a rate limit.
 *
 * The window is fixed at seven days by the server, so the payload carries
 * counts rather than a time series.
 */

export interface UsageStats {
  /** Filename → call count, only for credentials that still exist. */
  credential_usage: Record<string, number>
  /** Model id → call count. */
  model_usage: Record<string, number>
}

/** Reads the seven-day call counts. */
export async function fetchUsageStats(): Promise<UsageStats> {
  return consoleGet<UsageStats>('/admin-api/stats')
}

export interface UsageRow {
  count: number
  label: string
}

/**
 * Turns a count map into a sorted list, largest first.
 *
 * `Record` iteration order follows insertion, which for this data is the order
 * the server happened to walk its credential files — meaningless to a reader.
 * Sorting by count is the only ordering a person can act on.
 *
 * Ties fall back to the label so the list does not reshuffle between reloads
 * when several entries have the same count.
 */
export function toUsageRows(counts: Record<string, number> | undefined): UsageRow[] {
  return Object.entries(counts ?? {})
    .map(([label, count]) => ({ count, label }))
    .sort((left, right) =>
      right.count - left.count || left.label.localeCompare(right.label))
}

/** The largest count in a list, or 0 when it is empty. Used to scale bars. */
export function maxUsageCount(rows: UsageRow[]): number {
  return rows.reduce((max, row) => Math.max(max, row.count), 0)
}

/**
 * A row's width as a percentage of the largest one.
 *
 * Relative rather than absolute: the point of the bar is to show which entry
 * dominates, and an absolute scale would make every bar invisible on a quiet
 * week. Returns 0 for an all-zero list so nothing divides by zero.
 */
export function usageShare(count: number, max: number): number {
  if (max <= 0) {
    return 0
  }

  return Math.round((count / max) * 100)
}
