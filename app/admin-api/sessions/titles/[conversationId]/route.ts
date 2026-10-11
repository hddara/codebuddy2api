import { getAdminSessionErrorResponse } from '@/lib/server/admin/session';
import {
  MAX_TITLE_CHARS,
  renameSession,
} from '@/lib/server/domain/session-titles';
import { getJsonBody } from '@/lib/server/shared/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Renames one conversation.
 *
 * The result is marked `manual`, which is terminal: the model will not overwrite
 * it on later turns. That is the whole reason this endpoint exists rather than
 * reusing whatever the summariser writes — a name a person chose should stay
 * chosen.
 *
 * The title is trimmed and length-capped here as well as in the store. Returning
 * the stored record means a client sees exactly what was saved (including any
 * normalisation) instead of assuming its own input landed unchanged.
 */
export const PATCH = async (
  request: Request,
  { params }: { params: Promise<{ conversationId: string }> },
): Promise<Response> => {
  const authError = await getAdminSessionErrorResponse(request);

  if (authError) {
    return authError;
  }

  const { conversationId } = await params;

  if (!conversationId?.trim()) {
    return Response.json(
      { error: 'conversationId is required' },
      { status: 400 },
    );
  }

  const body = await getJsonBody<{ title?: unknown }>(request);
  const rawTitle = typeof body?.title === 'string' ? body.title : '';

  if (!rawTitle.trim()) {
    return Response.json({ error: 'title is required' }, { status: 400 });
  }

  if (rawTitle.length > MAX_TITLE_CHARS) {
    return Response.json(
      { error: `title must be at most ${MAX_TITLE_CHARS} characters` },
      { status: 400 },
    );
  }

  const record = await renameSession({
    conversationId: conversationId.trim(),
    title: rawTitle,
  });

  if (!record) {
    // Only reached when the backend cannot store titles at all (file backend)
    // or the cleaned title was empty.
    return Response.json(
      { error: 'title could not be stored' },
      { status: 503 },
    );
  }

  return Response.json({ session: record });
};
