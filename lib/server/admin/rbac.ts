import type { NextRequest } from 'next/server';

import type { PublicUser, UserRole } from '../domain/users';

import {
  getAdminSessionErrorResponse,
  getAdminSessionSummary,
} from './session';

type RequestLike = Request | NextRequest;

export type RoleGuardResult =
  { ok: false; response: Response } | { ok: true; user: PublicUser };

/**
 * Enforces an admin session owning one of the given roles. Rejections reuse the
 * error shape of `getAdminSessionErrorResponse` so clients only ever parse one
 * error format.
 */
export const requireRole = async (
  request: RequestLike,
  roles: UserRole[],
): Promise<RoleGuardResult> => {
  const authError = await getAdminSessionErrorResponse(request);

  if (authError) {
    return { ok: false, response: authError };
  }

  const summary = await getAdminSessionSummary(request);
  const user = summary.user;

  if (!user) {
    return {
      ok: false,
      response: Response.json(
        {
          error: {
            code: 'admin_auth_required',
            message: 'Admin session required',
          },
        },
        { status: 401 },
      ),
    };
  }

  if (!roles.includes(user.role)) {
    return {
      ok: false,
      response: Response.json(
        {
          error: {
            code: 'admin_role_required',
            message: `Role "${user.role}" is not allowed for this resource`,
          },
        },
        { status: 403 },
      ),
    };
  }

  return { ok: true, user };
};
