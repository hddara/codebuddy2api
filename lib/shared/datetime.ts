/**
 * Time zone pinned to the operating region for every date rendered in the UI.
 *
 * Without an explicit `timeZone`, `Date#toLocaleString` resolves against the
 * ambient zone of whoever is running: the container reports UTC while a browser
 * in China reports UTC+8. A component that formats a timestamp during the
 * server render therefore emits different text than the client produces on
 * hydration, and React discards the subtree with error #418.
 *
 * Pinning the zone makes both sides agree, and it is also the honest choice for
 * an operations console: operators compare credential expiry and bucket labels
 * against the upstream reset windows, which are published in UTC+8.
 */
export const DISPLAY_TIME_ZONE = 'Asia/Shanghai';

interface FormatDateTimeOptions {
  timeZone?: string;
}

/**
 * Format an instant as a date and time for display.
 *
 * `value` accepts a Date, an epoch timestamp in milliseconds, or a parseable
 * string. Returns `''` for null/undefined/Invalid Date so callers can render
 * the result directly without an extra guard.
 */
export const formatDateTime = (
  value: Date | number | string | null | undefined,
  locale: string,
  { timeZone = DISPLAY_TIME_ZONE }: FormatDateTimeOptions = {},
): string => {
  if (value === null || value === undefined) return '';

  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) return '';

  return date.toLocaleString(locale, { timeZone });
};

/**
 * Format an instant as a time of day for display. Shares the zone with
 * {@link formatDateTime} so a page cannot mix two conventions by accident.
 */
export const formatTime = (
  value: Date | number | string | null | undefined,
  locale: string,
  { timeZone = DISPLAY_TIME_ZONE }: FormatDateTimeOptions = {},
): string => {
  if (value === null || value === undefined) return '';

  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) return '';

  return date.toLocaleTimeString(locale, { timeZone });
};

/**
 * Format an instant as a date for display, using the same zone as the helpers
 * above.
 */
export const formatDate = (
  value: Date | number | string | null | undefined,
  locale: string,
  { timeZone = DISPLAY_TIME_ZONE }: FormatDateTimeOptions = {},
): string => {
  if (value === null || value === undefined) return '';

  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) return '';

  return date.toLocaleDateString(locale, { timeZone });
};
