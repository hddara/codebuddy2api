import { ALL_ROLES, requireRole } from '@/lib/server/admin/rbac';
import {
  createApplication,
  findApplicationById,
  listApplicationRecords,
  toOwnedApplicationSummary,
} from '@/lib/server/domain/applications';
import { createApiErrorResponse, readJsonBody } from '@/lib/server/shared/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Lists the applications owned by the signed in user, including the plaintext
 * secret: reading the secret of your own application is an explicit product
 * decision, and it is scoped by `ownerUserId` so nobody sees another user's
 * applications.
 */
export const GET = async (request: Request): Promise<Response> => {
  const guard = await requireRole(request, ALL_ROLES);

  if (!guard.ok) {
    return guard.response;
  }

  const applications = await listApplicationRecords();

  return Response.json({
    applications: applications
      .filter((record) => record.ownerUserId === guard.user.userId)
      .map(toOwnedApplicationSummary),
  });
};

/**
 * Members can create their own API keys. The key is not bound to CodeBuddy
 * credentials: those stay under administrator control, so the request simply
 * follows the system credential selection.
 */
export const POST = async (request: Request): Promise<Response> => {
  const guard = await requireRole(request, ALL_ROLES);

  if (!guard.ok) {
    return guard.response;
  }

  const body = await readJsonBody<{
    description?: unknown;
    name?: unknown;
  }>(request);

  if (!body) {
    return createApiErrorResponse(
      400,
      'invalid_json',
      'Request body must be valid JSON',
    );
  }

  if (typeof body.name !== 'string') {
    return createApiErrorResponse(400, 'invalid_request', 'name is required');
  }

  if (body.description !== undefined && typeof body.description !== 'string') {
    return createApiErrorResponse(
      400,
      'invalid_request',
      'description must be a string',
    );
  }

  try {
    const { application } = await createApplication({
      credentialFilenames: [],
      description:
        typeof body.description === 'string' ? body.description : undefined,
      name: body.name,
      ownerUserId: guard.user.userId,
    });
    const created = await findApplicationById(application.id);

    return Response.json({
      application: created
        ? toOwnedApplicationSummary(created)
        : { ...application, secret: '' },
    });
  } catch (error) {
    return createApiErrorResponse(
      400,
      'invalid_request',
      error instanceof Error
        ? error.message
        : 'Failed to create the application',
    );
  }
};
