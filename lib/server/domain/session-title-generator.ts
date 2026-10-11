import { NextRequest } from 'next/server';

import { proxyChatCompletions } from '../proxy/codebuddy';
import {
  beginTitleGeneration,
  buildTitlePrompt,
  cleanTitleForStorage,
  endTitleGeneration,
  getSessionTitle,
  needsAiTitle,
  setSessionTitle,
} from './session-titles';

/**
 * Asks the gateway's own model for a short conversation title.
 *
 * The call reuses the normal proxy path rather than opening an HTTP request to
 * ourselves: `proxyChatCompletions` already carries credential selection, model
 * alias resolution and rotation, and a round trip through the front door would
 * re-enter the same code with extra failure modes (and no benefits).
 *
 * Everything here is best-effort. A title is cosmetic; it must never turn a
 * successful reply into a failed request, so all failures are swallowed and the
 * caller keeps whatever label it already had.
 */

/** Titles are cosmetic: give up quickly rather than hold a slot open. */
const TITLE_TIMEOUT_MS = 20_000;

/** A summarised title is one short phrase; this bounds a runaway generation. */
const TITLE_MAX_TOKENS = 32;

/**
 * Synthetic request used to reach the upstream.
 *
 * `resolveProxyContext` reads the access key from the headers and
 * `buildUpstreamHeaders` forwards the caller's context, so the request cannot be
 * omitted — but it must carry **no** conversation id, or generating a title would
 * itself be recorded as activity in the conversation it is naming.
 */
const buildInternalRequest = (): NextRequest =>
  new NextRequest('http://internal.local/admin-api/sessions/title', {
    headers: {
      'content-type': 'application/json',
      'x-internal-call': 'session-title',
    },
    method: 'POST',
  });

interface CompletionChoice {
  message?: { content?: unknown };
}

interface CompletionResponse {
  choices?: CompletionChoice[];
}

const readCompletionText = (payload: unknown): string => {
  const choices = (payload as CompletionResponse | null)?.choices;

  if (!Array.isArray(choices) || !choices.length) {
    return '';
  }

  const content = choices[0]?.message?.content;

  return typeof content === 'string' ? content : '';
};

/**
 * Generates and stores a title for one conversation.
 *
 * Runs the model summary only when the stored title is still the truncated
 * fallback (or absent). A `manual` rename and an existing `ai` title are both
 * left alone — regenerating on every turn would let the name drift under the
 * user, and would cost a call per turn for no benefit.
 *
 * Returns the stored record, or null when nothing was written.
 */
export const generateSessionTitle = async ({
  conversationId,
  question,
  model,
}: {
  conversationId: string;
  question: string;
  /** Model to summarise with; falls back to the gateway default when null. */
  model?: string | null;
}): Promise<{ source: string; title: string } | null> => {
  if (!conversationId || !question.trim()) {
    return null;
  }

  try {
    const existing = await getSessionTitle(conversationId);

    if (!needsAiTitle(existing)) {
      return existing
        ? { source: existing.source, title: existing.title }
        : null;
    }

    // Several turns of one conversation can finish at once; without this each
    // would ask the model the same question.
    if (!beginTitleGeneration(conversationId)) {
      return null;
    }

    try {
      const response = await proxyChatCompletions(
        buildInternalRequest(),
        {
          max_tokens: TITLE_MAX_TOKENS,
          messages: [
            { content: buildTitlePrompt(question), role: 'user' as const },
          ],
          model: model ?? undefined,
          stream: false,
          temperature: 0.2,
        },
        undefined,
        undefined,
        '/admin-api/sessions/title',
      );

      if (!response.ok) {
        return null;
      }

      const payload = (await response.json()) as unknown;
      const raw = readCompletionText(payload);
      const cleaned = cleanTitleForStorage(raw);

      if (!cleaned) {
        // The model replied with something unusable. Keep the fallback rather
        // than overwriting a workable label with an empty one.
        return null;
      }

      const record = await setSessionTitle({
        conversationId,
        source: 'ai',
        title: cleaned,
      });

      return record ? { source: record.source, title: record.title } : null;
    } finally {
      endTitleGeneration(conversationId);
    }
  } catch {
    // Best-effort by design: title generation must never surface as an error.
    return null;
  }
};

export { TITLE_TIMEOUT_MS };
