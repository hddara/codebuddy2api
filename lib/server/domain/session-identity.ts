/**
 * Conversation resolution (design 1.2).
 *
 * Chat Completions is stateless and the Responses API mints a fresh response id
 * every turn, so nothing in a request names the conversation it belongs to.
 * Session logging therefore reconstructs that identity through the four
 * priority steps the design fixed:
 *
 *   1. explicit `x-conversation-id` / `x-session-id` headers
 *   2. the `/v1/responses` `previous_response_id` chain
 *   3. Anthropic `metadata.user_id` plus a system prompt fingerprint
 *   4. `access_key_id` plus the first user message, within a sliding window
 *
 * Steps 1 and 2 yield an identity that is stable for the whole conversation,
 * because the client told us (or the chain told us) which conversation it is.
 * Steps 3 and 4 only continue a conversation while it stays active: a
 * `metadata.user_id` identifies a *user*, not a conversation, so without the
 * window every conversation of that user would collapse into one session.
 *
 * The module returns a null identity when sessions cannot be stored at all,
 * which is the single reason session logging silently does nothing.
 */

import { createHash } from 'node:crypto';

import { resolveResponsesConversationRef } from '../proxy/responses';
import {
  findStorageSessionByExternalRef,
  getSessionStorageAvailability,
} from '../storage';

/** How long a fallback conversation may stay idle before it counts as ended. */
export const SESSION_RESOLUTION_WINDOW_MS = 30 * 60 * 1000;

const MAX_TITLE_LENGTH = 80;
const HEADER_KEYS = ['x-conversation-id', 'x-session-id'] as const;
/**
 * Client supplied ids end up as storage keys, so they are kept to a shape that
 * cannot smuggle path separators or control characters into them.
 */
const EXTERNAL_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
/** Responses input item types that never hold the user's own words. */
const NON_MESSAGE_INPUT_TYPES = new Set([
  'additional_tools',
  'function_call',
  'function_call_output',
  'reasoning',
]);

export type SessionIdentityStrategy =
  'anthropic-metadata' | 'fallback' | 'header' | 'responses-chain';

export interface SessionIdentityInput {
  accessKeyId: string | null;
  body: Record<string, unknown> | null;
  headers: { get(name: string): string | null };
  nowMs?: number;
  route: string;
}

export interface SessionIdentity {
  /**
   * What identifies the conversation. Stable for strategies 1 and 2; for the
   * windowed strategies it is the fingerprint the window is applied to.
   */
  externalRef: string;
  model: string | null;
  sessionId: string;
  strategy: SessionIdentityStrategy;
  /** First user message excerpt, used as the session list title. */
  title: string | null;
}

const digest = (...parts: string[]): string => {
  return createHash('sha256')
    .update(parts.join('\u0000'))
    .digest('hex')
    .slice(0, 32);
};

const collapseWhitespace = (value: string): string => {
  return value.replace(/\s+/g, ' ').trim();
};

const truncate = (value: string, maxLength: number): string => {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
};

/**
 * Reads the text out of a Chat Completions / Anthropic `content` value, which
 * is either a plain string or a list of typed blocks. Blocks without text (a
 * tool result, an image) contribute nothing.
 */
const readContentText = (content: unknown): string | null => {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return null;
  }

  const parts = content
    .map((block) => {
      if (typeof block === 'string') {
        return block;
      }

      if (!block || typeof block !== 'object') {
        return null;
      }

      const text = (block as { text?: unknown }).text;

      return typeof text === 'string' ? text : null;
    })
    .filter((part): part is string => Boolean(part));

  return parts.length ? parts.join('\n') : null;
};

const readMessageArray = (
  value: unknown,
): Array<{ content?: unknown; role?: unknown; type?: unknown }> => {
  return Array.isArray(value)
    ? (value as Array<{ content?: unknown; role?: unknown; type?: unknown }>)
    : [];
};

/**
 * First user message text across the three request shapes: Chat Completions and
 * Anthropic `messages`, and Responses `input` (a bare string or item list).
 */
export const extractFirstUserText = (
  body: Record<string, unknown> | null,
): string | null => {
  if (!body) {
    return null;
  }

  const fromMessages = readContentText(
    readMessageArray(body.messages).find((message) => message?.role === 'user')
      ?.content,
  );

  if (fromMessages) {
    return fromMessages;
  }

  if (typeof body.input === 'string') {
    return body.input;
  }

  const userItem = readMessageArray(body.input).find((item) => {
    if (typeof item.role === 'string') {
      return item.role === 'user';
    }

    // Responses item lists also carry non-message entries; only an explicit
    // type marks one as something other than the user's first input.
    return !(
      typeof item.type === 'string' && NON_MESSAGE_INPUT_TYPES.has(item.type)
    );
  });

  return readContentText(userItem?.content);
};

const readSystemText = (
  body: Record<string, unknown> | null,
): string | null => {
  const system = body?.system;

  return typeof system === 'string' ? system : readContentText(system);
};

const readMetadataUserId = (
  body: Record<string, unknown> | null,
): string | null => {
  const metadata = body?.metadata;

  if (!metadata || typeof metadata !== 'object') {
    return null;
  }

  const userId = (metadata as { user_id?: unknown }).user_id;

  return typeof userId === 'string' && userId.trim() ? userId.trim() : null;
};

const readPreviousResponseId = (
  body: Record<string, unknown> | null,
): string | null => {
  const value = body?.previous_response_id;

  return typeof value === 'string' && value.trim() ? value.trim() : null;
};

const readModel = (body: Record<string, unknown> | null): string | null => {
  const model = body?.model;

  return typeof model === 'string' && model.trim() ? model.trim() : null;
};

const readHeaderRef = (
  headers: SessionIdentityInput['headers'],
): string | null => {
  for (const key of HEADER_KEYS) {
    const raw = headers.get(key)?.trim();

    if (raw && EXTERNAL_ID_PATTERN.test(raw)) {
      return raw;
    }
  }

  return null;
};

interface WindowedIdentityOptions {
  accessKeyId: string | null;
  externalRef: string;
  model: string | null;
  nowMs: number;
  /** Session id prefix, so the strategy behind a row stays readable. */
  prefix: string;
  strategy: SessionIdentityStrategy;
  title: string | null;
}

/**
 * Continues the newest session of the same fingerprint while it is still inside
 * the window, and otherwise starts a new one. A fresh id is derived from the
 * fingerprint plus the timestamp so a retried first turn lands on one session.
 */
const buildWindowedIdentity = async (
  options: WindowedIdentityOptions,
): Promise<SessionIdentity> => {
  const existing = await findStorageSessionByExternalRef(
    options.accessKeyId,
    options.externalRef,
    options.nowMs - SESSION_RESOLUTION_WINDOW_MS,
  );

  return {
    externalRef: options.externalRef,
    model: options.model,
    sessionId:
      existing?.sessionId ??
      `${options.prefix}_${digest(options.externalRef, String(options.nowMs))}`,
    strategy: options.strategy,
    title: options.title,
  };
};

export const resolveSessionIdentity = async (
  input: SessionIdentityInput,
): Promise<SessionIdentity | null> => {
  // File storage cannot index or encrypt turns, so it has no session log form.
  if (!getSessionStorageAvailability().available) {
    return null;
  }

  const nowMs = input.nowMs ?? Date.now();
  const model = readModel(input.body);
  const firstUserText = extractFirstUserText(input.body);
  const title = firstUserText
    ? truncate(collapseWhitespace(firstUserText), MAX_TITLE_LENGTH)
    : null;

  // 1. An explicit header is the client telling us the answer.
  const headerRef = readHeaderRef(input.headers);

  if (headerRef) {
    return {
      externalRef: headerRef,
      model,
      sessionId: `h_${digest('header', headerRef)}`,
      strategy: 'header',
      title,
    };
  }

  // 2. Reuse the Responses chain binding rather than a second index. An
  //    unknown or foreign id resolves to null and falls through.
  const previousResponseId = readPreviousResponseId(input.body);

  if (previousResponseId) {
    const chainRef = await resolveResponsesConversationRef(
      previousResponseId,
      input.accessKeyId,
    );

    if (chainRef) {
      return {
        externalRef: `responses:${chainRef}`,
        model,
        sessionId: `r_${digest('responses', chainRef)}`,
        strategy: 'responses-chain',
        title,
      };
    }
  }

  // 3. Anthropic callers can name the end user, and the system prompt pins the
  //    agent, so together they fingerprint an intended conversation.
  const metadataUserId = input.route.startsWith('/v1/messages')
    ? readMetadataUserId(input.body)
    : null;

  if (metadataUserId) {
    return buildWindowedIdentity({
      accessKeyId: input.accessKeyId,
      externalRef: `anthropic:${digest(
        metadataUserId,
        readSystemText(input.body) ?? '',
      )}`,
      model,
      nowMs,
      prefix: 'a',
      strategy: 'anthropic-metadata',
      title,
    });
  }

  // 4. The mandatory fallback. Without it most Chat clients would be split into
  //    one session per turn. When a request carries no user text there is no
  //    honest fingerprint left but the body itself, which then cannot group
  //    anything beyond an identical retry.
  return buildWindowedIdentity({
    accessKeyId: input.accessKeyId,
    externalRef: `fallback:${digest(
      input.accessKeyId ?? '',
      firstUserText ?? JSON.stringify(input.body ?? {}),
    )}`,
    model,
    nowMs,
    prefix: 'f',
    strategy: 'fallback',
    title,
  });
};
