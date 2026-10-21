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
 *    on the terminal event, so a per-chunk publish stays O(delta) instead of
 *    O(reply length) — a full-text field on every chunk would make a long
 *    answer quadratic on both CPU and wire size.
 *
 * Streamed text is **not retained**. This module keeps only what a viewer needs
 * to know that a turn is running — model, key and question — and the terminal
 * event carries the finished reply once. The reply is accumulated inside the
 * proxy call that produced it, so a client that disconnects mid-stream (or an
 * upstream that throws) leaves nothing behind: the closure dies and its buffer
 * with it. An earlier version kept per-conversation chunk arrays in a global
 * map keyed by a client-supplied id, which survived every abnormal ending and
 * had no entry cap.
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
   * The finished reply. Present on `session.completed` and `session.failed`
   * only, and only when the caller supplied it.
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

/**
 * Upper bound on conversations tracked as "live".
 *
 * Only metadata is held here, but the id comes from the client, so the map needs
 * a ceiling even so — a caller that never completes a turn must not be able to
 * grow it without limit.
 */
const MAX_ACTIVE_TURNS = 512;

/** Turns idle longer than this stop being reported as live. */
const ACTIVE_TURN_TTL_MS = 30 * 60 * 1000;

/** Prompt characters kept for a viewer; the stored transcript has its own cap. */
const MAX_QUESTION_CHARS = 4_000;

const PRUNE_INTERVAL_MS = 60 * 1000;

/**
 * Metadata for a turn that is currently producing output.
 *
 * Deliberately contains no reply text: the answer is accumulated by the proxy
 * call handling it and handed over once, on completion.
 */
interface ActiveTurn {
  accessKeyId: string | null;
  model: string | null;
  question: string;
  startedAt: number;
  updatedAt: number;
}

/** A rendered view of the live turn, used to seed late subscribers. */
export interface SessionSnapshot {
  accessKeyId: string | null;
  model: string | null;
  question: string;
  /** Always empty: streamed text is not retained. */
  text: string;
}

interface SessionStreamState {
  __codebuddy2apiActiveTurns__?: Map<string, ActiveTurn>;
  __codebuddy2apiSubscribers__?: Map<string, SessionSubscriber>;
  __codebuddy2apiPruneTimer__?: ReturnType<typeof setInterval>;
}

const globalState = globalThis as typeof globalThis & SessionStreamState;

const getSubscribers = (): Map<string, SessionSubscriber> => {
  globalState.__codebuddy2apiSubscribers__ ??= new Map();

  return globalState.__codebuddy2apiSubscribers__;
};

const getActiveTurns = (): Map<string, ActiveTurn> => {
  globalState.__codebuddy2apiActiveTurns__ ??= new Map();

  return globalState.__codebuddy2apiActiveTurns__;
};

const clampQuestion = (value: string): string =>
  value.length > MAX_QUESTION_CHARS
    ? value.slice(0, MAX_QUESTION_CHARS)
    : value;

/**
 * Drops idle entries and enforces the entry ceiling, oldest first.
 *
 * Called on every turn start and from a timer, because a turn that never
 * completes still has to fall out of the map eventually.
 */
const pruneActiveTurns = (now: number): void => {
  const store = getActiveTurns();

  for (const [conversationId, turn] of store) {
    if (now - turn.updatedAt > ACTIVE_TURN_TTL_MS) {
      store.delete(conversationId);
    }
  }

  while (store.size > MAX_ACTIVE_TURNS) {
    const oldestId = store.keys().next().value;

    if (oldestId === undefined) break;

    store.delete(oldestId);
  }
};

/**
 * Starts the idle sweep once per process.
 *
 * `unref()` so a CLI or test run is not held open by it.
 */
const ensurePruneTimer = (): void => {
  if (globalState.__codebuddy2apiPruneTimer__) return;

  const timer = setInterval(() => {
    pruneActiveTurns(Date.now());
  }, PRUNE_INTERVAL_MS);

  timer.unref?.();
  globalState.__codebuddy2apiPruneTimer__ = timer;
};

/**
 * Current live turn for a conversation, or null when nothing is streaming.
 *
 * `text` is always empty: streamed output is not retained by the gateway.
 */
export const getSessionSnapshot = (
  conversationId: string,
): SessionSnapshot | null => {
  const turn = getActiveTurns().get(conversationId);

  if (!turn) {
    return null;
  }

  return {
    accessKeyId: turn.accessKeyId,
    model: turn.model,
    question: turn.question,
    text: '',
  };
};

/** Conversation ids with a live turn. */
export const listSessionSnapshotIds = (): string[] => [
  ...getActiveTurns().keys(),
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
  const prompt = clampQuestion(sanitizeText(question));

  ensurePruneTimer();
  pruneActiveTurns(now);
  getActiveTurns().set(conversationId, {
    accessKeyId: accessKeyId ?? null,
    model: model ?? null,
    question: prompt,
    startedAt: now,
    updatedAt: now,
  });

  publish({
    accessKeyId: accessKeyId ?? null,
    conversationId,
    model: model ?? null,
    occurredAt: now,
    question: prompt,
    type: 'session.started',
  });
};

/**
 * Publishes one model delta.
 *
 * Nothing is retained: a delta only reaches subscribers that are connected at
 * this instant, and the finished reply arrives once on the terminal event.
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

  const now = Date.now();
  const existing = getActiveTurns().get(conversationId);

  if (existing) {
    existing.updatedAt = now;
  } else {
    // No `session.started` was seen, so the first delta is the best available
    // start: the turn cannot have begun later than its first output.
    ensurePruneTimer();
    pruneActiveTurns(now);
    getActiveTurns().set(conversationId, {
      accessKeyId: null,
      model: null,
      question: '',
      startedAt: now,
      updatedAt: now,
    });
  }

  publish({
    accessKeyId: existing?.accessKeyId ?? null,
    conversationId,
    delta: text,
    model: existing?.model ?? null,
    occurredAt: now,
    type: 'session.delta',
  });
};

/**
 * Publishes the terminal event with the finished reply, then forgets the turn.
 *
 * `text` is supplied by the caller that accumulated it — the buffer lives in
 * that call's scope, so nothing here can outlive an abnormal ending.
 */
export const publishSessionCompleted = ({
  conversationId,
  error,
  text,
  toolTurn,
}: {
  conversationId: string;
  error?: string;
  /** The finished reply, when the caller has it. */
  text?: string;
  /** True when the turn ended in tool calls rather than in an answer. */
  toolTurn?: boolean;
}): void => {
  if (!conversationId) return;

  const activeTurns = getActiveTurns();
  const existing = activeTurns.get(conversationId);
  const now = Date.now();

  publish({
    accessKeyId: existing?.accessKeyId ?? null,
    conversationId,
    error,
    model: existing?.model ?? null,
    occurredAt: now,
    question: existing?.question ?? '',
    startedAt: existing?.startedAt ?? now,
    text: sanitizeText(text),
    toolTurn: toolTurn ? true : undefined,
    type: error ? 'session.failed' : 'session.completed',
  });

  activeTurns.delete(conversationId);
};

/** Test/teardown helper: clears subscribers, live turns and the sweep timer. */
export const resetSessionStreamRuntime = (): void => {
  if (globalState.__codebuddy2apiPruneTimer__) {
    clearInterval(globalState.__codebuddy2apiPruneTimer__);
    globalState.__codebuddy2apiPruneTimer__ = undefined;
  }

  delete globalState.__codebuddy2apiSubscribers__;
  delete globalState.__codebuddy2apiActiveTurns__;
};
