import { getAdminSessionErrorResponse } from '@/lib/server/admin/session';
import {
  getSessionSnapshot,
  MAX_SESSION_SUBSCRIBERS,
  type SessionEvent,
  subscribeToSessionEvents,
  unsubscribeFromSessionEvents,
} from '@/lib/server/domain/session-stream';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Comment frame interval, kept under common 60s idle-proxy timeouts. */
const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Bytes this stream may buffer before its consumer is considered stalled.
 *
 * A phone on cellular can lag well behind the model. Without a bound, the
 * gateway would hold the entire reply in memory per subscriber and every other
 * request would pay for it, so a subscriber that stops draining is dropped and
 * expected to reconnect.
 */
const MAX_QUEUE_BYTES = 2 * 1024 * 1024;

/**
 * Streams live conversation activity as Server-Sent Events.
 *
 * `?conversationId=` narrows the subscription to one conversation; omitting it
 * subscribes to every conversation the gateway serves. Each frame is one
 * `SessionEvent` as JSON, so clients can switch on `type` without extra parsing
 * rules.
 *
 * A client that connects while a reply is already streaming receives one
 * `session.snapshot` for each conversation it asked for, because `session.delta`
 * frames carry only the new text — without the seed it would render a partial
 * reply. Subscribers to "all conversations" get the snapshot at the next
 * `session.started` instead, since replaying every live turn on connect would
 * be unbounded. A comment frame every 15s keeps intermediaries from closing an
 * idle connection.
 */
export const GET = async (request: Request): Promise<Response> => {
  const authError = await getAdminSessionErrorResponse(request);

  if (authError) {
    return authError;
  }

  const requested = new URL(request.url).searchParams.get('conversationId');
  const conversationIds = new Set<string>(
    requested
      ? requested
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
      : [],
  );

  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let subscriberId: string | null = null;

  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        let closed = false;

        const cleanup = (): void => {
          if (closed) return;
          closed = true;

          if (heartbeat) {
            clearInterval(heartbeat);
            heartbeat = null;
          }

          if (subscriberId) {
            unsubscribeFromSessionEvents(subscriberId);
            subscriberId = null;
          }
        };

        const closeStream = (): void => {
          cleanup();
          try {
            controller.close();
          } catch {
            // Already closed by the client.
          }
        };

        const write = (chunk: string): boolean => {
          if (closed) return false;

          // A full queue means the consumer stopped draining; drop it instead of
          // buffering the reply in the gateway's heap.
          if (controller.desiredSize !== null && controller.desiredSize <= 0) {
            closeStream();
            return false;
          }

          try {
            controller.enqueue(encoder.encode(chunk));
            return true;
          } catch {
            // The consumer went away between our check and the write.
            closeStream();
            return false;
          }
        };

        const subscriber = subscribeToSessionEvents({
          conversationIds,
          send: (event: SessionEvent): boolean =>
            write(`data: ${JSON.stringify(event)}\n\n`),
        });

        if (!subscriber) {
          write(
            `data: ${JSON.stringify({ message: 'Too many subscribers', type: 'session.overflow' })}\n\n`,
          );
          cleanup();
          try {
            controller.close();
          } catch {
            // Already closed by the client.
          }
          return;
        }

        subscriberId = subscriber.id;

        // Tell the client the stream is live before anything happens, and remind
        // it how many slots are left so it can back off when the gateway is full.
        write(
          `data: ${JSON.stringify({
            availableSlots: MAX_SESSION_SUBSCRIBERS,
            conversationIds: [...conversationIds],
            type: 'stream.ready',
          })}\n\n`,
        );

        // Seed any conversation already mid-reply so the client can render the
        // partial answer it joined late for.
        for (const conversationId of conversationIds) {
          const snapshot = getSessionSnapshot(conversationId);

          if (!snapshot) continue;

          write(
            `data: ${JSON.stringify({
              ...snapshot,
              conversationId,
              occurredAt: Date.now(),
              type: 'session.snapshot',
            })}\n\n`,
          );
        }

        heartbeat = setInterval(() => {
          if (!write(`: keep-alive ${Date.now()}\n\n`)) {
            cleanup();
          }
        }, HEARTBEAT_INTERVAL_MS);

        request.signal.addEventListener('abort', closeStream);
      },
      cancel() {
        if (heartbeat) {
          clearInterval(heartbeat);
          heartbeat = null;
        }

        if (subscriberId) {
          unsubscribeFromSessionEvents(subscriberId);
          subscriberId = null;
        }
      },
    },
    { highWaterMark: MAX_QUEUE_BYTES },
  );

  return new Response(stream, {
    headers: {
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8',
      'X-Accel-Buffering': 'no',
    },
  });
};
