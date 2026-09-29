import { readStorageJson } from '../storage';

/**
 * Level gating for diagnostics. `CODEBUDDY_LOG_LEVEL` is a runtime setting, so
 * it is read straight from the persisted config document instead of through
 * `domain/config`, which imports `domain/credentials` and would create an
 * import cycle with the credential selection logging. The result is cached
 * briefly because the read hits the storage backend and this module is called
 * from the request hot path.
 */
export type ProxyLogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const LOG_LEVEL_ORDER: Record<ProxyLogLevel, number> = {
  DEBUG: 10,
  ERROR: 40,
  INFO: 20,
  WARN: 30,
};

export const LOG_LEVEL_CACHE_TTL_MS = 5000;
export const MAX_LOG_TEXT_LENGTH = 2000;

let cachedLogLevel: { expiresAt: number; level: ProxyLogLevel } | null = null;

export const normalizeLogLevel = (value: unknown): ProxyLogLevel => {
  const normalized = String(value ?? '')
    .trim()
    .toUpperCase();

  if (
    normalized === 'DEBUG' ||
    normalized === 'INFO' ||
    normalized === 'WARN' ||
    normalized === 'ERROR'
  ) {
    return normalized;
  }

  return 'INFO';
};

export const getActiveLogLevel = async (): Promise<ProxyLogLevel> => {
  const now = Date.now();

  if (cachedLogLevel && cachedLogLevel.expiresAt > now) {
    return cachedLogLevel.level;
  }

  let level: ProxyLogLevel;

  try {
    const persisted = await readStorageJson<{ CODEBUDDY_LOG_LEVEL?: string }>(
      'config',
      'runtime',
    );
    level = normalizeLogLevel(
      persisted?.CODEBUDDY_LOG_LEVEL ?? process.env.CODEBUDDY_LOG_LEVEL,
    );
  } catch {
    level = normalizeLogLevel(process.env.CODEBUDDY_LOG_LEVEL);
  }

  cachedLogLevel = { expiresAt: now + LOG_LEVEL_CACHE_TTL_MS, level };

  return level;
};

export const resetLogLevelCache = (): void => {
  cachedLogLevel = null;
};

export const isLogLevelEnabled = (
  level: ProxyLogLevel,
  activeLevel: ProxyLogLevel,
): boolean => LOG_LEVEL_ORDER[level] >= LOG_LEVEL_ORDER[activeLevel];

export const truncateLogText = (
  value: string,
  limit: number = MAX_LOG_TEXT_LENGTH,
): string =>
  value.length > limit
    ? `${value.slice(0, limit)}...[truncated ${value.length - limit} chars]`
    : value;

const SENSITIVE_LOG_HEADERS = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'set-cookie',
  'x-api-key',
  'x-user-id',
]);

const MAX_LOGGED_HEADER_LENGTH = 200;

export const summarizeLogHeaders = (
  headers: HeadersInit | undefined,
): Record<string, string> | undefined => {
  if (!headers) {
    return undefined;
  }

  const entries = [...new Headers(headers).entries()].filter(
    ([name, value]) =>
      !SENSITIVE_LOG_HEADERS.has(name.toLowerCase()) &&
      value.length <= MAX_LOGGED_HEADER_LENGTH,
  );

  return entries.length ? Object.fromEntries(entries) : undefined;
};

export const logEvent = async ({
  level,
  message,
  payload,
}: {
  level: ProxyLogLevel;
  message: string;
  payload?: Record<string, unknown>;
}): Promise<void> => {
  if (!isLogLevelEnabled(level, await getActiveLogLevel())) {
    return;
  }

  const line = `[CodeBuddy2API][${level}] ${message}`;

  if (level === 'ERROR') {
    console.error(line, payload ?? '');
    return;
  }

  if (level === 'WARN') {
    console.warn(line, payload ?? '');
    return;
  }

  console.log(line, payload ?? '');
};
