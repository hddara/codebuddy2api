import { getAdminSessionErrorResponse } from '@/lib/server/admin/session';
import { readCredentialRecords } from '@/lib/server/domain/credentials';
import {
  checkinAccounts,
  checkinAccount,
  getAccountStatus,
  getAccountStatusCredentials,
} from '@/lib/server/domain/account-status';
import { getJsonBody } from '@/lib/server/shared/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The account status page lists every saved credential, expired ones included,
 * so a package table can be expanded for any of them. Only the eligible records
 * can be queried upstream, so the snapshots are left out for the rest instead of
 * being requested and failing.
 */
export const GET = async (request: Request): Promise<Response> => {
  const authError = await getAdminSessionErrorResponse(request);
  if (authError) return authError;
  const [credentials, eligible] = await Promise.all([
    getAccountStatusCredentials(),
    readCredentialRecords(),
  ]);
  const statuses = eligible.length ? await getAccountStatus() : [];
  return Response.json({ credentials, statuses });
};

export const POST = async (request: Request): Promise<Response> => {
  const authError = await getAdminSessionErrorResponse(request);
  if (authError) return authError;
  const body = await getJsonBody<{ action?: unknown; filename?: unknown }>(
    request,
  );
  const filename =
    typeof body.filename === 'string' ? body.filename.trim() : '';
  if (body.action === 'checkin') {
    if (filename) {
      return Response.json({ status: await checkinAccount(filename) });
    }
    return Response.json({ statuses: await checkinAccounts() });
  }
  return Response.json({
    statuses: await getAccountStatus(filename ? [filename] : undefined),
  });
};
