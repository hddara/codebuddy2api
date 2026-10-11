import { ensureFallbackTitle } from './session-titles';
import { generateSessionTitle } from './session-title-generator';
import { subscribeToSessionEvents, type SessionEvent } from './session-stream';

/**
 * Turns session stream events into conversation titles.
 *
 * Two moments, deliberately split:
 *
 *  - `session.started` — the question has just arrived. Writes the truncated
 *    fallback *immediately*, so the conversation has a readable label before any
 *    model call happens. Doing this at completion instead would leave the list
 *    showing a bare id for as long as the first answer takes.
 *  - `session.completed` / `session.failed` — the model has answered, so it is
 *    a good time to ask it for a proper summary. Uses the question carried on
 *    the terminal event, which is already extracted by the same code the
 *    transcripts use; there is no second extraction path to keep in sync.
 *
 * Kept separate from the transcript recorder: the two write different things
 * for different reasons, and a failure in one must not affect the other.
 */

interface SessionTitleRecorderState {
  __codebuddy2apiTitleRecorder__?: string;
}

const globalState = globalThis as typeof globalThis & SessionTitleRecorderState;

const FIRST_QUESTION_MAX_CHARS = 4_000;

/**
 * Registers the title recorder. Idempotent, and stored on `globalThis` so a hot
 * reload does not stack subscribers.
 *
 * Never throws: titles are cosmetic and this runs inside the request path's
 * event fan-out, where an exception would be indistinguishable from a failure
 * of the reply itself.
 */
export const ensureSessionTitleRecorder = (): void => {
  if (globalState.__codebuddy2apiTitleRecorder__) {
    return;
  }

  const subscriber = subscribeToSessionEvents({
    conversationIds: new Set<string>(),
    send: (event: SessionEvent): boolean => {
      const question = (event.question ?? '').slice(
        0,
        FIRST_QUESTION_MAX_CHARS,
      );

      if (event.type === 'session.started') {
        if (question.trim()) {
          // Fire-and-forget: the list must not wait on storage.
          void ensureFallbackTitle({
            conversationId: event.conversationId,
            question,
          }).catch(() => undefined);
        }

        return true;
      }

      if (
        event.type !== 'session.completed' &&
        event.type !== 'session.failed'
      ) {
        return true;
      }

      if (!question.trim()) {
        return true;
      }

      void generateSessionTitle({
        conversationId: event.conversationId,
        model: event.model ?? null,
        question,
      }).catch(() => undefined);

      return true;
    },
  });

  if (subscriber) {
    globalState.__codebuddy2apiTitleRecorder__ = subscriber.id;
  }
};

/** Test/teardown helper. */
export const resetSessionTitleRecorderRuntime = (): void => {
  delete globalState.__codebuddy2apiTitleRecorder__;
};
