import { ADMIN_ROLES, OWNER_ROLES, requireRole } from '@/lib/server/admin/rbac';
import {
  createUser,
  isUserRole,
  listPublicUsers,
  normalizeUserPreferences,
  toPublicUser,
} from '@/lib/server/domain/users';
import { createApiErrorResponse, readJsonBody } from '@/lib/server/shared/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = async (request: Request): Promise<Response> => {
  const guard = await requireRole(request, ADMIN_ROLES);

  if (!guard.ok) {
    return guard.response;
  }

  return Response.json({ users: await listPublicUsers() });
};

export const POST = async (request: Request): Promise<Response> => {
  const guard = await requireRole(request, OWNER_ROLES);

  if (!guard.ok) {
    return guard.response;
  }

  const body = await readJsonBody<{
    displayName?: unknown;
    password?: unknown;
    preferences?: unknown;
    role?: unknown;
    username?: unknown;
  }>(request);

  if (!body) {
    return createApiErrorResponse(
      400,
      'invalid_json',
      'Request body must be valid JSON',
    );
  }

  if (typeof body.username !== 'string' || !body.username.trim()) {
    return createApiErrorResponse(
      400,
      'invalid_request',
      'username is required',
    );
  }

  const role = body.role === undefined ? 'member' : body.role;

  if (!isUserRole(role)) {
    return createApiErrorResponse(
      400,
      'invalid_request',
      'role must be one of owner, admin or member',
    );
  }

  if (body.password !== undefined && typeof body.password !== 'string') {
    return createApiErrorResponse(
      400,
      'invalid_request',
      'password must be a string',
    );
  }

  if (body.displayName !== undefined && typeof body.displayName !== 'string') {
    return createApiErrorResponse(
      400,
      'invalid_request',
      'displayName must be a string',
    );
  }

  if (
    body.preferences !== undefined &&
    (typeof body.preferences !== 'object' ||
      body.preferences === null ||
      Array.isArray(body.preferences))
  ) {
    return createApiErrorResponse(
      400,
      'invalid_request',
      'preferences must be an object',
    );
  }

  try {
    const user = await createUser({
      displayName:
        typeof body.displayName === 'string' ? body.displayName : undefined,
      password: typeof body.password === 'string' ? body.password : undefined,
      preferences:
        body.preferences === undefined
          ? undefined
          : normalizeUserPreferences(body.preferences),
      role,
      username: body.username,
    });

    return Response.json({ user: toPublicUser(user) });
  } catch (error) {
    return createApiErrorResponse(
      400,
      'invalid_request',
      error instanceof Error ? error.message : 'Failed to create the user',
    );
  }
};
