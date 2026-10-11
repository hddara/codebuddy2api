import { getAdminSessionErrorResponse } from '@/lib/server/admin/session';
import { listSessionTitles } from '@/lib/server/domain/session-titles';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Every stored conversation title, keyed by conversation id.
 *
 * The session list already carries each title inline; this endpoint exists so a
 * client can tell which conversations still have **no** title, which is what the
 * lazy backfill needs before it asks for generation. Fetching that from the
 * list alone would mean subtracting two lists of ids on every refresh.
 */
export const GET = async (request: Request): Promise<Response> => {
  const authError = await getAdminSessionErrorResponse(request);

  if (authError) {
    return authError;
  }

  try {
    const titles = await listSessionTitles();

    return Response.json({ titles });
  } catch {
    // A listing failure is not an error the client can act on; an empty map
    // degrades to "nothing is titled yet", which is a valid starting state.
    return Response.json({ titles: {} });
  }
};
