import {
  deleteStorageJson,
  readStorageJson,
  writeStorageJson,
} from '../storage';
import { listApplicationRecords } from './applications';
import { getUsageTotalsForAccessKeys } from './usage';

export const BILLING_NAMESPACE = 'billing';

export type BillingPlanPeriod = 'monthly' | 'yearly';

/**
 * A prepaid plan: `tokens` are consumed between `startedAt` and `expiresAt`.
 * `period` only drives how the administrator builds `expiresAt`.
 */
export interface BillingPlan {
  name: string;
  tokens: number;
  period: BillingPlanPeriod;
  startedAt: string;
  expiresAt: string;
  /** Free-form annotations for the administrator. */
  note?: string;
  discount?: string;
  bonus?: string;
}

export interface BillingAccountRecord {
  /** Tokens bought through top-ups. Never resets. */
  balanceTokens: number;
  plan: BillingPlan | null;
  updatedAt: string;
}

export interface BillingViolation {
  max: number;
  message: string;
  used: number;
}

const toTokenCount = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : Number(value);

  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
};

const toIsoString = (value: unknown): string | null => {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  const ms = Date.parse(value);

  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

const toOptionalText = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();

  return trimmed ? trimmed : undefined;
};

const parseBillingPlan = (value: unknown): BillingPlan | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const name = toOptionalText(record.name);
  const startedAt = toIsoString(record.startedAt);
  const expiresAt = toIsoString(record.expiresAt);

  if (!name || !startedAt || !expiresAt) {
    return null;
  }

  return {
    bonus: toOptionalText(record.bonus),
    discount: toOptionalText(record.discount),
    expiresAt,
    name,
    note: toOptionalText(record.note),
    period: record.period === 'yearly' ? 'yearly' : 'monthly',
    startedAt,
    tokens: toTokenCount(record.tokens),
  };
};

const parseBillingAccount = (value: unknown): BillingAccountRecord | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;

  return {
    balanceTokens: toTokenCount(record.balanceTokens),
    plan: parseBillingPlan(record.plan),
    updatedAt: toIsoString(record.updatedAt) ?? new Date().toISOString(),
  };
};

/**
 * Every proxied request evaluates the balance, so accounts are cached for a
 * short window. Writes drop the entry, which keeps reads consistent.
 */
const BILLING_CACHE_TTL_MS = 5_000;
let billingCache = new Map<
  string,
  { account: BillingAccountRecord | null; expiresAt: number }
>();

/** Drops cached accounts; tests reset the runtime state between cases. */
export const resetBillingRuntimeState = (): void => {
  billingCache = new Map();
};

export const getBillingAccount = async (
  userId: string,
): Promise<BillingAccountRecord | null> => {
  const cached = billingCache.get(userId);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.account;
  }

  try {
    const value = await readStorageJson<unknown>(BILLING_NAMESPACE, userId);
    const account = parseBillingAccount(value);

    billingCache.set(userId, {
      account,
      expiresAt: Date.now() + BILLING_CACHE_TTL_MS,
    });

    return account;
  } catch (error) {
    // An unreadable document means "no billing configured", which must not
    // make the whole quota evaluation fail. Failures are not cached.
    console.warn('[CodeBuddy2API] Unable to read the billing account', error);

    return null;
  }
};

export interface SaveBillingAccountInput {
  balanceTokens?: number;
  plan?: BillingPlan | null;
}

/** Writes the whole account; omitted fields keep their stored value. */
export const saveBillingAccount = async (
  userId: string,
  input: SaveBillingAccountInput,
): Promise<BillingAccountRecord> => {
  const existing = await getBillingAccount(userId);
  const record: BillingAccountRecord = {
    balanceTokens:
      input.balanceTokens === undefined
        ? (existing?.balanceTokens ?? 0)
        : toTokenCount(input.balanceTokens),
    plan:
      input.plan === undefined
        ? (existing?.plan ?? null)
        : parseBillingPlan(input.plan),
    updatedAt: new Date().toISOString(),
  };

  await writeStorageJson(BILLING_NAMESPACE, userId, record);
  billingCache.delete(userId);

  return record;
};

/** Removes the account, which makes the user unrestricted again. */
export const deleteBillingAccount = async (userId: string): Promise<void> => {
  await deleteStorageJson(BILLING_NAMESPACE, userId);
  billingCache.delete(userId);
};

/** Usage of a user is the sum of every API key they own. */
const resolveOwnerAccessKeyIds = async (userId: string): Promise<string[]> => {
  const applications = await listApplicationRecords();

  return applications
    .filter((record) => record.ownerUserId === userId)
    .map((record) => record.id);
};

const sumTokens = async (
  accessKeyIds: string[],
  startMs: number,
  endMs: number,
): Promise<number> => {
  if (!accessKeyIds.length) {
    return 0;
  }

  const totals = await getUsageTotalsForAccessKeys({
    accessKeyIds,
    endMs,
    startMs,
  });

  return totals.totalTokens;
};

/**
 * Charging order: the plan first, then the balance, and only when both are
 * exhausted the request is rejected. Accounts without a billing document stay
 * unrestricted, which keeps installations that predate this feature working.
 */
export const getBillingViolation = async (
  userId: string,
): Promise<BillingViolation | null> => {
  const account = await getBillingAccount(userId);

  if (!account) {
    return null;
  }

  const accessKeyIds = await resolveOwnerAccessKeyIds(userId);

  if (!accessKeyIds.length) {
    return null;
  }

  const now = Date.now();
  const plan = account.plan;

  if (plan && plan.tokens > 0 && Date.parse(plan.expiresAt) > now) {
    const planUsed = await sumTokens(
      accessKeyIds,
      Date.parse(plan.startedAt),
      now + 1,
    );

    if (planUsed < plan.tokens) {
      return null;
    }
  }

  const lifetimeUsed = await sumTokens(accessKeyIds, 0, now + 1);

  if (account.balanceTokens > 0 && lifetimeUsed < account.balanceTokens) {
    return null;
  }

  return {
    max: account.balanceTokens,
    message: plan
      ? 'Your account has no remaining tokens. Renew the plan or top up the balance.'
      : 'Your account has no remaining tokens. Top up the balance to continue.',
    used: lifetimeUsed,
  };
};
