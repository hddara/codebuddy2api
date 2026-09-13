import { ADMIN_ROLES, requireRole } from '@/lib/server/admin/rbac';
import {
  type QuotaPeriod,
  DEFAULT_QUOTA_PERIOD,
  isQuotaPeriod,
  listQuotaBalances,
} from '@/lib/server/domain/quotas';
import { createApiErrorResponse } from '@/lib/server/shared/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = async (request: Request): Promise<Response> => {
  const guard = await requireRole(request, ADMIN_ROLES);

  if (!guard.ok) {
    return guard.response;
  }

  const periodParam = new URL(request.url).searchParams.get('period');

  if (periodParam !== null && !isQuotaPeriod(periodParam)) {
    return createApiErrorResponse(
      400,
      'invalid_request',
      'period must be daily, monthly or total',
    );
  }

  const period: QuotaPeriod = isQuotaPeriod(periodParam)
    ? periodParam
    : DEFAULT_QUOTA_PERIOD;

  return Response.json({ balances: await listQuotaBalances(period) });
};
