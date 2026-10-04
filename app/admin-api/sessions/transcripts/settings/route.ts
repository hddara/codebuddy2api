import { getAdminSessionErrorResponse } from '@/lib/server/admin/session';
import {
  getSessionTranscriptSettings,
  pruneSessionTranscripts,
  updateSessionTranscriptSettings,
} from '@/lib/server/domain/session-transcripts';
import { getJsonBody } from '@/lib/server/shared/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Retention controls for the stored transcripts.
 *
 * Two limits apply together — `retentionDays` (age) and `maxEntries` (count) —
 * and whichever is reached first prunes. Saving re-runs the prune immediately so
 * the effect is visible without waiting for the next recorded turn.
 */
export const GET = async (request: Request): Promise<Response> => {
  const authError = await getAdminSessionErrorResponse(request);

  if (authError) {
    return authError;
  }

  return Response.json({ settings: await getSessionTranscriptSettings() });
};

export const POST = async (request: Request): Promise<Response> => {
  const authError = await getAdminSessionErrorResponse(request);

  if (authError) {
    return authError;
  }

  const body = await getJsonBody<{
    enabled?: boolean;
    maxEntries?: number;
    retentionDays?: number;
  }>(request);

  const settings = await updateSessionTranscriptSettings({
    enabled: body.enabled,
    maxEntries: body.maxEntries,
    retentionDays: body.retentionDays,
  });

  return Response.json({
    pruned: await pruneSessionTranscripts(settings),
    settings,
  });
};
