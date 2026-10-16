import { renewAdminSession } from '@/lib/server/admin/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Exchanges a valid console session for a fresh one.
 *
 * A `POST` rather than a `GET` even though nothing is persisted by the caller:
 * the call revokes the token it was given, so it is not safe to prefetch, retry
 * blindly or replay from a cache. The native client hits this once per unlock.
 *
 * See `renewAdminSession` for why the old token is retired and why this cannot
 * be used to obtain a session that did not already exist.
 */
export const POST = async (request: Request): Promise<Response> => {
  return await renewAdminSession(request);
};
