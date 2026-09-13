import { ALL_ROLES, requireRole } from '@/lib/server/admin/rbac';
import { getSessionLog } from '@/lib/server/domain/session-logs';
import { createApiErrorResponse } from '@/lib/server/shared/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const GET = async (
  request: Request,
  context: RouteContext,
): Promise<Response> => {
  const guard = await requireRole(request, ALL_ROLES);

  if (!guard.ok) {
    return guard.response;
  }

  const { id } = await context.params;
  const log = await getSessionLog(id);

  // A member must not be able to tell somebody else's session apart from a
  // missing one.
  if (
    !log ||
    (guard.user.role === 'member' && log.userId !== guard.user.userId)
  ) {
    return createApiErrorResponse(404, 'not_found', 'Session not found');
  }

  return Response.json({ log });
};
