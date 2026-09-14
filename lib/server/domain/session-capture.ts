/**
 * Turns one request/response pair into session log rows.
 *
 * The capture is deliberately fire-and-forget: it reads a *clone* of the
 * response that is already on its way to the client, and every failure is
 * swallowed after a warning. Observability must never break a request that
 * would otherwise have been served.
 */

import type { SessionIdentity } from './session-identity';
import {
  extractFirstUserText,
  resolveSessionIdentity,
} from './session-identity';
import {
  getSessionLogSettings,
  getSessionRetentionStartMs,
} from './session-log';
import type { HttpSnapshot } from '../shared/stream-capture';
import { captureIndependentResponseSnapshot } from '../shared/stream-capture';
import type { SessionTurnRecord, SessionWriteInput } from '../storage';
import {
  appendStorageSessionTurns,
  getStorageSessionRecord,
  trimStorageSessions,
} from '../storage';

export interface SessionCaptureInput {
  accessKeyId: string | null;
  body: Record<string, unknown> | null;
  credentialFilename: string | null;
  headers: { get(name: string): string | null };
  route: string;
}

export interface SessionCapture {
  accessKeyId: string | null;
  credentialFilename: string | null;
  identity: SessionIdentity;
  requestBody: Record<string, unknown> | null;
  route: string;
  startedAt: number;
  /** Turn index of the request turn; the response turn takes the next one. */
  turnBase: number;
}

const asRecord = (value: unknown): Record<string, unknown> | null => {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
};

const readTextParts = (value: unknown): string | null => {
  if (typeof value === 'string') {
    return value.trim() ? value : null;
  }

  if (!Array.isArray(value)) {
    return null;
  }

  const parts = value
    .map((item) => {
      const block = asRecord(item);
      const text = block?.text;

      return typeof text === 'string' ? text : null;
    })
    .filter((part): part is string => Boolean(part));

  return parts.length ? parts.join('') : null;
};

const extractStreamedText = (raw: string): string | null => {
  let text = '';

  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith('data:')) {
      continue;
    }

    const payload = line.slice('data:'.length).trim();

    if (!payload || payload === '[DONE]') {
      continue;
    }

    try {
      const event = asRecord(JSON.parse(payload) as unknown);
      const choice = asRecord(
        Array.isArray(event?.choices) ? event?.choices[0] : null,
      );
      const delta = asRecord(choice?.delta) ?? asRecord(event?.delta);
      const chunk =
        readTextParts(delta?.content) ??
        (typeof delta?.text === 'string' ? delta.text : null);

      if (chunk) {
        text += chunk;
      }
    } catch {
      // Sentinels and partial frames are expected in an SSE body.
    }
  }

  return text || null;
};

/**
 * Best effort assistant text across Chat Completions, Anthropic and Responses,
 * for both a buffered JSON body and a server-sent event stream. Anything the
 * shapes do not cover is left to `contentRaw`, which keeps the whole snapshot.
 */
export const extractAssistantText = (body: unknown): string | null => {
  const record = asRecord(body);

  if (!record) {
    return typeof body === 'string' ? extractStreamedText(body) : null;
  }

  const choice = asRecord(
    Array.isArray(record.choices) ? record.choices[0] : null,
  );
  const fromChat = readTextParts(asRecord(choice?.message)?.content);

  if (fromChat) {
    return fromChat;
  }

  const fromAnthropic = readTextParts(record.content);

  if (fromAnthropic) {
    return fromAnthropic;
  }

  if (typeof record.output_text === 'string' && record.output_text.trim()) {
    return record.output_text;
  }

  if (Array.isArray(record.output)) {
    const texts = record.output
      .map((item) => readTextParts(asRecord(item)?.content))
      .filter((text): text is string => Boolean(text));

    if (texts.length) {
      return texts.join('');
    }
  }

  return null;
};

const buildTurn = (
  capture: SessionCapture,
  turn: {
    contentRaw: unknown;
    contentText: string | null;
    createdAt: number;
    role: string;
    turnIndex: number;
    usage: unknown;
  },
): SessionTurnRecord => ({
  contentRaw: turn.contentRaw,
  contentText: turn.contentText,
  context: null,
  createdAt: turn.createdAt,
  model: capture.identity.model,
  reasoning: null,
  role: turn.role,
  route: capture.route,
  sessionId: capture.identity.sessionId,
  toolCalls: null,
  turnId: `${capture.identity.sessionId}:${capture.startedAt}:${turn.role}:${turn.turnIndex}`,
  turnIndex: turn.turnIndex,
  usage: turn.usage,
});

const buildSession = (
  capture: SessionCapture,
  updatedAt: number,
): SessionWriteInput => ({
  accessKeyId: capture.accessKeyId,
  credentialFilename: capture.credentialFilename,
  externalRef: capture.identity.externalRef,
  model: capture.identity.model,
  sessionId: capture.identity.sessionId,
  sourceRoute: capture.route,
  startedAt: capture.startedAt,
  title: capture.identity.title,
  updatedAt,
});

const writeSessionTurns = async (
  capture: SessionCapture,
  snapshot: HttpSnapshot,
): Promise<void> => {
  const settings = getSessionLogSettings();
  const nowMs = Date.now();
  const usage = asRecord(snapshot.body)?.usage ?? null;

  await appendStorageSessionTurns({
    maxTurnsPerSession: settings.maxTurnsPerSession,
    session: buildSession(capture, nowMs),
    turns: [
      buildTurn(capture, {
        contentRaw: capture.requestBody,
        contentText: extractFirstUserText(capture.requestBody),
        createdAt: capture.startedAt,
        role: 'user',
        turnIndex: capture.turnBase,
        usage: null,
      }),
      buildTurn(capture, {
        contentRaw: snapshot.body,
        contentText: extractAssistantText(snapshot.body),
        createdAt: nowMs,
        role: 'assistant',
        turnIndex: capture.turnBase + 1,
        usage,
      }),
    ],
  });

  await trimStorageSessions(
    new Date(getSessionRetentionStartMs(nowMs, settings.retentionDays)),
  );
};

export const beginSessionCapture = async (
  input: SessionCaptureInput,
): Promise<SessionCapture | null> => {
  if (!getSessionLogSettings().enabled) {
    return null;
  }

  try {
    const identity = await resolveSessionIdentity({
      accessKeyId: input.accessKeyId,
      body: input.body,
      headers: input.headers,
      route: input.route,
    });

    if (!identity) {
      return null;
    }

    const existing = await getStorageSessionRecord(identity.sessionId);

    return {
      accessKeyId: input.accessKeyId,
      credentialFilename: input.credentialFilename,
      identity,
      requestBody: input.body,
      route: input.route,
      startedAt: Date.now(),
      turnBase: existing?.turnCount ?? 0,
    };
  } catch (error) {
    console.warn('[CodeBuddy2API] Unable to start session capture', error);

    return null;
  }
};

/**
 * Returns the response untouched: the snapshot is taken from a clone, so the
 * client stream is neither delayed nor consumed.
 */
export const finalizeSessionCapture = (
  capture: SessionCapture | null,
  response: Response,
): Response => {
  if (!capture) {
    return response;
  }

  void captureIndependentResponseSnapshot(response)
    .then((snapshot) => writeSessionTurns(capture, snapshot))
    .catch((error) => {
      console.warn('[CodeBuddy2API] Unable to record session turns', error);
    });

  return response;
};
