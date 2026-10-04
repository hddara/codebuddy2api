import { getAdminSessionErrorResponse } from '@/lib/server/admin/session';
import {
  clearSessionTranscripts,
  listSessionTranscripts,
} from '@/lib/server/domain/session-transcripts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Stored question/answer turns.
 *
 * `?conversationId=` narrows to one conversation and `?limit=` caps the page.
 * `DELETE` clears everything — the stored content is plain conversation text, so
 * an operator needs a way to purge it.
 */
export const GET = async (request: Request): Promise<Response> => {
  const authError = await getAdminSessionErrorResponse(request);

  if (authError) {
    return authError;
  }

  const params = new URL(request.url).searchParams;
  const conversationId = params.get('conversationId')?.trim();
  const rawLimit = params.get('limit');
  const parsedLimit = rawLimit ? Number(rawLimit) : undefined;

  return Response.json(
    await listSessionTranscripts({
      conversationId: conversationId || undefined,
      limit:
        parsedLimit !== undefined && Number.isFinite(parsedLimit)
          ? parsedLimit
          : undefined,
    }),
  );
};

export const DELETE = async (request: Request): Promise<Response> => {
  const authError = await getAdminSessionErrorResponse(request);

  if (authError) {
    return authError;
  }

  return Response.json({ removed: await clearSessionTranscripts() });
};
