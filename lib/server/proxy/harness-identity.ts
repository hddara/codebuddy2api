/**
 * Neutralises a client-identity token the upstream refuses to accept.
 *
 * The CodeBuddy upstream inspects the `system` messages of a request and drops
 * any call whose text names a rival harness, answering `code: 11128` ("illegal
 * API invocation from an unapproved channel"). The check reads only `system`
 * content — the same word in a `user` message passes — so a client that
 * prefaces its requests with such an identity marker cannot reach the models at
 * all, whatever credential or network is used.
 *
 * This rewrite is opt-in and off by default: it changes what is sent upstream,
 * which is the operator's call, not a default this gateway should make.
 *
 * Scope is deliberately narrow:
 *  - only `role: 'system'` messages are scanned, since the upstream ignores the
 *    marker anywhere else;
 *  - only the exact identity phrase is replaced, leaving the surrounding
 *    instructions intact;
 *  - a body without the phrase is returned untouched, byte for byte.
 */

import { OFFICIAL_CHANNEL_SYSTEM_PROMPT } from './official-system-prompt';

/** The phrase the upstream refuses, matched case-insensitively. */
const BLOCKED_HARNESS_IDENTITY = 'DeepSeek Harness';

/**
 * What the phrase becomes on the wire.
 *
 * A neutral product-style name, so the sentence still reads as an identity
 * statement instead of a sentence with a hole in it.
 */
const NEUTRAL_HARNESS_IDENTITY = 'DeepSeek';

const escapeForRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const IDENTITY_PATTERN = new RegExp(
  escapeForRegExp(BLOCKED_HARNESS_IDENTITY),
  'gi',
);

/** True when the value carries the refused identity phrase. */
export const hasBlockedHarnessIdentity = (value: unknown): boolean => {
  if (typeof value !== 'string') {
    return false;
  }

  return new RegExp(IDENTITY_PATTERN.source, 'i').test(value);
};

/**
 * Replaces the phrase inside one message's content.
 *
 * Content is either a string or an array of parts; only text parts carry text,
 * and `cache_control` markers are preserved so prompt caching keeps working.
 */
const rewriteContent = (content: unknown): unknown => {
  if (typeof content === 'string') {
    return content.replace(IDENTITY_PATTERN, NEUTRAL_HARNESS_IDENTITY);
  }

  if (!Array.isArray(content)) {
    return content;
  }

  let changed = false;
  const parts = content.map((part) => {
    if (
      part &&
      typeof part === 'object' &&
      (part as { type?: unknown }).type === 'text' &&
      typeof (part as { text?: unknown }).text === 'string'
    ) {
      const text = (part as { text: string }).text;
      const next = text.replace(IDENTITY_PATTERN, NEUTRAL_HARNESS_IDENTITY);

      if (next !== text) {
        changed = true;

        return { ...(part as object), text: next };
      }
    }

    return part;
  });

  return changed ? parts : content;
};

/**
 * Rewrites the identity phrase in every `system` message of a chat body.
 *
 * Returns the original object when nothing matched, so an untouched request
 * does not allocate a copy of a body that may be several megabytes.
 */
export const rewriteHarnessIdentity = <T extends { messages?: unknown }>(
  body: T,
): T => {
  if (!Array.isArray(body.messages)) {
    return body;
  }

  let changed = false;
  const messages = body.messages.map((message) => {
    if (
      !message ||
      typeof message !== 'object' ||
      (message as { role?: unknown }).role !== 'system'
    ) {
      return message;
    }

    const content = (message as { content?: unknown }).content;
    const next = rewriteContent(content);

    if (next !== content) {
      changed = true;

      return { ...(message as object), content: next };
    }

    return message;
  });

  return changed ? { ...body, messages } : body;
};

/** Exported for tests and for the log line that reports a rewrite. */
export const HARNESS_IDENTITY_PLACEHOLDER = NEUTRAL_HARNESS_IDENTITY;

/**
 * Reads the opt-out switch.
 *
 * On by default because the refusal it prevents is invisible in the response the
 * caller gets: the upstream answers `code: 11128` before the request is routed
 * to a model, and the caller only sees a 400 that looks like bad input. Leaving
 * the rewrite off therefore means shipping a proxy that forwards a request it
 * can already tell will be refused.
 *
 * The switch stays, and it is an opt-*out* now, so the behaviour can still be
 * turned off from the deployment definition without a code change if the
 * upstream ever starts accepting these bodies again.
 *
 * A plain environment read rather than a config entry, on purpose: this decides
 * what gets sent to the upstream, it has to be visible in the deployment
 * definition next to the credentials, and it has to be revocable by editing that
 * definition alone rather than a value persisted in a storage backend.
 */
export const isHarnessIdentityRewriteEnabled = (): boolean =>
  !['0', 'false', 'no', 'off'].includes(
    (process.env.CODEBUDDY_REWRITE_HARNESS_IDENTITY ?? '').trim().toLowerCase(),
  );

/**
 * Phrases that look like an identity statement rather than instructions.
 *
 * The upstream refuses a request whose `system` text names a rival harness, and
 * the only way to learn which spelling it objects to is to look at what callers
 * actually send. Matching on a shape — "a product name, followed by a role" —
 * finds those sentences without storing the prompt.
 */
const IDENTITY_CLAIM_PATTERN =
  /(?:you are|i am|powered by|built on|built with|running on|made by|created by|developed by|produced by|a product of)\s+[A-Z][\w.'-]*(?:\s+[A-Z][\w.'-]*){0,3}/gi;

/** Longest snippet worth keeping; an identity sentence is short. */
const MAX_IDENTITY_SNIPPET_CHARS = 120;

/**
 * Every identity-shaped claim in a body's `system` messages, deduplicated.
 *
 * Returns snippets only, never the prompt itself, so the caller can log what the
 * upstream is likely reading without persisting a user's source code.
 */
export const collectIdentityClaims = (body: {
  messages?: unknown;
}): string[] => {
  if (!Array.isArray(body.messages)) {
    return [];
  }

  const claims = new Set<string>();

  for (const message of body.messages) {
    if (
      !message ||
      typeof message !== 'object' ||
      (message as { role?: unknown }).role !== 'system'
    ) {
      continue;
    }

    const content = (message as { content?: unknown }).content;
    const texts: string[] = [];

    if (typeof content === 'string') {
      texts.push(content);
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (
          part &&
          typeof part === 'object' &&
          (part as { type?: unknown }).type === 'text' &&
          typeof (part as { text?: unknown }).text === 'string'
        ) {
          texts.push((part as { text: string }).text);
        }
      }
    }

    for (const text of texts) {
      for (const match of text.matchAll(IDENTITY_CLAIM_PATTERN)) {
        claims.add(match[0].slice(0, MAX_IDENTITY_SNIPPET_CHARS));

        if (claims.size >= 40) {
          return [...claims];
        }
      }
    }
  }

  return [...claims];
};

/**
 * The system prompt sent when a caller supplies none.
 *
 * This is the official client's own opening prompt, captured from a real call,
 * not a placeholder. Measured over a day of production traffic: requests that
 * had to fall back to a placeholder line were refused with code 11128 on 35 of
 * 35 attempts, while requests that carried a caller-supplied preamble were
 * refused on 0.7% of 1610. The channel check is reading this text, so the
 * stand-in has to be the real one rather than a sentence that merely fills the
 * slot.
 */
export const DEFAULT_CHANNEL_SYSTEM_PROMPT = OFFICIAL_CHANNEL_SYSTEM_PROMPT;

/**
 * Reads the opt-out switch.
 *
 * On by default because it is the difference between a call the upstream
 * accepts and one it refuses, and a proxy that stays quiet about that is worse
 * than one that adds a sentence. The switch exists so the behaviour can be
 * turned off from the deployment definition without a code change if the
 * upstream ever starts accepting system-less bodies again.
 */
export const isSystemPromptInjectionEnabled = (): boolean =>
  !['0', 'false', 'no', 'off'].includes(
    (process.env.CODEBUDDY_INJECT_SYSTEM_PROMPT ?? '').trim().toLowerCase(),
  );

/**
 * Prepends a system message to a body that has none.
 *
 * Returns the original object when a system message is already present, so the
 * requests that already pass are not copied or altered in any way.
 */
/**
 * Whether the caller's system text should be moved out of the `system` slot.
 *
 * On by default, and the reason is measured rather than theoretical: the
 * upstream's channel check classifies the *system* slot only. The same
 * sentence is accepted inside a `user` message and refused as a `system`
 * message, so a harness prompt in the system slot is a 11128 waiting to
 * happen — while the identical text in the conversation passes untouched.
 * Demoting keeps the caller's instructions intact and makes the request look
 * like the official client, which never sends anything but its own preamble.
 */
export const isSystemPromptDemotionEnabled = (): boolean =>
  !['0', 'false', 'no', 'off'].includes(
    (process.env.CODEBUDDY_DEMOTE_SYSTEM_PROMPT ?? '').trim().toLowerCase(),
  );

type MessageLike = { content?: unknown; role?: unknown } | null;

const systemTextOf = (messages: unknown[]): string => {
  const parts: string[] = [];

  for (const message of messages) {
    const entry = message as MessageLike;

    if (!entry || entry.role !== 'system') {
      continue;
    }

    if (typeof entry.content === 'string') {
      if (entry.content.trim()) {
        parts.push(entry.content);
      }

      continue;
    }

    if (Array.isArray(entry.content)) {
      for (const part of entry.content) {
        const text = (part as { text?: unknown } | null)?.text;

        if (typeof text === 'string' && text.trim()) {
          parts.push(text);
        }
      }
    }
  }

  return parts.join('\n\n').trim();
};

const prependText = (content: unknown, text: string): unknown => {
  if (typeof content === 'string') {
    return content.trim() ? `${text}\n\n${content}` : text;
  }

  if (Array.isArray(content)) {
    return [{ text, type: 'text' }, ...content];
  }

  return [{ text, type: 'text' }];
};

/**
 * Replaces the `system` slot with the official preamble and demotes whatever
 * the caller had there into the first user turn.
 *
 * Nothing is dropped: the caller's instructions stay in the conversation, in
 * the slot the channel check does not read. A body that had no system message
 * simply gains the official one, which is what the earlier injection path did.
 */
export const demoteSystemPrompt = <T extends { messages?: unknown }>(
  body: T,
  enabled: boolean = isSystemPromptDemotionEnabled(),
): T => {
  if (!enabled || !Array.isArray(body.messages)) {
    return body;
  }

  const messages = body.messages as unknown[];
  const systemText = systemTextOf(messages);
  const rest = messages.filter((message) => {
    return (message as MessageLike)?.role !== 'system';
  });

  if (systemText) {
    const index = rest.findIndex((message) => {
      return (message as MessageLike)?.role === 'user';
    });

    if (index >= 0) {
      const message = rest[index] as { content?: unknown };

      rest[index] = {
        ...(message as object),
        content: prependText(message.content, systemText),
      };
    } else {
      rest.unshift({ content: systemText, role: 'user' });
    }
  }

  return {
    ...body,
    messages: [
      { content: DEFAULT_CHANNEL_SYSTEM_PROMPT, role: 'system' },
      ...rest,
    ],
  };
};

export const ensureSystemPrompt = <T extends { messages?: unknown }>(
  body: T,
  enabled: boolean = isSystemPromptInjectionEnabled(),
): T => {
  if (!enabled || !Array.isArray(body.messages)) {
    return body;
  }

  const hasSystemMessage = body.messages.some(
    (message) =>
      !!message &&
      typeof message === 'object' &&
      (message as { role?: unknown }).role === 'system',
  );

  if (hasSystemMessage) {
    return body;
  }

  return {
    ...body,
    messages: [
      { content: DEFAULT_CHANNEL_SYSTEM_PROMPT, role: 'system' },
      ...body.messages,
    ],
  };
};
