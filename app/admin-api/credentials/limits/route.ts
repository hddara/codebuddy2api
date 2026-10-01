import { getAdminSessionErrorResponse } from '@/lib/server/admin/session';
import {
  clearCredentialLimits,
  listCredentialLimits,
} from '@/lib/server/domain/credentials';
import {
  createErrorResponse,
  readJsonBodyOrErrorResponse,
} from '@/lib/server/shared/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = async (request: Request): Promise<Response> => {
  const authError = await getAdminSessionErrorResponse(request);

  if (authError) {
    return authError;
  }

  return Response.json({ limits: await listCredentialLimits() });
};

/**
 * Manual release of the rate limit marks. Omitting `filename` releases every
 * credential, which is the recovery path when the upstream reported limits that
 * no longer apply.
 */
export const POST = async (request: Request): Promise<Response> => {
  const authError = await getAdminSessionErrorResponse(request);

  if (authError) {
    return authError;
  }

  const parsed = await readJsonBodyOrErrorResponse<{ filename?: unknown }>(
    request,
  );

  if ('response' in parsed) {
    return parsed.response;
  }

  const { filename } = parsed.body;

  if (filename !== undefined && typeof filename !== 'string') {
    return createErrorResponse(400, 'filename must be a string');
  }

  const target = typeof filename === 'string' ? filename.trim() : '';
  const cleared = await clearCredentialLimits(target ? [target] : undefined);

  return Response.json({ cleared, success: true });
};
