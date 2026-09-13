import { ADMIN_ROLES, OWNER_ROLES, requireRole } from '@/lib/server/admin/rbac';
import {
  type BillingPlan,
  type BillingPlanPeriod,
  deleteBillingAccount,
  getBillingAccount,
  saveBillingAccount,
} from '@/lib/server/domain/billing';
import { getUser } from '@/lib/server/domain/users';
import { createApiErrorResponse, readJsonBody } from '@/lib/server/shared/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ userId: string }>;
}

const isTokenCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

const toOptionalText = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();

  return trimmed ? trimmed : undefined;
};

const toIsoOr = (value: unknown, fallback: string): string => {
  if (typeof value !== 'string') {
    return fallback;
  }

  const ms = Date.parse(value);

  return Number.isFinite(ms) ? new Date(ms).toISOString() : fallback;
};

const addPlanPeriod = (startIso: string, period: BillingPlanPeriod): string => {
  const start = new Date(startIso);

  if (period === 'yearly') {
    start.setUTCFullYear(start.getUTCFullYear() + 1);
  } else {
    start.setUTCMonth(start.getUTCMonth() + 1);
  }

  return start.toISOString();
};

/** Returns null when the payload cannot describe a plan. */
const readPlan = (value: unknown): BillingPlan | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const name = toOptionalText(record.name);

  if (!name || !isTokenCount(record.tokens)) {
    return null;
  }

  const period: BillingPlanPeriod =
    record.period === 'yearly' ? 'yearly' : 'monthly';
  const startedAt = toIsoOr(record.startedAt, new Date().toISOString());

  return {
    bonus: toOptionalText(record.bonus),
    discount: toOptionalText(record.discount),
    expiresAt: toIsoOr(record.expiresAt, addPlanPeriod(startedAt, period)),
    name,
    note: toOptionalText(record.note),
    period,
    startedAt,
    tokens: record.tokens,
  };
};

const resolveUser = async (context: RouteContext) => {
  const { userId } = await context.params;

  return getUser(userId);
};

export const GET = async (
  request: Request,
  context: RouteContext,
): Promise<Response> => {
  const guard = await requireRole(request, ADMIN_ROLES);

  if (!guard.ok) {
    return guard.response;
  }

  const user = await resolveUser(context);

  if (!user) {
    return createApiErrorResponse(404, 'not_found', 'User not found');
  }

  return Response.json({ account: await getBillingAccount(user.userId) });
};

export const PUT = async (
  request: Request,
  context: RouteContext,
): Promise<Response> => {
  const guard = await requireRole(request, OWNER_ROLES);

  if (!guard.ok) {
    return guard.response;
  }

  const user = await resolveUser(context);

  if (!user) {
    return createApiErrorResponse(404, 'not_found', 'User not found');
  }

  const body = await readJsonBody<{
    balanceTokens?: unknown;
    plan?: unknown;
    topUpTokens?: unknown;
  }>(request);

  if (!body) {
    return createApiErrorResponse(
      400,
      'invalid_json',
      'Request body must be valid JSON',
    );
  }

  if (body.balanceTokens !== undefined && !isTokenCount(body.balanceTokens)) {
    return createApiErrorResponse(
      400,
      'invalid_request',
      'balanceTokens must be a non-negative integer',
    );
  }

  if (body.topUpTokens !== undefined && !isTokenCount(body.topUpTokens)) {
    return createApiErrorResponse(
      400,
      'invalid_request',
      'topUpTokens must be a non-negative integer',
    );
  }

  const plan = body.plan === undefined ? undefined : readPlan(body.plan);

  if (body.plan !== undefined && body.plan !== null && !plan) {
    return createApiErrorResponse(
      400,
      'invalid_request',
      'plan must provide a name and a non-negative integer token count',
    );
  }

  const existing = await getBillingAccount(user.userId);
  let balanceTokens: number | undefined;

  if (typeof body.balanceTokens === 'number') {
    balanceTokens = body.balanceTokens;
  } else if (typeof body.topUpTokens === 'number') {
    balanceTokens = (existing?.balanceTokens ?? 0) + body.topUpTokens;
  }

  const account = await saveBillingAccount(user.userId, {
    balanceTokens,
    plan: body.plan === undefined ? undefined : plan,
  });

  return Response.json({ account });
};

/** Removes the account, which returns the user to "unrestricted". */
export const DELETE = async (
  request: Request,
  context: RouteContext,
): Promise<Response> => {
  const guard = await requireRole(request, OWNER_ROLES);

  if (!guard.ok) {
    return guard.response;
  }

  const user = await resolveUser(context);

  if (!user) {
    return createApiErrorResponse(404, 'not_found', 'User not found');
  }

  await deleteBillingAccount(user.userId);

  return Response.json({ success: true });
};
