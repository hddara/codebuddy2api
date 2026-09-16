import { submitCredentialCheckin } from './account-status';
import { DEFAULT_CHECKIN_TIME, getActiveConfig } from './config';
import { listEligibleCredentialRecords } from './credentials';
import { readStorageJson, writeStorageJson } from '../storage';

const CHECKIN_NAMESPACE = 'checkin';
const CHECKIN_STATE_KEY = 'state';

const MAX_ATTEMPTS_PER_DAY = 3;
const RETRY_DELAY_MS = 5 * 60 * 1000;
const CHECKIN_CONCURRENCY = 4;
const MAX_TIMER_DELAY_MS = 60 * 60 * 1000;
const ENABLED_VALUES = ['1', 'on', 'true', 'yes'];

export type AutoCheckinLastStatus = 'completed' | 'failed' | 'idle';

export interface AutoCheckinRunSummary {
  failed: number;
  finishedAt: string;
  succeeded: number;
  total: number;
}

export interface AutoCheckinState {
  attempts: number;
  lastError: string | null;
  lastRunAt: string | null;
  lastStatus: AutoCheckinLastStatus;
  result: AutoCheckinRunSummary | null;
}

export interface AutoCheckinStatus extends AutoCheckinState {
  enabled: boolean;
  nextRunAt: string | null;
  running: boolean;
  time: string;
}

export interface CheckinTime {
  hours: number;
  minutes: number;
}

interface AutoCheckinRuntime {
  nextRunAt: number | null;
  running: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

const globalAutoCheckinState = globalThis as typeof globalThis & {
  __codebuddy2apiAutoCheckin__?: AutoCheckinRuntime;
};

const getRuntime = (): AutoCheckinRuntime => {
  if (!globalAutoCheckinState.__codebuddy2apiAutoCheckin__) {
    globalAutoCheckinState.__codebuddy2apiAutoCheckin__ = {
      nextRunAt: null,
      running: false,
      timer: null,
    };
  }

  return globalAutoCheckinState.__codebuddy2apiAutoCheckin__;
};

const clearTimer = (runtime: AutoCheckinRuntime): void => {
  if (runtime.timer) {
    clearTimeout(runtime.timer);
    runtime.timer = null;
  }

  runtime.nextRunAt = null;
};

export const parseCheckinTime = (
  value: string | null | undefined,
): CheckinTime | null => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());

  if (!match) {
    return null;
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);

  if (hours > 23 || minutes > 59) {
    return null;
  }

  return { hours, minutes };
};

export const resolveCheckinTime = (
  value: string | null | undefined,
): string => {
  const parsed = parseCheckinTime(value);

  return parsed
    ? `${String(parsed.hours).padStart(2, '0')}:${String(parsed.minutes).padStart(2, '0')}`
    : DEFAULT_CHECKIN_TIME;
};

export const localDateKey = (date: Date): string => {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  return `${date.getFullYear()}-${month}-${day}`;
};

export const computeNextRunAt = (options: {
  attempts: number;
  lastRunAt: string | null;
  lastStatus: AutoCheckinLastStatus;
  now: Date;
  time: string;
}): Date => {
  const { attempts, lastRunAt, lastStatus, now, time } = options;
  const parsed =
    parseCheckinTime(time) ?? parseCheckinTime(DEFAULT_CHECKIN_TIME)!;
  const todayTarget = new Date(now);

  todayTarget.setHours(parsed.hours, parsed.minutes, 0, 0);

  const tomorrowTarget = new Date(todayTarget);
  tomorrowTarget.setDate(tomorrowTarget.getDate() + 1);

  const todayKey = localDateKey(now);
  const lastRunDate = lastRunAt ? new Date(lastRunAt) : null;
  const completedToday =
    lastStatus === 'completed' &&
    lastRunDate !== null &&
    !Number.isNaN(lastRunDate.getTime()) &&
    localDateKey(lastRunDate) === todayKey;

  if (completedToday || attempts >= MAX_ATTEMPTS_PER_DAY) {
    return tomorrowTarget;
  }

  if (attempts > 0) {
    const lastAttemptAt = lastRunDate?.getTime() ?? Number.NaN;
    const retryAt = Number.isFinite(lastAttemptAt)
      ? new Date(lastAttemptAt + RETRY_DELAY_MS)
      : now;

    if (retryAt.getTime() < now.getTime()) {
      return now;
    }

    return retryAt.getTime() < tomorrowTarget.getTime()
      ? retryAt
      : tomorrowTarget;
  }

  return todayTarget.getTime() <= now.getTime() ? now : todayTarget;
};

const emptyState = (): AutoCheckinState => ({
  attempts: 0,
  lastError: null,
  lastRunAt: null,
  lastStatus: 'idle',
  result: null,
});

const loadState = async (now: Date): Promise<AutoCheckinState> => {
  try {
    const stored = await readStorageJson<AutoCheckinState>(
      CHECKIN_NAMESPACE,
      CHECKIN_STATE_KEY,
    );

    if (!stored) {
      return emptyState();
    }

    const lastRunDate = stored.lastRunAt ? new Date(stored.lastRunAt) : null;
    const sameDay =
      lastRunDate !== null &&
      !Number.isNaN(lastRunDate.getTime()) &&
      localDateKey(lastRunDate) === localDateKey(now);

    return {
      attempts: sameDay ? Number(stored.attempts) || 0 : 0,
      lastError: stored.lastError ?? null,
      lastRunAt: stored.lastRunAt ?? null,
      lastStatus: stored.lastStatus ?? 'idle',
      result: stored.result ?? null,
    };
  } catch (error) {
    console.warn('[CodeBuddy2API] Unable to read auto check-in state', error);

    return emptyState();
  }
};

const saveState = async (state: AutoCheckinState): Promise<void> => {
  try {
    await writeStorageJson(CHECKIN_NAMESPACE, CHECKIN_STATE_KEY, state);
  } catch (error) {
    console.warn(
      '[CodeBuddy2API] Unable to persist auto check-in state',
      error,
    );
  }
};

const isCheckinEnabled = (value: unknown): boolean =>
  ENABLED_VALUES.includes(
    String(value ?? '')
      .trim()
      .toLowerCase(),
  );

const readCheckinSettings = async (): Promise<{
  enabled: boolean;
  time: string;
}> => {
  try {
    const config = await getActiveConfig();

    return {
      enabled: isCheckinEnabled(config.CODEBUDDY_AUTO_CHECKIN_ENABLED),
      time: resolveCheckinTime(config.CODEBUDDY_AUTO_CHECKIN_TIME),
    };
  } catch (error) {
    console.warn(
      '[CodeBuddy2API] Unable to read auto check-in settings',
      error,
    );

    return { enabled: false, time: DEFAULT_CHECKIN_TIME };
  }
};

const checkinEveryCredential = async (): Promise<{
  errors: string[];
  result: AutoCheckinRunSummary;
}> => {
  const credentials = await listEligibleCredentialRecords();
  const outcomes: Array<{
    error: string | null;
    filename: string;
    ok: boolean;
  }> = [];

  for (
    let index = 0;
    index < credentials.length;
    index += CHECKIN_CONCURRENCY
  ) {
    const chunk = credentials.slice(index, index + CHECKIN_CONCURRENCY);

    outcomes.push(
      ...(await Promise.all(
        chunk.map(async (credential) => ({
          ...(await submitCredentialCheckin(credential)),
          filename: credential.filename,
        })),
      )),
    );
  }

  const succeeded = outcomes.filter((outcome) => outcome.ok).length;
  const failures = outcomes.filter((outcome) => !outcome.ok);

  return {
    errors: failures
      .slice(0, 3)
      .map(
        (outcome) =>
          `${outcome.filename}: ${outcome.error ?? 'Check-in failed'}`,
      ),
    result: {
      failed: failures.length,
      finishedAt: new Date().toISOString(),
      succeeded,
      total: outcomes.length,
    },
  };
};

export const runAutoCheckin = async (): Promise<AutoCheckinStatus> => {
  const runtime = getRuntime();

  if (runtime.running) {
    return getAutoCheckinStatus();
  }

  runtime.running = true;

  try {
    const { errors, result } = await checkinEveryCredential();
    const previous = await loadState(new Date());
    const state: AutoCheckinState = {
      attempts: previous.attempts + 1,
      lastError: errors.length ? errors.join('; ') : null,
      lastRunAt: result.finishedAt,
      lastStatus: result.failed === 0 ? 'completed' : 'failed',
      result,
    };

    await saveState(state);
    console.info(
      `[CodeBuddy2API] Automatic check-in finished: ${result.succeeded}/${result.total} succeeded`,
    );
  } catch (error) {
    const previous = await loadState(new Date());

    await saveState({
      attempts: previous.attempts + 1,
      lastError: error instanceof Error ? error.message : 'Check-in failed',
      lastRunAt: new Date().toISOString(),
      lastStatus: 'failed',
      result: previous.result,
    });
    console.warn('[CodeBuddy2API] Automatic check-in failed', error);
  } finally {
    runtime.running = false;
  }

  return getAutoCheckinStatus();
};

export const getAutoCheckinStatus = async (): Promise<AutoCheckinStatus> => {
  const runtime = getRuntime();
  const { enabled, time } = await readCheckinSettings();
  const state = await loadState(new Date());

  return {
    ...state,
    enabled,
    nextRunAt:
      enabled && runtime.nextRunAt !== null
        ? new Date(runtime.nextRunAt).toISOString()
        : null,
    running: runtime.running,
    time,
  };
};

export const scheduleAutoCheckin = async (): Promise<AutoCheckinStatus> => {
  const runtime = getRuntime();

  clearTimer(runtime);

  const { enabled, time } = await readCheckinSettings();

  if (!enabled) {
    return getAutoCheckinStatus();
  }

  const now = new Date();
  const state = await loadState(now);
  const nextRunAt = computeNextRunAt({ ...state, now, time });
  const delay = Math.max(
    0,
    Math.min(nextRunAt.getTime() - now.getTime(), MAX_TIMER_DELAY_MS),
  );

  runtime.nextRunAt = nextRunAt.getTime();
  runtime.timer = setTimeout(() => {
    runtime.timer = null;
    void runAutoCheckin().then(() => scheduleAutoCheckin());
  }, delay);
  (runtime.timer as { unref?: () => void }).unref?.();

  return getAutoCheckinStatus();
};

export const runAutoCheckinNow = async (): Promise<AutoCheckinStatus> => {
  const runtime = getRuntime();

  clearTimer(runtime);
  await runAutoCheckin();
  await scheduleAutoCheckin();

  return getAutoCheckinStatus();
};
