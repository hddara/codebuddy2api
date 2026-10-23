import {
  getConcurrencyState,
  getMaxConcurrentRequests,
} from './concurrency-gate';
import { getMaxRequestBodyBytes, getRequestTargetBytes } from './http';
import { logEvent } from './log';
import {
  getMemoryLevel,
  getMemoryRecycleRssMb,
  getMemorySnapshot,
  MEMORY_ERROR_RSS_MB,
  MEMORY_RECYCLE_DRAIN_TIMEOUT_MS,
  MEMORY_RECYCLE_MIN_UPTIME_MS,
  MEMORY_WARN_RSS_MB,
  MEMORY_WATCH_INTERVAL_MS,
  type MemorySnapshot,
} from './memory';
import { isHistoryCompressionEnabled } from '../proxy/history-compression';

/**
 * Process-level diagnostics.
 *
 * The service was killed three times in a day by the kernel OOM killer (exit
 * 137). An OOM kill gives the process no chance to write a final line, so the
 * only way to see the growth coming is to sample the resident set periodically
 * and keep the sample in the normal log stream, where it lines up with the
 * request logs. Thresholds turn silently growing memory into a WARN/ERROR that
 * can be alerted on before the container dies.
 *
 * Sampling alone was not enough. The resident set does not come back down after
 * a spike — V8 keeps the pages it grew into — so a process that survived one
 * burst of large requests sat at 1.8 GB and died on the next one. The watchdog
 * therefore also *recycles*: past a configurable line it drains the requests in
 * flight and exits cleanly, which the swarm restarts in seconds. A restart is a
 * few seconds of unavailable capacity; an OOM kill is the same downtime with no
 * log line, no drain, and a truncated reply for whoever was mid-stream.
 */
export type { MemorySnapshot };

export {
  getMemorySnapshot,
  MEMORY_ERROR_RSS_MB,
  MEMORY_WARN_RSS_MB,
  MEMORY_WATCH_INTERVAL_MS,
} from './memory';
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
let recycling = false;

const waitForDrain = async (timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (getConcurrencyState().active <= 0) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return getConcurrencyState().active <= 0;
};

/**
 * Restarts the process instead of letting the kernel do it.
 *
 * The guards matter more than the trigger:
 * - a young process is not recycled, so a request that trips the threshold
 *   during startup cannot turn into a restart loop;
 * - only one recycle runs at a time;
 * - requests in flight get a bounded drain window, because a stream that never
 *   ends must not be able to block the exit forever.
 */
const maybeRecycle = async (): Promise<void> => {
  if (recycling) return;

  const thresholdMb = getMemoryRecycleRssMb();

  if (thresholdMb === null) return;

  const snapshot = getMemorySnapshot();

  if (snapshot.rssMb < thresholdMb) return;

  if (process.uptime() * 1_000 < MEMORY_RECYCLE_MIN_UPTIME_MS) {
    void logEvent({
      level: 'WARN',
      message:
        'Memory over the recycle threshold but uptime is too low to recycle',
      payload: {
        ...snapshot,
        active: getConcurrencyState().active,
        minUptimeSeconds: Math.round(MEMORY_RECYCLE_MIN_UPTIME_MS / 1_000),
        thresholdMb,
      },
    });

    return;
  }

  recycling = true;

  void logEvent({
    level: 'ERROR',
    message: 'Recycling the process to avoid an OOM kill',
    payload: {
      ...snapshot,
      active: getConcurrencyState().active,
      drainTimeoutMs: MEMORY_RECYCLE_DRAIN_TIMEOUT_MS,
      thresholdMb,
    },
  });

  const drained = await waitForDrain(MEMORY_RECYCLE_DRAIN_TIMEOUT_MS);

  void logEvent({
    level: drained ? 'WARN' : 'ERROR',
    message: drained
      ? 'Drained in-flight requests, exiting for a clean restart'
      : 'Drain timed out, forcing the restart with requests still active',
    payload: {
      ...getMemorySnapshot(),
      active: getConcurrencyState().active,
      drained,
    },
  });

  // 0 rather than 1: the swarm restart policy treats a non-zero exit as a
  // failure, and this is a controlled restart, not a crash. It also stops
  // Docker from backing off the restart.
  process.exit(0);
};

export const runRecycleCheck = async (): Promise<void> => {
  await maybeRecycle();
};

export const startMemoryWatchdog = (): void => {
  if (watchTimer) return;

  watchTimer = setInterval(() => {
    logMemorySnapshot('interval', { active: getConcurrencyState().active });
    void maybeRecycle();
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

export const resetRecycleTimerForTests = (): void => {
  recycling = false;
};

/**
 * One line at boot naming every memory guard and the value it resolved to.
 *
 * The limits are read from the environment, and the stack file is not evidence
 * of what a running task received: on 2026-10-23 the definition said one image
 * and no guard variables while the service ran a different image entirely. A
 * line like this turns "did the deploy pick it up" from an inference into a
 * lookup, and it is emitted before any request can arrive.
 */
export const logRuntimeLimits = (): void => {
  const snapshot = getMemorySnapshot();

  void logEvent({
    level: 'INFO',
    message: 'Runtime limits',
    payload: {
      ...snapshot,
      historyCompression: isHistoryCompressionEnabled(),
      maxConcurrentRequests: getMaxConcurrentRequests(),
      maxRequestBodyBytes: getMaxRequestBodyBytes(),
      requestTargetBytes: getRequestTargetBytes(),
      memoryErrorRssMb: MEMORY_ERROR_RSS_MB,
      memoryRecycleRssMb: getMemoryRecycleRssMb(),
      memoryWarnRssMb: MEMORY_WARN_RSS_MB,
      nodeVersion: process.version,
      pid: process.pid,
    },
  });
};
