/**
 * Admission control for chat-shaped requests.
 *
 * Memory here is dominated by *how much is in flight at once*: one request
 * carries a multi-hundred-kilobyte conversation, its parsed object graph, a
 * serialised copy for the upstream call, and the stream buffers of the reply.
 * A single request is survivable; four overlapping ones are not, and the four
 * that arrive together are exactly what a chat client with a background agent
 * produces.
 *
 * So the gate refuses rather than queues. Queueing looks friendlier but is
 * worse under memory pressure: a queued request has already had its body read
 * and parsed (that is the expensive part), so a deep queue means hundreds of
 * megabytes of admitted-but-waiting work — the failure mode is unchanged, only
 * later. A 503 with `Retry-After` tells the client to come back, and the client
 * is a retrying SDK far more often than a human on a form.
 */
import { logEvent } from './log';
import { getMemorySnapshot } from './memory';

export interface RequestSlot {
  /** Idempotent: a double release must not free somebody else's slot. */
  release: () => void;
}

export interface ConcurrencyState {
  active: number;
  admitted: number;
  limit: number | null;
  peak: number;
  rejected: number;
}

export const MAX_CONCURRENT_ENV = 'CODEBUDDY_MAX_CONCURRENT_REQUESTS';

/**
 * Four in flight, against a 2 GB container limit.
 *
 * Below the observed peak of two large requests plus their parse copies (~1.8
 * GB), with room for the background work that is not admitted here (schedulers,
 * usage recording, session recorders).
 */
export const DEFAULT_MAX_CONCURRENT_REQUESTS = 4;

/** Slower than any healthy turn; a slot held this long is a leak or a stall. */
const SLOW_REQUEST_WARN_MS = 120_000;

/**
 * The hard ceiling on how long one slot may be held.
 *
 * `attachSlotToResponse` frees the slot when the body ends, errors, or is
 * cancelled — but a response that is *never* consumed and never cancelled (an
 * aborted connection whose reader is dropped without a cancel reaching us)
 * frees nothing. Each such orphan would permanently consume one of four slots,
 * and after four of them the gate would answer 503 to every request forever.
 * That failure would be self-inflicted and far worse than the memory it guards,
 * so the slot is also given an absolute lease: on expiry it is freed anyway and
 * the event is logged as a leak. Thirty minutes is well past any real turn, so
 * in practice this only ever fires on a leak.
 */
const SLOT_LEASE_MS = 30 * 60_000;

let active = 0;
let admitted = 0;
let peak = 0;
let rejected = 0;

/**
 * Reads the concurrency limit, or `null` when the gate is switched off.
 *
 * `0` and negative values disable it. An operator debugging a different
 * bottleneck should be able to take the gate out of the way with an
 * environment change, without a new image.
 */
export const getMaxConcurrentRequests = (): number | null => {
  const raw = (process.env[MAX_CONCURRENT_ENV] ?? '').trim();

  if (!raw) {
    return DEFAULT_MAX_CONCURRENT_REQUESTS;
  }

  const parsed = Number.parseInt(raw, 10);

  if (!Number.isFinite(parsed)) {
    return DEFAULT_MAX_CONCURRENT_REQUESTS;
  }

  return parsed > 0 ? parsed : null;
};

export const getConcurrencyState = (): ConcurrencyState => ({
  active,
  admitted,
  limit: getMaxConcurrentRequests(),
  peak,
  rejected,
});

export const resetConcurrencyGateForTests = (): void => {
  active = 0;
  admitted = 0;
  peak = 0;
  rejected = 0;
};

/**
 * Takes a slot, or reports that the process is already at its limit.
 *
 * Synchronous on purpose: admission has to happen before the body is read, and
 * an async gate would let every concurrent request run its first microtasks
 * (and possibly start reading) before anybody is turned away.
 */
export const acquireRequestSlot = (): RequestSlot | null => {
  const limit = getMaxConcurrentRequests();

  if (limit !== null && active >= limit) {
    rejected += 1;

    void logEvent({
      level: 'WARN',
      message: 'Request rejected: concurrency limit reached',
      payload: {
        ...getMemorySnapshot(),
        active,
        admitted,
        limit,
        peak,
        rejected,
      },
    });

    return null;
  }

  active += 1;
  admitted += 1;
  peak = Math.max(peak, active);

  const startedAt = Date.now();
  let released = false;

  void logEvent({
    level: 'DEBUG',
    message: 'Request slot acquired',
    payload: { active, limit, peak },
  });

  const release = (leaked = false): void => {
    if (released) return;

    released = true;
    active = Math.max(0, active - 1);

    const durationMs = Date.now() - startedAt;
    const snapshot = getMemorySnapshot();

    void logEvent({
      level: leaked || durationMs >= SLOW_REQUEST_WARN_MS ? 'WARN' : 'DEBUG',
      message: leaked
        ? 'Request slot leaked, releasing it'
        : 'Request slot released',
      payload: {
        ...snapshot,
        active,
        durationMs,
        leaseMs: SLOT_LEASE_MS,
        limit,
        peak,
        ...(durationMs >= SLOW_REQUEST_WARN_MS
          ? { slowRequestThresholdMs: SLOW_REQUEST_WARN_MS }
          : {}),
      },
    });
  };

  // Backstop for a holder that is never disposed of. Unref'd so it cannot keep
  // the process alive on its own.
  const leaseTimer = setTimeout(() => release(true), SLOT_LEASE_MS);
  leaseTimer.unref?.();

  return {
    release: () => {
      if (released) {
        return;
      }

      clearTimeout(leaseTimer);
      release();
    },
  };
};

/**
 * Holds the slot for as long as the response is still being produced.
 *
 * Releasing when the route handler returns would be wrong for a streaming
 * reply: the handler returns as soon as the first byte is ready, while the
 * body is still being pulled — and a stream that is slow to drain is exactly
 * the case where memory is being held. So the slot follows the body, and a
 * body-less response releases immediately.
 */
export const attachSlotToResponse = (
  response: Response,
  slot: RequestSlot,
): Response => {
  const body = response.body;

  if (!body) {
    slot.release();

    return response;
  }

  const reader = body.getReader();

  return new Response(
    new ReadableStream<Uint8Array>({
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } finally {
          slot.release();
        }
      },
      async pull(controller) {
        try {
          const { done, value } = await reader.read();

          if (done) {
            slot.release();
            controller.close();
            return;
          }

          controller.enqueue(value);
        } catch (error) {
          slot.release();
          controller.error(error);
        }
      },
    }),
    {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    },
  );
};

/**
 * Runs `handler` inside a slot, or answers 503 when there is none free.
 *
 * The slot is taken *before* the handler runs, which is the whole point: the
 * expensive part of a request is reading and parsing its body, so admitting
 * first and refusing later would still have paid the cost.
 *
 * `formatRejection` exists because the two API families disagree on the error
 * envelope; the gate itself has no opinion about which one a route speaks.
 */
export const withAdmission = async (
  handler: () => Promise<Response>,
  formatRejection: () => Response = buildConcurrencyRejection,
): Promise<Response> => {
  const slot = acquireRequestSlot();

  if (!slot) {
    return formatRejection();
  }

  try {
    return attachSlotToResponse(await handler(), slot);
  } catch (error) {
    slot.release();

    throw error;
  }
};

export const getConcurrencyRejectionMessage = (): string =>
  `Too many concurrent requests (limit ${
    getMaxConcurrentRequests() ?? 0
  }); retry shortly`;

/**
 * The 503 a rejected request gets.
 *
 * `Retry-After` is short and deliberate: the slot frees when an in-flight turn
 * ends, which is seconds to a minute, and a long backoff would turn a busy
 * moment into a client-side outage.
 */
export const buildConcurrencyRejection = (): Response =>
  Response.json(
    {
      error: {
        code: 'server_busy',
        message: getConcurrencyRejectionMessage(),
        type: 'overloaded_error',
      },
    },
    {
      headers: {
        'Retry-After': '2',
      },
      status: 503,
    },
  );
