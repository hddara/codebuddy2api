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
 */

export type SessionEventType =
  'session.started' | 'session.delta' | 'session.completed' | 'session.failed';

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
   * The user prompt that started this turn, extracted from the request body.
   * Carried on start/completion so a recorder can persist a readable Q&A pair
   * without reaching back into the request.
   */
  question?: string;
  /**
   * Text accumulated so far for this turn. Lets a late subscriber render the
   * current reply without replaying every delta.
   */
  text?: string;
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

interface AccumulatedTurn {
  accessKeyId: string | null;
  model: string | null;
  question: string;
  text: string;
  updatedAt: number;
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

/** Current accumulated reply text for a conversation, if any. */
export const getAccumulatedText = (conversationId: string): string =>
  getAccumulated().get(conversationId)?.text ?? '';

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
    model: model ?? null,
    question: prompt,
    text: '',
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
 * Appends a model delta and publishes it. `delta` may be empty, in which case
 * nothing is published (keeps the wire quiet between meaningful chunks).
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
  const nextText = `${existing?.text ?? ''}${text}`.slice(
    -MAX_ACCUMULATED_TEXT,
  );

  accumulated.set(conversationId, {
    accessKeyId: existing?.accessKeyId ?? null,
    model: existing?.model ?? null,
    question: existing?.question ?? '',
    text: nextText,
    updatedAt: now,
  });

  publish({
    accessKeyId: existing?.accessKeyId ?? null,
    conversationId,
    delta: text,
    model: existing?.model ?? null,
    occurredAt: now,
    question: existing?.question ?? '',
    text: nextText,
    type: 'session.delta',
  });
};

export const publishSessionCompleted = ({
  conversationId,
  error,
}: {
  conversationId: string;
  error?: string;
}): void => {
  if (!conversationId) return;

  const existing = getAccumulated().get(conversationId);
  const now = Date.now();

  publish({
    accessKeyId: existing?.accessKeyId ?? null,
    conversationId,
    error,
    model: existing?.model ?? null,
    occurredAt: now,
    question: existing?.question ?? '',
    text: existing?.text ?? '',
    type: error ? 'session.failed' : 'session.completed',
  });
};

/** Test/teardown helper: clears subscribers and accumulated text. */
export const resetSessionStreamRuntime = (): void => {
  delete globalState.__codebuddy2apiSubscribers__;
  delete globalState.__codebuddy2apiAccumulated__;
};
