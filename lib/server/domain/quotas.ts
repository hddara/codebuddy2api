import {
  deleteStorageJson,
  listStorageJson,
  writeStorageJson,
} from '../storage';
import {
  type ApplicationRecord,
  findApplicationById,
  listApplicationRecords,
} from './applications';
import { getBillingViolation } from './billing';
import { getUsageRetentionStartMs, getUsageTotalsForAccessKeys } from './usage';
import { getUser, listUsers } from './users';

export const QUOTAS_NAMESPACE = 'quotas';

export type QuotaOwnerType = 'app' | 'user';

export type QuotaPeriod = 'daily' | 'monthly' | 'total';

/** Quota period locked by the design decision: quotas reset every month. */
export const DEFAULT_QUOTA_PERIOD: QuotaPeriod = 'monthly';

/** A null limit means "unlimited" for that dimension. */
export interface QuotaRecord {
  createdAt: string;
  maxCalls: number | null;
  maxTokens: number | null;
  ownerId: string;
  ownerType: QuotaOwnerType;
  period: QuotaPeriod;
  updatedAt: string;
}

/** Quota minus consumed usage. `remaining*` are null when unlimited. */
export interface QuotaBalance {
  /** False when no quota document exists; usage is still reported. */
  configured: boolean;
  /**
   * True when the period starts before the retained usage window, so the
   * reported usage is a lower bound (only possible for `total` periods or a
   * retention override shorter than the period).
   */
  degraded: boolean;
  maxCalls: number | null;
  maxTokens: number | null;
  ownerId: string;
  ownerType: QuotaOwnerType;
  period: QuotaPeriod;
  periodStart: string;
  remainingCalls: number | null;
  remainingTokens: number | null;
  /** Null for the `total` period, which never resets. */
  resetAt: string | null;
  usedCalls: number;
  usedTokens: number;
}

export interface QuotaViolation {
  limit: 'calls' | 'tokens';
  max: number;
  message: string;
  ownerType: QuotaOwnerType;
  period: QuotaPeriod;
  used: number;
}

export interface SetQuotaInput {
  maxCalls?: number | null;
  maxTokens?: number | null;
  ownerId: string;
  ownerType: QuotaOwnerType;
  period: QuotaPeriod;
}

const QUOTA_CACHE_TTL_MS = 10_000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
// Keys become file names on the file backend, so the owner id has to stay a
// single safe path segment. Every real owner id is a UUID or a slug.
const QUOTA_KEY_SEGMENT_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

interface QuotaCacheEntry {
  expiresAt: number;
  records: QuotaRecord[];
}

let quotaCache: QuotaCacheEntry | null = null;
const balanceCache = new Map<
  string,
  { balance: QuotaBalance; expiresAt: number }
>();

/** Drops the in-process caches. Tests and storage resets must call this. */
export const resetQuotaRuntimeState = (): void => {
  quotaCache = null;
  balanceCache.clear();
};

export const isQuotaOwnerType = (value: unknown): value is QuotaOwnerType => {
  return value === 'app' || value === 'user';
};

export const isQuotaPeriod = (value: unknown): value is QuotaPeriod => {
  return value === 'daily' || value === 'monthly' || value === 'total';
};

/**
 * True when the referenced owner exists. Quotas for unknown ids are rejected so
 * a typo cannot silently create an unenforced document.
 */
export const quotaOwnerExists = async (
  ownerType: QuotaOwnerType,
  ownerId: string,
): Promise<boolean> => {
  if (ownerType === 'app') {
    return (await findApplicationById(ownerId)) !== null;
  }

  return (await getUser(ownerId)) !== null;
};

const toLimit = (value: unknown): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null;
  }

  return Math.floor(value);
};

export const parseQuotaRecord = (value: unknown): QuotaRecord | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const record = value as Partial<QuotaRecord>;

  if (
    typeof record.ownerId !== 'string' ||
    !record.ownerId ||
    !isQuotaOwnerType(record.ownerType) ||
    !isQuotaPeriod(record.period)
  ) {
    return null;
  }

  const fallbackTimestamp = new Date(0).toISOString();

  return {
    createdAt:
      typeof record.createdAt === 'string'
        ? record.createdAt
        : fallbackTimestamp,
    maxCalls: toLimit(record.maxCalls),
    maxTokens: toLimit(record.maxTokens),
    ownerId: record.ownerId,
    ownerType: record.ownerType,
    period: record.period,
    updatedAt:
      typeof record.updatedAt === 'string'
        ? record.updatedAt
        : fallbackTimestamp,
  };
};

/** Storage key of one quota document, or null when the owner id is unusable. */
export const getQuotaKey = (
  ownerType: QuotaOwnerType,
  ownerId: string,
  period: QuotaPeriod,
): string | null => {
  if (!QUOTA_KEY_SEGMENT_PATTERN.test(ownerId)) {
    return null;
  }

  return `${ownerType}-${period}-${ownerId}`;
};

/**
 * Lists every quota. Unreadable documents are skipped, which fails open: a
 * broken quota document can never block inference, it only stops enforcing.
 */
export const listQuotaRecords = async (): Promise<QuotaRecord[]> => {
  if (quotaCache && quotaCache.expiresAt > Date.now()) {
    return quotaCache.records;
  }

  const documents = await listStorageJson<unknown>(QUOTAS_NAMESPACE);
  const records = documents
    .map((document) => parseQuotaRecord(document.value))
    .filter((record): record is QuotaRecord => record !== null);

  quotaCache = { expiresAt: Date.now() + QUOTA_CACHE_TTL_MS, records };

  return records;
};

export const getQuotaRecord = async ({
  ownerId,
  ownerType,
  period,
}: {
  ownerId: string;
  ownerType: QuotaOwnerType;
  period: QuotaPeriod;
}): Promise<QuotaRecord | null> => {
  const key = getQuotaKey(ownerType, ownerId, period);

  if (!key) {
    return null;
  }

  const records = await listQuotaRecords();

  return (
    records.find(
      (record) =>
        getQuotaKey(record.ownerType, record.ownerId, record.period) === key,
    ) ?? null
  );
};

export const setQuotaRecord = async (
  input: SetQuotaInput,
): Promise<QuotaRecord> => {
  const key = getQuotaKey(input.ownerType, input.ownerId, input.period);

  if (!key) {
    throw new Error('Quota owner id must be a simple identifier');
  }

  const existing = await getQuotaRecord(input);
  const now = new Date().toISOString();
  const record: QuotaRecord = {
    createdAt: existing?.createdAt ?? now,
    maxCalls: toLimit(input.maxCalls),
    maxTokens: toLimit(input.maxTokens),
    ownerId: input.ownerId,
    ownerType: input.ownerType,
    period: input.period,
    updatedAt: now,
  };

  await writeStorageJson(QUOTAS_NAMESPACE, key, record);
  resetQuotaRuntimeState();

  return record;
};

export const deleteQuotaRecord = async ({
  ownerId,
  ownerType,
  period,
}: {
  ownerId: string;
  ownerType: QuotaOwnerType;
  period: QuotaPeriod;
}): Promise<boolean> => {
  const key = getQuotaKey(ownerType, ownerId, period);

  if (!key || !(await getQuotaRecord({ ownerId, ownerType, period }))) {
    return false;
  }

  await deleteStorageJson(QUOTAS_NAMESPACE, key);
  resetQuotaRuntimeState();

  return true;
};

/**
 * Quota windows use UTC so the reset instant does not depend on the host time
 * zone. `total` never resets and starts at the epoch.
 */
export const getQuotaPeriodWindow = (
  period: QuotaPeriod,
  now: Date,
): { endMs: number; resetAt: string | null; startMs: number } => {
  if (period === 'daily') {
    const startMs = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
    );
    const endMs = startMs + DAY_MS;

    return { endMs, resetAt: new Date(endMs).toISOString(), startMs };
  }

  if (period === 'monthly') {
    const startMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const endMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);

    return { endMs, resetAt: new Date(endMs).toISOString(), startMs };
  }

  return { endMs: now.getTime(), resetAt: null, startMs: 0 };
};

/**
 * Access keys whose usage counts towards the owner. A user owns the sum of
 * their applications; an application owns only itself.
 */
export const resolveOwnerAccessKeyIds = async (
  ownerType: QuotaOwnerType,
  ownerId: string,
): Promise<string[]> => {
  if (ownerType === 'app') {
    return [ownerId];
  }

  const applications = await listApplicationRecords();

  return applications
    .filter((record) => record.ownerUserId === ownerId)
    .map((record) => record.id);
};

const toRemaining = (max: number | null, used: number): number | null => {
  return max === null ? null : Math.max(0, max - used);
};

export const getBalance = async ({
  now = new Date(),
  ownerId,
  ownerType,
  period,
}: {
  now?: Date;
  ownerId: string;
  ownerType: QuotaOwnerType;
  period: QuotaPeriod;
}): Promise<QuotaBalance> => {
  const { endMs, resetAt, startMs } = getQuotaPeriodWindow(period, now);
  const quota = await getQuotaRecord({ ownerId, ownerType, period });
  const accessKeyIds = await resolveOwnerAccessKeyIds(ownerType, ownerId);
  const totals = await getUsageTotalsForAccessKeys({
    accessKeyIds,
    endMs,
    startMs,
  });
  const maxCalls = quota?.maxCalls ?? null;
  const maxTokens = quota?.maxTokens ?? null;

  return {
    configured: quota !== null,
    degraded: startMs < getUsageRetentionStartMs(now.getTime()),
    maxCalls,
    maxTokens,
    ownerId,
    ownerType,
    period,
    periodStart: new Date(startMs).toISOString(),
    remainingCalls: toRemaining(maxCalls, totals.callCount),
    remainingTokens: toRemaining(maxTokens, totals.totalTokens),
    resetAt,
    usedCalls: totals.callCount,
    usedTokens: totals.totalTokens,
  };
};

export interface QuotaOwnerBalance extends QuotaBalance {
  /** Application name or user display name, for the admin quota list. */
  name: string;
}

/**
 * Balance of every application and every user, which is what the admin quota
 * page lists. Owners without a quota document are included so their current
 * usage stays visible.
 */
export const listQuotaBalances = async (
  period: QuotaPeriod = DEFAULT_QUOTA_PERIOD,
): Promise<QuotaOwnerBalance[]> => {
  const [applications, users] = await Promise.all([
    listApplicationRecords(),
    listUsers(),
  ]);
  const owners = [
    ...applications.map((record) => ({
      name: record.name,
      ownerId: record.id,
      ownerType: 'app' as const,
    })),
    ...users.map((user) => ({
      name: user.displayName,
      ownerId: user.userId,
      ownerType: 'user' as const,
    })),
  ];

  return Promise.all(
    owners.map(async (owner) => ({
      ...(await getBalance({
        ownerId: owner.ownerId,
        ownerType: owner.ownerType,
        period,
      })),
      name: owner.name,
    })),
  );
};

const getCachedBalance = async ({
  now,
  ownerId,
  ownerType,
  period,
}: {
  now?: Date;
  ownerId: string;
  ownerType: QuotaOwnerType;
  period: QuotaPeriod;
}): Promise<QuotaBalance> => {
  const key = getQuotaKey(ownerType, ownerId, period);

  if (!key) {
    throw new Error('Quota owner id must be a simple identifier');
  }

  const cached = balanceCache.get(key);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.balance;
  }

  const balance = await getBalance({ now, ownerId, ownerType, period });

  balanceCache.set(key, {
    balance,
    expiresAt: Date.now() + QUOTA_CACHE_TTL_MS,
  });

  return balance;
};

const findViolation = async (
  ownerType: QuotaOwnerType,
  ownerId: string,
  label: string,
  period: QuotaPeriod,
): Promise<QuotaViolation | null> => {
  const quota = await getQuotaRecord({ ownerId, ownerType, period });

  if (!quota) {
    return null;
  }

  const maxCalls = quota.maxCalls;
  const maxTokens = quota.maxTokens;

  if (maxCalls === null && maxTokens === null) {
    return null;
  }

  const balance = await getCachedBalance({ ownerId, ownerType, period });

  if (maxCalls !== null && balance.usedCalls >= maxCalls) {
    return {
      limit: 'calls',
      max: maxCalls,
      message: `${label} reached its ${period} call quota (${balance.usedCalls} of ${maxCalls} calls used).`,
      ownerType,
      period,
      used: balance.usedCalls,
    };
  }

  if (maxTokens !== null && balance.usedTokens >= maxTokens) {
    return {
      limit: 'tokens',
      max: maxTokens,
      message: `${label} reached its ${period} token quota (${balance.usedTokens} of ${maxTokens} tokens used).`,
      ownerType,
      period,
      used: balance.usedTokens,
    };
  }

  return null;
};

/**
 * First quota exceeded by this application (application quota wins over the
 * owner's user quota). Storage failures fail open: quotas are a resource guard,
 * not an authorization boundary, and must not break inference.
 */
export const getAccessKeyQuotaViolation = async (
  accessKey: Pick<ApplicationRecord, 'id' | 'name' | 'ownerUserId'>,
): Promise<QuotaViolation | null> => {
  try {
    const applicationViolation = await findViolation(
      'app',
      accessKey.id,
      `Application "${accessKey.name}"`,
      DEFAULT_QUOTA_PERIOD,
    );

    if (applicationViolation) {
      return applicationViolation;
    }

    if (!accessKey.ownerUserId) {
      return null;
    }

    // Prepaid billing (plan, then balance) comes first: it is the product
    // model, while the user quota above remains as a legacy safeguard.
    const billingViolation = await getBillingViolation(accessKey.ownerUserId);

    if (billingViolation) {
      return {
        limit: 'tokens',
        max: billingViolation.max,
        message: billingViolation.message,
        ownerType: 'user',
        period: DEFAULT_QUOTA_PERIOD,
        used: billingViolation.used,
      };
    }

    return await findViolation(
      'user',
      accessKey.ownerUserId,
      'Your account',
      DEFAULT_QUOTA_PERIOD,
    );
  } catch (error) {
    console.warn('[CodeBuddy2API] Unable to evaluate the quota balance', error);

    return null;
  }
};
