import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/server/storage', () => ({
  readStorageJson: vi.fn(),
}));

const { readStorageJson } = await import('@/lib/server/storage');
const {
  DEFAULT_MEMORY_RECYCLE_RSS_MB,
  MEMORY_RECYCLE_ENV,
  MEMORY_RECYCLE_MIN_UPTIME_MS,
  getMemoryRecycleRssMb,
  getMemorySnapshot,
  isMemoryRecycleEnabled,
} = await import('@/lib/server/shared/memory');
const { runRecycleCheck, resetRecycleTimerForTests } =
  await import('@/lib/server/shared/diagnostics');
const { acquireRequestSlot, resetConcurrencyGateForTests } =
  await import('@/lib/server/shared/concurrency-gate');
const { resetLogLevelCache } = await import('@/lib/server/shared/log');

const BYTES_PER_MB = 1024 * 1024;

const stubMemory = (rssMb: number) =>
  vi.spyOn(process, 'memoryUsage').mockReturnValue({
    arrayBuffers: 1 * BYTES_PER_MB,
    external: 4 * BYTES_PER_MB,
    heapTotal: 200 * BYTES_PER_MB,
    heapUsed: 120 * BYTES_PER_MB,
    rss: rssMb * BYTES_PER_MB,
  });

const stubUptime = (seconds: number) =>
  vi.spyOn(process, 'uptime').mockReturnValue(seconds);

describe('memory recycling', () => {
  beforeEach(() => {
    resetConcurrencyGateForTests();
    resetRecycleTimerForTests();
    delete process.env[MEMORY_RECYCLE_ENV];
    resetLogLevelCache();
    vi.mocked(readStorageJson).mockResolvedValue({
      CODEBUDDY_LOG_LEVEL: 'DEBUG',
    });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    renewExit();
    resetConcurrencyGateForTests();
    resetRecycleTimerForTests();
    delete process.env[MEMORY_RECYCLE_ENV];
    vi.restoreAllMocks();
    resetLogLevelCache();
  });

  it('reads the threshold, and treats zero or negative as switched off', () => {
    expect(getMemoryRecycleRssMb()).toBe(DEFAULT_MEMORY_RECYCLE_RSS_MB);

    process.env[MEMORY_RECYCLE_ENV] = '1500';
    expect(getMemoryRecycleRssMb()).toBe(1_500);

    process.env[MEMORY_RECYCLE_ENV] = '0';
    expect(getMemoryRecycleRssMb()).toBeNull();

    process.env[MEMORY_RECYCLE_ENV] = '-4';
    expect(getMemoryRecycleRssMb()).toBeNull();

    process.env[MEMORY_RECYCLE_ENV] = 'nonsense';
    expect(getMemoryRecycleRssMb()).toBe(DEFAULT_MEMORY_RECYCLE_RSS_MB);

    process.env[MEMORY_RECYCLE_ENV] = '';
    expect(getMemoryRecycleRssMb()).toBe(DEFAULT_MEMORY_RECYCLE_RSS_MB);
  });

  it('reports whether recycling is on', () => {
    expect(isMemoryRecycleEnabled()).toBe(true);

    process.env[MEMORY_RECYCLE_ENV] = '0';
    expect(isMemoryRecycleEnabled()).toBe(false);
  });

  it('does nothing while the process is under the line', async () => {
    stubMemory(DEFAULT_MEMORY_RECYCLE_RSS_MB - 1);
    stubUptime(600);

    await runRecycleCheck();

    expect(console.error).not.toHaveBeenCalled();
  });

  it('does nothing when the switch is off', async () => {
    process.env[MEMORY_RECYCLE_ENV] = '0';
    stubMemory(DEFAULT_MEMORY_RECYCLE_RSS_MB + 500);
    stubUptime(600);

    await runRecycleCheck();

    expect(console.error).not.toHaveBeenCalled();
  });

  it('refuses to recycle a process that has only just started', async () => {
    stubMemory(DEFAULT_MEMORY_RECYCLE_RSS_MB + 500);
    stubUptime(MEMORY_RECYCLE_MIN_UPTIME_MS / 1_000 - 1);

    await runRecycleCheck();

    await vi.waitFor(() =>
      expect(console.warn).toHaveBeenCalledWith(
        '[CodeBuddy2API][WARN] Memory over the recycle threshold but uptime is too low to recycle',
        expect.objectContaining({
          minUptimeSeconds: MEMORY_RECYCLE_MIN_UPTIME_MS / 1_000,
        }),
      ),
    );
    expect(console.error).not.toHaveBeenCalled();
  });

  it('drains in-flight requests and exits cleanly once over the line', async () => {
    const exit = stubExit();
    stubMemory(DEFAULT_MEMORY_RECYCLE_RSS_MB + 300);
    stubUptime(600);

    const slot = acquireRequestSlot();

    // The drain polls every 250ms, so let a tick pass before freeing the slot.
    setTimeout(() => slot?.release(), 10);
    await runRecycleCheck();

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(console.error).toHaveBeenCalledWith(
      '[CodeBuddy2API][ERROR] Recycling the process to avoid an OOM kill',
      expect.objectContaining({
        thresholdMb: DEFAULT_MEMORY_RECYCLE_RSS_MB,
      }),
    );
    expect(console.warn).toHaveBeenCalledWith(
      '[CodeBuddy2API][WARN] Drained in-flight requests, exiting for a clean restart',
      expect.objectContaining({ drained: true }),
    );
  });

  it('does not recycle twice while a drain is in progress', async () => {
    const exit = stubExit();
    stubMemory(DEFAULT_MEMORY_RECYCLE_RSS_MB + 300);
    stubUptime(600);

    setTimeout(() => acquireRequestSlot()?.release(), 5);

    await Promise.all([runRecycleCheck(), runRecycleCheck()]);

    await vi.waitFor(() => expect(exit).toHaveBeenCalled());
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('reports the snapshot it is acting on', () => {
    stubMemory(1_234);

    expect(getMemorySnapshot()).toMatchObject({
      heapTotalMb: 200,
      heapUsedMb: 120,
      rssMb: 1_234,
    });
  });
});

/**
 * Replaces `process.exit` with a no-op for the duration of a test.
 *
 * Left un-stubbed, a recycle test would take the whole vitest worker down.
 */
const stubExit = (): ReturnType<typeof vi.fn> =>
  vi
    .spyOn(process, 'exit')
    .mockImplementation((() => undefined) as typeof process.exit);

const renewExit = (): void => {
  if (vi.isMockFunction(process.exit)) {
    vi.mocked(process.exit).mockRestore();
  }
};
