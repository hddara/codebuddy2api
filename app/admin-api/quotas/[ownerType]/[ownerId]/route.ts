import { ADMIN_ROLES, OWNER_ROLES, requireRole } from '@/lib/server/admin/rbac';
import {
  type QuotaOwnerType,
  type QuotaPeriod,
  DEFAULT_QUOTA_PERIOD,
  deleteQuotaRecord,
  getBalance,
  getQuotaRecord,
  isQuotaOwnerType,
  isQuotaPeriod,
  quotaOwnerExists,
  setQuotaRecord,
} from '@/lib/server/domain/quotas';
import { createApiErrorResponse, readJsonBody } from '@/lib/server/shared/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ ownerId: string; ownerType: string }>;
}

interface QuotaTarget {
  ownerId: string;
  ownerType: QuotaOwnerType;
  period: QuotaPeriod;
}

type QuotaTargetResult =
  { ok: true; target: QuotaTarget } | { ok: false; response: Response };

const readTarget = async (
  request: Request,
  context: RouteContext,
): Promise<QuotaTargetResult> => {
  const { ownerId, ownerType } = await context.params;

  if (!isQuotaOwnerType(ownerType)) {
    return {
      ok: false,
      response: createApiErrorResponse(
        400,
        'invalid_request',
        'ownerType must be app or user',
      ),
    };
  }

  const periodParam = new URL(request.url).searchParams.get('period');

  if (periodParam !== null && !isQuotaPeriod(periodParam)) {
    return {
      ok: false,
      response: createApiErrorResponse(
        400,
        'invalid_request',
        'period must be daily, monthly or total',
      ),
    };
  }

  return {
    ok: true,
    target: {
      ownerId,
      ownerType,
      period: isQuotaPeriod(periodParam) ? periodParam : DEFAULT_QUOTA_PERIOD,
    },
  };
};

const notFound = (ownerType: QuotaOwnerType, ownerId: string): Response => {
  return createApiErrorResponse(
    404,
    'not_found',
    `No ${ownerType} exists for "${ownerId}"`,
  );
};

const isQuotaLimit = (value: unknown): value is number | null => {
  if (value === null) {
    return true;
  }

  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
};

export const GET = async (
  request: Request,
  context: RouteContext,
): Promise<Response> => {
  const guard = await requireRole(request, ADMIN_ROLES);

  if (!guard.ok) {
    return guard.response;
  }

  const resolved = await readTarget(request, context);

  if (!resolved.ok) {
    return resolved.response;
  }

  const { ownerId, ownerType, period } = resolved.target;

  if (!(await quotaOwnerExists(ownerType, ownerId))) {
    return notFound(ownerType, ownerId);
  }

  return Response.json({
    balance: await getBalance({ ownerId, ownerType, period }),
  });
};

export const PUT = async (
  request: Request,
  context: RouteContext,
): Promise<Response> => {
  const guard = await requireRole(request, OWNER_ROLES);

  if (!guard.ok) {
    return guard.response;
  }

  const resolved = await readTarget(request, context);

  if (!resolved.ok) {
    return resolved.response;
  }

  const { ownerId, ownerType, period } = resolved.target;

  if (!(await quotaOwnerExists(ownerType, ownerId))) {
    return notFound(ownerType, ownerId);
  }

  const body = await readJsonBody<{
    maxCalls?: unknown;
    maxTokens?: unknown;
  }>(request);

  if (!body) {
    return createApiErrorResponse(
      400,
      'invalid_json',
      'Request body must be valid JSON',
    );
  }

  const maxCalls = body.maxCalls;
  const maxTokens = body.maxTokens;

  if (maxCalls !== undefined && !isQuotaLimit(maxCalls)) {
    return createApiErrorResponse(
      400,
      'invalid_request',
      'maxCalls must be a non-negative integer or null',
    );
  }

  if (maxTokens !== undefined && !isQuotaLimit(maxTokens)) {
    return createApiErrorResponse(
      400,
      'invalid_request',
      'maxTokens must be a non-negative integer or null',
    );
  }

  // Omitted limits keep the stored value; an explicit null means unlimited.
  const current = await getQuotaRecord({ ownerId, ownerType, period });
  const quota = await setQuotaRecord({
    maxCalls: maxCalls === undefined ? (current?.maxCalls ?? null) : maxCalls,
    maxTokens:
      maxTokens === undefined ? (current?.maxTokens ?? null) : maxTokens,
    ownerId,
    ownerType,
    period,
  });

  return Response.json({
    balance: await getBalance({ ownerId, ownerType, period }),
    quota,
  });
};

export const DELETE = async (
  request: Request,
  context: RouteContext,
): Promise<Response> => {
  const guard = await requireRole(request, OWNER_ROLES);

  if (!guard.ok) {
    return guard.response;
  }

  const resolved = await readTarget(request, context);

  if (!resolved.ok) {
    return resolved.response;
  }

  const { ownerId, ownerType, period } = resolved.target;
  const removed = await deleteQuotaRecord({ ownerId, ownerType, period });

  if (!removed) {
    return createApiErrorResponse(
      404,
      'not_found',
      'No quota is configured for this owner',
    );
  }

  return Response.json({ success: true });
};
