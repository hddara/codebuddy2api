import { getCodeBuddyApiEndpoint } from './config';
import {
  listCredentials,
  listEligibleCredentialRecords,
  type CredentialRecord,
} from './credentials';
import { getModelsForCredential } from '../proxy/codebuddy';
import { logEvent, truncateLogText } from '../shared/log';

export interface AccountStatusSnapshot {
  checkin: { claimed: boolean | null; message: string | null };
  credits: {
    total: number | null;
    used: number | null;
    remaining: number | null;
    plan: string | null;
    resetAt: string | null;
    /** Every package the account holds, including expired ones. */
    packages: Array<{
      capacityRemain: number | null;
      capacitySize: number | null;
      capacityUsed: number | null;
      cycleEndTime: string | null;
      cycleStartTime: string | null;
      packageName: string | null;
      status: number | null;
    }>;
    /** Packages that are neither expired nor empty; the totals above cover these only. */
    usablePackageCount: number;
  };
  error: string | null;
  filename: string;
  models: string[];
  queriedAt: string;
}

const getBearerToken = (credential: CredentialRecord): string =>
  String(
    credential.data.bearer_token ?? credential.data.access_token ?? '',
  ).trim();

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null;

/**
 * Same lookup as `findValue`, but keeps the search inside `value` instead of
 * walking into nested objects. Quota fields are read off a package record, and
 * a recursive search would happily pick the same field name from a sibling or
 * from an aggregated node, which is how an expired package's capacity leaks
 * into a usable one.
 */
const findOwnValue = (
  value: Record<string, unknown>,
  keys: string[],
): unknown => {
  for (const key of keys) {
    if (value[key] !== undefined && value[key] !== null) return value[key];
  }

  return undefined;
};

const findValue = (value: unknown, keys: string[]): unknown => {
  const record = asRecord(value);
  if (record) {
    for (const key of keys) {
      if (record[key] !== undefined && record[key] !== null) return record[key];
    }
    for (const nested of Object.values(record)) {
      const found = findValue(nested, keys);
      if (found !== undefined) return found;
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findValue(item, keys);
      if (found !== undefined) return found;
    }
  }
  return undefined;
};

const toNumber = (value: unknown): number | null => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const resolveCheckinState = (
  payload: unknown,
): { claimed: boolean | null; message: string | null } => {
  const value = findValue(payload, [
    'claimed',
    'isClaimed',
    'checkedIn',
    'today_checked_in',
    'todayCheckedIn',
    'status',
  ]);
  const claimed =
    typeof value === 'boolean'
      ? value
      : typeof value === 'string'
        ? ['CLAIMED', 'ALREADY_CLAIMED', 'CHECKED_IN'].includes(
            value.toUpperCase(),
          )
        : null;

  return { claimed, message: typeof value === 'string' ? value : null };
};

const MAX_ERROR_DETAIL_LENGTH = 300;

const readErrorDetail = async (response: Response): Promise<string> => {
  try {
    const detail = (await response.text()).trim();

    if (!detail) {
      return '';
    }

    return detail.length > MAX_ERROR_DETAIL_LENGTH
      ? `${detail.slice(0, MAX_ERROR_DETAIL_LENGTH)}...`
      : detail;
  } catch {
    return '';
  }
};

class UpstreamRequestError extends Error {
  readonly status: number;

  constructor(path: string, status: number, detail: string) {
    super(
      detail
        ? `${path} returned ${status}: ${detail}`
        : `${path} returned ${status}`,
    );
    this.name = 'UpstreamRequestError';
    this.status = status;
  }
}

const fetchJson = async (
  credential: CredentialRecord,
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<unknown> => {
  const domain = String(credential.data.domain ?? '')
    .trim()
    .toLowerCase();
  const endpoint = domain.endsWith('workbuddy.ai')
    ? 'https://www.workbuddy.ai'
    : await getCodeBuddyApiEndpoint();
  const origin = domain.endsWith('workbuddy.ai')
    ? 'https://www.workbuddy.ai'
    : 'https://www.codebuddy.cn';
  const userId = String(
    credential.data.user_id ?? credential.data.user_info?.email ?? '',
  ).trim();
  const enterpriseId = String(
    credential.data.enterprise_id ?? credential.data.enterpriseId ?? '',
  ).trim();
  const tenantId = String(
    credential.data.tenant_id ?? credential.data.tenantId ?? enterpriseId,
  ).trim();
  const response = await fetch(new URL(path, endpoint), {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      Accept: 'application/json, text/plain, */*',
      Authorization: `Bearer ${getBearerToken(credential)}`,
      'Content-Type': 'application/json',
      Origin: origin,
      Referer: `${origin}/`,
      'User-Agent': 'CLI/2.137.1 CodeBuddy/2.137.1',
      'X-IDE-Name': 'CLI',
      'X-IDE-Type': 'CLI',
      'X-IDE-Version': '2.137.1',
      'X-Product': 'SaaS',
      'X-Requested-With': 'XMLHttpRequest',
      ...(userId ? { 'X-User-Id': userId } : {}),
      ...(enterpriseId ? { 'X-Enterprise-Id': enterpriseId } : {}),
      ...(tenantId ? { 'X-Tenant-Id': tenantId } : {}),
      ...(domain ? { 'X-Domain': domain } : {}),
    },
    method,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const detail = await readErrorDetail(response);

    throw new UpstreamRequestError(path, response.status, detail);
  }

  return response.json();
};

const fetchCheckinStatus = async (
  credential: CredentialRecord,
): Promise<unknown> => {
  try {
    return await fetchJson(
      credential,
      '/v2/billing/meter/checkin-activity-status',
      'POST',
      {},
    );
  } catch (error) {
    if (
      !(error instanceof UpstreamRequestError) ||
      (error.status !== 404 && error.status !== 405)
    ) {
      throw error;
    }
    return fetchJson(
      credential,
      '/v2/billing/meter/checkin-status',
      'POST',
      {},
    );
  }
};

/**
 * The upstream quota response carries the fields the account really reports
 * (package size, remaining dosage, cycle end). Keep the raw body in the logs so
 * the reset cadence and any per-day allowance can be derived after the fact
 * instead of guessed from the parsed snapshot alone.
 */
const MAX_CREDITS_LOG_LENGTH = 4000;

const logCreditsPayload = (
  credential: CredentialRecord,
  payload: unknown,
  source: string,
): void => {
  void logEvent({
    level: 'INFO',
    message: 'Credits payload captured',
    payload: {
      credentialFilename: credential.filename,
      credentialUserId: String(credential.data.user_id ?? 'unknown'),
      queriedAt: new Date().toISOString(),
      source,
      payload: truncateLogText(
        JSON.stringify(payload ?? null),
        MAX_CREDITS_LOG_LENGTH,
      ),
    },
  });
};

/**
 * A single package from the upstream quota response. One account usually holds
 * several packages at once, each with its own cycle and its own capacity, so the
 * account-level totals cannot answer "how much can I use right now".
 */
interface QuotaPackage {
  capacityRemain: number | null;
  capacitySize: number | null;
  capacityUsed: number | null;
  cycleEndTime: string | null;
  cycleStartTime: string | null;
  packageName: string | null;
  status: number | null;
}

const PACKAGE_FIELDS = {
  capacityRemain: ['CycleCapacityRemain', 'CapacityRemain'],
  capacitySize: ['CycleCapacitySize', 'CapacitySize'],
  capacityUsed: ['CycleCapacityUsed', 'CapacityUsed'],
  cycleEndTime: ['CycleEndTime'],
  cycleStartTime: ['CycleStartTime'],
  packageName: ['PackageName'],
  status: ['Status'],
};

/**
 * `Status: 3` marks an expired package. Its capacity must never be counted as
 * available, which is exactly what the previous account-level aggregation did.
 */
const EXPIRED_PACKAGE_STATUS = 3;

const toRecordArray = (value: unknown): Array<Record<string, unknown>> =>
  Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => !!asRecord(item))
    : [];

const readString = (
  record: Record<string, unknown>,
  keys: string[],
): string | null => {
  const value = findOwnValue(record, keys);

  return value === undefined || value === null || value === ''
    ? null
    : String(value);
};

const extractQuotaPackages = (payload: unknown): QuotaPackage[] => {
  const accounts = findValue(payload, ['Accounts']);

  return toRecordArray(accounts).map((record) => ({
    capacityRemain: toNumber(
      findOwnValue(record, PACKAGE_FIELDS.capacityRemain),
    ),
    capacitySize: toNumber(findOwnValue(record, PACKAGE_FIELDS.capacitySize)),
    capacityUsed: toNumber(findOwnValue(record, PACKAGE_FIELDS.capacityUsed)),
    cycleEndTime: readString(record, PACKAGE_FIELDS.cycleEndTime),
    cycleStartTime: readString(record, PACKAGE_FIELDS.cycleStartTime),
    packageName: readString(record, PACKAGE_FIELDS.packageName),
    status: toNumber(findOwnValue(record, PACKAGE_FIELDS.status)),
  }));
};

/**
 * A package counts as usable when it is not expired. Capacity is deliberately
 * not part of the test: an unparseable size still describes a real package, and
 * dropping it would silently hide the account's allowance instead of reporting
 * the value as unknown.
 */
const isUsablePackage = (quotaPackage: QuotaPackage): boolean =>
  quotaPackage.status !== EXPIRED_PACKAGE_STATUS;

/**
 * Packages with the earliest cycle end are consumed first, so the reset that
 * actually matters is the one on the soonest-expiring usable package.
 */
const pickResetAt = (quotaPackages: QuotaPackage[]): string | null => {
  const endings = quotaPackages
    .map((item) => item.cycleEndTime)
    .filter((value): value is string => Boolean(value))
    .sort();

  return endings[0] ?? null;
};

const loadAccountStatus = async (
  credential: CredentialRecord,
): Promise<AccountStatusSnapshot> => {
  const errors: string[] = [];
  let creditsPayload: unknown;
  let checkinPayload: unknown;
  let models: string[] = [];

  try {
    const now = new Date();
    const formatDate = (value: Date) =>
      value.toISOString().slice(0, 19).replace('T', ' ');
    creditsPayload = await fetchJson(
      credential,
      '/v2/billing/meter/get-user-resource',
      'POST',
      {
        PageNumber: 1,
        PageSize: 100,
        ProductCode: 'p_tcaca',
        Status: [0, 3],
        PackageEndTimeRangeBegin: formatDate(now),
        PackageEndTimeRangeEnd: formatDate(
          new Date(now.getTime() + 365 * 101 * 24 * 60 * 60 * 1000),
        ),
      },
    );
    logCreditsPayload(credential, creditsPayload, 'account-status');
  } catch (error) {
    errors.push(
      error instanceof Error ? error.message : 'Credits query failed',
    );
  }
  try {
    checkinPayload = await fetchCheckinStatus(credential);
  } catch (error) {
    errors.push(
      error instanceof Error ? error.message : 'Check-in query failed',
    );
  }
  try {
    const savedModels = String(credential.data.supported_models ?? '')
      .split(',')
      .map((model) => model.trim())
      .filter(Boolean);
    models = savedModels.length
      ? savedModels
      : (
          await getModelsForCredential({
            bearerToken: getBearerToken(credential),
            credentialData: credential.data,
          })
        ).map((model) => model.id);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : 'Model query failed');
  }

  const quotaPackages = extractQuotaPackages(creditsPayload);
  const usablePackages = quotaPackages.filter(isUsablePackage);
  const sum = (
    selector: (item: QuotaPackage) => number | null,
  ): number | null => {
    const values = usablePackages
      .map(selector)
      .filter((value): value is number => value !== null);

    return values.length
      ? values.reduce((left, right) => left + right, 0)
      : null;
  };

  return {
    checkin: resolveCheckinState(checkinPayload),
    credits: {
      total: sum((item) => item.capacitySize),
      used: sum((item) => item.capacityUsed),
      remaining: sum((item) => item.capacityRemain),
      // Several packages usually share one name, so de-duplicate: a free
      // account otherwise renders its plan as the same name repeated a dozen
      // times and the string carries no extra information.
      plan:
        [
          ...new Set(
            usablePackages
              .map((item) => item.packageName)
              .filter((value): value is string => Boolean(value)),
          ),
        ].join(' + ') || null,
      resetAt: pickResetAt(usablePackages),
      packages: quotaPackages,
      usablePackageCount: usablePackages.length,
    },
    error: errors.length ? errors.join('; ') : null,
    filename: credential.filename,
    models,
    queriedAt: new Date().toISOString(),
  };
};

export const getAccountStatus = async (
  filenames?: string[],
): Promise<AccountStatusSnapshot[]> => {
  const credentials = await listEligibleCredentialRecords(filenames);
  const results: AccountStatusSnapshot[] = [];
  for (let index = 0; index < credentials.length; index += 4) {
    const chunk = credentials.slice(index, index + 4);
    results.push(...(await Promise.all(chunk.map(loadAccountStatus))));
  }
  return results;
};

export const getAccountStatusCredentials = async () => {
  const response = await listCredentials();
  return response.credentials;
};

const isCheckinClaimed = async (
  credential: CredentialRecord,
): Promise<boolean> => {
  try {
    const payload = await fetchCheckinStatus(credential);

    return resolveCheckinState(payload).claimed === true;
  } catch {
    return false;
  }
};

export const submitCredentialCheckin = async (
  credential: CredentialRecord,
): Promise<{ error: string | null; ok: boolean }> => {
  try {
    await fetchJson(credential, '/v2/billing/meter/daily-checkin', 'POST', {});
    return { error: null, ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Check-in failed';

    // Upstream rejects a second claim on the same day; confirm the reported state
    // so an account that is already claimed today is not counted as a failure.
    if (
      error instanceof UpstreamRequestError &&
      error.status >= 400 &&
      error.status < 500 &&
      (await isCheckinClaimed(credential))
    ) {
      return { error: null, ok: true };
    }

    return {
      error: message.replace(
        '/v2/billing/meter/daily-checkin returned',
        'claim returned',
      ),
      ok: false,
    };
  }
};

export const checkinAccount = async (
  filename: string,
): Promise<AccountStatusSnapshot> => {
  const credential = (await listEligibleCredentialRecords([filename]))[0];
  if (!credential) throw new Error('Credential is unavailable');
  const outcome = await submitCredentialCheckin(credential);
  const status = await loadAccountStatus(credential);

  return outcome.ok ? status : { ...status, error: outcome.error };
};

export const checkinAccounts = async (
  filenames?: string[],
): Promise<AccountStatusSnapshot[]> => {
  const credentials = await listEligibleCredentialRecords(filenames);
  const results: AccountStatusSnapshot[] = [];
  for (let index = 0; index < credentials.length; index += 4) {
    const chunk = credentials.slice(index, index + 4);
    results.push(
      ...(await Promise.all(
        chunk.map((credential) => checkinAccount(credential.filename)),
      )),
    );
  }
  return results;
};
