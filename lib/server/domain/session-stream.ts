/**
 * In-process pub/sub for live conversation activity.
 *
 * The gateway already passes every upstream stream chunk through its own
 * pipeline, so it can publish what the model is saying without changing a
 * single byte of the client response. Subscribers (the mobile app, via the SSE
 * endpoint) receive those deltas in near real time.
 *
 * Scope and limits, stated so callers do not assume more than exists:
 *  - Delivery is **in-memory and single-replica**. With more than one replica,
 *    a subscriber only sees events produced by the replica it connected to.
 *  - Publishing never throws and never blocks the request path: a slow or broken
 *    subscriber is dropped instead of applying backpressure to a live reply.
 *  - Only text/reasoning deltas and lifecycle transitions are published; raw
 *    upstream payloads are never forwarded.
 *  - `session.delta` carries **only the new text**. The accumulated reply rides
 *    on lifecycle events and on `session.snapshot`, so a per-chunk publish stays
 *    O(delta) instead of O(reply length) — a full-text field on every chunk
 *    would make a long answer quadratic on both CPU and wire size.
 */

export type SessionEventType =
  | 'session.started'
  | 'session.delta'
  | 'session.completed'
  | 'session.failed'
  | 'session.snapshot';

export interface SessionEvent {
  /** Conversation id as sent by the client (`x-conversation-id`). */
  conversationId: string;
  /** Text delta for `session.delta`; absent on lifecycle events. */
  delta?: string;
  /** Error summary for `session.failed`. */
  error?: string;
  /** Which gateway key served the request, when known. */
  accessKeyId?: string | null;
  model?: string | null;
  /** Monotonic publish time, epoch milliseconds. */
  occurredAt: number;
  /**
   * When the turn began, epoch milliseconds.
   *
   * `occurredAt` is when the event was published, which for a completion is the
   * end of the turn — so a record built from it alone reported a start time
   * identical to its finish. Carried on the terminal event instead.
   */
  startedAt?: number;
  /**
   * The user prompt that started this turn, extracted from the request body.
   * Carried on start/completion so a recorder can persist a readable Q&A pair
   * without reaching back into the request.
   */
  question?: string;
  /**
   * Text accumulated so far for this turn. Present on `session.started`,
   * `session.completed`, `session.failed` and `session.snapshot` — never on
   * `session.delta`, where it would be resent in full for every chunk.
   */
  text?: string;
  /**
   * Set when the turn ended by calling tools rather than by answering.
   *
   * A task the IDE runs issues dozens of these on the way to one answer, and
   * measured against production they made up 142 of 500 stored turns — each a
   * fragment like "Now re-run the RV to confirm…" filed as if it were a
   * question and its answer. Marking them lets a viewer keep them out of the
   * Q&A without discarding what the gateway saw.
   */
  toolTurn?: boolean;
  type: SessionEventType;
}

export interface SessionSubscriber {
  /** Conversation ids to receive; empty means "all conversations". */
  conversationIds: Set<string>;
  id: string;
  /** Returns false when the event was not delivered (queue full / closed). */
  send: (event: SessionEvent) => boolean;
}

/** Upper bound on concurrent SSE subscribers; beyond this, connects are refused. */
export const MAX_SESSION_SUBSCRIBERS = 32;

/** Accumulated reply text kept per conversation, capped to bound memory. */
const MAX_ACCUMULATED_TEXT = 200_000;

/** Conversations idle longer than this are dropped from the accumulator. */
const ACCUMULATED_TTL_MS = 30 * 60 * 1000;

/**
 * Deltas are held as a list of chunks rather than one concatenated string.
 * Appending then becomes O(1); the join happens only when a full snapshot is
 * actually needed (turn start/end, or a subscriber connecting mid-reply).
 */
interface AccumulatedTurn {
  accessKeyId: string | null;
  chunks: string[];
  model: string | null;
  question: string;
  /** Publish time of `session.started`, or of the first delta if none arrived. */
  startedAt: number;
  totalChars: number;
  updatedAt: number;
}

/** A rendered view of the live turn, used to seed late subscribers. */
export interface SessionSnapshot {
  accessKeyId: string | null;
  model: string | null;
  question: string;
  text: string;
}

interface SessionStreamState {
  __codebuddy2apiAccumulated__?: Map<string, AccumulatedTurn>;
  __codebuddy2apiSubscribers__?: Map<string, SessionSubscriber>;
}

const globalState = globalThis as typeof globalThis & SessionStreamState;

const getSubscribers = (): Map<string, SessionSubscriber> => {
  globalState.__codebuddy2apiSubscribers__ ??= new Map();

  return globalState.__codebuddy2apiSubscribers__;
};

const getAccumulated = (): Map<string, AccumulatedTurn> => {
  globalState.__codebuddy2apiAccumulated__ ??= new Map();

  return globalState.__codebuddy2apiAccumulated__;
};

const pruneAccumulated = (now: number): void => {
  const store = getAccumulated();

  for (const [conversationId, turn] of store) {
    if (now - turn.updatedAt > ACCUMULATED_TTL_MS) {
      store.delete(conversationId);
    }
  }
};

/** Joins the held chunks, dropping the oldest text beyond the memory cap. */
const joinChunks = (turn: AccumulatedTurn): string => {
  const text = turn.chunks.join('');

  if (text.length <= MAX_ACCUMULATED_TEXT) {
    return text;
  }

  return text.slice(-MAX_ACCUMULATED_TEXT);
};

const appendChunk = (turn: AccumulatedTurn, text: string): void => {
  turn.chunks.push(text);
  turn.totalChars += text.length;

  // Drop whole chunks from the front so the live buffer stays bounded without
  // touching the newly appended text.
  while (
    turn.totalChars > MAX_ACCUMULATED_TEXT &&
    turn.chunks.length > 1 &&
    (turn.chunks[0]?.length ?? 0) <= turn.totalChars - MAX_ACCUMULATED_TEXT
  ) {
    const dropped = turn.chunks.shift();

    turn.totalChars -= dropped?.length ?? 0;
  }
};

/**
 * Current live turn for a conversation, or null when nothing is streaming.
 *
 * Used to seed a subscriber that connects mid-reply so it can render without
 * replaying the deltas it missed.
 */
export const getSessionSnapshot = (
  conversationId: string,
): SessionSnapshot | null => {
  const turn = getAccumulated().get(conversationId);

  if (!turn) {
    return null;
  }

  return {
    accessKeyId: turn.accessKeyId,
    model: turn.model,
    question: turn.question,
    text: joinChunks(turn),
  };
};

/** Conversation ids with a live or recently finished turn. */
export const listSessionSnapshotIds = (): string[] => [
  ...getAccumulated().keys(),
];

export const getSessionSubscriberCount = (): number => getSubscribers().size;

/**
 * Registers a subscriber. Returns `null` when the subscriber limit is reached,
 * so the endpoint can answer 503 rather than silently accepting and starving
 * other clients.
 */
export const subscribeToSessionEvents = (
  subscriber: Omit<SessionSubscriber, 'id'> & { id?: string },
): SessionSubscriber | null => {
  const subscribers = getSubscribers();

  if (subscribers.size >= MAX_SESSION_SUBSCRIBERS) {
    return null;
  }

  const id = subscriber.id ?? `sub-${Math.random().toString(36).slice(2, 10)}`;
  const entry: SessionSubscriber = { ...subscriber, id };

  subscribers.set(id, entry);

  return entry;
};

export const unsubscribeFromSessionEvents = (id: string): void => {
  getSubscribers().delete(id);
};

const sanitizeText = (value: unknown): string =>
  typeof value === 'string' ? value : '';

/**
 * Publishes to every matching subscriber, dropping any whose queue is full.
 *
 * Never throws: a live model reply must not be interrupted by a reporting
 * failure, so failures are swallowed by design.
 */
const publish = (event: SessionEvent): void => {
  const subscribers = getSubscribers();

  if (!subscribers.size) {
    return;
  }

  for (const [id, subscriber] of subscribers) {
    if (
      subscriber.conversationIds.size > 0 &&
      !subscriber.conversationIds.has(event.conversationId)
    ) {
      continue;
    }

    let delivered = false;

    try {
      delivered = subscriber.send(event);
    } catch {
      delivered = false;
    }

    if (!delivered) {
      subscribers.delete(id);
    }
  }
};

export const publishSessionStarted = ({
  accessKeyId,
  conversationId,
  model,
  question,
}: {
  accessKeyId?: string | null;
  conversationId: string;
  model?: string | null;
  question?: string;
}): void => {
  if (!conversationId) return;

  const now = Date.now();
  const prompt = sanitizeText(question);

  pruneAccumulated(now);
  getAccumulated().set(conversationId, {
    accessKeyId: accessKeyId ?? null,
    chunks: [],
    model: model ?? null,
    question: prompt,
    startedAt: now,
    totalChars: 0,
    updatedAt: now,
  });

  publish({
    accessKeyId: accessKeyId ?? null,
    conversationId,
    model: model ?? null,
    occurredAt: now,
    question: prompt,
    text: '',
    type: 'session.started',
  });
};

/**
 * Appends a model delta and publishes it.
 *
 * The event carries only the new text: subscribers append it themselves, and a
 * client that joined mid-reply is seeded once via `session.snapshot`.
 */
export const publishSessionDelta = ({
  conversationId,
  delta,
}: {
  conversationId: string;
  delta: unknown;
}): void => {
  const text = sanitizeText(delta);

  if (!conversationId || !text) {
    return;
  }

  const accumulated = getAccumulated();
  const existing = accumulated.get(conversationId);
  const now = Date.now();
  const turn: AccumulatedTurn = existing ?? {
    accessKeyId: null,
    chunks: [],
    model: null,
    question: '',
    // No `session.started` was seen, so the first delta is the best available
    // start: the turn cannot have begun later than its first output.
    startedAt: now,
    totalChars: 0,
    updatedAt: now,
  };

  appendChunk(turn, text);
  turn.updatedAt = now;
  accumulated.set(conversationId, turn);

  publish({
    accessKeyId: turn.accessKeyId,
    conversationId,
    delta: text,
    model: turn.model,
    occurredAt: now,
    type: 'session.delta',
  });
};

/**
 * Publishes the terminal event with the full reply text, then releases the
 * accumulated turn: the text now lives in the event (and in the transcript
 * store), so keeping it here would only hold memory until the idle sweep.
 */
export const publishSessionCompleted = ({
  conversationId,
  error,
  toolTurn,
}: {
  conversationId: string;
  error?: string;
  /** True when the turn ended in tool calls rather than in an answer. */
  toolTurn?: boolean;
}): void => {
  if (!conversationId) return;

  const accumulated = getAccumulated();
  const existing = accumulated.get(conversationId);
  const now = Date.now();
  const text = existing ? joinChunks(existing) : '';

  publish({
    accessKeyId: existing?.accessKeyId ?? null,
    conversationId,
    error,
    model: existing?.model ?? null,
    occurredAt: now,
    question: existing?.question ?? '',
    startedAt: existing?.startedAt ?? now,
    text,
    toolTurn: toolTurn ? true : undefined,
    type: error ? 'session.failed' : 'session.completed',
  });

  accumulated.delete(conversationId);
};

/** Test/teardown helper: clears subscribers and accumulated text. */
export const resetSessionStreamRuntime = (): void => {
  delete globalState.__codebuddy2apiSubscribers__;
  delete globalState.__codebuddy2apiAccumulated__;
};
