import { ALL_ROLES, requireRole } from '@/lib/server/admin/rbac';
import {
  type ApplicationStatus,
  deleteApplication,
  findApplicationById,
  toOwnedApplicationSummary,
  updateApplication,
} from '@/lib/server/domain/applications';
import { createApiErrorResponse, readJsonBody } from '@/lib/server/shared/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

const isApplicationStatus = (value: unknown): value is ApplicationStatus => {
  return value === 'active' || value === 'disabled';
};

export const PATCH = async (
  request: Request,
  context: RouteContext,
): Promise<Response> => {
  const guard = await requireRole(request, ALL_ROLES);

  if (!guard.ok) {
    return guard.response;
  }

  const { id } = await context.params;
  const current = await findApplicationById(id);

  // Somebody else's application is reported as missing, never as forbidden.
  if (!current || current.ownerUserId !== guard.user.userId) {
    return createApiErrorResponse(404, 'not_found', 'Application not found');
  }

  const body = await readJsonBody<{
    description?: unknown;
    name?: unknown;
    status?: unknown;
  }>(request);

  if (!body) {
    return createApiErrorResponse(
      400,
      'invalid_json',
      'Request body must be valid JSON',
    );
  }

  if (body.name !== undefined && typeof body.name !== 'string') {
    return createApiErrorResponse(
      400,
      'invalid_request',
      'name must be a string',
    );
  }

  if (body.description !== undefined && typeof body.description !== 'string') {
    return createApiErrorResponse(
      400,
      'invalid_request',
      'description must be a string',
    );
  }

  if (body.status !== undefined && !isApplicationStatus(body.status)) {
    return createApiErrorResponse(
      400,
      'invalid_request',
      'status must be active or disabled',
    );
  }

  try {
    // Credential binding and ownership are administrator concerns and are
    // deliberately not accepted here.
    const application = await updateApplication(id, {
      description:
        typeof body.description === 'string' ? body.description : undefined,
      name: typeof body.name === 'string' ? body.name : undefined,
      status: isApplicationStatus(body.status) ? body.status : undefined,
    });
    const updated = await findApplicationById(application.id);

    return Response.json({
      application: updated ? toOwnedApplicationSummary(updated) : application,
    });
  } catch (error) {
    return createApiErrorResponse(
      400,
      'invalid_request',
      error instanceof Error
        ? error.message
        : 'Failed to update the application',
    );
  }
};

export const DELETE = async (
  request: Request,
  context: RouteContext,
): Promise<Response> => {
  const guard = await requireRole(request, ALL_ROLES);

  if (!guard.ok) {
    return guard.response;
  }

  const { id } = await context.params;
  const current = await findApplicationById(id);

  if (!current || current.ownerUserId !== guard.user.userId) {
    return createApiErrorResponse(404, 'not_found', 'Application not found');
  }

  await deleteApplication(id);

  return Response.json({ success: true });
};
