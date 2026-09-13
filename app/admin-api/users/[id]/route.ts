import { ADMIN_ROLES, OWNER_ROLES, requireRole } from '@/lib/server/admin/rbac';
import { getAdminSessionSummary } from '@/lib/server/admin/session';
import {
  type UserRole,
  type UserStatus,
  deleteUser,
  getUser,
  getUserByUsername,
  isLastActiveOwner,
  isUserRole,
  isUserStatus,
  normalizeUserPreferences,
  toPublicUser,
  updateUser,
} from '@/lib/server/domain/users';
import { createApiErrorResponse, readJsonBody } from '@/lib/server/shared/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

const notFound = (id: string): Response => {
  return createApiErrorResponse(404, 'not_found', `User "${id}" was not found`);
};

export const GET = async (
  request: Request,
  context: RouteContext,
): Promise<Response> => {
  const guard = await requireRole(request, ADMIN_ROLES);

  if (!guard.ok) {
    return guard.response;
  }

  const { id } = await context.params;
  const user = await getUser(id);

  if (!user) {
    return notFound(id);
  }

  return Response.json({ user: toPublicUser(user) });
};

export const PATCH = async (
  request: Request,
  context: RouteContext,
): Promise<Response> => {
  const guard = await requireRole(request, OWNER_ROLES);

  if (!guard.ok) {
    return guard.response;
  }

  const { id } = await context.params;
  const current = await getUser(id);

  if (!current) {
    return notFound(id);
  }

  const body = await readJsonBody<{
    displayName?: unknown;
    password?: unknown;
    preferences?: unknown;
    role?: unknown;
    status?: unknown;
    username?: unknown;
  }>(request);

  if (!body) {
    return createApiErrorResponse(
      400,
      'invalid_json',
      'Request body must be valid JSON',
    );
  }

  if (body.role !== undefined && !isUserRole(body.role)) {
    return createApiErrorResponse(
      400,
      'invalid_request',
      'role must be one of owner, admin or member',
    );
  }

  if (body.status !== undefined && !isUserStatus(body.status)) {
    return createApiErrorResponse(
      400,
      'invalid_request',
      'status must be active or disabled',
    );
  }

  if (body.username !== undefined && typeof body.username !== 'string') {
    return createApiErrorResponse(
      400,
      'invalid_request',
      'username must be a string',
    );
  }

  if (body.displayName !== undefined && typeof body.displayName !== 'string') {
    return createApiErrorResponse(
      400,
      'invalid_request',
      'displayName must be a string',
    );
  }

  if (body.password !== undefined && typeof body.password !== 'string') {
    return createApiErrorResponse(
      400,
      'invalid_request',
      'password must be a string',
    );
  }

  const nextRole: UserRole = isUserRole(body.role) ? body.role : current.role;
  const nextStatus: UserStatus = isUserStatus(body.status)
    ? body.status
    : current.status;
  const losesActiveOwner =
    current.role === 'owner' &&
    (nextRole !== 'owner' || nextStatus !== 'active');

  // The console credential is stored in the admin-auth state as well, so it is
  // only changed through the password settings; editing it here would leave the
  // two copies out of step (the legacy login fallback would keep accepting the
  // previous password).
  if (body.password !== undefined || body.username !== undefined) {
    const consoleUsername = (await getAdminSessionSummary(request)).username;
    const consoleOwner = await getUserByUsername(consoleUsername);

    if (consoleOwner?.userId === id) {
      return createApiErrorResponse(
        409,
        'console_owner_credentials',
        'The built-in owner password and username are changed through the password settings',
      );
    }
  }

  if (losesActiveOwner && (await isLastActiveOwner(id))) {
    return createApiErrorResponse(
      409,
      'last_owner',
      'The last active owner cannot be demoted or disabled',
    );
  }

  try {
    const user = await updateUser(id, {
      displayName:
        typeof body.displayName === 'string' ? body.displayName : undefined,
      password: typeof body.password === 'string' ? body.password : undefined,
      preferences:
        body.preferences === undefined
          ? undefined
          : {
              ...current.preferences,
              ...normalizeUserPreferences(body.preferences),
            },
      role: isUserRole(body.role) ? body.role : undefined,
      status: isUserStatus(body.status) ? body.status : undefined,
      username: typeof body.username === 'string' ? body.username : undefined,
    });

    return Response.json({ user: toPublicUser(user) });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to update the user';

    return createApiErrorResponse(
      message.includes('already taken') ? 409 : 400,
      message.includes('already taken') ? 'conflict' : 'invalid_request',
      message,
    );
  }
};

export const DELETE = async (
  request: Request,
  context: RouteContext,
): Promise<Response> => {
  const guard = await requireRole(request, OWNER_ROLES);

  if (!guard.ok) {
    return guard.response;
  }

  const { id } = await context.params;

  if (!(await getUser(id))) {
    return notFound(id);
  }

  if (guard.user.userId === id) {
    return createApiErrorResponse(
      409,
      'cannot_delete_self',
      'You cannot delete your own account',
    );
  }

  if (await isLastActiveOwner(id)) {
    return createApiErrorResponse(
      409,
      'last_owner',
      'The last active owner cannot be deleted',
    );
  }

  await deleteUser(id);

  return Response.json({ success: true });
};
