import type { NextRequest } from 'next/server';

import type { PublicUser, UserRole } from '../domain/users';

import {
  getAdminSessionErrorResponse,
  getAdminSessionSummary,
} from './session';

type RequestLike = Request | NextRequest;

export type RoleGuardResult =
  { ok: false; response: Response } | { ok: true; user: PublicUser };

/** Every role that can hold a console session. */
export const ALL_ROLES: UserRole[] = ['owner', 'admin', 'member'];

/** Roles allowed to read the shared administration data. */
export const ADMIN_ROLES: UserRole[] = ['owner', 'admin'];

/** Only an owner may mutate accounts, quotas and other owners' data. */
export const OWNER_ROLES: UserRole[] = ['owner'];

/**
 * Enforces an admin session owning one of the given roles. Rejections reuse the
 * error shape of `getAdminSessionErrorResponse` so clients only ever parse one
 * error format.
 */
/**
 * Guards a route that only administrators (owner/admin) may use, keeping the
 * `Response | null` shape of the legacy session guard so call sites stay simple.
 * Credentials, CodeBuddy accounts and console tooling all go through this.
 *
 * When authentication is disabled the console is a single open local user and
 * there are no roles to check, so those deployments keep working as before.
 */
export const getAdminRoleErrorResponse = async (
  request: RequestLike,
): Promise<Response | null> => {
  const authError = await getAdminSessionErrorResponse(request);

  if (authError) {
    return authError;
  }

  const user = (await getAdminSessionSummary(request)).user;

  if (!user) {
    return null;
  }

  if (!ADMIN_ROLES.includes(user.role)) {
    return Response.json(
      {
        error: {
          code: 'admin_role_required',
          message: `Role "${user.role}" is not allowed for this resource`,
        },
      },
      { status: 403 },
    );
  }

  return null;
};

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
