/**
 * Resident-set sampling and the thresholds derived from it.
 *
 * Kept separate from `diagnostics.ts` so that modules which only need a
 * reading (the concurrency gate logs one per request) do not pull in the
 * watchdog, the process hooks, or the recycle routine.
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

/**
 * Where the process restarts itself instead of waiting to be shot.
 *
 * The container limit is 2 GB and the kernel kills at that line with no
 * warning and no final log line. Recycling at 1.7 GB leaves ~300 MB of runway:
 * enough to finish the requests already in flight, write the reason down, and
 * exit cleanly — which the swarm restarts in a few seconds.
 */
export const DEFAULT_MEMORY_RECYCLE_RSS_MB = 1_700;

/**
 * A restart loop is worse than one slow leak: refuse to recycle a process that
 * has not been up long enough to have accumulated anything worth reclaiming.
 */
export const MEMORY_RECYCLE_MIN_UPTIME_MS = 180_000;

/** How long in-flight requests get to finish before the exit is forced. */
export const MEMORY_RECYCLE_DRAIN_TIMEOUT_MS = 30_000;

export const MEMORY_RECYCLE_ENV = 'CODEBUDDY_MEMORY_RECYCLE_MB';

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

export const getMemoryLevel = (rssMb: number): 'ERROR' | 'INFO' | 'WARN' => {
  if (rssMb >= MEMORY_ERROR_RSS_MB) return 'ERROR';
  if (rssMb >= MEMORY_WARN_RSS_MB) return 'WARN';

  return 'INFO';
};

/**
 * Reads the recycle threshold, or `null` when self-recycling is switched off.
 *
 * `0` and negative values disable it, which is the escape hatch for an operator
 * who would rather see the kernel kill the process than have it restart itself.
 */
export const getMemoryRecycleRssMb = (): number | null => {
  const raw = (process.env[MEMORY_RECYCLE_ENV] ?? '').trim();

  if (!raw) {
    return DEFAULT_MEMORY_RECYCLE_RSS_MB;
  }

  const parsed = Number.parseInt(raw, 10);

  if (!Number.isFinite(parsed)) {
    return DEFAULT_MEMORY_RECYCLE_RSS_MB;
  }

  return parsed > 0 ? parsed : null;
};

export const isMemoryRecycleEnabled = (): boolean =>
  getMemoryRecycleRssMb() !== null;
