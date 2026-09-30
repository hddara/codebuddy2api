import { logEvent } from '../shared/log';
import { getAccountStatus } from './account-status';

/**
 * Periodic quota sampling. The upstream quota endpoint is only queried when an
 * operator opens the account status page, which produces isolated observations
 * and makes the reset cadence impossible to read. Sampling every credential on
 * a fixed interval turns the raw payload captured by `account-status` into a
 * usable series.
 *
 * Each run also emits one compact summary line per credential so the allowance
 * movement can be read without parsing the full payloads.
 */

const ENABLED_ENV = 'CODEBUDDY_QUOTA_SNAPSHOT_ENABLED';
const INTERVAL_ENV = 'CODEBUDDY_QUOTA_SNAPSHOT_INTERVAL_MINUTES';
const DEFAULT_INTERVAL_MINUTES = 360;
const MIN_INTERVAL_MINUTES = 5;
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;
const FIRST_RUN_DELAY_MS = 60_000;

interface QuotaSnapshotRuntime {
  enabled: boolean;
  intervalMs: number;
  lastRunAt: number | null;
  nextRunAt: number | null;
  running: boolean;
  sampledCount: number | null;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface QuotaSnapshotStatus {
  enabled: boolean;
  intervalMinutes: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
  running: boolean;
  sampledCount: number | null;
}

const globalQuotaSnapshotState = globalThis as typeof globalThis & {
  __codebuddy2apiQuotaSnapshot__?: QuotaSnapshotRuntime;
};

const getRuntime = (): QuotaSnapshotRuntime => {
  globalQuotaSnapshotState.__codebuddy2apiQuotaSnapshot__ ??= {
    enabled: true,
    intervalMs: DEFAULT_INTERVAL_MINUTES * 60_000,
    lastRunAt: null,
    nextRunAt: null,
    running: false,
    sampledCount: null,
    timer: null,
  };

  return globalQuotaSnapshotState.__codebuddy2apiQuotaSnapshot__;
};

const isDisabled = (value: string | undefined): boolean => {
  const normalized = (value ?? '').trim().toLowerCase();

  return normalized === 'false' || normalized === '0' || normalized === 'no';
};

const resolveIntervalMinutes = (): number => {
  const parsed = Number(process.env[INTERVAL_ENV]);

  return Number.isFinite(parsed) && parsed >= MIN_INTERVAL_MINUTES
    ? parsed
    : DEFAULT_INTERVAL_MINUTES;
};

const clearTimer = (runtime: QuotaSnapshotRuntime): void => {
  if (runtime.timer) {
    clearTimeout(runtime.timer);
    runtime.timer = null;
  }
};

export const getQuotaSnapshotStatus = (): QuotaSnapshotStatus => {
  const runtime = getRuntime();

  return {
    enabled: runtime.enabled,
    intervalMinutes: Math.round(runtime.intervalMs / 60_000),
    lastRunAt:
      runtime.lastRunAt === null
        ? null
        : new Date(runtime.lastRunAt).toISOString(),
    nextRunAt:
      runtime.enabled && runtime.nextRunAt !== null
        ? new Date(runtime.nextRunAt).toISOString()
        : null,
    running: runtime.running,
    sampledCount: runtime.sampledCount,
  };
};

export const captureQuotaSnapshots = async (
  source: string,
): Promise<number> => {
  const runtime = getRuntime();

  runtime.running = true;

  try {
    const snapshots = await getAccountStatus();

    for (const snapshot of snapshots) {
      void logEvent({
        level: 'INFO',
        message: 'Quota snapshot',
        payload: {
          source,
          credentialFilename: snapshot.filename,
          total: snapshot.credits.total,
          used: snapshot.credits.used,
          remaining: snapshot.credits.remaining,
          plan: snapshot.credits.plan,
          resetAt: snapshot.credits.resetAt,
          error: snapshot.error,
          queriedAt: snapshot.queriedAt,
        },
      });
    }

    runtime.sampledCount = snapshots.length;

    return snapshots.length;
  } catch (error) {
    runtime.sampledCount = 0;
    void logEvent({
      level: 'WARN',
      message: 'Quota snapshot failed',
      payload: {
        source,
        error: error instanceof Error ? error.message : String(error),
      },
    });

    return 0;
  } finally {
    runtime.running = false;
    runtime.lastRunAt = Date.now();
  }
};

export const scheduleQuotaSnapshots =
  async (): Promise<QuotaSnapshotStatus> => {
    const runtime = getRuntime();

    clearTimer(runtime);

    runtime.enabled = !isDisabled(process.env[ENABLED_ENV]);
    runtime.intervalMs = resolveIntervalMinutes() * 60_000;

    if (!runtime.enabled) {
      runtime.nextRunAt = null;

      return getQuotaSnapshotStatus();
    }

    // A restart (rolling update, crash) must not push the next sample a whole
    // interval away, or a frequently restarted deployment would never sample.
    const delay =
      runtime.lastRunAt === null
        ? FIRST_RUN_DELAY_MS
        : Math.min(runtime.intervalMs, MAX_TIMER_DELAY_MS);
    const nextRunAt = Date.now() + delay;

    runtime.nextRunAt = nextRunAt;
    runtime.timer = setTimeout(() => {
      runtime.timer = null;
      void captureQuotaSnapshots('scheduled').then(() =>
        scheduleQuotaSnapshots(),
      );
    }, delay);
    (runtime.timer as { unref?: () => void }).unref?.();

    return getQuotaSnapshotStatus();
  };

export const runQuotaSnapshotNow = async (): Promise<QuotaSnapshotStatus> => {
  await captureQuotaSnapshots('manual');
  await scheduleQuotaSnapshots();

  return getQuotaSnapshotStatus();
};
