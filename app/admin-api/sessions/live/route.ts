import { NextResponse, type NextRequest } from 'next/server';

import { getAdminSessionErrorResponse } from '@/lib/server/admin/session';
import { getSessionSnapshot } from '@/lib/server/domain/session-stream';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Current live text for one conversation.
 *
 * Why this exists alongside `GET /admin-api/sessions/stream`: the App runtime
 * cannot consume an SSE response. Its `plus.net.XMLHttpRequest` accepts the
 * request and exposes a cumulative `response`, but the incremental callbacks do
 * not fire, so a subscribed App sits on "waiting" while the gateway streams into
 * the void — verified by publishing 29 frames against a device and watching the
 * screen stay at `0 字`. `uni.request`'s `enableChunked` is a mini-program
 * feature and does nothing here either.
 *
 * Polling is therefore the transport the App can actually use. The browser build
 * keeps the SSE endpoint, which is strictly better where it works; this route is
 * a small additive read of the same in-process state.
 */
export const GET = async (request: NextRequest): Promise<Response> => {
  const denied = await getAdminSessionErrorResponse(request);

  if (denied) {
    return denied;
  }

  const conversationId = new URL(request.url).searchParams
    .get('conversationId')
    ?.trim();

  if (!conversationId) {
    return NextResponse.json(
      { error: { message: 'conversationId is required' } },
      { status: 400 },
    );
  }

  const snapshot = getSessionSnapshot(conversationId);

  // `live: false` is a normal answer rather than a 404: the turn may simply not
  // have started yet, and the client keeps polling until it does.
  return NextResponse.json({
    accessKeyId: snapshot?.accessKeyId ?? null,
    live: Boolean(snapshot),
    model: snapshot?.model ?? null,
    question: snapshot?.question ?? null,
    text: snapshot?.text ?? '',
  });
};
