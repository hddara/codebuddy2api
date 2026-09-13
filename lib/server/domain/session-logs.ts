import { randomUUID } from 'node:crypto';

import {
  deleteStorageJson,
  ensureStorageReady,
  getStorageBackendMeta,
  readStorageJsonResult,
  writeStorageJson,
} from '../storage';

import { findApplicationById } from './applications';

export const SESSION_LOGS_NAMESPACE = 'session-logs';

const INDEX_KEY = 'index';
const DEFAULT_RETENTION_DAYS = 30;
/**
 * The index is a single document, so it stays bounded. Older conversations are
 * dropped from the index (and their documents deleted) once it is full.
 */
const MAX_INDEX_ENTRIES = 500;
const MAX_MESSAGES_CHARS = 200_000;
const MAX_UPSTREAM_CHARS = 200_000;
const OWNER_CACHE_TTL_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const SESSION_LOG_ENABLED_ENV = 'CODEBUDDY_SESSION_LOG_ENABLED';
const SESSION_LOG_RETENTION_ENV = 'CODEBUDDY_SESSION_LOG_RETENTION_DAYS';

export type SessionProtocol = 'anthropic' | 'chat' | 'responses';

export interface SessionLogSummary {
  accessKeyId: string | null;
  accessKeyName: string | null;
  createdAt: string;
  id: string;
  messageCount: number;
  model: string;
  protocol: SessionProtocol;
  route: string;
  /** True when the stored conversation hit the size cap and was clipped. */
  truncated: boolean;
  userId: string | null;
}

export interface SessionLogEntry extends SessionLogSummary {
  messages: unknown[];
  upstreamRequest: unknown;
}

export interface SessionLogState {
  /**
   * Session logs need the documents of a database backend; the file backend
   * cannot index or prune them, so it reports the feature as degraded.
   */
  degraded: boolean;
  enabled: boolean;
  retentionDays: number;
  storageError: string | null;
}

export interface RecordSessionLogInput {
  accessKeyId: string | null;
  accessKeyName: string | null;
  messages: unknown;
  model: string;
  protocol: SessionProtocol;
  route: string;
  upstreamRequest: unknown;
  /** Owning user; resolved from the access key when omitted. */
  userId?: string | null;
}

interface SessionLogIndex {
  logs: SessionLogSummary[];
}

const ownerCache = new Map<
  string,
  { expiresAt: number; userId: string | null }
>();
let mutationQueue: Promise<void> = Promise.resolve();

/** Drops the in-process caches. Tests and storage resets must call this. */
export const resetSessionLogRuntimeState = (): void => {
  ownerCache.clear();
  mutationQueue = Promise.resolve();
};

const enqueueMutation = async <T>(mutation: () => Promise<T>): Promise<T> => {
  const operation = mutationQueue.then(mutation, mutation);
  mutationQueue = operation.then(
    () => undefined,
    () => undefined,
  );

  return operation;
};

const getRetentionDays = (): number => {
  const raw = process.env[SESSION_LOG_RETENTION_ENV]?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;

  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_RETENTION_DAYS;
};

/**
 * Waits for the backend to be resolved first: before initialization the meta
 * descriptor can still disagree with the backend that actually serves writes.
 */
const isDegraded = async (): Promise<boolean> => {
  await ensureStorageReady();

  return getStorageBackendMeta().backend === 'file';
};

/** Session logging is on by default; only an explicit "false" turns it off. */
const isEnabled = async (): Promise<boolean> => {
  return (
    !(await isDegraded()) &&
    process.env[SESSION_LOG_ENABLED_ENV]?.trim().toLowerCase() !== 'false'
  );
};

const parseSummary = (value: unknown): SessionLogSummary | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const record = value as Partial<SessionLogSummary>;

  if (
    typeof record.id !== 'string' ||
    !record.id ||
    typeof record.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(record.createdAt))
  ) {
    return null;
  }

  return {
    accessKeyId:
      typeof record.accessKeyId === 'string' ? record.accessKeyId : null,
    accessKeyName:
      typeof record.accessKeyName === 'string' ? record.accessKeyName : null,
    createdAt: record.createdAt,
    id: record.id,
    messageCount: Number.isFinite(record.messageCount)
      ? Number(record.messageCount)
      : 0,
    model: typeof record.model === 'string' ? record.model : 'unknown',
    protocol:
      record.protocol === 'anthropic' ||
      record.protocol === 'chat' ||
      record.protocol === 'responses'
        ? record.protocol
        : 'chat',
    route: typeof record.route === 'string' ? record.route : '',
    truncated: record.truncated === true,
    userId: typeof record.userId === 'string' ? record.userId : null,
  };
};

const pruneExpired = (
  logs: SessionLogSummary[],
  nowMs: number = Date.now(),
): SessionLogSummary[] => {
  const cutoff = nowMs - getRetentionDays() * DAY_MS;

  return logs.filter((log) => {
    const createdAtMs = Date.parse(log.createdAt);

    return Number.isFinite(createdAtMs) && createdAtMs >= cutoff;
  });
};

const readIndex = async (): Promise<{
  error: string | null;
  logs: SessionLogSummary[];
}> => {
  const result = await readStorageJsonResult<unknown>(
    SESSION_LOGS_NAMESPACE,
    INDEX_KEY,
  );

  if (result.error) {
    return { error: result.error, logs: [] };
  }

  if (!result.exists) {
    return { error: null, logs: [] };
  }

  const value = result.value as Partial<SessionLogIndex> | null;
  const logs = Array.isArray(value?.logs)
    ? value.logs
        .map((entry) => parseSummary(entry))
        .filter((entry): entry is SessionLogSummary => entry !== null)
    : [];

  return { error: null, logs: pruneExpired(logs) };
};

/** Clips a payload that would otherwise bloat a single document. */
const clampPayload = (
  value: unknown,
  maxChars: number,
): { truncated: boolean; value: unknown } => {
  try {
    const text = JSON.stringify(value) ?? '';

    if (text.length <= maxChars) {
      return { truncated: false, value };
    }

    return {
      truncated: true,
      value: { preview: text.slice(0, maxChars), truncated: true },
    };
  } catch {
    return { truncated: true, value: { preview: null, truncated: true } };
  }
};

/** Owning user of an access key, cached because logging runs per request. */
const resolveUserId = async (accessKeyId: string): Promise<string | null> => {
  const cached = ownerCache.get(accessKeyId);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.userId;
  }

  const application = await findApplicationById(accessKeyId);
  const userId = application?.ownerUserId ?? null;

  ownerCache.set(accessKeyId, {
    expiresAt: Date.now() + OWNER_CACHE_TTL_MS,
    userId,
  });

  return userId;
};

export const getSessionLogState = async (): Promise<SessionLogState> => {
  const degraded = await isDegraded();
  const index = degraded ? { error: null } : await readIndex();

  return {
    degraded,
    enabled: !degraded && (await isEnabled()),
    retentionDays: getRetentionDays(),
    storageError: index.error,
  };
};

/**
 * Appends one conversation. Storage problems never propagate: logging must not
 * break inference, exactly like the usage counters.
 */
export const recordSessionLog = async (
  input: RecordSessionLogInput,
): Promise<void> => {
  try {
    if (!(await isEnabled())) {
      return;
    }

    const messages = clampPayload(input.messages, MAX_MESSAGES_CHARS);
    const upstreamRequest = clampPayload(
      input.upstreamRequest,
      MAX_UPSTREAM_CHARS,
    );
    const summary: SessionLogSummary = {
      accessKeyId: input.accessKeyId,
      accessKeyName: input.accessKeyName,
      createdAt: new Date().toISOString(),
      id: randomUUID(),
      messageCount: Array.isArray(input.messages) ? input.messages.length : 0,
      model: input.model.trim() || 'unknown',
      protocol: input.protocol,
      route: input.route,
      truncated: messages.truncated || upstreamRequest.truncated,
      userId:
        input.userId ??
        (input.accessKeyId ? await resolveUserId(input.accessKeyId) : null),
    };

    await writeStorageJson<SessionLogEntry>(
      SESSION_LOGS_NAMESPACE,
      summary.id,
      {
        ...summary,
        messages: Array.isArray(messages.value)
          ? (messages.value as unknown[])
          : [messages.value],
        upstreamRequest: upstreamRequest.value,
      },
    );

    await enqueueMutation(async () => {
      const { logs } = await readIndex();
      const nextLogs = [summary, ...logs].slice(0, MAX_INDEX_ENTRIES);
      const keptIds = new Set(nextLogs.map((log) => log.id));

      await writeStorageJson<SessionLogIndex>(
        SESSION_LOGS_NAMESPACE,
        INDEX_KEY,
        { logs: nextLogs },
      );

      // Anything pushed out of the index can no longer be listed, so its
      // document is deleted instead of leaking storage.
      for (const dropped of logs.filter((log) => !keptIds.has(log.id))) {
        await deleteStorageJson(SESSION_LOGS_NAMESPACE, dropped.id).catch(
          () => undefined,
        );
      }
    });
  } catch (error) {
    console.warn('[CodeBuddy2API] Unable to record the session log', error);
  }
};

export const listSessionLogs = async ({
  limit = 50,
  userId,
}: {
  limit?: number;
  userId?: string | null;
} = {}): Promise<SessionLogSummary[]> => {
  if (await isDegraded()) {
    return [];
  }

  const { logs } = await readIndex();
  const visible = userId ? logs.filter((log) => log.userId === userId) : logs;

  return visible.slice(0, Math.max(1, Math.min(limit, MAX_INDEX_ENTRIES)));
};

export const getSessionLog = async (
  id: string,
): Promise<SessionLogEntry | null> => {
  if (await isDegraded()) {
    return null;
  }

  const result = await readStorageJsonResult<unknown>(
    SESSION_LOGS_NAMESPACE,
    id,
  );

  if (result.error || !result.exists) {
    return null;
  }

  const value = result.value as Partial<SessionLogEntry> | null;
  const summary = parseSummary(value);

  if (!summary) {
    return null;
  }

  return {
    ...summary,
    messages: Array.isArray(value?.messages) ? value.messages : [],
    upstreamRequest: value?.upstreamRequest ?? null,
  };
};

/** Deletes every stored conversation and returns how many were listed. */
export const clearSessionLogs = async (): Promise<number> => {
  if (await isDegraded()) {
    return 0;
  }

  const { logs } = await readIndex();

  await enqueueMutation(async () => {
    for (const log of logs) {
      await deleteStorageJson(SESSION_LOGS_NAMESPACE, log.id).catch(
        () => undefined,
      );
    }

    await writeStorageJson<SessionLogIndex>(SESSION_LOGS_NAMESPACE, INDEX_KEY, {
      logs: [],
    });
  });

  return logs.length;
};
