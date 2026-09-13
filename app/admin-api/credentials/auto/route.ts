import { getAdminRoleErrorResponse } from '@/lib/server/admin/rbac';
import { resumeAutoRotation } from '@/lib/server/domain/credentials';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = async (request: Request): Promise<Response> => {
  const authError = await getAdminRoleErrorResponse(request);

  if (authError) {
    return authError;
  }

  return Response.json(resumeAutoRotation());
};
