import { ALL_ROLES, requireRole } from '@/lib/server/admin/rbac';
import {
  changeAdminPassword,
  hasAdminPassword,
} from '@/lib/server/admin/session';
import { authenticateUser, updateUser } from '@/lib/server/domain/users';
import { createApiErrorResponse, readJsonBody } from '@/lib/server/shared/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = async (request: Request): Promise<Response> => {
  const guard = await requireRole(request, ALL_ROLES);

  if (!guard.ok) {
    return guard.response;
  }

  const body = await readJsonBody<{
    currentPassword?: unknown;
    newPassword?: unknown;
  }>(request);

  if (!body) {
    return createApiErrorResponse(
      400,
      'invalid_json',
      'Request body must be valid JSON',
    );
  }

  const currentPassword =
    typeof body.currentPassword === 'string' ? body.currentPassword : '';
  const newPassword =
    typeof body.newPassword === 'string' ? body.newPassword : '';

  if (!currentPassword || !newPassword) {
    return createApiErrorResponse(
      400,
      'invalid_request',
      'currentPassword and newPassword are required',
    );
  }

  const verified = await authenticateUser(guard.user.username, currentPassword);

  if (!verified || verified.userId !== guard.user.userId) {
    return createApiErrorResponse(
      401,
      'invalid_credentials',
      'Current password is invalid',
    );
  }

  // The owner credential is mirrored in the admin-auth state, so it has to go
  // through the existing flow to keep both copies in step. Members only exist
  // in the user store and must not touch the admin-auth sessions.
  if (guard.user.role === 'owner' && (await hasAdminPassword())) {
    return changeAdminPassword(request, currentPassword, newPassword);
  }

  try {
    await updateUser(guard.user.userId, { password: newPassword });
  } catch (error) {
    return createApiErrorResponse(
      400,
      'invalid_request',
      error instanceof Error ? error.message : 'Failed to change the password',
    );
  }

  return Response.json({ success: true });
};
