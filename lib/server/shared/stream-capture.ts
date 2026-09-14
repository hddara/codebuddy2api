/**
 * HTTP snapshot capture, shared by debug tracing and session logging.
 *
 * Both features need the body of a response that is already on its way to the
 * client, and both need the secrets inside that body redacted. Building it
 * twice would either read the stream twice or install a second tee, so the
 * capture lives here exactly once:
 *
 * - `captureResponseSnapshot` tees the body and hands back a replacement
 *   response, for responses the caller keeps forwarding (the upstream
 *   response inside the proxy).
 * - `captureIndependentResponseSnapshot` clones the body and leaves the
 *   original untouched, for a response the caller is already returning (the
 *   transformed response at the route).
 */

const MAX_SNAPSHOT_TEXT_LENGTH = 200_000;
const REDACTED_VALUE = '[redacted]';

const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'x-user-id',
  'cookie',
  'set-cookie',
]);
const SENSITIVE_FIELD_NAMES = new Set([
  'access_token',
  'api_key',
  'authorization',
  'bearer_token',
  'cookie',
  'id_token',
  'refresh_token',
  'requestkey',
  'request_key',
  'secret',
  'session_state',
  'set-cookie',
  'token',
  'user_id',
  'x-api-key',
  'x-user-id',
  'x_user_id',
]);
const JSON_STRING_PROPERTY_PATTERN =
  /("(?:\\.|[^"\\])*")(\s*:\s*)("(?:\\.|[^"\\])*(?:"|$))/g;

export interface HttpSnapshot {
  body: unknown;
  headers: Record<string, string>;
  status: number;
}

export const maskSensitiveString = (value: string): string => {
  const trimmed = value.trim();

  if (!trimmed) {
    return value;
  }

  const bearerPrefixMatch = trimmed.match(/^Bearer\s+/i);

  if (bearerPrefixMatch) {
    const token = trimmed.slice(bearerPrefixMatch[0].length);

    if (!token) {
      return '';
    }

    if (token.length <= 4) {
      return '****';
    }

    if (token.length <= 12) {
      return `${token.slice(0, 4)}${'*'.repeat(Math.max(4, token.length - 4))}`;
    }

    return `${token.slice(0, 8)}${'*'.repeat(token.length - 12)}${token.slice(-4)}`;
  }

  if (trimmed.length <= 4) {
    return '****';
  }

  if (trimmed.length <= 12) {
    return `${trimmed.slice(0, 4)}${'*'.repeat(Math.max(4, trimmed.length - 4))}`;
  }

  return `${trimmed.slice(0, 8)}${'*'.repeat(trimmed.length - 12)}${trimmed.slice(-4)}`;
};

const isSensitiveFieldName = (name: string): boolean => {
  return SENSITIVE_FIELD_NAMES.has(name.trim().toLowerCase());
};

const truncateString = (value: string): string => {
  if (value.length <= MAX_SNAPSHOT_TEXT_LENGTH) {
    return value;
  }

  return `${value.slice(0, MAX_SNAPSHOT_TEXT_LENGTH)}\n...[truncated]`;
};

export const sanitizeValue = (value: unknown, key?: string): unknown => {
  if (typeof key === 'string' && isSensitiveFieldName(key)) {
    if (value === null || value === undefined || value === '') {
      return value;
    }

    return typeof value === 'string'
      ? maskSensitiveString(value)
      : REDACTED_VALUE;
  }

  if (typeof value === 'string') {
    return truncateString(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(
        ([entryKey, entryValue]) => [
          entryKey,
          sanitizeValue(entryValue, entryKey),
        ],
      ),
    );
  }

  return value;
};

export const sanitizeHeadersRecord = (
  headers: Record<string, string>,
): Record<string, string> => {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      SENSITIVE_HEADER_NAMES.has(key.trim().toLowerCase())
        ? maskSensitiveString(value)
        : truncateString(value),
    ]),
  );
};

const toHeadersRecord = (headers: Headers): Record<string, string> => {
  return sanitizeHeadersRecord(Object.fromEntries(headers.entries()));
};

const redactSensitiveJsonFields = (value: string): string => {
  return value.replace(
    JSON_STRING_PROPERTY_PATTERN,
    (match, serializedKey: string, separator: string) => {
      try {
        const key = JSON.parse(serializedKey) as unknown;

        return typeof key === 'string' && isSensitiveFieldName(key)
          ? `${serializedKey}${separator}${JSON.stringify(REDACTED_VALUE)}`
          : match;
      } catch {
        return match;
      }
    },
  );
};

const tryParseBody = (
  text: string,
  contentType: string,
): string | Record<string, unknown> | unknown[] => {
  const trimmed = text.trim();

  if (!trimmed) {
    return '';
  }

  if (contentType.toLowerCase().includes('application/json')) {
    try {
      return sanitizeValue(
        JSON.parse(trimmed) as Record<string, unknown> | unknown[],
      ) as Record<string, unknown> | unknown[];
    } catch {
      return redactSensitiveJsonFields(trimmed);
    }
  }

  return truncateString(text);
};

const readSnapshotText = async (response: Response): Promise<string> => {
  if (!response.body) {
    return '';
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let capturedLength = 0;
  let truncated = false;

  try {
    while (capturedLength < MAX_SNAPSHOT_TEXT_LENGTH) {
      const chunk = await reader.read();

      if (chunk.done) {
        text += decoder.decode();
        break;
      }

      const remaining = MAX_SNAPSHOT_TEXT_LENGTH - capturedLength;
      const decoded = decoder.decode(chunk.value, { stream: true });

      if (decoded.length <= remaining) {
        text += decoded;
        capturedLength += decoded.length;
        continue;
      }

      text += decoded.slice(0, remaining);
      truncated = true;
      break;
    }
  } finally {
    if (truncated) {
      void reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }

  return truncated ? `${text}\n...[truncated]` : text;
};

/**
 * Tee the body: the returned response must be used by the caller, because the
 * original stream is consumed by the tee. `snapshot` resolves once the stream
 * has been read to the end (or cancelled).
 */
export const captureResponseSnapshot = (
  response: Response,
): { response: Response; snapshot: Promise<HttpSnapshot> } => {
  const contentType = response.headers.get('content-type') ?? '';
  const decoder = new TextDecoder();
  let text = '';
  let capturedLength = 0;
  let truncated = false;
  let resolveSnapshot: (snapshot: HttpSnapshot) => void;
  const snapshot = new Promise<HttpSnapshot>((resolve) => {
    resolveSnapshot = resolve;
  });
  let completed = false;
  const finish = (): void => {
    if (completed) return;
    completed = true;
    text += decoder.decode();
    resolveSnapshot({
      body: tryParseBody(
        truncated ? `${text}\n...[truncated]` : text,
        contentType,
      ),
      headers: toHeadersRecord(response.headers),
      status: response.status,
    });
  };
  const capture = (chunk: Uint8Array): void => {
    if (truncated) return;

    const remaining = MAX_SNAPSHOT_TEXT_LENGTH - capturedLength;
    const decoded = decoder.decode(chunk, { stream: true });

    if (decoded.length <= remaining) {
      text += decoded;
      capturedLength += decoded.length;
      return;
    }

    text += decoded.slice(0, remaining);
    capturedLength += remaining;
    truncated = true;
  };

  if (!response.body) {
    finish();
    return { response, snapshot };
  }

  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async cancel(reason): Promise<void> {
      await reader.cancel(reason);
      finish();
    },
    async pull(controller): Promise<void> {
      try {
        const chunk = await reader.read();

        if (chunk.done) {
          finish();
          controller.close();
          reader.releaseLock();
          return;
        }

        capture(chunk.value);
        controller.enqueue(chunk.value);
      } catch (error) {
        finish();
        controller.error(error);
        reader.releaseLock();
      }
    },
  });

  return {
    response: new Response(body, {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    }),
    snapshot,
  };
};

/**
 * Clone the body: the caller keeps returning the original response unchanged,
 * and only the clone is drained.
 */
export const captureIndependentResponseSnapshot = async (
  response: Response,
): Promise<HttpSnapshot> => {
  const clone = response.clone();

  return {
    body: tryParseBody(
      await readSnapshotText(clone),
      clone.headers.get('content-type') ?? '',
    ),
    headers: toHeadersRecord(clone.headers),
    status: clone.status,
  };
};
