import { ALL_ROLES, OWNER_ROLES, requireRole } from '@/lib/server/admin/rbac';
import {
  clearSessionLogs,
  getSessionLogState,
  listSessionLogs,
} from '@/lib/server/domain/session-logs';
import { createApiErrorResponse } from '@/lib/server/shared/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

export const GET = async (request: Request): Promise<Response> => {
  const guard = await requireRole(request, ALL_ROLES);

  if (!guard.ok) {
    return guard.response;
  }

  const limitParam = new URL(request.url).searchParams.get('limit');
  const requestedLimit = limitParam ? Number.parseInt(limitParam, 10) : NaN;
  const limit =
    Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, MAX_LIMIT)
      : DEFAULT_LIMIT;

  if (limitParam !== null && !Number.isFinite(requestedLimit)) {
    return createApiErrorResponse(
      400,
      'invalid_request',
      'limit must be a positive integer',
    );
  }

  // Members only ever see the conversations of their own applications.
  const scopedUserId =
    guard.user.role === 'member' ? guard.user.userId : undefined;

  return Response.json({
    logs: await listSessionLogs({ limit, userId: scopedUserId }),
    state: await getSessionLogState(),
  });
};

export const DELETE = async (request: Request): Promise<Response> => {
  const guard = await requireRole(request, OWNER_ROLES);

  if (!guard.ok) {
    return guard.response;
  }

  return Response.json({ removed: await clearSessionLogs(), success: true });
};
