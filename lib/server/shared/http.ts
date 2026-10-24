import { logEvent } from './log';

/**
 * Anomaly guard on a proxied JSON request body — not a size policy.
 *
 * This is the one number a caller can trip, so it is worth being precise about
 * what it is for. `request.json()` buffers and parses the whole payload before
 * any check is possible, so something has to bound the read. But bounding the
 * read is not the same as deciding what a conversation is allowed to weigh, and
 * conflating the two is what produced the 413s filed against this service: a
 * long agent transcript crossed the line on arrival and was refused *before*
 * the compressor that exists to shrink it ever ran. A cap that fires before the
 * fix-up it is meant to trigger is not a safety valve, it is a bug with a
 * status code.
 *
 * So the roles are separated. The *policy* limit is the dispatch target below:
 * everything a caller sends is compressed down to it before it goes upstream.
 * This number is only here to stop a runaway or hostile client from being
 * parsed at all, and it therefore sits far above any real conversation. A
 * session large enough to reach it is not being "too big to send", it is
 * broken.
 *
 * The heap arithmetic, so the value is not arbitrary: the parsed form of a JSON
 * body measures roughly 4x its wire size, so a 64 MiB body peaks near 256 MB
 * while it is handled. The concurrency gate admits at most 4 at once, so the
 * absolute worst case is about 1 GB against a 2 GB container — which is why the
 * memory watchdog recycles the process at 1700 MB rather than trusting this
 * number alone to keep the heap in bounds.
 *
 * History worth keeping: an earlier revision cut this to 2 MiB on the theory
 * that a parsed 8 MiB body costs 3-5x its size and two overlapping requests
 * would breach the container limit. Measured, it is about 4x, and two
 * overlapping 8 MiB requests were never the failure mode; the cut only
 * converted working requests into 413s. The follow-up raised it to 32 MiB while
 * still treating it as a policy limit; this revision raises it to 64 MiB and
 * stops treating it as one.
 */
export const MAX_REQUEST_BODY_ENV = 'CODEBUDDY_MAX_REQUEST_BYTES';

const DEFAULT_MAX_REQUEST_BODY_BYTES = 64 * 1024 * 1024;

/**
 * Ceiling on a body actually dispatched upstream, applied after compression.
 *
 * 1 MiB. The gateway re-sends the whole conversation on every turn, so this is
 * the number that governs both upstream latency and the rate at which a session
 * becomes unsendable. A conversation compressed to fit here still carries its
 * newest turns verbatim, its tool results with the middle elided and its tool
 * call arguments reduced — everything the next step of the agent loop needs.
 */
export const REQUEST_TARGET_ENV = 'CODEBUDDY_REQUEST_TARGET_BYTES';

const DEFAULT_REQUEST_TARGET_BYTES = 1024 * 1024;

/**
 * Reads a byte cap from the environment, always returning a usable number.
 *
 * A malformed or non-positive value falls back to the default rather than
 * disabling the cap: these are the last line between an arbitrary client and
 * the heap, so neither should ever be "off" by accident.
 */
const readByteCap = (name: string, fallback: number): number => {
  const raw = (process.env[name] ?? '').trim();

  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const getMaxRequestBodyBytes = (): number =>
  readByteCap(MAX_REQUEST_BODY_ENV, DEFAULT_MAX_REQUEST_BODY_BYTES);

export const getRequestTargetBytes = (): number =>
  readByteCap(REQUEST_TARGET_ENV, DEFAULT_REQUEST_TARGET_BYTES);

/**
 * The two caps must never cross, or every request is refused before it can be
 * compressed. A target above the reject cap would make compression pointless,
 * so the target is clamped — a misconfiguration degrades to "compress
 * aggressively", never to "refuse everything".
 */
export const getEffectiveTargetBytes = (): number =>
  Math.min(getRequestTargetBytes(), getMaxRequestBodyBytes());

export class RequestBodyTooLargeError extends Error {
  readonly declaredBytes: number | null;
  readonly limitBytes: number;

  constructor(limitBytes: number, declaredBytes: number | null = null) {
    super(
      `Request body exceeds the maximum size of ${Math.floor(
        limitBytes / (1024 * 1024),
      )}MB`,
    );
    this.name = 'RequestBodyTooLargeError';
    this.limitBytes = limitBytes;
    this.declaredBytes = declaredBytes;
  }
}

const getDeclaredBodyBytes = (request: Request): number | null => {
  const contentLength = request.headers.get('content-length');

  if (!contentLength) {
    return null;
  }

  const parsed = Number.parseInt(contentLength, 10);

  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

/**
 * Reads the body while enforcing the size cap. A chunked request declares no
 * Content-Length, so the limit has to be applied as the bytes arrive;
 * buffering the whole body first would let an arbitrarily large payload
 * exhaust the heap before it could ever be rejected. The stream is cancelled as
 * soon as the cap is passed so the connection stops being fed.
 */
const readCappedText = async (request: Request): Promise<string> => {
  const limitBytes = getMaxRequestBodyBytes();
  const body = request.body;

  if (!body) {
    return request.text();
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      totalBytes += value.byteLength;

      if (totalBytes > limitBytes) {
        logBodyRejection('streamed', totalBytes, limitBytes);

        throw new RequestBodyTooLargeError(limitBytes, totalBytes);
      }

      chunks.push(decoder.decode(value, { stream: true }));
    }

    chunks.push(decoder.decode());
  } finally {
    // Cancel rather than just releasing, so a rejected body stops the client
    // from pushing the remainder through a connection nobody will read.
    try {
      await reader.cancel();
    } catch {
      // The stream may already be closed or errored.
    } finally {
      reader.releaseLock();
    }
  }

  return chunks.join('');
};

/**
 * Every rejection is logged with the numbers that make the cause obvious.
 *
 * A 413 used to leave no trace at all, so "the client says it sends a normal
 * request" and "the gateway says it refused a 9 MB body" could not be told
 * apart from the logs. The declared length is logged separately from the
 * counted one because a poisoned `Content-Length` (a proxy that lies, or a
 * chunked body with none) is a different bug from a genuinely large payload.
 */
const logBodyRejection = (
  source: 'declared' | 'streamed',
  observedBytes: number,
  limitBytes: number,
): void => {
  const targetBytes = getEffectiveTargetBytes();

  void logEvent({
    level: 'WARN',
    message: 'Request body rejected: past the anomaly guard',
    payload: {
      declaredBytes: source === 'declared' ? observedBytes : null,
      limitBytes,
      observedBytes,
      overByBytes: observedBytes - limitBytes,
      source,
      targetBytes,
      // Spelled out so nobody reads this line as "the conversation was too
      // large to serve". Reaching this guard means the body was still growing
      // after compression was supposed to bound it, which is a client or
      // retention bug, not a size policy doing its job.
      hint: 'body exceeded the anomaly guard before compression could run',
    },
  });
};

export const getJsonBody = async <T>(request: Request): Promise<T> => {
  const limitBytes = getMaxRequestBodyBytes();
  const declaredBytes = getDeclaredBodyBytes(request);

  // Cheap fast path: reject a body that declares itself oversized without
  // reading any of it.
  if (declaredBytes !== null && declaredBytes > limitBytes) {
    logBodyRejection('declared', declaredBytes, limitBytes);

    throw new RequestBodyTooLargeError(limitBytes, declaredBytes);
  }

  const text = await readCappedText(request);

  return JSON.parse(text) as T;
};

/**
 * Reads and parses the body, reporting a malformed or oversized body as a
 * `(status, message)` pair instead of throwing. Callers turn that into
 * whichever error shape their API contract uses, so the Anthropic route can
 * stay on `type: "error"` while the OpenAI-compatible routes keep
 * `{ error: { message } }`.
 */
export const readJsonBodyOrFailure = async <T>(
  request: Request,
): Promise<{ body: T } | { failure: { message: string; status: number } }> => {
  try {
    return { body: await getJsonBody<T>(request) };
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return { failure: { message: error.message, status: 413 } };
    }

    // A malformed body is logged too: a client that sends a body it cannot
    // parse (a truncated upload, a wrong content-type) looks identical to a
    // gateway bug until the log says which one it was.
    void logEvent({
      level: 'WARN',
      message: 'Request body rejected: not valid JSON',
      payload: {
        detail: error instanceof Error ? error.message : String(error),
      },
    });

    return {
      failure: { message: 'Request body must be valid JSON', status: 400 },
    };
  }
};

/**
 * OpenAI-compatible variant of `readJsonBodyOrFailure`.
 */
export const readJsonBodyOrErrorResponse = async <T>(
  request: Request,
): Promise<{ body: T } | { response: Response }> => {
  const result = await readJsonBodyOrFailure<T>(request);

  if ('failure' in result) {
    const { message, status } = result.failure;

    return {
      response:
        status === 413
          ? createErrorResponse(413, message, {
              limit_bytes: getMaxRequestBodyBytes(),
            })
          : createErrorResponse(400, message),
    };
  }

  return result;
};

/**
 * Waits until the stream's consumer has room for another chunk.
 *
 * `controller.enqueue` never blocks: a producer that reads a source as fast as
 * it can emit will queue every chunk the consumer has not taken yet, and that
 * queue is unbounded. A model reply can be megabytes, so a client on a slow link
 * turns into hundreds of megabytes of retained `Uint8Array` unless the producer
 * stops at `desiredSize <= 0`. The poll is deliberate — the stream API offers no
 * "demand changed" signal, and 5ms is far below any human-perceptible latency.
 */
export const waitForStreamDemand = async (
  controller: ReadableStreamDefaultController<Uint8Array>,
  isCancelled: () => boolean = () => false,
): Promise<void> => {
  while (
    !isCancelled() &&
    controller.desiredSize !== null &&
    controller.desiredSize <= 0
  ) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

/**
 * Buffers a whole response body as text, refusing to exceed `maxBytes`.
 *
 * Used where the caller needs the complete payload (aggregating an SSE reply
 * into one JSON object). The cap matters because `.text()` has none: an upstream
 * that streams far more than expected would be held in memory in full.
 */
export const readCappedResponseText = async (
  response: Response,
  maxBytes: number,
): Promise<string> => {
  const body = response.body;

  if (!body) {
    return '';
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      totalBytes += value.byteLength;

      if (totalBytes > maxBytes) {
        throw new Error(
          `Upstream response exceeds the maximum size of ${Math.floor(
            maxBytes / (1024 * 1024),
          )}MB`,
        );
      }

      chunks.push(decoder.decode(value, { stream: true }));
    }

    chunks.push(decoder.decode());
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The stream may already be closed or errored.
    } finally {
      reader.releaseLock();
    }
  }

  return chunks.join('');
};

export const getRequestHeaderMap = (
  headers: Headers,
): Record<string, string> => {
  const passThroughNames = [
    'x-conversation-id',
    'x-conversation-request-id',
    'x-conversation-message-id',
    'x-request-id',
    'traceparent',
    'tracestate',
    'x-trace-id',
    'x-session-id',
    'x-originator',
    'session_id',
    'originator',
  ];

  return passThroughNames.reduce<Record<string, string>>((result, name) => {
    const value = headers.get(name);

    if (value) {
      if (name === 'session_id') {
        result['x-session-id'] = value;
      } else if (name === 'originator') {
        result['x-originator'] = value;
      } else {
        result[name] = value;
      }
    }

    return result;
  }, {});
};

export interface ErrorResponseOptions {
  /** Machine-readable discriminator, e.g. `upstream_credentials_exhausted`. */
  code?: string;
  /** Extra response headers, e.g. `Retry-After`. */
  headers?: Record<string, string>;
  /** OpenAI-compatible error type, e.g. `rate_limit_error`. */
  type?: string;
}

export const createErrorResponse = (
  status: number,
  message: string,
  detail?: unknown,
  options: ErrorResponseOptions = {},
): Response => {
  const { code, headers, type } = options;
  // `type` and `code` are only attached when a caller asks for them, so the
  // shape returned by every other route stays exactly what it has always been.
  const error: Record<string, unknown> = { message, detail };

  if (type) {
    error.type = type;
  }

  if (code) {
    error.code = code;
  }

  return Response.json({ error }, { headers, status });
};
