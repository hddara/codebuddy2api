/**
 * Policy knobs for session logging. The storage facade only takes explicit
 * values, so all environment parsing lives here — mirroring how usage retention
 * is handled in `usage.ts`.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULT_SESSION_RETENTION_DAYS = 30;
const DEFAULT_SESSION_MAX_TURNS = 200;
const SESSION_LOG_ENABLED_ENV = 'CODEBUDDY_SESSION_LOG_ENABLED';
const SESSION_MAX_TURNS_ENV = 'CODEBUDDY_SESSION_MAX_TURNS_PER_SESSION';
const SESSION_RETENTION_DAYS_ENV = 'CODEBUDDY_SESSION_RETENTION_DAYS';

const DISABLED_VALUES = new Set(['0', 'false', 'no', 'off']);

export interface SessionLogSettings {
  enabled: boolean;
  /** 0 means "keep every turn". */
  maxTurnsPerSession: number;
  /** 0 means "do not record sessions at all". */
  retentionDays: number;
}

const readBoolean = (raw: string | undefined, fallback: boolean): boolean => {
  const normalized = raw?.trim().toLowerCase();

  if (!normalized) {
    return fallback;
  }

  return !DISABLED_VALUES.has(normalized);
};

const readCount = (raw: string | undefined, fallback: number): number => {
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;

  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

export const getSessionLogSettings = (): SessionLogSettings => {
  const retentionDays = readCount(
    process.env[SESSION_RETENTION_DAYS_ENV],
    DEFAULT_SESSION_RETENTION_DAYS,
  );
  const maxTurnsPerSession = readCount(
    process.env[SESSION_MAX_TURNS_ENV],
    DEFAULT_SESSION_MAX_TURNS,
  );

  return {
    enabled:
      retentionDays > 0 &&
      readBoolean(process.env[SESSION_LOG_ENABLED_ENV], true),
    maxTurnsPerSession,
    retentionDays,
  };
};

/** Cutoff used by `trimStorageSessions`: anything older is deleted. */
export const getSessionRetentionStartMs = (
  nowMs: number,
  retentionDays: number,
): number => {
  return nowMs - retentionDays * DAY_MS;
};
