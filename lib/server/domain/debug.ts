import crypto from 'node:crypto';

import {
  captureIndependentResponseSnapshot,
  captureResponseSnapshot,
  maskSensitiveString,
  sanitizeHeadersRecord,
  sanitizeValue,
  type HttpSnapshot,
} from '../shared/stream-capture';

import {
  appendStorageDebugLogs,
  clearStorageDebugLogs,
  getStorageBackendMeta,
  listStorageDebugLogs,
  readStorageJson,
  trimStorageDebugLogs,
  writeStorageJson,
} from '../storage';

export interface DebugLogEntry {
  credentialFilename: string | null;
  createdAt: string;
  elapsedMs: number;
  error: string | null;
  id: string;
  model: string | null;
  requestBody: unknown;
  requestKey: string | null;
  route: string;
  transformedResponse: DebugHttpSnapshot | null;
  upstreamRequest: DebugUpstreamRequest | null;
  upstreamResponse: DebugHttpSnapshot | null;
  usage: DebugUsageMetrics | null;
}

export interface DebugUsageMetrics {
  cacheCreationTokens: number;
  cacheReadTokens: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export type DebugHttpSnapshot = HttpSnapshot;

export interface DebugSettings {
  autoRefreshSeconds: number;
  enabled: boolean;
  maxEntries: number;
}

export interface DebugTrace {
  credentialFilename: string | null;
  createdAt: string;
  error: string | null;
  id: string;
  pending: Promise<void>[];
  requestBody: unknown;
  requestKey: string | null;
  route: string;
  startedAtMs: number;
  transformedResponse: DebugHttpSnapshot | null;
  upstreamRequest: DebugUpstreamRequest | null;
  upstreamResponse: DebugHttpSnapshot | null;
}

interface DebugConfigFile {
  autoRefreshSeconds?: number;
  enabled?: boolean;
  maxEntries?: number;
}

export interface DebugUpstreamRequest {
  body: unknown;
  headers: Record<string, string>;
  method: string;
  url: string;
}

const DEFAULT_DEBUG_SETTINGS: DebugSettings = {
  autoRefreshSeconds: 0,
  enabled: false,
  maxEntries: 10,
};

const FLUSH_INTERVAL_MS = 1000;
const DEBUG_SETTINGS_CACHE_TTL_MS = 1000;
const MAX_PENDING_LOGS = 100;
let debugWriteQueue: Promise<void> = Promise.resolve();
let pendingDebugLogs: DebugLogEntry[] = [];
let pendingDebugFlushes = 0;
let pendingDebugTraces = 0;
let debugFlushTimer: ReturnType<typeof setTimeout> | null = null;
let debugSettingsCache: {
  cachedAt: number;
  key: string;
  value: DebugSettings;
} | null = null;
const enqueueDebugWrite = async <T>(mutation: () => Promise<T>): Promise<T> => {
  const operation = debugWriteQueue.then(mutation, mutation);
  debugWriteQueue = operation.then(
    () => undefined,
    () => undefined,
  );

  return operation;
};

const normalizeMaxEntries = (value: unknown): number => {
  const numeric =
    typeof value === 'number'
      ? value
      : Number.parseInt(String(value ?? ''), 10);

  if (!Number.isFinite(numeric) || numeric <= 0) {
    return DEFAULT_DEBUG_SETTINGS.maxEntries;
  }

  return Math.min(1000, Math.max(1, numeric));
};

const normalizeAutoRefreshSeconds = (value: unknown): number => {
  const numeric =
    typeof value === 'number'
      ? value
      : Number.parseInt(String(value ?? ''), 10);

  if (!Number.isFinite(numeric) || numeric < 0) {
    return DEFAULT_DEBUG_SETTINGS.autoRefreshSeconds;
  }

  const allowedValues = new Set([0, 5, 10, 15, 30, 60, 120, 300]);

  return allowedValues.has(numeric)
    ? numeric
    : DEFAULT_DEBUG_SETTINGS.autoRefreshSeconds;
};

const getDebugSettingsCacheKey = (): string => {
  return [
    process.cwd(),
    process.env.CODEBUDDY_CONFIG_PATH ?? '',
    process.env.CODEBUDDY_STORAGE_BACKEND ?? '',
    process.env.CODEBUDDY_STORAGE_FILE_DIR ?? '',
    process.env.CODEBUDDY_STORAGE_SQLITE_PATH ?? '',
  ].join(':');
};

const readDebugSettings = async (): Promise<DebugSettings> => {
  const file =
    (await readStorageJson<DebugConfigFile>('debug', 'settings')) ?? {};

  const settings = {
    autoRefreshSeconds: normalizeAutoRefreshSeconds(file.autoRefreshSeconds),
    enabled:
      typeof file.enabled === 'boolean'
        ? file.enabled
        : DEFAULT_DEBUG_SETTINGS.enabled,
    maxEntries: normalizeMaxEntries(file.maxEntries),
  };
  debugSettingsCache = {
    cachedAt: Date.now(),
    key: getDebugSettingsCacheKey(),
    value: settings,
  };
  return settings;
};

export const getDebugSettings = async (): Promise<DebugSettings> => {
  return readDebugSettings();
};

export const updateDebugSettings = async (
  nextSettings: Partial<DebugSettings>,
): Promise<DebugSettings> => {
  const current = await readDebugSettings();
  const merged: DebugSettings = {
    autoRefreshSeconds:
      nextSettings.autoRefreshSeconds !== undefined
        ? normalizeAutoRefreshSeconds(nextSettings.autoRefreshSeconds)
        : current.autoRefreshSeconds,
    enabled:
      typeof nextSettings.enabled === 'boolean'
        ? nextSettings.enabled
        : current.enabled,
    maxEntries:
      nextSettings.maxEntries !== undefined
        ? normalizeMaxEntries(nextSettings.maxEntries)
        : current.maxEntries,
  };

  await enqueueDebugWrite(async () => {
    await writeStorageJson('debug', 'settings', merged);

    if (getStorageBackendMeta().backend !== 'file') {
      await trimStorageDebugLogs(merged.maxEntries);
      return;
    }

    const logs = await readDebugLogs();
    await writeStorageJson('debug', 'logs', logs.slice(0, merged.maxEntries));
  });
  debugSettingsCache = {
    cachedAt: Date.now(),
    key: getDebugSettingsCacheKey(),
    value: merged,
  };

  return merged;
};

const readDebugLogs = async (): Promise<DebugLogEntry[]> => {
  if (getStorageBackendMeta().backend !== 'file') {
    const settings = await getDebugSettings();
    const events = await listStorageDebugLogs(settings.maxEntries);
    return events
      .filter((event): event is typeof event & { payload: DebugLogEntry } => {
        const entry = event.payload;
        return Boolean(
          entry &&
          typeof entry === 'object' &&
          typeof (entry as DebugLogEntry).id === 'string',
        );
      })
      .map((event) => event.payload);
  }

  const logs = (await readStorageJson<DebugLogEntry[]>('debug', 'logs')) ?? [];

  if (!Array.isArray(logs)) {
    return [];
  }

  return logs.filter((log): log is DebugLogEntry => {
    return Boolean(
      log &&
      typeof log === 'object' &&
      typeof log.id === 'string' &&
      typeof log.route === 'string' &&
      typeof log.createdAt === 'string',
    );
  });
};

export const listDebugLogs = async (): Promise<DebugLogEntry[]> => {
  return readDebugLogs();
};

export const hasPendingDebugLogWrites = (): boolean => {
  return Boolean(
    pendingDebugLogs.length ||
    debugFlushTimer ||
    pendingDebugFlushes ||
    pendingDebugTraces,
  );
};

export const clearDebugLogs = async (): Promise<void> => {
  pendingDebugLogs = [];
  if (debugFlushTimer) {
    clearTimeout(debugFlushTimer);
    debugFlushTimer = null;
  }
  await enqueueDebugWrite(async () => {
    if (getStorageBackendMeta().backend !== 'file') {
      await clearStorageDebugLogs();
      return;
    }
    await writeStorageJson('debug', 'logs', []);
  });
};

export const isDebugEnabled = async (): Promise<boolean> => {
  const cacheKey = getDebugSettingsCacheKey();

  if (
    debugSettingsCache?.key === cacheKey &&
    Date.now() - debugSettingsCache.cachedAt < DEBUG_SETTINGS_CACHE_TTL_MS
  ) {
    return debugSettingsCache.value.enabled;
  }

  return (await readDebugSettings()).enabled;
};

export const createDebugTrace = ({
  requestBody,
  requestKey,
  route,
}: {
  requestBody: unknown;
  requestKey: string | null;
  route: string;
}): DebugTrace => {
  return {
    credentialFilename: null,
    createdAt: new Date().toISOString(),
    error: null,
    id: crypto.randomUUID(),
    pending: [],
    requestBody: sanitizeValue(requestBody),
    requestKey:
      typeof requestKey === 'string'
        ? maskSensitiveString(requestKey)
        : requestKey,
    route,
    startedAtMs: Date.now(),
    transformedResponse: null,
    upstreamRequest: null,
    upstreamResponse: null,
  };
};

export const setDebugTraceCredential = (
  trace: DebugTrace | undefined,
  credentialFilename: string | null,
): void => {
  if (!trace) {
    return;
  }

  trace.credentialFilename = credentialFilename;
};

export const setDebugTraceError = (
  trace: DebugTrace | undefined,
  error: unknown,
): void => {
  if (!trace) {
    return;
  }

  trace.error =
    error instanceof Error ? error.message : String(error ?? 'Unknown error');
};

export const setDebugUpstreamRequest = (
  trace: DebugTrace | undefined,
  request: DebugUpstreamRequest,
): void => {
  if (!trace) {
    return;
  }

  trace.upstreamRequest = {
    ...request,
    body: sanitizeValue(request.body),
    headers: sanitizeHeadersRecord(request.headers),
  };
};

const asRecord = (value: unknown): Record<string, unknown> | null => {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
};

const toTokenCount = (value: unknown): number => {
  const numeric =
    typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));

  return Number.isFinite(numeric) && numeric >= 0 ? numeric : 0;
};

const getTraceModel = (trace: DebugTrace): string | null => {
  const upstreamBody = asRecord(trace.upstreamRequest?.body);
  const requestBody = asRecord(trace.requestBody);
  const model = upstreamBody?.model ?? requestBody?.model;

  return typeof model === 'string' && model.trim() ? model.trim() : null;
};

const getResponseRecord = (body: unknown): Record<string, unknown> | null => {
  const record = asRecord(body);

  if (record) {
    return record;
  }

  if (typeof body !== 'string') {
    return null;
  }

  const events = body
    .split(/\r?\n\r?\n/)
    .map((event) =>
      event
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice('data:'.length).trim())
        .join('\n'),
    )
    .filter(Boolean);

  for (const event of events.reverse()) {
    try {
      const parsed = asRecord(JSON.parse(event) as unknown);
      if (getResponseUsage(parsed)) {
        return parsed;
      }
    } catch {
      // Ignore non-JSON SSE sentinels such as [DONE].
    }
  }

  try {
    return asRecord(JSON.parse(body) as unknown);
  } catch {
    return null;
  }
};

const getResponseUsage = (
  response: Record<string, unknown> | null,
): Record<string, unknown> | null => {
  return (
    asRecord(asRecord(response?.response)?.usage) ?? asRecord(response?.usage)
  );
};

const getTraceUsage = (trace: DebugTrace): DebugUsageMetrics | null => {
  const responseBody =
    getResponseRecord(trace.transformedResponse?.body) ??
    getResponseRecord(trace.upstreamResponse?.body);
  const usage = getResponseUsage(responseBody);

  if (!usage) {
    return null;
  }

  const inputTokens = toTokenCount(usage.input_tokens ?? usage.prompt_tokens);
  const outputTokens = toTokenCount(
    usage.output_tokens ?? usage.completion_tokens,
  );
  const promptTokenDetails = asRecord(usage.prompt_tokens_details);
  const cacheReadTokens = Math.max(
    toTokenCount(usage.cache_read_input_tokens),
    toTokenCount(promptTokenDetails?.cached_tokens),
    toTokenCount(usage.prompt_cache_hit_tokens),
  );
  const cacheCreationTokens = Math.max(
    toTokenCount(usage.cache_creation_input_tokens),
    toTokenCount(promptTokenDetails?.cache_creation_tokens),
    toTokenCount(usage.prompt_cache_write_tokens),
  );
  const totalTokens =
    toTokenCount(usage.total_tokens) ||
    inputTokens +
      outputTokens +
      (promptTokenDetails ? 0 : cacheReadTokens + cacheCreationTokens);

  return {
    cacheCreationTokens,
    cacheReadTokens,
    inputTokens,
    outputTokens,
    totalTokens,
  };
};

export const enqueueUpstreamResponseSnapshot = (
  trace: DebugTrace | undefined,
  response: Response,
): Response => {
  if (!trace) {
    return response;
  }

  const captured = captureResponseSnapshot(response);

  trace.pending.push(
    captured.snapshot
      .then((snapshot) => {
        trace.upstreamResponse = snapshot;
      })
      .catch((error) => {
        setDebugTraceError(trace, error);
      }),
  );
  return captured.response;
};

const appendDebugLog = async (entry: DebugLogEntry): Promise<void> => {
  pendingDebugLogs.push(entry);

  if (pendingDebugLogs.length >= MAX_PENDING_LOGS) {
    void flushPendingDebugLogs().catch(() => undefined);
    return;
  }

  scheduleDebugFlush();
};

const flushPendingDebugLogs = async (): Promise<void> => {
  if (debugFlushTimer) {
    clearTimeout(debugFlushTimer);
    debugFlushTimer = null;
  }

  const entries = pendingDebugLogs.splice(0, MAX_PENDING_LOGS);

  if (!entries.length) {
    await debugWriteQueue;
    return;
  }

  pendingDebugFlushes += 1;

  try {
    await enqueueDebugWrite(async () => {
      if (getStorageBackendMeta().backend !== 'file') {
        const settings = await getDebugSettings();
        await appendStorageDebugLogs(
          entries.map((entry) => ({
            id: entry.id,
            payload: entry,
            timestamp: entry.createdAt,
          })),
        );
        await trimStorageDebugLogs(settings.maxEntries);
        if (pendingDebugLogs.length) {
          scheduleDebugFlush();
        }
        return;
      }
      const settings = await getDebugSettings();
      const currentLogs = await readDebugLogs();
      const nextLogs = [...entries]
        .reverse()
        .concat(currentLogs)
        .slice(0, settings.maxEntries);
      await writeStorageJson('debug', 'logs', nextLogs);
      if (pendingDebugLogs.length) {
        scheduleDebugFlush();
      }
    });
  } catch (error) {
    pendingDebugLogs = [...entries, ...pendingDebugLogs];
    scheduleDebugFlush();
    throw error;
  } finally {
    pendingDebugFlushes -= 1;
  }
};

export const flushDebugLogs = async (): Promise<void> => {
  while (pendingDebugLogs.length || pendingDebugFlushes) {
    await flushPendingDebugLogs();
  }
};

const scheduleDebugFlush = (): void => {
  if (debugFlushTimer) return;
  debugFlushTimer = setTimeout(() => {
    void flushPendingDebugLogs().catch(() => undefined);
  }, FLUSH_INTERVAL_MS);
  debugFlushTimer.unref?.();
};

export const finalizeDebugTrace = (
  trace: DebugTrace | undefined,
  response: Response,
): Response => {
  if (!trace) {
    return response;
  }

  pendingDebugTraces += 1;

  trace.pending.push(
    captureIndependentResponseSnapshot(response)
      .then((snapshot) => {
        trace.transformedResponse = snapshot;
      })
      .catch((error) => {
        setDebugTraceError(trace, error);
      }),
  );

  void Promise.all(trace.pending)
    .catch((error) => {
      setDebugTraceError(trace, error);
    })
    .finally(() => {
      const elapsedMs = Math.max(0, Date.now() - trace.startedAtMs);
      void appendDebugLog({
        credentialFilename: trace.credentialFilename,
        createdAt: trace.createdAt,
        elapsedMs,
        error: trace.error,
        id: trace.id,
        model: getTraceModel(trace),
        requestBody: trace.requestBody,
        requestKey: trace.requestKey,
        route: trace.route,
        transformedResponse: trace.transformedResponse,
        upstreamRequest: trace.upstreamRequest,
        upstreamResponse: trace.upstreamResponse,
        usage: getTraceUsage(trace),
      });
      pendingDebugTraces -= 1;
    });
  return response;
};
