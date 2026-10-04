import {
  deleteStorageJson,
  getStorageBackendMeta,
  listStorageJson,
  readStorageJson,
  writeStorageJson,
} from '../storage';
import { subscribeToSessionEvents, type SessionEvent } from './session-stream';

/**
 * Durable question/answer log for conversations the gateway served.
 *
 * Each turn is stored as its own document (`namespace/key`) so recording is O(1):
 * rewriting a single array document would cost a full rewrite of every stored
 * turn on every request. Retention is governed by **two independent limits** —
 * age and count — and whichever is hit first wins, because count alone cannot
 * express "keep 30 days" and age alone cannot bound a traffic spike.
 *
 * Content is stored as plain JSON text. Callers that treat the gateway as a
 * trusted boundary can rely on that; anyone exposing these endpoints should
 * treat the data as sensitive conversation content.
 */

const NAMESPACE = 'session-transcripts';
const SETTINGS_KEY = 'settings';

/** Turns kept per conversation prompt/answer, mirroring the debug snapshot cap. */
const MAX_QUESTION_CHARS = 4_000;
const MAX_ANSWER_CHARS = 100_000;

export const SESSION_TRANSCRIPT_LIMITS = {
  maxEntries: { hard: 20_000, min: 10 },
  retentionDays: { hard: 365, min: 1 },
} as const;

export interface SessionTranscriptSettings {
  enabled: boolean;
  /** Maximum stored turns; oldest are pruned once exceeded. */
  maxEntries: number;
  /** Maximum age in days; older turns are pruned. */
  retentionDays: number;
}

export const DEFAULT_SESSION_TRANSCRIPT_SETTINGS: SessionTranscriptSettings = {
  enabled: true,
  maxEntries: 2_000,
  retentionDays: 30,
};

export type SessionTranscriptStatus = 'completed' | 'failed';

export interface SessionTranscriptRecord {
  accessKeyId: string | null;
  /** Model output as accumulated by the gateway, truncated to the storage cap. */
  answer: string;
  answerChars: number;
  completedAt: string;
  conversationId: string;
  error?: string;
  /** Storage key; sortable because it is prefixed with the completion time. */
  id: string;
  model: string | null;
  /** The user prompt that triggered this turn, truncated to the storage cap. */
  question: string;
  questionChars: number;
  startedAt: string;
  status: SessionTranscriptStatus;
}

export interface SessionTranscriptListResponse {
  entries: SessionTranscriptRecord[];
  settings: SessionTranscriptSettings;
  totals: {
    answerChars: number;
    questionChars: number;
    stored: number;
  };
}

interface SessionTranscriptRuntime {
  __codebuddy2apiTranscriptRecorder__?: string;
  __codebuddy2apiTranscriptPrunedAt__?: number;
}

const globalState = globalThis as typeof globalThis & SessionTranscriptRuntime;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(Math.floor(value), min), max);

const normalizePositiveInt = (
  value: unknown,
  fallback: number,
  bounds: { hard: number; min: number },
): number => {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : Number.NaN;

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return clamp(parsed, bounds.min, bounds.hard);
};

const truncate = (value: string, max: number): string =>
  value.length > max ? value.slice(0, max) : value;

const isContentPart = (value: unknown): value is { text?: unknown } =>
  typeof value === 'object' && value !== null;

/**
 * Pulls the user prompt out of an OpenAI-style chat body.
 *
 * Walks backwards to the last `user` message and joins its text parts, because
 * that is the turn the reply belongs to. Tool-result-only messages are skipped:
 * they carry no human question.
 */
export const extractQuestionText = (body?: object): string => {
  const messages = (body as { messages?: unknown })?.messages;

  if (!Array.isArray(messages)) {
    return '';
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as
      { content?: unknown; role?: unknown } | undefined;

    if (!message || message.role !== 'user') {
      continue;
    }

    const content = message.content;

    if (typeof content === 'string') {
      const trimmed = content.trim();

      if (trimmed) {
        return truncate(trimmed, MAX_QUESTION_CHARS);
      }

      continue;
    }

    if (!Array.isArray(content)) {
      continue;
    }

    const parts = content
      .filter(isContentPart)
      .map((part) => (typeof part.text === 'string' ? part.text : ''))
      .filter(Boolean);

    if (parts.length) {
      return truncate(parts.join('\n').trim(), MAX_QUESTION_CHARS);
    }
  }

  return '';
};

export const getSessionTranscriptSettings =
  async (): Promise<SessionTranscriptSettings> => {
    const stored =
      (await readStorageJson<Partial<SessionTranscriptSettings>>(
        NAMESPACE,
        SETTINGS_KEY,
      )) ?? {};

    return {
      enabled:
        typeof stored.enabled === 'boolean'
          ? stored.enabled
          : DEFAULT_SESSION_TRANSCRIPT_SETTINGS.enabled,
      maxEntries: normalizePositiveInt(
        stored.maxEntries,
        DEFAULT_SESSION_TRANSCRIPT_SETTINGS.maxEntries,
        SESSION_TRANSCRIPT_LIMITS.maxEntries,
      ),
      retentionDays: normalizePositiveInt(
        stored.retentionDays,
        DEFAULT_SESSION_TRANSCRIPT_SETTINGS.retentionDays,
        SESSION_TRANSCRIPT_LIMITS.retentionDays,
      ),
    };
  };

export const updateSessionTranscriptSettings = async (
  patch: Partial<SessionTranscriptSettings>,
): Promise<SessionTranscriptSettings> => {
  const current = await getSessionTranscriptSettings();
  const next: SessionTranscriptSettings = {
    enabled:
      typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
    maxEntries:
      patch.maxEntries === undefined
        ? current.maxEntries
        : normalizePositiveInt(
            patch.maxEntries,
            current.maxEntries,
            SESSION_TRANSCRIPT_LIMITS.maxEntries,
          ),
    retentionDays:
      patch.retentionDays === undefined
        ? current.retentionDays
        : normalizePositiveInt(
            patch.retentionDays,
            current.retentionDays,
            SESSION_TRANSCRIPT_LIMITS.retentionDays,
          ),
  };

  await writeStorageJson(NAMESPACE, SETTINGS_KEY, next);

  return next;
};

const buildRecordId = (completedAt: string, conversationId: string): string =>
  `${completedAt}-${conversationId.slice(0, 12)}`;

/**
 * True when the active backend can enumerate a namespace other than
 * `credentials`. The file backend refuses to list anything else, so transcripts
 * degrade to "not collected" there instead of throwing.
 */
const canEnumerateTurns = (): boolean =>
  getStorageBackendMeta().backend !== 'file';

/**
 * Storage documents are keyed per turn; the settings document is skipped when
 * reading turns back so it can share the namespace.
 */
const listStoredTurns = async (): Promise<SessionTranscriptRecord[]> => {
  if (!canEnumerateTurns()) {
    return [];
  }

  const documents = await listStorageJson<SessionTranscriptRecord>(NAMESPACE);

  return documents
    .filter((document) => document.key !== SETTINGS_KEY)
    .map((document) => document.value)
    .filter(
      (value): value is SessionTranscriptRecord =>
        Boolean(value) && typeof value === 'object' && 'id' in value,
    );
};

/**
 * Deletes turns beyond the age or count limit. Returns how many were removed.
 *
 * Both limits are applied in one pass so a single sort serves both checks.
 */
export const pruneSessionTranscripts = async (
  settings?: SessionTranscriptSettings,
): Promise<number> => {
  const effective = settings ?? (await getSessionTranscriptSettings());
  const turns = await listStoredTurns();
  const cutoffMs = Date.now() - effective.retentionDays * 24 * 60 * 60 * 1000;

  const expiredIds = new Set(
    turns
      .filter((turn) => {
        const completedMs = Date.parse(turn.completedAt);

        return !Number.isFinite(completedMs) || completedMs < cutoffMs;
      })
      .map((turn) => turn.id),
  );

  const survivors = turns
    .filter((turn) => !expiredIds.has(turn.id))
    .sort(
      (left, right) =>
        Date.parse(right.completedAt) - Date.parse(left.completedAt),
    );

  const expired = turns.filter((turn) => expiredIds.has(turn.id));
  const overflow = survivors.slice(effective.maxEntries);
  const removable = [...expired, ...overflow];

  await Promise.all(
    removable.map((turn) => deleteStorageJson(NAMESPACE, turn.id)),
  );

  return removable.length;
};

/** Prune at most once per interval so a burst of turns cannot thrash storage. */
const PRUNE_INTERVAL_MS = 60_000;

const pruneIfDue = async (
  settings: SessionTranscriptSettings,
): Promise<void> => {
  const now = Date.now();

  if (
    globalState.__codebuddy2apiTranscriptPrunedAt__ !== undefined &&
    now - globalState.__codebuddy2apiTranscriptPrunedAt__ < PRUNE_INTERVAL_MS
  ) {
    return;
  }

  globalState.__codebuddy2apiTranscriptPrunedAt__ = now;

  try {
    await pruneSessionTranscripts(settings);
  } catch {
    // Pruning is housekeeping: a failure must not surface to the caller.
  }
};

export interface RecordSessionTurnInput {
  accessKeyId?: string | null;
  answer: string;
  completedAt: string;
  conversationId: string;
  error?: string;
  model?: string | null;
  question?: string;
  startedAt?: string;
}

/**
 * Persists one finished turn. Never throws: recording is observability and must
 * not turn a successful reply into a failed request.
 */
export const recordSessionTurn = async ({
  accessKeyId,
  answer,
  completedAt,
  conversationId,
  error,
  model,
  question,
  startedAt,
}: RecordSessionTurnInput): Promise<SessionTranscriptRecord | null> => {
  if (!conversationId || !canEnumerateTurns()) {
    return null;
  }

  try {
    const settings = await getSessionTranscriptSettings();

    if (!settings.enabled) {
      return null;
    }

    const storedAnswer = truncate(answer ?? '', MAX_ANSWER_CHARS);
    const storedQuestion = truncate(question ?? '', MAX_QUESTION_CHARS);
    const record: SessionTranscriptRecord = {
      accessKeyId: accessKeyId ?? null,
      answer: storedAnswer,
      answerChars: storedAnswer.length,
      completedAt,
      conversationId,
      id: buildRecordId(completedAt, conversationId),
      model: model ?? null,
      question: storedQuestion,
      questionChars: storedQuestion.length,
      startedAt: startedAt ?? completedAt,
      status: error ? 'failed' : 'completed',
    };

    if (error) {
      record.error = error;
    }

    await writeStorageJson(NAMESPACE, record.id, record);
    await pruneIfDue(settings);

    return record;
  } catch {
    return null;
  }
};

export const listSessionTranscripts = async ({
  conversationId,
  limit = 100,
}: {
  conversationId?: string;
  limit?: number;
} = {}): Promise<SessionTranscriptListResponse> => {
  const settings = await getSessionTranscriptSettings();
  const turns = await listStoredTurns();
  const filtered = conversationId
    ? turns.filter((turn) => turn.conversationId === conversationId)
    : turns;
  const sorted = filtered.sort(
    (left, right) =>
      Date.parse(right.completedAt) - Date.parse(left.completedAt),
  );
  const entries = sorted.slice(0, clamp(limit, 1, 500));

  return {
    entries,
    settings,
    totals: {
      answerChars: entries.reduce((sum, turn) => sum + turn.answerChars, 0),
      questionChars: entries.reduce((sum, turn) => sum + turn.questionChars, 0),
      stored: sorted.length,
    },
  };
};

export const clearSessionTranscripts = async (): Promise<number> => {
  const turns = await listStoredTurns();

  await Promise.all(turns.map((turn) => deleteStorageJson(NAMESPACE, turn.id)));

  return turns.length;
};

/**
 * Registers the recorder that turns session stream events into stored turns.
 *
 * Idempotent and safe to call from every request path; the subscription is kept
 * on `globalThis` so hot reloads do not stack recorders. The recorder always
 * reports success so the publisher never drops it.
 */
export const ensureSessionTranscriptRecorder = (): void => {
  if (globalState.__codebuddy2apiTranscriptRecorder__) {
    return;
  }

  // File-backed storage cannot enumerate this namespace, so there is nothing to
  // record into; skip the subscription rather than write orphan documents.
  if (!canEnumerateTurns()) {
    return;
  }

  const subscriber = subscribeToSessionEvents({
    conversationIds: new Set<string>(),
    send: (event: SessionEvent): boolean => {
      if (
        event.type !== 'session.completed' &&
        event.type !== 'session.failed'
      ) {
        return true;
      }

      void recordSessionTurn({
        accessKeyId: event.accessKeyId ?? null,
        answer: event.text ?? '',
        completedAt: new Date(event.occurredAt).toISOString(),
        conversationId: event.conversationId,
        error: event.error,
        model: event.model ?? null,
        question: event.question ?? '',
        startedAt: new Date(event.occurredAt).toISOString(),
      });

      return true;
    },
  });

  if (subscriber) {
    globalState.__codebuddy2apiTranscriptRecorder__ = subscriber.id;
  }
};

/** Test/teardown helper. */
export const resetSessionTranscriptRuntime = (): void => {
  delete globalState.__codebuddy2apiTranscriptRecorder__;
  delete globalState.__codebuddy2apiTranscriptPrunedAt__;
};
