import { getAdminSessionErrorResponse } from '@/lib/server/admin/session';
import {
  getSessionSummaries,
  normalizeSessionWindowMinutes,
} from '@/lib/server/domain/sessions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Lists conversations seen by the gateway within a time window, grouped by the
 * `x-conversation-id` the client sends. `?windowMinutes=` tunes the window.
 */
export const GET = async (request: Request): Promise<Response> => {
  const authError = await getAdminSessionErrorResponse(request);

  if (authError) {
    return authError;
  }

  const rawWindow = new URL(request.url).searchParams.get('windowMinutes');
  const windowMinutes = normalizeSessionWindowMinutes(rawWindow ?? undefined);

  return Response.json(await getSessionSummaries({ windowMinutes }));
};
