import { truncateLogText } from './log';

/**
 * Upstream rate limit classification.
 *
 * Observed production payload for a throttled credential (2026-09-30):
 * `{"code":6004,"msg":"您的使用量已超出频率限制，将在 2026-10-01 00:36:46 UTC+8 重置，您也可以切换其他模型继续使用。","requestId":"..."}`
 * with HTTP 429. The message carries an explicit reset instant, so the cooldown
 * can follow the quota window instead of guessing a backoff.
 */
export type RateLimitKind = 'frequency' | 'quota';

export interface RateLimitSignal {
  code: number | null;
  kind: RateLimitKind;
  reason: string | null;
  resumeAt: number;
}

export const MIN_RATE_LIMIT_COOLDOWN_MS = 60 * 1000;
/**
 * Upper bound for every cooldown, so a mark always releases itself even when
 * the upstream promises a later reset. Operators can override it through the
 * `CODEBUDDY_CREDENTIAL_LIMIT_HOURS` runtime setting (12 hours by default).
 */
export const DEFAULT_MAX_RATE_LIMIT_COOLDOWN_MS = 12 * 60 * 60 * 1000;
export const DEFAULT_FREQUENCY_COOLDOWN_MS = 5 * 60 * 1000;
export const DEFAULT_QUOTA_COOLDOWN_MS = 60 * 60 * 1000;
export const MAX_RATE_LIMIT_REASON_LENGTH = 500;

/** CodeBuddy messages render their reset instant in UTC+8 when no zone is given. */
const DEFAULT_RESET_OFFSET_MINUTES = 8 * 60;

const CODE_KEYS = new Set([
  'code',
  'error_code',
  'errorcode',
  'errno',
  'sub_code',
  'subcode',
]);
const MESSAGE_KEYS = new Set([
  'detail',
  'error',
  'error_description',
  'message',
  'msg',
  'reason',
]);
const RESET_KEYS = new Set([
  'cycleendtime',
  'nextresetat',
  'nextresettime',
  'quota_reset_at',
  'reset_at',
  'resetat',
  'reset_time',
  'resettime',
  'resume_at',
  'resumeat',
  'retry_after',
  'retryafter',
]);

const QUOTA_PATTERN =
  /使用量已超出|超出(了)?(使用量|额度|配额|限制)|额度|配额|quota|exceeded|exhausted|insufficient|credit/i;
const FREQUENCY_PATTERN =
  /频率|频繁|rate\s*limit|too\s*many\s*requests|frequency|throttl/i;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const parseJsonDetail = (detail: string): Record<string, unknown> | null => {
  const trimmed = detail.trim();

  if (!trimmed.startsWith('{')) {
    return null;
  }

  try {
    return asRecord(JSON.parse(trimmed));
  } catch {
    return null;
  }
};

const findNestedValue = (
  value: unknown,
  keys: Set<string>,
  depth = 0,
): unknown => {
  if (depth > 3) return undefined;

  const record = asRecord(value);

  if (!record) return undefined;

  for (const [key, entry] of Object.entries(record)) {
    if (!keys.has(key.toLowerCase())) continue;
    if (entry === undefined || entry === null || entry === '') continue;
    // Keep looking inside wrappers such as `{ error: { message } }`.
    if (typeof entry === 'object') continue;

    return entry;
  }

  for (const entry of Object.values(record)) {
    const nested = findNestedValue(entry, keys, depth + 1);

    if (nested !== undefined && nested !== '') {
      return nested;
    }
  }

  return undefined;
};

/** Accepts epoch milliseconds, epoch seconds, or a relative offset in seconds. */
const toEpochMs = (value: unknown, now: number): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value >= 1e12) return Math.round(value);
    if (value >= 1e9) return Math.round(value * 1000);
    if (value > 0) return now + Math.round(value * 1000);

    return null;
  }

  if (typeof value !== 'string') return null;

  const trimmed = value.trim();

  if (!trimmed) return null;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return toEpochMs(Number(trimmed), now);

  const parsed = Date.parse(trimmed);

  return Number.isFinite(parsed) ? parsed : null;
};

const parseResetTimeFromText = (text: string): number | null => {
  const isoMatch = text.match(
    /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})/,
  );

  if (isoMatch) {
    const parsed = Date.parse(isoMatch[0]);

    if (Number.isFinite(parsed)) return parsed;
  }

  const localMatch = text.match(
    /(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(?:UTC|GMT)?\s*([+-]\d{1,2})?(?::(\d{2}))?/i,
  );

  if (!localMatch) return null;

  const [, year, month, day, hour, minute, second, offsetHour, offsetMinute] =
    localMatch;
  const base = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second ?? 0),
  );

  if (!Number.isFinite(base)) return null;

  const offsetMinutes =
    offsetHour === undefined
      ? DEFAULT_RESET_OFFSET_MINUTES
      : (String(offsetHour).startsWith('-') ? -1 : 1) *
        (Math.abs(Number(offsetHour)) * 60 + Number(offsetMinute ?? 0));

  return base - offsetMinutes * 60 * 1000;
};

const parseRetryAfter = (
  header: string | null | undefined,
  now: number,
): number | null => {
  const trimmed = header?.trim();

  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) return now + Number(trimmed) * 1000;

  const parsed = Date.parse(trimmed);

  return Number.isFinite(parsed) ? parsed : null;
};

const clampResumeAt = (
  resumeAt: number,
  now: number,
  maxCooldownMs: number,
): number => {
  const upperBound = now + Math.max(maxCooldownMs, MIN_RATE_LIMIT_COOLDOWN_MS);

  return Math.min(
    Math.max(resumeAt, now + MIN_RATE_LIMIT_COOLDOWN_MS),
    upperBound,
  );
};

const resolveReason = (
  payload: Record<string, unknown> | null,
  detail: string,
): string | null => {
  const message = payload ? findNestedValue(payload, MESSAGE_KEYS) : undefined;

  if (typeof message === 'string' && message.trim()) {
    return truncateLogText(message.trim(), MAX_RATE_LIMIT_REASON_LENGTH);
  }

  const trimmed = detail.trim();

  return trimmed
    ? truncateLogText(trimmed, MAX_RATE_LIMIT_REASON_LENGTH)
    : null;
};

const resolveKind = ({
  explicitResumeAt,
  haystack,
}: {
  explicitResumeAt: number | null;
  haystack: string;
}): RateLimitKind => {
  // A scheduled reset instant means a quota window, not a short burst limit.
  if (explicitResumeAt !== null) return 'quota';
  if (QUOTA_PATTERN.test(haystack)) return 'quota';
  if (FREQUENCY_PATTERN.test(haystack)) return 'frequency';

  return 'frequency';
};

export const parseRateLimitSignal = ({
  status,
  detail,
  maxCooldownMs = DEFAULT_MAX_RATE_LIMIT_COOLDOWN_MS,
  retryAfter,
}: {
  status: number;
  detail?: string | null;
  maxCooldownMs?: number;
  retryAfter?: string | null;
}): RateLimitSignal | null => {
  if (status !== 429) return null;

  const now = Date.now();
  const text = String(detail ?? '');
  const payload = parseJsonDetail(text);
  const reason = resolveReason(payload, text);
  const structuredResumeAt = payload
    ? toEpochMs(findNestedValue(payload, RESET_KEYS), now)
    : null;
  const explicitResumeAt =
    structuredResumeAt ??
    parseResetTimeFromText(text) ??
    parseRetryAfter(retryAfter, now);
  const haystack = `${text}\n${reason ?? ''}`;
  const kind = resolveKind({ explicitResumeAt, haystack });
  const fallbackDelay =
    kind === 'quota'
      ? DEFAULT_QUOTA_COOLDOWN_MS
      : DEFAULT_FREQUENCY_COOLDOWN_MS;
  const code = payload ? findNestedValue(payload, CODE_KEYS) : undefined;

  return {
    code: typeof code === 'number' ? code : null,
    kind,
    reason,
    resumeAt: clampResumeAt(
      explicitResumeAt ?? now + fallbackDelay,
      now,
      maxCooldownMs,
    ),
  };
};
