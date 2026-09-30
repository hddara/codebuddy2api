import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/server/domain/account-status', () => ({
  getAccountStatus: vi.fn(),
}));
vi.mock('@/lib/server/shared/log', () => ({
  logEvent: vi.fn().mockResolvedValue(undefined),
}));

const { getAccountStatus } = await import('@/lib/server/domain/account-status');
const { logEvent } = await import('@/lib/server/shared/log');
const {
  captureQuotaSnapshots,
  getQuotaSnapshotStatus,
  runQuotaSnapshotNow,
  scheduleQuotaSnapshots,
} = await import('@/lib/server/domain/quota-snapshot');

const snapshot = (filename: string, remaining: number) => ({
  checkin: { claimed: true, message: null },
  credits: {
    plan: 'Free',
    remaining,
    resetAt: '2026-10-01 00:00:00',
    total: 1000,
    used: 1000 - remaining,
  },
  error: null,
  filename,
  models: ['model-one'],
  queriedAt: '2026-09-30T00:00:00.000Z',
});

const resetRuntime = (): void => {
  delete (
    globalThis as typeof globalThis & {
      __codebuddy2apiQuotaSnapshot__?: unknown;
    }
  ).__codebuddy2apiQuotaSnapshot__;
};

describe('quota snapshot sampling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    resetRuntime();
    delete process.env.CODEBUDDY_QUOTA_SNAPSHOT_ENABLED;
    delete process.env.CODEBUDDY_QUOTA_SNAPSHOT_INTERVAL_MINUTES;
  });

  afterEach(() => {
    vi.useRealTimers();
    resetRuntime();
  });

  it('logs one summary line per credential', async () => {
    vi.mocked(getAccountStatus).mockResolvedValue([
      snapshot('a.json', 100),
      snapshot('b.json', 900),
    ] as never);

    const count = await captureQuotaSnapshots('manual');

    expect(count).toBe(2);
    expect(logEvent).toHaveBeenCalledTimes(2);
    expect(logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'INFO',
        message: 'Quota snapshot',
        payload: expect.objectContaining({
          credentialFilename: 'a.json',
          plan: 'Free',
          remaining: 100,
          source: 'manual',
        }),
      }),
    );
  });

  it('reports a failure without throwing', async () => {
    vi.mocked(getAccountStatus).mockRejectedValue(new Error('boom'));

    await expect(captureQuotaSnapshots('scheduled')).resolves.toBe(0);
    expect(logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'WARN',
        message: 'Quota snapshot failed',
      }),
    );
    expect(getQuotaSnapshotStatus().sampledCount).toBe(0);
  });

  it('records the partial error reported for a credential', async () => {
    vi.mocked(getAccountStatus).mockResolvedValue([
      { ...snapshot('a.json', 0), error: 'claimed returned 400' },
    ] as never);

    await captureQuotaSnapshots('manual');

    expect(logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Quota snapshot',
        payload: expect.objectContaining({
          error: 'claimed returned 400',
          remaining: 0,
        }),
      }),
    );
  });

  it('stringifies a non-Error rejection', async () => {
    vi.mocked(getAccountStatus).mockRejectedValue('plain failure');

    await expect(captureQuotaSnapshots('scheduled')).resolves.toBe(0);
    expect(logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'WARN',
        payload: expect.objectContaining({ error: 'plain failure' }),
      }),
    );
  });

  it('samples shortly after startup and then keeps rescheduling', async () => {
    vi.mocked(getAccountStatus).mockResolvedValue([] as never);

    const status = await scheduleQuotaSnapshots();

    expect(status.enabled).toBe(true);
    expect(status.intervalMinutes).toBe(360);
    expect(status.nextRunAt).not.toBeNull();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(getAccountStatus).toHaveBeenCalledTimes(1);
  });

  it('honours the interval override', async () => {
    process.env.CODEBUDDY_QUOTA_SNAPSHOT_INTERVAL_MINUTES = '30';

    await scheduleQuotaSnapshots();

    expect(getQuotaSnapshotStatus().intervalMinutes).toBe(30);
  });

  it('falls back to the default interval when the override is unusable', async () => {
    process.env.CODEBUDDY_QUOTA_SNAPSHOT_INTERVAL_MINUTES = '1';

    await scheduleQuotaSnapshots();

    expect(getQuotaSnapshotStatus().intervalMinutes).toBe(360);
  });

  it('stays idle when disabled', async () => {
    process.env.CODEBUDDY_QUOTA_SNAPSHOT_ENABLED = 'false';

    const status = await scheduleQuotaSnapshots();

    expect(status.enabled).toBe(false);
    expect(status.nextRunAt).toBeNull();

    await vi.advanceTimersByTimeAsync(600_000);
    expect(getAccountStatus).not.toHaveBeenCalled();
  });

  it('runs on demand and reschedules', async () => {
    vi.mocked(getAccountStatus).mockResolvedValue([] as never);

    const status = await runQuotaSnapshotNow();

    expect(status.running).toBe(false);
    expect(status.nextRunAt).not.toBeNull();
    expect(getAccountStatus).toHaveBeenCalledTimes(1);
  });
});
