import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { storageStore } = vi.hoisted(() => ({
  storageStore: new Map<string, unknown>(),
}));

vi.mock('@/lib/server/domain/account-status', () => ({
  submitCredentialCheckin: vi.fn(),
}));
vi.mock('@/lib/server/domain/config', () => ({
  DEFAULT_CHECKIN_TIME: '00:30',
  getActiveConfig: vi.fn(),
}));
vi.mock('@/lib/server/domain/credentials', () => ({
  listEligibleCredentialRecords: vi.fn(),
}));
vi.mock('@/lib/server/storage', () => ({
  readStorageJson: vi.fn(),
  writeStorageJson: vi.fn(),
}));

const { submitCredentialCheckin } =
  await import('@/lib/server/domain/account-status');
const { getActiveConfig } = await import('@/lib/server/domain/config');
const { listEligibleCredentialRecords } =
  await import('@/lib/server/domain/credentials');
const { readStorageJson, writeStorageJson } =
  await import('@/lib/server/storage');
const {
  computeNextRunAt,
  getAutoCheckinStatus,
  localDateKey,
  parseCheckinTime,
  resolveCheckinTime,
  runAutoCheckin,
  runAutoCheckinNow,
  scheduleAutoCheckin,
} = await import('@/lib/server/domain/auto-checkin');

const storageKey = (namespace: string, key: string): string =>
  `${namespace}/${key}`;

const at = (hours: number, minutes: number, day = 15): Date =>
  new Date(2026, 8, day, hours, minutes, 0, 0);

const credential = (filename: string) => ({ filename }) as never;

const storedState = (overrides: Record<string, unknown> = {}) => ({
  attempts: 1,
  lastError: null,
  lastRunAt: at(0, 30).toISOString(),
  lastStatus: 'completed',
  result: {
    failed: 0,
    finishedAt: at(0, 30).toISOString(),
    succeeded: 1,
    total: 1,
  },
  ...overrides,
});

const resetRuntime = (): void => {
  (globalThis as Record<string, unknown>).__codebuddy2apiAutoCheckin__ =
    undefined;
};

const flushTimers = async (ms = 1): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
  await Promise.resolve();
  await Promise.resolve();
};

describe('automatic check-in schedule math', () => {
  it('parses valid and invalid check-in times', () => {
    expect(parseCheckinTime('00:30')).toEqual({ hours: 0, minutes: 30 });
    expect(parseCheckinTime(' 7:05 ')).toEqual({ hours: 7, minutes: 5 });
    expect(parseCheckinTime('23:59')).toEqual({ hours: 23, minutes: 59 });
    expect(parseCheckinTime('24:00')).toBeNull();
    expect(parseCheckinTime('12:60')).toBeNull();
    expect(parseCheckinTime('12:5')).toBeNull();
    expect(parseCheckinTime('noon')).toBeNull();
    expect(parseCheckinTime(undefined)).toBeNull();
  });

  it('normalizes check-in times with a fallback', () => {
    expect(resolveCheckinTime('9:05')).toBe('09:05');
    expect(resolveCheckinTime('21:00')).toBe('21:00');
    expect(resolveCheckinTime('nonsense')).toBe('00:30');
    expect(resolveCheckinTime(null)).toBe('00:30');
  });

  it('builds local date keys', () => {
    expect(localDateKey(at(9, 5))).toBe('2026-09-15');
    expect(localDateKey(new Date(2026, 0, 3, 23, 59))).toBe('2026-01-03');
  });

  it('targets today when the configured time is still ahead', () => {
    const next = computeNextRunAt({
      attempts: 0,
      lastRunAt: null,
      lastStatus: 'idle',
      now: at(9, 0),
      time: '21:15',
    });

    expect(next.getTime()).toBe(at(21, 15).getTime());
  });

  it('catches up immediately when today is still pending', () => {
    const next = computeNextRunAt({
      attempts: 0,
      lastRunAt: null,
      lastStatus: 'idle',
      now: at(9, 0),
      time: '00:30',
    });

    expect(next.getTime()).toBe(at(9, 0).getTime());
  });

  it('waits for tomorrow once today succeeded', () => {
    const next = computeNextRunAt({
      attempts: 1,
      lastRunAt: at(0, 30).toISOString(),
      lastStatus: 'completed',
      now: at(9, 0),
      time: '00:30',
    });

    expect(next.getTime()).toBe(at(0, 30, 16).getTime());
  });

  it('retries after the retry delay when today failed', () => {
    const next = computeNextRunAt({
      attempts: 1,
      lastRunAt: at(8, 58).toISOString(),
      lastStatus: 'failed',
      now: at(9, 0),
      time: '00:30',
    });

    expect(next.getTime()).toBe(at(9, 3).getTime());
  });

  it('runs immediately when the retry window already elapsed', () => {
    const next = computeNextRunAt({
      attempts: 1,
      lastRunAt: at(8, 0).toISOString(),
      lastStatus: 'failed',
      now: at(9, 0),
      time: '00:30',
    });

    expect(next.getTime()).toBe(at(9, 0).getTime());
  });

  it('falls back to tomorrow when the retry overlaps the next window', () => {
    const next = computeNextRunAt({
      attempts: 1,
      lastRunAt: at(0, 25, 16).toISOString(),
      lastStatus: 'failed',
      now: at(0, 26, 16),
      time: '00:30',
    });

    expect(next.getTime()).toBe(at(0, 30, 16).getTime());
  });

  it('ignores unparsable previous run timestamps', () => {
    const next = computeNextRunAt({
      attempts: 2,
      lastRunAt: 'not-a-date',
      lastStatus: 'failed',
      now: at(9, 0),
      time: '00:30',
    });

    expect(next.getTime()).toBe(at(9, 0).getTime());
  });

  it('gives up for the day after the attempt budget is used', () => {
    const next = computeNextRunAt({
      attempts: 3,
      lastRunAt: at(8, 0).toISOString(),
      lastStatus: 'failed',
      now: at(9, 0),
      time: '00:30',
    });

    expect(next.getTime()).toBe(at(0, 30, 16).getTime());
  });
});

describe('automatic check-in runner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRuntime();
    storageStore.clear();
    vi.useFakeTimers();
    vi.setSystemTime(at(9, 0));
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(getActiveConfig).mockResolvedValue({
      CODEBUDDY_AUTO_CHECKIN_ENABLED: 'true',
      CODEBUDDY_AUTO_CHECKIN_TIME: '00:30',
    } as never);
    vi.mocked(readStorageJson).mockImplementation(
      (async (namespace: string, key: string) =>
        storageStore.get(storageKey(namespace, key)) ?? null) as never,
    );
    vi.mocked(writeStorageJson).mockImplementation((async (
      namespace: string,
      key: string,
      value: unknown,
    ) => {
      storageStore.set(storageKey(namespace, key), value);
    }) as never);
    vi.mocked(listEligibleCredentialRecords).mockResolvedValue([
      credential('one.json'),
    ]);
    vi.mocked(submitCredentialCheckin).mockResolvedValue({
      error: null,
      ok: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    resetRuntime();
  });

  it('marks the day as completed when every credential is checked in', async () => {
    vi.mocked(listEligibleCredentialRecords).mockResolvedValue([
      credential('one.json'),
      credential('two.json'),
    ]);

    const status = await runAutoCheckin();

    expect(submitCredentialCheckin).toHaveBeenCalledTimes(2);
    expect(writeStorageJson).toHaveBeenCalledWith(
      'checkin',
      'state',
      expect.objectContaining({
        attempts: 1,
        lastError: null,
        lastStatus: 'completed',
        result: expect.objectContaining({ failed: 0, succeeded: 2, total: 2 }),
      }),
    );
    expect(status).toMatchObject({
      enabled: true,
      lastStatus: 'completed',
      running: false,
      time: '00:30',
    });
  });

  it('completes the day when there is nothing to check in', async () => {
    vi.mocked(listEligibleCredentialRecords).mockResolvedValue([]);

    const status = await runAutoCheckin();

    expect(submitCredentialCheckin).not.toHaveBeenCalled();
    expect(status.result).toMatchObject({ failed: 0, succeeded: 0, total: 0 });
    expect(status.lastStatus).toBe('completed');
  });

  it('records failures with credential context', async () => {
    vi.mocked(listEligibleCredentialRecords).mockResolvedValue([
      credential('one.json'),
      credential('two.json'),
    ]);
    vi.mocked(submitCredentialCheckin)
      .mockResolvedValueOnce({ error: null, ok: true })
      .mockResolvedValueOnce({ error: 'claim returned 500', ok: false });

    const status = await runAutoCheckin();

    expect(status.lastStatus).toBe('failed');
    expect(status.lastError).toBe('two.json: claim returned 500');
    expect(status.result).toMatchObject({ failed: 1, succeeded: 1, total: 2 });
  });

  it('reports failures without an error message', async () => {
    vi.mocked(submitCredentialCheckin).mockResolvedValue({
      error: null,
      ok: false,
    });

    const status = await runAutoCheckin();

    expect(status.lastError).toBe('one.json: Check-in failed');
  });

  it('checks in every credential in bounded batches', async () => {
    vi.mocked(listEligibleCredentialRecords).mockResolvedValue(
      Array.from({ length: 5 }, (_value, index) =>
        credential(`credential-${index}.json`),
      ),
    );

    await runAutoCheckin();

    expect(submitCredentialCheckin).toHaveBeenCalledTimes(5);
  });

  it('records an unexpected failure and keeps the previous result', async () => {
    storageStore.set('checkin/state', storedState());
    vi.mocked(listEligibleCredentialRecords).mockRejectedValue(
      new Error('credential store offline'),
    );

    const status = await runAutoCheckin();

    expect(status.lastStatus).toBe('failed');
    expect(status.lastError).toBe('credential store offline');
    expect(status.attempts).toBe(2);
    expect(status.result).toMatchObject({ succeeded: 1, total: 1 });
  });

  it('keeps going when the stored state cannot be read', async () => {
    vi.mocked(readStorageJson).mockRejectedValue(new Error('disk unavailable'));

    const status = await runAutoCheckin();

    expect(submitCredentialCheckin).toHaveBeenCalledTimes(1);
    expect(status.running).toBe(false);
    expect(console.warn).toHaveBeenCalled();
  });

  it('skips overlapping executions while a run is in flight', async () => {
    let release = (): void => {};
    vi.mocked(submitCredentialCheckin).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ error: null, ok: true });
        }),
    );

    const running = runAutoCheckin();
    const overlapping = await runAutoCheckin();

    release();
    await running;

    expect(overlapping.running).toBe(true);
    expect(submitCredentialCheckin).toHaveBeenCalledTimes(1);
  });

  it('keeps running when the state file cannot be written', async () => {
    vi.mocked(writeStorageJson).mockRejectedValue(new Error('read only'));

    const status = await runAutoCheckin();

    expect(submitCredentialCheckin).toHaveBeenCalledTimes(1);
    expect(status.running).toBe(false);
    expect(console.warn).toHaveBeenCalled();
  });
});

describe('automatic check-in scheduling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRuntime();
    storageStore.clear();
    vi.useFakeTimers();
    vi.setSystemTime(at(9, 0));
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(getActiveConfig).mockResolvedValue({
      CODEBUDDY_AUTO_CHECKIN_ENABLED: 'true',
      CODEBUDDY_AUTO_CHECKIN_TIME: '00:30',
    } as never);
    vi.mocked(readStorageJson).mockImplementation(
      (async (namespace: string, key: string) =>
        storageStore.get(storageKey(namespace, key)) ?? null) as never,
    );
    vi.mocked(writeStorageJson).mockImplementation((async (
      namespace: string,
      key: string,
      value: unknown,
    ) => {
      storageStore.set(storageKey(namespace, key), value);
    }) as never);
    vi.mocked(listEligibleCredentialRecords).mockResolvedValue([
      credential('one.json'),
    ]);
    vi.mocked(submitCredentialCheckin).mockResolvedValue({
      error: null,
      ok: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    resetRuntime();
  });

  it('does not schedule anything while the feature is disabled', async () => {
    vi.mocked(getActiveConfig).mockResolvedValue({
      CODEBUDDY_AUTO_CHECKIN_ENABLED: 'false',
      CODEBUDDY_AUTO_CHECKIN_TIME: '00:30',
    } as never);

    const status = await scheduleAutoCheckin();

    expect(status.enabled).toBe(false);
    expect(status.nextRunAt).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('treats a missing configuration as disabled', async () => {
    vi.mocked(getActiveConfig).mockRejectedValue(new Error('config broken'));

    const status = await scheduleAutoCheckin();

    expect(status.enabled).toBe(false);
    expect(status.time).toBe('00:30');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('catches up on startup and schedules the next day afterwards', async () => {
    await scheduleAutoCheckin();

    expect(vi.getTimerCount()).toBe(1);
    expect((await getAutoCheckinStatus()).nextRunAt).toBe(
      at(9, 0).toISOString(),
    );

    await flushTimers();

    expect(submitCredentialCheckin).toHaveBeenCalledTimes(1);
    expect((await getAutoCheckinStatus()).nextRunAt).toBe(
      at(0, 30, 16).toISOString(),
    );
  });

  it('waits for the configured time when it is still ahead', async () => {
    vi.mocked(getActiveConfig).mockResolvedValue({
      CODEBUDDY_AUTO_CHECKIN_ENABLED: 'true',
      CODEBUDDY_AUTO_CHECKIN_TIME: '21:15',
    } as never);

    const status = await scheduleAutoCheckin();

    expect(status.nextRunAt).toBe(at(21, 15).toISOString());
    expect(submitCredentialCheckin).not.toHaveBeenCalled();
  });

  it('does not catch up twice on the same day', async () => {
    storageStore.set('checkin/state', storedState());

    const status = await scheduleAutoCheckin();

    expect(status.attempts).toBe(1);
    expect(status.nextRunAt).toBe(at(0, 30, 16).toISOString());
  });

  it('retries a failed day instead of waiting for tomorrow', async () => {
    storageStore.set(
      'checkin/state',
      storedState({ lastRunAt: at(9, 0).toISOString(), lastStatus: 'failed' }),
    );

    const status = await scheduleAutoCheckin();

    expect(status.nextRunAt).toBe(at(9, 5).toISOString());
  });

  it('stops retrying once the daily attempt budget is exhausted', async () => {
    storageStore.set(
      'checkin/state',
      storedState({
        attempts: 3,
        lastRunAt: at(8, 0).toISOString(),
        lastStatus: 'failed',
      }),
    );

    const status = await scheduleAutoCheckin();

    expect(status.nextRunAt).toBe(at(0, 30, 16).toISOString());
  });

  it('reports status without a scheduled run before scheduling', async () => {
    const status = await getAutoCheckinStatus();

    expect(status).toMatchObject({
      attempts: 0,
      enabled: true,
      lastError: null,
      lastRunAt: null,
      lastStatus: 'idle',
      nextRunAt: null,
      running: false,
      time: '00:30',
    });
  });

  it('runs on demand and reschedules', async () => {
    const status = await runAutoCheckinNow();

    expect(submitCredentialCheckin).toHaveBeenCalledTimes(1);
    expect(status).toMatchObject({ lastStatus: 'completed', running: false });
    expect(status.nextRunAt).toBe(at(0, 30, 16).toISOString());
    expect(vi.getTimerCount()).toBe(1);
  });

  it('accepts other truthy enabled spellings', async () => {
    vi.mocked(getActiveConfig).mockResolvedValue({
      CODEBUDDY_AUTO_CHECKIN_ENABLED: 'TRUE',
      CODEBUDDY_AUTO_CHECKIN_TIME: '07:05',
    } as never);

    const status = await scheduleAutoCheckin();

    expect(status.enabled).toBe(true);
    expect(status.time).toBe('07:05');
  });
});
