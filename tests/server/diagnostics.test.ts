import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/server/storage', () => ({
  readStorageJson: vi.fn(),
}));

const { readStorageJson } = await import('@/lib/server/storage');
const {
  MEMORY_ERROR_RSS_MB,
  MEMORY_WARN_RSS_MB,
  getMemorySnapshot,
  installProcessDiagnostics,
  logMemorySnapshot,
  logRuntimeLimits,
  startMemoryWatchdog,
  stopMemoryWatchdog,
} = await import('@/lib/server/shared/diagnostics');
const { getRequestContext, runWithRequestContext } =
  await import('@/lib/server/shared/request-context');
const { logEvent, resetLogLevelCache } =
  await import('@/lib/server/shared/log');

const BYTES_PER_MB = 1024 * 1024;

const stubMemory = (rssMb: number) =>
  vi.spyOn(process, 'memoryUsage').mockReturnValue({
    arrayBuffers: 3 * BYTES_PER_MB,
    external: 7 * BYTES_PER_MB,
    heapTotal: 40 * BYTES_PER_MB,
    heapUsed: 20 * BYTES_PER_MB,
    rss: rssMb * BYTES_PER_MB,
  });

describe('process diagnostics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetLogLevelCache();
    delete process.env.CODEBUDDY_LOG_LEVEL;
    vi.mocked(readStorageJson).mockResolvedValue({
      CODEBUDDY_LOG_LEVEL: 'DEBUG',
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    stopMemoryWatchdog();
    vi.restoreAllMocks();
    resetLogLevelCache();
  });

  it('reports the resident set and heap in megabytes', () => {
    stubMemory(1_234);

    expect(getMemorySnapshot()).toMatchObject({
      arrayBuffersMb: 3,
      externalMb: 7,
      heapTotalMb: 40,
      heapUsedMb: 20,
      rssMb: 1_234,
    });
  });

  it('escalates the memory snapshot once it approaches the OOM point', async () => {
    stubMemory(MEMORY_WARN_RSS_MB + 1);
    logMemorySnapshot('unit');
    await vi.waitFor(() => expect(console.warn).toHaveBeenCalled());
    expect(console.warn).toHaveBeenCalledWith(
      '[CodeBuddy2API][WARN] Process memory snapshot',
      expect.objectContaining({ rssMb: MEMORY_WARN_RSS_MB + 1 }),
    );

    vi.mocked(console.warn).mockClear();
    stubMemory(MEMORY_ERROR_RSS_MB + 1);
    logMemorySnapshot('unit');
    await vi.waitFor(() => expect(console.error).toHaveBeenCalled());
    expect(console.error).toHaveBeenCalledWith(
      '[CodeBuddy2API][ERROR] Process memory snapshot',
      expect.objectContaining({ rssMb: MEMORY_ERROR_RSS_MB + 1 }),
    );
  });

  it('keeps a single watchdog running when started twice', async () => {
    vi.useFakeTimers();
    stubMemory(100);

    startMemoryWatchdog();
    startMemoryWatchdog();
    await vi.advanceTimersByTimeAsync(60_000);

    // One sample per interval regardless of how many callers asked for it.
    expect(console.log).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('records the limits the process actually resolved at boot', async () => {
    stubMemory(80);
    logRuntimeLimits();

    await vi.waitFor(() =>
      expect(console.log).toHaveBeenCalledWith(
        '[CodeBuddy2API][INFO] Runtime limits',
        expect.objectContaining({
          historyCompression: true,
          maxConcurrentRequests: 4,
          maxRequestBodyBytes: 32 * 1024 * 1024,
          memoryRecycleRssMb: 1700,
          nodeVersion: process.version,
          requestTargetBytes: 1024 * 1024,
        }),
      ),
    );
  });

  it('installs its process hooks once', () => {
    const before = process.listenerCount('beforeExit');
    installProcessDiagnostics();
    installProcessDiagnostics();

    expect(process.listenerCount('beforeExit')).toBe(before + 1);
  });
});

describe('request context', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetLogLevelCache();
    vi.mocked(readStorageJson).mockResolvedValue({
      CODEBUDDY_LOG_LEVEL: 'DEBUG',
    });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetLogLevelCache();
  });

  it('propagates an id across awaits and stamps every log line', async () => {
    await runWithRequestContext('/v1/chat/completions', async () => {
      const context = getRequestContext();
      await new Promise((resolve) => setTimeout(resolve, 1));

      expect(getRequestContext()?.id).toBe(context?.id);
      expect(context?.route).toBe('/v1/chat/completions');

      await logEvent({
        level: 'INFO',
        message: 'stage',
        payload: { model: 'deepseek-v4.1-flash' },
      });

      expect(console.log).toHaveBeenCalledWith(
        '[CodeBuddy2API][INFO] stage',
        expect.objectContaining({
          model: 'deepseek-v4.1-flash',
          reqId: context?.id,
        }),
      );
    });

    expect(getRequestContext()).toBeUndefined();
  });
});
