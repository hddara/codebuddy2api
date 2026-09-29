import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/server/storage', () => ({
  readStorageJson: vi.fn(),
}));

const { readStorageJson } = await import('@/lib/server/storage');
const {
  LOG_LEVEL_CACHE_TTL_MS,
  MAX_LOG_TEXT_LENGTH,
  getActiveLogLevel,
  isLogLevelEnabled,
  logEvent,
  normalizeLogLevel,
  resetLogLevelCache,
  summarizeLogHeaders,
  truncateLogText,
} = await import('@/lib/server/shared/log');

const consoleSpies = () => ({
  error: vi.spyOn(console, 'error').mockImplementation(() => undefined),
  log: vi.spyOn(console, 'log').mockImplementation(() => undefined),
  warn: vi.spyOn(console, 'warn').mockImplementation(() => undefined),
});

describe('proxy log', () => {
  let spies: ReturnType<typeof consoleSpies>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetLogLevelCache();
    delete process.env.CODEBUDDY_LOG_LEVEL;
    vi.mocked(readStorageJson).mockResolvedValue({
      CODEBUDDY_LOG_LEVEL: 'INFO',
    });
    spies = consoleSpies();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetLogLevelCache();
    delete process.env.CODEBUDDY_LOG_LEVEL;
  });

  it('normalizes log levels and falls back to INFO', () => {
    expect(normalizeLogLevel('debug')).toBe('DEBUG');
    expect(normalizeLogLevel(' warn ')).toBe('WARN');
    expect(normalizeLogLevel('ERROR')).toBe('ERROR');
    expect(normalizeLogLevel('verbose')).toBe('INFO');
    expect(normalizeLogLevel(undefined)).toBe('INFO');
  });

  it('orders levels so that louder levels stay enabled', () => {
    expect(isLogLevelEnabled('ERROR', 'INFO')).toBe(true);
    expect(isLogLevelEnabled('INFO', 'INFO')).toBe(true);
    expect(isLogLevelEnabled('DEBUG', 'INFO')).toBe(false);
    expect(isLogLevelEnabled('WARN', 'ERROR')).toBe(false);
  });

  it('truncates oversized log text with the dropped length', () => {
    expect(truncateLogText('short')).toBe('short');
    expect(truncateLogText('abcdef', 4)).toBe('abcd...[truncated 2 chars]');
    expect(truncateLogText('x'.repeat(MAX_LOG_TEXT_LENGTH + 1))).toContain(
      '[truncated 1 chars]',
    );
  });

  it('summarizes headers while dropping sensitive and oversized values', () => {
    expect(summarizeLogHeaders(undefined)).toBeUndefined();
    expect(
      summarizeLogHeaders(
        new Headers({
          authorization: 'Bearer secret',
          'content-type': 'text/plain',
          'retry-after': '30',
        }),
      ),
    ).toEqual({ 'content-type': 'text/plain', 'retry-after': '30' });
    expect(
      summarizeLogHeaders({ 'x-long': 'y'.repeat(201), 'x-trace': 'trace-1' }),
    ).toEqual({ 'x-trace': 'trace-1' });
    expect(summarizeLogHeaders({ 'set-cookie': 'a=1' })).toBeUndefined();
  });

  it('reads the persisted level, caches it, and falls back to the environment', async () => {
    vi.mocked(readStorageJson).mockResolvedValue({
      CODEBUDDY_LOG_LEVEL: 'DEBUG',
    });

    expect(await getActiveLogLevel()).toBe('DEBUG');
    expect(await getActiveLogLevel()).toBe('DEBUG');
    expect(vi.mocked(readStorageJson)).toHaveBeenCalledTimes(1);

    vi.mocked(readStorageJson).mockRejectedValue(new Error('storage offline'));
    resetLogLevelCache();
    process.env.CODEBUDDY_LOG_LEVEL = 'warn';

    expect(await getActiveLogLevel()).toBe('WARN');

    process.env.CODEBUDDY_LOG_LEVEL = 'not-a-level';
    resetLogLevelCache();

    expect(await getActiveLogLevel()).toBe('INFO');
  });

  it('re-reads the level once the cache has expired', async () => {
    vi.useFakeTimers({ now: new Date('2026-09-29T00:00:00.000Z') });
    vi.mocked(readStorageJson).mockResolvedValue({
      CODEBUDDY_LOG_LEVEL: 'DEBUG',
    });

    expect(await getActiveLogLevel()).toBe('DEBUG');
    vi.advanceTimersByTime(LOG_LEVEL_CACHE_TTL_MS + 1);

    expect(await getActiveLogLevel()).toBe('DEBUG');
    expect(vi.mocked(readStorageJson)).toHaveBeenCalledTimes(2);
  });

  it('routes events to the matching console channel and honors the level', async () => {
    await logEvent({ level: 'ERROR', message: 'boom', payload: { a: 1 } });
    await logEvent({ level: 'WARN', message: 'careful' });
    await logEvent({ level: 'INFO', message: 'hello', payload: { b: 2 } });
    await logEvent({ level: 'DEBUG', message: 'hidden' });

    expect(spies.error).toHaveBeenCalledWith(
      '[CodeBuddy2API][ERROR] boom',
      expect.objectContaining({ a: 1 }),
    );
    expect(spies.warn).toHaveBeenCalledWith(
      '[CodeBuddy2API][WARN] careful',
      '',
    );
    expect(spies.log).toHaveBeenCalledWith(
      '[CodeBuddy2API][INFO] hello',
      expect.objectContaining({ b: 2 }),
    );
    expect(spies.log).toHaveBeenCalledTimes(1);
  });

  it('treats an unknown configured level as INFO', async () => {
    vi.mocked(readStorageJson).mockResolvedValue({
      CODEBUDDY_LOG_LEVEL: 'quiet',
    });
    resetLogLevelCache();

    await logEvent({ level: 'DEBUG', message: 'hidden' });
    await logEvent({ level: 'INFO', message: 'visible' });

    expect(spies.log).toHaveBeenCalledTimes(1);
    expect(spies.log).toHaveBeenCalledWith('[CodeBuddy2API][INFO] visible', '');
  });
});
