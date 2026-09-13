import { ALL_ROLES, requireRole } from '@/lib/server/admin/rbac';
import { DEFAULT_QUOTA_PERIOD, getBalance } from '@/lib/server/domain/quotas';
import {
  getUser,
  normalizeUserPreferences,
  toPublicUser,
  updateUser,
} from '@/lib/server/domain/users';
import { createApiErrorResponse, readJsonBody } from '@/lib/server/shared/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = async (request: Request): Promise<Response> => {
  const guard = await requireRole(request, ALL_ROLES);

  if (!guard.ok) {
    return guard.response;
  }

  return Response.json({
    balance: await getBalance({
      ownerId: guard.user.userId,
      ownerType: 'user',
      period: DEFAULT_QUOTA_PERIOD,
    }),
    user: guard.user,
  });
};

/**
 * Self-service profile update. Role and status are deliberately not accepted
 * here: a member must not be able to grant themselves more access through
 * their own profile endpoint.
 */
export const PATCH = async (request: Request): Promise<Response> => {
  const guard = await requireRole(request, ALL_ROLES);

  if (!guard.ok) {
    return guard.response;
  }

  const body = await readJsonBody<{
    displayName?: unknown;
    preferences?: unknown;
  }>(request);

  if (!body) {
    return createApiErrorResponse(
      400,
      'invalid_json',
      'Request body must be valid JSON',
    );
  }

  if (body.displayName !== undefined && typeof body.displayName !== 'string') {
    return createApiErrorResponse(
      400,
      'invalid_request',
      'displayName must be a string',
    );
  }

  const current = await getUser(guard.user.userId);

  if (!current) {
    return createApiErrorResponse(
      401,
      'admin_auth_required',
      'Admin session required',
    );
  }

  try {
    const user = await updateUser(current.userId, {
      displayName:
        typeof body.displayName === 'string' ? body.displayName : undefined,
      preferences:
        body.preferences === undefined
          ? undefined
          : {
              ...current.preferences,
              ...normalizeUserPreferences(body.preferences),
            },
    });

    return Response.json({ user: toPublicUser(user) });
  } catch (error) {
    return createApiErrorResponse(
      400,
      'invalid_request',
      error instanceof Error ? error.message : 'Failed to update the profile',
    );
  }
};
