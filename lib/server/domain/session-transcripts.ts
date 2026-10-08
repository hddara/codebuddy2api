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
 * Layout, and why it is split across two namespaces:
 *
 *  - `session-transcripts` holds one **metadata** document per turn: prompt,
 *    timestamps, status, sizes. Small and bounded.
 *  - `session-transcript-answers` holds the model output, keyed by the same id.
 *
 * Retention has to inspect every stored turn to decide what to drop, and the
 * store can only list whole documents. Keeping answer bodies out of the listing
 * namespace means a prune costs O(number of turns) instead of O(total answer
 * bytes) — with answers up to 100 KB each, the difference is megabytes of JSON
 * parsed on every sweep.
 *
 * Retention is governed by **two independent limits** — age and count — and
 * whichever is hit first wins, because count alone cannot express "keep 30 days"
 * and age alone cannot bound a traffic spike.
 *
 * Content is stored as plain JSON text. Callers that treat the gateway as a
 * trusted boundary can rely on that; anyone exposing these endpoints should
 * treat the data as sensitive conversation content.
 */

const NAMESPACE = 'session-transcripts';
const ANSWER_NAMESPACE = 'session-transcript-answers';
const SETTINGS_KEY = 'settings';

/** Turns kept per conversation prompt/answer, mirroring the debug snapshot cap. */
const MAX_QUESTION_CHARS = 4_000;
const MAX_ANSWER_CHARS = 100_000;

/** Bounds how many documents a single sweep touches at once. */
const DELETE_BATCH_SIZE = 50;
const ANSWER_READ_CONCURRENCY = 8;

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

/** Stored metadata document; the answer lives in its own namespace. */
interface SessionTranscriptMeta {
  accessKeyId: string | null;
  answerChars: number;
  completedAt: string;
  conversationId: string;
  error?: string;
  id: string;
  model: string | null;
  question: string;
  questionChars: number;
  startedAt: string;
  status: SessionTranscriptStatus;
  /** Absent on turns that ended with an answer; see `SessionEvent.toolTurn`. */
  toolTurn?: boolean;
}

/** API-facing turn, metadata joined with its answer body. */
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
  /**
   * True when this was one step of a longer task rather than a finished
   * exchange. Present so a viewer can leave them out of the Q&A list.
   */
  toolTurn?: boolean;
}

export interface SessionTranscriptListResponse {
  entries: SessionTranscriptRecord[];
  settings: SessionTranscriptSettings;
  totals: {
    answerChars: number;
    questionChars: number;
    stored: number;
    /** How many of `stored` are intermediate tool steps. */
    toolTurns: number;
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
 * The user's own words, as the IDE marks them inside its preamble.
 *
 * Everything the IDE sends is one user message: instructions, environment
 * details, recalled context and the question, in that order. This tag is the
 * only part a person recognises as their own, so it is what the transcript
 * shows.
 */
const USER_QUERY_PATTERN = /<user_query>([\s\S]*?)<\/user_query>/i;

/**
 * Preamble blocks dropped as whole units when both of their tags survived.
 *
 * A closed block is unambiguously scaffolding, and removing it leaves whatever
 * the prompt said after it — which is where the question lives when the tag is
 * absent but the prompt is short enough to be stored intact.
 */
const SCAFFOLD_BLOCK_PATTERNS: RegExp[] = [
  /<additional_data>[\s\S]*?<\/additional_data>/gi,
  /<system_reminder>[\s\S]*?<\/system_reminder>/gi,
  /<user_info>[\s\S]*?<\/user_info>/gi,
  /<artifact_directory_path>[\s\S]*?<\/artifact_directory_path>/gi,
  /<rules>[\s\S]*?<\/rules>/gi,
  // A tag whose body held nothing usable: the extractor above already declined
  // it, so all that remains is markup.
  /<user_query>[\s\S]*?<\/user_query>/gi,
];

/**
 * A scaffolding tag left at the front of whatever was captured.
 *
 * The storage cap can cut a prompt off before it ever reaches `<user_query>`,
 * leaving nothing but the IDE's preamble. Measured against production, 39 of 500
 * stored turns rendered as `OS Version: darwin …` and a further 24 as
 * `<artifact_directory_path>…`.
 *
 * Matched by shape, not by name: the block names are neither exhaustive nor even
 * uniform (`<rules>` is not snake_case), and two batches only surfaced one after
 * the other as each was fixed. What they share is that the tag sits **alone on
 * its line** — every block is a section of the preamble — while a question that
 * legitimately opens with markup keeps text on the same line, as in
 * `<div> 为什么不渲染`.
 */
const SCAFFOLD_TAG_PATTERN = /^<[a-z][a-z0-9_]*>\s*\n/i;

/**
 * A label some upstream clients put in front of the input itself.
 *
 * Measured in production: `User's input is: uTools 基础文档总览…`. It is not our
 * format and not something a person types, but it is also unbranded — the next
 * client will word it differently, so matching a name list would miss it.
 *
 * Anchored on a Chinese question following the label: an English prompt that
 * legitimately opens with its own label (`Note: …`) is left exactly as written.
 */
const INPUT_WRAPPER_PATTERN =
  /^[A-Za-z][A-Za-z'\u2019\s-]{2,30}[:：]\s*(?=[\s\S]{0,40}[\u4E00-\u9FFF])/;

/**
 * Reduces one prompt to what the user actually asked.
 *
 * The tag is consulted **before** truncating, which is the whole fix: the
 * question sits near the end of the IDE's preamble, so truncating first threw
 * away exactly the part worth keeping and stored the scaffolding instead.
 *
 * Returns an empty string when the prompt carries no question — a continuation
 * whose last user turn is tool output, for instance.
 */
const readQuestion = (value: string): string => {
  const tagged = USER_QUERY_PATTERN.exec(value)?.[1]?.trim();

  if (tagged) {
    return truncate(tagged, MAX_QUESTION_CHARS);
  }

  let stripped = value;

  for (const pattern of SCAFFOLD_BLOCK_PATTERNS) {
    stripped = stripped.replace(pattern, '');
  }

  const unwrapped = stripped.trim().replace(INPUT_WRAPPER_PATTERN, '');

  if (!unwrapped || SCAFFOLD_TAG_PATTERN.test(unwrapped)) {
    return '';
  }

  return truncate(unwrapped, MAX_QUESTION_CHARS);
};

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
      const question = readQuestion(content);

      if (question) {
        return question;
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
      const question = readQuestion(parts.join('\n'));

      if (question) {
        return question;
      }
    }
  }

  return '';
};

/**
 * True when the active backend can enumerate a namespace other than
 * `credentials`. The file backend refuses to list anything else, so transcripts
 * degrade to "not collected" there instead of throwing.
 */
const canEnumerateTurns = (): boolean =>
  getStorageBackendMeta().backend !== 'file';

/** Settings are only persisted on backends that can read them back. */

export const getSessionTranscriptSettings =
  async (): Promise<SessionTranscriptSettings> => {
    // Check the backend *before* touching storage: the file backend rejects any
    // namespace other than `credentials`, so reading here would throw and take
    // the settings/listing endpoints down with it.
    const stored = canEnumerateTurns()
      ? ((await readStorageJson<Partial<SessionTranscriptSettings>>(
          NAMESPACE,
          SETTINGS_KEY,
        )) ?? {})
      : {};

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
 * Runs `worker` over `items` with a fixed ceiling on in-flight work, so a large
 * page cannot open hundreds of simultaneous storage reads.
 */
const mapWithConcurrency = async <TItem, TResult>(
  items: TItem[],
  concurrency: number,
  worker: (item: TItem) => Promise<TResult>,
): Promise<TResult[]> => {
  const results: TResult[] = new Array(items.length);
  let cursor = 0;

  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;

        if (index >= items.length) return;

        results[index] = await worker(items[index] as TItem);
      }
    },
  );

  await Promise.all(runners);

  return results;
};

/** Reads the metadata documents only; answer bodies are never loaded here. */
const listStoredTurns = async (): Promise<SessionTranscriptMeta[]> => {
  if (!canEnumerateTurns()) {
    return [];
  }

  const documents = await listStorageJson<SessionTranscriptMeta>(NAMESPACE);

  return documents
    .filter((document) => document.key !== SETTINGS_KEY)
    .map((document) => document.value)
    .filter(
      (value): value is SessionTranscriptMeta =>
        Boolean(value) && typeof value === 'object' && 'id' in value,
    );
};

/**
 * Loads one answer body.
 *
 * Falls back to an `answer` field on the metadata document so turns written
 * before the split are still readable.
 */
const readAnswer = async (turn: SessionTranscriptMeta): Promise<string> => {
  const stored = await readStorageJson<{ answer?: unknown }>(
    ANSWER_NAMESPACE,
    turn.id,
  );

  if (typeof stored?.answer === 'string') {
    return stored.answer;
  }

  const legacy = await readStorageJson<{ answer?: unknown }>(
    NAMESPACE,
    turn.id,
  );

  return typeof legacy?.answer === 'string' ? legacy.answer : '';
};

/** Deletes turns in bounded batches so one sweep cannot saturate the pool. */
const deleteTurns = async (ids: string[]): Promise<void> => {
  for (let index = 0; index < ids.length; index += DELETE_BATCH_SIZE) {
    const batch = ids.slice(index, index + DELETE_BATCH_SIZE);

    await Promise.all(
      batch.flatMap((id) => [
        deleteStorageJson(NAMESPACE, id),
        deleteStorageJson(ANSWER_NAMESPACE, id),
      ]),
    );
  }
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

  const removable = [
    ...expiredIds,
    ...survivors.slice(effective.maxEntries).map((turn) => turn.id),
  ];

  await deleteTurns(removable);

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
  /** Marks an intermediate tool step; see `SessionEvent.toolTurn`. */
  toolTurn?: boolean;
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
  toolTurn,
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
    const id = buildRecordId(completedAt, conversationId);
    const meta: SessionTranscriptMeta = {
      accessKeyId: accessKeyId ?? null,
      answerChars: storedAnswer.length,
      completedAt,
      conversationId,
      id,
      model: model ?? null,
      question: storedQuestion,
      questionChars: storedQuestion.length,
      startedAt: startedAt ?? completedAt,
      status: error ? 'failed' : 'completed',
    };

    if (error) {
      meta.error = error;
    }

    // Only ever written when true: the field is optional, and omitting it keeps
    // the stored document identical for ordinary turns.
    if (toolTurn) {
      meta.toolTurn = true;
    }

    // Metadata first: a prune reading between the two writes sees a turn that is
    // listed but has no body yet, which readAnswer reports as empty rather than
    // as a failure.
    await writeStorageJson(NAMESPACE, id, meta);
    await writeStorageJson(ANSWER_NAMESPACE, id, { answer: storedAnswer });
    await pruneIfDue(settings);

    return { ...meta, answer: storedAnswer };
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
  const page = sorted.slice(0, clamp(limit, 1, 500));
  // Bodies are fetched only for the page being returned, never for the whole
  // store.
  const answers = await mapWithConcurrency(
    page,
    ANSWER_READ_CONCURRENCY,
    readAnswer,
  );
  const entries = page.map((turn, index) => ({
    ...turn,
    answer: answers[index] ?? '',
  }));

  return {
    entries,
    settings,
    // Every total describes the conversation, not the page. `entries` is a
    // bounded slice, so summing it would have the same response report "695
    // stored, 12k characters" for a page holding 40 of them — two numbers that
    // cannot both be true. The character counts come from the metadata documents,
    // which are already in hand, so counting everything costs no extra reads.
    totals: {
      answerChars: sorted.reduce((sum, turn) => sum + turn.answerChars, 0),
      questionChars: sorted.reduce((sum, turn) => sum + turn.questionChars, 0),
      stored: sorted.length,
      toolTurns: sorted.filter((turn) => turn.toolTurn).length,
    },
  };
};

export const clearSessionTranscripts = async (): Promise<number> => {
  const turns = await listStoredTurns();

  await deleteTurns(turns.map((turn) => turn.id));

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
        // `occurredAt` is the completion's publish time, so using it for both
        // ends stored every turn with a zero-length duration.
        startedAt: new Date(event.startedAt ?? event.occurredAt).toISOString(),
        toolTurn: event.toolTurn,
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
