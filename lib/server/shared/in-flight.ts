/**
 * How many chat-shaped requests are being served right now.
 *
 * This is a counter, not a gate. Nothing in this module can refuse, queue,
 * throttle, or delay a request — there is no limit to compare against and no
 * rejection path to take. It exists for one reader: the memory watchdog, which
 * waits for a quiet moment before a controlled restart so that a response is
 * not cut in half mid-stream.
 *
 * An earlier revision did gate on this number and turned away 8.5% of healthy
 * traffic with a 503. Refusing a request that the process could have served is
 * a capacity policy, and capacity belongs to the upstream that actually runs
 * out of it — not to a proxy guessing at its own container size.
 */
import { logEvent } from './log';
import { getMemorySnapshot } from './memory';

export interface RequestSlot {
  /** Idempotent: a double release must not decrement somebody else's slot. */
  release: () => void;
}

/** Slower than any healthy turn; a slot held this long is a leak or a stall. */
const SLOW_REQUEST_WARN_MS = 120_000;

/**
 * The hard ceiling on how long one slot may be held.
 *
 * `attachSlotToResponse` frees the slot when the body ends, errors, or is
 * cancelled — but a response that is *never* consumed and never cancelled (an
 * aborted connection whose reader is dropped without a cancel reaching us)
 * frees nothing. Without a lease that leak would be permanent, and a counter
 * that only grows would keep the watchdog from ever draining. Thirty minutes is
 * well past any real turn, so in practice this only fires on a leak.
 */
const SLOT_LEASE_MS = 30 * 60_000;

let active = 0;
let peak = 0;

export const getActiveRequests = (): number => active;

export const getPeakRequests = (): number => peak;

export const resetInFlightForTests = (): void => {
  active = 0;
  peak = 0;
};

export const beginRequest = (): RequestSlot => {
  active += 1;
  peak = Math.max(peak, active);

  const startedAt = Date.now();
  let released = false;

  void logEvent({
    level: 'DEBUG',
    message: 'Request slot acquired',
    payload: { active, peak },
  });

  const release = (leaked = false): void => {
    if (released) return;

    released = true;
    active = Math.max(0, active - 1);
    clearTimeout(leaseTimer);

    const durationMs = Date.now() - startedAt;

    void logEvent({
      level: leaked || durationMs >= SLOW_REQUEST_WARN_MS ? 'WARN' : 'DEBUG',
      message: leaked
        ? 'Request slot leaked, releasing it'
        : 'Request slot released',
      payload: {
        ...getMemorySnapshot(),
        active,
        durationMs,
        leaseMs: SLOT_LEASE_MS,
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

  return { release: () => release(false) };
};

/**
 * Ties a slot to a response body, so it is freed when the body ends, errors, or
 * is cancelled rather than when the handler function happens to return.
 */
export const attachSlotToResponse = (
  response: Response,
  slot: RequestSlot,
): Response => {
  if (!response.body) {
    slot.release();
    return response;
  }

  let released = false;
  const release = (): void => {
    if (released) return;

    released = true;
    slot.release();
  };

  const reader = response.body.getReader();

  return new Response(
    new ReadableStream<Uint8Array>({
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } finally {
          release();
        }
      },
      async pull(controller) {
        try {
          const { done, value } = await reader.read();

          if (done) {
            release();
            controller.close();
            return;
          }

          controller.enqueue(value);
        } catch (error) {
          release();
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
 * Runs a handler with a slot held, without ever turning a request away.
 *
 * There is no rejection callback on purpose: a request that arrives while
 * others are in flight is still served, which is the whole point of the change
 * from admission control to plain accounting.
 */
export const withRequestTracking = async (
  handler: () => Promise<Response>,
): Promise<Response> => {
  const slot = beginRequest();

  try {
    const response = await handler();

    return attachSlotToResponse(response, slot);
  } catch (error) {
    slot.release();
    throw error;
  }
};
