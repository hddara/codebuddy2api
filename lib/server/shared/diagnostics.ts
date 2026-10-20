import { logEvent } from './log';

/**
 * Process-level diagnostics.
 *
 * The service was killed three times in a day by the kernel OOM killer (exit
 * 137). An OOM kill gives the process no chance to write a final line, so the
 * only way to see the growth coming is to sample the resident set periodically
 * and keep the sample in the normal log stream, where it lines up with the
 * request logs. Thresholds turn silently growing memory into a WARN/ERROR that
 * can be alerted on before the container dies.
 */
export interface MemorySnapshot {
  arrayBuffersMb: number;
  externalMb: number;
  heapTotalMb: number;
  heapUsedMb: number;
  rssMb: number;
  uptimeSeconds: number;
}

const BYTES_PER_MB = 1024 * 1024;

export const MEMORY_WATCH_INTERVAL_MS = 60_000;
export const MEMORY_WARN_RSS_MB = 1_500;
export const MEMORY_ERROR_RSS_MB = 2_000;

export const getMemorySnapshot = (): MemorySnapshot => {
  const usage = process.memoryUsage();

  return {
    arrayBuffersMb: Math.round(usage.arrayBuffers / BYTES_PER_MB),
    externalMb: Math.round(usage.external / BYTES_PER_MB),
    heapTotalMb: Math.round(usage.heapTotal / BYTES_PER_MB),
    heapUsedMb: Math.round(usage.heapUsed / BYTES_PER_MB),
    rssMb: Math.round(usage.rss / BYTES_PER_MB),
    uptimeSeconds: Math.round(process.uptime()),
  };
};

const getMemoryLevel = (rssMb: number): 'ERROR' | 'INFO' | 'WARN' => {
  if (rssMb >= MEMORY_ERROR_RSS_MB) return 'ERROR';
  if (rssMb >= MEMORY_WARN_RSS_MB) return 'WARN';

  return 'INFO';
};

export const logMemorySnapshot = (
  label: string,
  extra?: Record<string, unknown>,
): void => {
  const snapshot = getMemorySnapshot();

  void logEvent({
    level: getMemoryLevel(snapshot.rssMb),
    message: 'Process memory snapshot',
    payload: {
      label,
      ...snapshot,
      ...extra,
    },
  });
};

let watchTimer: ReturnType<typeof setInterval> | null = null;
let diagnosticsInstalled = false;

export const startMemoryWatchdog = (): void => {
  if (watchTimer) return;

  watchTimer = setInterval(() => {
    logMemorySnapshot('interval');
  }, MEMORY_WATCH_INTERVAL_MS);
  watchTimer.unref?.();
};

export const stopMemoryWatchdog = (): void => {
  if (!watchTimer) return;

  clearInterval(watchTimer);
  watchTimer = null;
};

/**
 * Observational hooks only: nothing here changes how the process terminates.
 * `uncaughtExceptionMonitor` fires before the default fatal handler, and
 * `beforeExit` runs when the event loop drains, so both are safe to attach.
 * Signal handlers are deliberately absent — `domain/credentials` already owns
 * SIGTERM/SIGINT and re-raises them, and a second listener would swallow the
 * termination.
 */
export const installProcessDiagnostics = (): void => {
  if (diagnosticsInstalled) return;

  diagnosticsInstalled = true;

  process.on('beforeExit', () => {
    logMemorySnapshot('before-exit');
  });

  process.on('uncaughtExceptionMonitor', (error) => {
    logMemorySnapshot('uncaught-exception', {
      errorMessage: String(error?.message ?? error),
      errorStack: String(error?.stack ?? '').slice(0, 2_000),
    });
  });
};
