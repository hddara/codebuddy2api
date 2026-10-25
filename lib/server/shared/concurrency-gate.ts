/**
 * In-flight tracking for chat-shaped requests, with an optional admission cap.
 *
 * The cap is **off by default**. It used to default to four, on the theory that
 * four overlapping conversations could not fit in a 2 GB container; that theory
 * predated the compressor and the body ceiling, and in practice it refused 8.5%
 * of all traffic with a 503 while the process sat at a quarter of its memory
 * limit. Refusing healthy requests to protect against a peak that the request
 * sizing work already removed is not a safety valve, it is an outage with a
 * status code — so the default is now "no limit".
 *
 * What remains is the accounting the rest of the runtime wants anyway: how many
 * requests are in flight (the memory watchdog drains against it before a
 * controlled restart), the peak, and a lease that frees a slot whose holder was
 * dropped without ever releasing it.
 *
 * Setting `CODEBUDDY_MAX_CONCURRENT_REQUESTS` to a positive integer re-enables
 * the cap for an operator who wants one; `0` or a negative value means no cap.
 * When a cap is active the gate refuses rather than queues: a queued request has
 * already had its body read and parsed, so a deep queue holds the very memory it
 * was meant to protect.
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
 * No cap unless an operator asks for one.
 *
 * `null` is the value `getMaxConcurrentRequests` returns when the environment
 * variable is unset, so the default deployment never turns a request away.
 */
export const DEFAULT_MAX_CONCURRENT_REQUESTS: number | null = null;

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
 * Reads the concurrency limit, or `null` when there is no cap.
 *
 * Unset, `0`, and negative values all mean "no cap", which is the shipped
 * default: the service is expected never to refuse a request for concurrency.
 * A positive integer installs a cap without needing a new image.
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
