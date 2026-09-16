import { getAdminSessionErrorResponse } from '@/lib/server/admin/session';
import {
  getAutoCheckinStatus,
  runAutoCheckinNow,
} from '@/lib/server/domain/auto-checkin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = async (request: Request): Promise<Response> => {
  const authError = await getAdminSessionErrorResponse(request);

  if (authError) {
    return authError;
  }

  return Response.json({ status: await getAutoCheckinStatus() });
};

export const POST = async (request: Request): Promise<Response> => {
  const authError = await getAdminSessionErrorResponse(request);

  if (authError) {
    return authError;
  }

  return Response.json({ status: await runAutoCheckinNow() });
};
