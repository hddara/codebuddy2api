/**
 * Time formatting for the session pages.
 *
 * Why this is one module: the three pages each grew their own version, and they
 * disagreed about the same instant. A turn completed 30 seconds ago read as
 * "30 秒前" in the list, "刚刚" in the detail header, and "2026/10/7 15:30:00" on
 * the transcript page — three answers to one question, decided by which screen
 * you happened to be looking at.
 *
 * The differences were not deliberate. They came from each page being written at
 * a different time with a different idea of how precise to be, and nothing tied
 * them together. Sharing the thresholds makes the app agree with itself and
 * gives one place to change if the wording needs to move.
 *
 * Precision increases with age, which is what a person actually wants: recent
 * things are worth counting ("3 分钟前"), old ones are worth dating
 * ("2026/10/4"). A single relative string for everything would put "1440 分钟前"
 * on something from yesterday.
 */

/** Below this, the relative form is more useful than a clock time. */
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Parses a timestamp, returning null rather than an Invalid Date. */
function parse(value: string | number | Date): Date | null {
  const parsed = value instanceof Date ? value : new Date(value)

  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/** Two-digit padding for clock output. */
const pad = (value: number): string => String(value).padStart(2, '0')

/**
 * Relative age, coarse enough to stay stable while a list sits on screen.
 *
 * Coarseness is deliberate: rounding to the minute means a visible list does not
 * have to re-render every second, and the exact second is never what the reader
 * is after. Seconds are still shown under a minute, because "0 分钟前" for
 * something that just happened reads as wrong.
 *
 * An unparseable value is returned unchanged: it is almost always the raw string
 * the API sent, and showing that is more useful than showing "Invalid Date".
 */
export function formatRelative(value: string | number | Date, now = Date.now()): string {
  const parsed = parse(value)

  if (!parsed)
    return String(value)

  const elapsed = now - parsed.getTime()

  // Clock skew, or a server slightly ahead of the phone. Reporting "-3 秒前"
  // would be nonsense, and the honest reading of a timestamp in the future is
  // that it just happened.
  if (elapsed < MINUTE)
    return elapsed < 0 ? '刚刚' : `${Math.max(1, Math.round(elapsed / 1000))} 秒前`

  if (elapsed < HOUR)
    return `${Math.round(elapsed / MINUTE)} 分钟前`

  if (elapsed < DAY)
    return `${Math.round(elapsed / HOUR)} 小时前`

  // Past a day the date itself is the useful part, so switch formats rather
  // than counting further: "5 天前" and "2026/10/2" carry the same information
  // and the date is the one that can be compared against something else.
  return formatDate(parsed)
}

/**
 * Calendar date, e.g. `2026/10/7`.
 *
 * Built by hand rather than through `toLocaleDateString`: the App runtime does
 * not guarantee full ICU data, so the locale-specific formatters can fall back
 * to US order (`10/7/2026`) and are not consistent across the devices this ships
 * to. The explicit order is the one the rest of the app uses.
 */
export function formatDate(value: string | number | Date): string {
  const parsed = parse(value)

  if (!parsed)
    return String(value)

  return `${parsed.getFullYear()}/${parsed.getMonth() + 1}/${parsed.getDate()}`
}

/**
 * Date and time to the second, e.g. `2026/10/7 15:30:00`.
 *
 * For the transcript page, where a turn is being inspected rather than skimmed
 * and the reader may be lining it up against a gateway log — so this one is
 * exact and does not round.
 */
export function formatDateTime(value: string | number | Date): string {
  const parsed = parse(value)

  if (!parsed)
    return String(value)

  return `${formatDate(parsed)} ${pad(parsed.getHours())}:${pad(parsed.getMinutes())}:${pad(parsed.getSeconds())}`
}

/**
 * Counts and token totals, shortened so a card keeps its shape.
 *
 * Raw values go to seven and nine digits on real traffic (a single session
 * reported `517158574` tokens), which either wraps onto a second line or pushes
 * the row's other figure out of the card. Two significant figures are enough to
 * compare sessions at a glance; the exact number is available from the API.
 */
export function formatCount(value: number): string {
  if (!Number.isFinite(value))
    return String(value)

  const sign = value < 0 ? '-' : ''
  const scaled = Math.abs(value)

  if (scaled >= 100_000_000)
    return `${sign}${trimZero((scaled / 100_000_000).toFixed(1))} 亿`

  if (scaled >= 10_000)
    return `${sign}${trimZero((scaled / 10_000).toFixed(scaled >= 1_000_000 ? 0 : 1))} 万`

  return String(value)
}

/** Drops a trailing `.0` so `5.0 亿` reads as `5 亿`. */
function trimZero(value: string): string {
  return value.endsWith('.0') ? value.slice(0, -2) : value
}
