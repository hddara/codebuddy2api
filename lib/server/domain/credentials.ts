import crypto from 'node:crypto';
import path from 'node:path';

import {
  hasAccessKeys,
  removeCredentialReferencesFromAccessKeys,
} from './access-keys';
import {
  deleteStorageJson,
  getCredsDir,
  listStorageJson,
  readStorageJson,
  writeStorageJson,
} from '../storage';
import { logEvent } from '../shared/log';
import type { RateLimitKind } from '../shared/rate-limit';

export type CredentialData = Record<string, unknown> & {
  access_token?: string;
  bearer_token?: string;
  created_at?: number;
  domain?: string;
  enterprise_id?: string;
  enterpriseId?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  session_state?: string;
  tenant_id?: string;
  tenantId?: string;
  token_type?: string;
  user_id?: string;
  user_info?: Record<string, unknown>;
  responses_passthrough?: boolean;
  upstream_protocol?: 'chat' | 'responses';
  first_message_role_to_system?: boolean;
  first_system_message_role_to_user?: boolean;
  supported_models?: string;
};

export interface CredentialRecord {
  data: CredentialData;
  filePath: string;
  filename: string;
}

/**
 * Runtime health mark for a credential that the upstream rejected with a rate
 * limit. Kept out of the credential document itself so user data stays clean.
 */
export interface CredentialLimitEntry {
  code: number | null;
  hits: number;
  kind: RateLimitKind;
  observedAt: number;
  reason: string | null;
  resumeAt: number;
  status: number;
}

interface ManagerState {
  globalNextFilename: string | null;
  keyNextFilenameByAccessKeyId: Record<string, string | null>;
  affinityAssignmentsByKey: Record<
    string,
    {
      credentialFilename: string;
      updatedAt: number;
    }
  >;
  limitedCredentials: Record<string, CredentialLimitEntry>;
}

const globalCredentialState = globalThis as typeof globalThis & {
  __codebuddy2apiCredentialState__?: ManagerState;
};

const MANAGER_STATE_FILENAME = 'manager_state.json';
const RUNTIME_STATE_FLUSH_INTERVAL_MS = 1000;
const MAX_PENDING_ROTATIONS = 100;
const AFFINITY_ASSIGNMENT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_AFFINITY_ASSIGNMENTS = 5_000;
let pendingRotationCount = 0;
let runtimeStateFlushTimer: ReturnType<typeof setTimeout> | null = null;

const loadPersistedManagerState = async (): Promise<Partial<ManagerState>> => {
  return (
    (await readStorageJson<Partial<ManagerState>>(
      'credentials',
      'manager_state.json',
    )) ?? {}
  );
};

const pruneAffinityAssignments = (
  assignments: unknown,
): ManagerState['affinityAssignmentsByKey'] => {
  if (!assignments || typeof assignments !== 'object') {
    return {};
  }

  const expiresBefore = Date.now() - AFFINITY_ASSIGNMENT_TTL_MS;
  const normalizedEntries = Object.entries(
    assignments as Record<string, unknown>,
  ).flatMap(([key, value]) => {
    if (!value || typeof value !== 'object') {
      return [];
    }

    const credentialFilename = String(
      (value as Record<string, unknown>).credentialFilename ?? '',
    ).trim();
    const updatedAt = Number((value as Record<string, unknown>).updatedAt);

    if (!credentialFilename || !Number.isFinite(updatedAt)) {
      return [];
    }

    if (updatedAt <= expiresBefore) {
      return [];
    }

    return [[key, { credentialFilename, updatedAt }] as const];
  });

  normalizedEntries.sort(
    (left, right) => right[1].updatedAt - left[1].updatedAt,
  );

  return Object.fromEntries(
    normalizedEntries.slice(0, MAX_AFFINITY_ASSIGNMENTS),
  );
};

/**
 * Drops malformed and already expired rate limit marks. Expiry is evaluated on
 * every read, so a credential rejoins the rotation without an explicit action.
 */
const pruneLimitedCredentials = (
  entries: unknown,
  now: number = Date.now(),
): ManagerState['limitedCredentials'] => {
  if (!entries || typeof entries !== 'object') {
    return {};
  }

  return Object.fromEntries(
    Object.entries(entries as Record<string, unknown>).flatMap(
      ([filename, value]) => {
        const record = value as Partial<CredentialLimitEntry> | null;

        if (!filename || !record || typeof record !== 'object') {
          return [];
        }

        const resumeAt = Number(record.resumeAt);

        if (!Number.isFinite(resumeAt) || resumeAt <= now) {
          return [];
        }

        const kind: RateLimitKind =
          record.kind === 'quota' ? 'quota' : 'frequency';

        return [
          [
            filename,
            {
              code:
                typeof record.code === 'number' && Number.isFinite(record.code)
                  ? record.code
                  : null,
              hits:
                typeof record.hits === 'number' && Number.isFinite(record.hits)
                  ? record.hits
                  : 1,
              kind,
              observedAt:
                typeof record.observedAt === 'number' &&
                Number.isFinite(record.observedAt)
                  ? record.observedAt
                  : now,
              reason: typeof record.reason === 'string' ? record.reason : null,
              resumeAt,
              status:
                typeof record.status === 'number' &&
                Number.isFinite(record.status)
                  ? record.status
                  : 429,
            } satisfies CredentialLimitEntry,
          ] as const,
        ];
      },
    ),
  );
};

const getRuntimeState = async (): Promise<ManagerState> => {
  if (!globalCredentialState.__codebuddy2apiCredentialState__) {
    const persisted = await loadPersistedManagerState();
    globalCredentialState.__codebuddy2apiCredentialState__ = {
      affinityAssignmentsByKey: pruneAffinityAssignments(
        persisted.affinityAssignmentsByKey,
      ),
      globalNextFilename: persisted.globalNextFilename ?? null,
      keyNextFilenameByAccessKeyId:
        persisted.keyNextFilenameByAccessKeyId ?? {},
      limitedCredentials: pruneLimitedCredentials(persisted.limitedCredentials),
    };
  }

  const state = globalCredentialState.__codebuddy2apiCredentialState__;
  state.limitedCredentials = pruneLimitedCredentials(state.limitedCredentials);

  return state;
};

const saveRuntimeState = async (): Promise<void> => {
  const state = await getRuntimeState();
  state.affinityAssignmentsByKey = pruneAffinityAssignments(
    state.affinityAssignmentsByKey,
  );
  state.limitedCredentials = pruneLimitedCredentials(state.limitedCredentials);
  await writeStorageJson('credentials', 'manager_state.json', {
    affinityAssignmentsByKey: state.affinityAssignmentsByKey,
    globalNextFilename: state.globalNextFilename,
    keyNextFilenameByAccessKeyId: state.keyNextFilenameByAccessKeyId,
    limitedCredentials: state.limitedCredentials,
    savedAt: Math.floor(Date.now() / 1000),
  });
};

export const flushCredentialRuntimeState = async (): Promise<void> => {
  if (runtimeStateFlushTimer) {
    clearTimeout(runtimeStateFlushTimer);
    runtimeStateFlushTimer = null;
  }

  if (!pendingRotationCount) return;
  const pendingCount = pendingRotationCount;
  pendingRotationCount = 0;

  try {
    await saveRuntimeState();
  } catch (error) {
    pendingRotationCount += pendingCount;
    scheduleRuntimeStateSave();
    throw error;
  }
};

const scheduleRuntimeStateSave = (): void => {
  pendingRotationCount += 1;

  if (pendingRotationCount >= MAX_PENDING_ROTATIONS) {
    void flushCredentialRuntimeState().catch(() => undefined);
    return;
  }

  if (runtimeStateFlushTimer) return;
  runtimeStateFlushTimer = setTimeout(() => {
    void flushCredentialRuntimeState().catch(() => undefined);
  }, RUNTIME_STATE_FLUSH_INTERVAL_MS);
  runtimeStateFlushTimer.unref?.();
};

const flushRuntimeStateBeforeShutdown = (signal: NodeJS.Signals): void => {
  void flushCredentialRuntimeState()
    .catch(() => undefined)
    .finally(() => {
      process.kill(process.pid, signal);
    });
};

process.once('SIGTERM', () => {
  flushRuntimeStateBeforeShutdown('SIGTERM');
});

process.once('SIGINT', () => {
  flushRuntimeStateBeforeShutdown('SIGINT');
});

const getNestedValue = (
  value: unknown,
  candidateKeys: string[],
): string | number | null => {
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = getNestedValue(item, candidateKeys);

      if (nested !== null && nested !== '') {
        return nested;
      }
    }

    return null;
  }

  if (value && typeof value === 'object') {
    for (const key of candidateKeys) {
      const nestedValue = (value as Record<string, unknown>)[key];

      if (
        nestedValue !== undefined &&
        nestedValue !== null &&
        nestedValue !== ''
      ) {
        return nestedValue as string | number;
      }
    }

    for (const nestedValue of Object.values(value as Record<string, unknown>)) {
      const nested = getNestedValue(nestedValue, candidateKeys);

      if (nested !== null && nested !== '') {
        return nested;
      }
    }
  }

  return null;
};

const getBooleanSetting = (value: unknown, fallback = false): boolean => {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();

    if (normalized === 'true') {
      return true;
    }

    if (normalized === 'false') {
      return false;
    }
  }

  return fallback;
};

export const getCredentialSupportedModels = (
  credential: CredentialData | null | undefined,
): string[] => {
  if (typeof credential?.supported_models !== 'string') {
    return [];
  }

  return [
    ...new Set(
      credential.supported_models
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
};

export const readCredentialRecords = async (): Promise<CredentialRecord[]> => {
  const items = await listStorageJson<CredentialData>('credentials');

  return items.flatMap(({ key: filename, value: data }) => {
    if (filename === 'manager_state.json') {
      return [];
    }

    const token = data.bearer_token ?? data.access_token;

    if (!token) {
      return [];
    }

    return [
      {
        data,
        filePath: path.join(getCredsDir(), filename),
        filename,
      },
    ];
  });
};

export const listCredentialFilenames = async (): Promise<string[]> => {
  return (await readCredentialRecords()).map((record) => record.filename);
};

export const findCredentialRecordByFilename = async (
  filename: string,
): Promise<CredentialRecord | null> => {
  return (
    (await readCredentialRecords()).find(
      (record) => record.filename === filename,
    ) ?? null
  );
};

export const findEligibleCredentialRecordByFilename = async (
  filename: string,
  allowedCredentialFilenames?: string[],
): Promise<CredentialRecord | null> => {
  return (
    getEligibleRecords(
      await readCredentialRecords(),
      allowedCredentialFilenames,
    ).find((record) => record.filename === filename) ?? null
  );
};

const getCredentialExpiry = (credential: CredentialData): number | null => {
  if (
    typeof credential.created_at !== 'number' ||
    typeof credential.expires_in !== 'number'
  ) {
    return null;
  }

  return credential.created_at + credential.expires_in;
};

const isCredentialExpired = (credential: CredentialData): boolean => {
  const expiresAt = getCredentialExpiry(credential);

  if (!expiresAt) {
    return false;
  }

  return expiresAt - 300 <= Math.floor(Date.now() / 1000);
};

const formatTimeRemaining = (expiresAt: number | null): string => {
  if (!expiresAt) {
    return 'Unknown';
  }

  const remaining = expiresAt - Math.floor(Date.now() / 1000);

  if (remaining <= 0) {
    return 'expired';
  }

  if (remaining < 3600) {
    return `${Math.ceil(remaining / 60)}m`;
  }

  if (remaining < 86400) {
    return `${Math.ceil(remaining / 3600)}h`;
  }

  return `${Math.ceil(remaining / 86400)}d`;
};

const getEligibleRecords = (
  records: CredentialRecord[],
  allowedCredentialFilenames?: string[],
): CredentialRecord[] => {
  const allowedSet = allowedCredentialFilenames
    ? new Set(allowedCredentialFilenames)
    : null;

  return records.filter((record) => {
    if (isCredentialExpired(record.data)) {
      return false;
    }

    if (allowedSet && !allowedSet.has(record.filename)) {
      return false;
    }

    return true;
  });
};

export const listEligibleCredentialRecords = async (
  allowedCredentialFilenames?: string[],
): Promise<CredentialRecord[]> => {
  return getEligibleRecords(
    await readCredentialRecords(),
    allowedCredentialFilenames,
  );
};

export const listCredentialLimits = async (): Promise<
  Array<CredentialLimitEntry & { filename: string }>
> => {
  const state = await getRuntimeState();

  return Object.entries(state.limitedCredentials).map(([filename, entry]) => ({
    filename,
    ...entry,
  }));
};

/**
 * Records that the upstream rejected requests for this credential with a rate
 * limit. The mark expires on its own at `resumeAt`, which is the instant the
 * upstream reported (or a bounded fallback when it reported none).
 */
export const markCredentialLimited = async ({
  code = null,
  filename,
  kind,
  reason = null,
  resumeAt,
  status,
}: {
  code?: number | null;
  filename: string;
  kind: RateLimitKind;
  reason?: string | null;
  resumeAt: number;
  status: number;
}): Promise<CredentialLimitEntry> => {
  const state = await getRuntimeState();
  const now = Date.now();
  const existing = state.limitedCredentials[filename];
  // Never shorten an already observed cooldown window.
  const resolvedResumeAt = Math.max(existing?.resumeAt ?? 0, resumeAt);
  const entry: CredentialLimitEntry = {
    code,
    hits: (existing?.hits ?? 0) + 1,
    kind,
    observedAt: now,
    reason,
    resumeAt: resolvedResumeAt,
    status,
  };

  state.limitedCredentials[filename] = entry;
  scheduleRuntimeStateSave();

  void logEvent({
    level: 'WARN',
    message: 'Credential rate limited',
    payload: {
      code,
      credentialFilename: filename,
      hits: entry.hits,
      kind,
      reason,
      resumeAt: new Date(resolvedResumeAt).toISOString(),
      resumeInMs: resolvedResumeAt - now,
      status,
    },
  });

  return entry;
};

export const clearCredentialLimits = async (
  filenames?: string[],
): Promise<number> => {
  const state = await getRuntimeState();
  const targets = filenames?.length
    ? filenames.filter((filename) => filename in state.limitedCredentials)
    : Object.keys(state.limitedCredentials);

  if (!targets.length) {
    return 0;
  }

  targets.forEach((filename) => {
    delete state.limitedCredentials[filename];
  });
  scheduleRuntimeStateSave();

  void logEvent({
    level: 'INFO',
    message: 'Credential rate limit cleared',
    payload: {
      count: targets.length,
      filenames: targets,
    },
  });

  return targets.length;
};

export const isCredentialLimited = async (filename: string): Promise<boolean> =>
  Boolean((await getRuntimeState()).limitedCredentials[filename]);

const chooseNextRecord = (
  eligibleRecords: CredentialRecord[],
  nextFilename: string | null,
): { current: CredentialRecord; nextFilename: string } => {
  const currentIndex = nextFilename
    ? eligibleRecords.findIndex((record) => record.filename === nextFilename)
    : -1;
  const resolvedIndex = currentIndex >= 0 ? currentIndex : 0;
  const current = eligibleRecords[resolvedIndex];
  const nextIndex = (resolvedIndex + 1) % eligibleRecords.length;

  return {
    current,
    nextFilename: eligibleRecords[nextIndex]?.filename ?? current.filename,
  };
};

const peekNextFilename = (
  eligibleRecords: CredentialRecord[],
  nextFilename: string | null,
): string | null => {
  if (!eligibleRecords.length) {
    return null;
  }

  if (
    nextFilename &&
    eligibleRecords.some((record) => record.filename === nextFilename)
  ) {
    return nextFilename;
  }

  return eligibleRecords[0]?.filename ?? null;
};

export const listCredentials = async (): Promise<{
  credentials: Array<Record<string, unknown>>;
}> => {
  const records = await readCredentialRecords();
  const limitedCredentials = (await getRuntimeState()).limitedCredentials;

  return {
    credentials: records.map((record, index) => {
      const expiresAt = getCredentialExpiry(record.data);
      const enterpriseId = getNestedValue(record.data, [
        'enterprise_id',
        'enterpriseId',
      ]);
      const limitEntry = limitedCredentials[record.filename] ?? null;
      const tenantId =
        getNestedValue(record.data, ['tenant_id', 'tenantId']) ?? enterpriseId;

      return {
        created_at: record.data.created_at ?? null,
        domain:
          getNestedValue(record.data, ['domain']) ?? 'copilot.tencent.com',
        email:
          (record.data.user_info as Record<string, unknown> | undefined)
            ?.email ??
          record.data.user_id ??
          'unknown',
        enterprise_id: enterpriseId,
        expires_at: expiresAt,
        expires_in: record.data.expires_in ?? null,
        filename: record.filename,
        has_refresh_token: Boolean(record.data.refresh_token),
        index,
        is_expired: isCredentialExpired(record.data),
        name:
          (record.data.user_info as Record<string, unknown> | undefined)
            ?.name ?? null,
        rate_limited_hits: limitEntry?.hits ?? 0,
        rate_limited_kind: limitEntry?.kind ?? null,
        rate_limited_reason: limitEntry?.reason ?? null,
        // Seconds, like `created_at` / `expires_at` in this payload.
        rate_limited_until: limitEntry
          ? Math.floor(limitEntry.resumeAt / 1000)
          : null,
        scope: record.data.scope ?? null,
        session_state: record.data.session_state ?? null,
        tenant_id: tenantId,
        time_remaining: expiresAt
          ? expiresAt - Math.floor(Date.now() / 1000)
          : null,
        time_remaining_str: formatTimeRemaining(expiresAt),
        token_type: record.data.token_type ?? 'Bearer',
        responses_passthrough: getBooleanSetting(
          record.data.responses_passthrough,
        ),
        upstream_protocol: getCredentialProxySettings(record.data)
          .upstreamProtocol,
        first_message_role_to_system: getBooleanSetting(
          record.data.first_message_role_to_system,
        ),
        first_system_message_role_to_user: getBooleanSetting(
          record.data.first_system_message_role_to_user,
        ),
        user_id:
          record.data.user_id ?? record.data.user_info?.email ?? 'unknown',
      };
    }),
  };
};

export const getCurrentCredentialInfo = async (): Promise<
  Record<string, unknown>
> => {
  const records = await readCredentialRecords();
  const availableRecords = getEligibleRecords(records);
  const state = await getRuntimeState();

  if (await hasAccessKeys()) {
    return {
      available_credential_count: availableRecords.length,
      next_filename: peekNextFilename(
        availableRecords,
        state.globalNextFilename,
      ),
      status: 'access_keys_enabled',
    };
  }

  if (!availableRecords.length) {
    return { status: 'no_credentials' };
  }

  const nextFilename = peekNextFilename(
    availableRecords,
    state.globalNextFilename,
  );
  const current =
    availableRecords.find((record) => record.filename === nextFilename) ??
    availableRecords[0];
  const enterpriseId = getNestedValue(current.data, [
    'enterprise_id',
    'enterpriseId',
  ]);
  const tenantId =
    getNestedValue(current.data, ['tenant_id', 'tenantId']) ?? enterpriseId;

  return {
    domain: getNestedValue(current.data, ['domain']) ?? 'copilot.tencent.com',
    enterprise_id: enterpriseId,
    filename: current.filename,
    next_filename: nextFilename,
    status: 'round_robin',
    tenant_id: tenantId,
    user_id: current.data.user_id ?? 'unknown',
  };
};

export const addCredential = async (
  credentialData: CredentialData,
  filename?: string,
): Promise<{ filename: string; success: boolean }> => {
  const now = Math.floor(Date.now() / 1000);
  const userId = String(credentialData.user_id ?? 'unknown');
  const safeUserId =
    userId.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 20) || 'unknown';
  const resolvedFilename =
    filename ??
    `codebuddy_${safeUserId}_${now}_${crypto.randomUUID().slice(0, 8)}.json`;
  const jsonFilename = resolvedFilename.endsWith('.json')
    ? resolvedFilename
    : `${resolvedFilename}.json`;

  if (jsonFilename === MANAGER_STATE_FILENAME) {
    throw new Error('Credential filename is reserved');
  }
  let existingPayload: CredentialData = {};

  const storedPayload = await readStorageJson<CredentialData>(
    'credentials',
    jsonFilename,
  );

  if (storedPayload) {
    existingPayload = storedPayload;
  }

  const upstreamProtocol =
    credentialData.upstream_protocol === 'responses'
      ? 'responses'
      : credentialData.upstream_protocol === 'chat'
        ? 'chat'
        : credentialData.responses_passthrough !== undefined
          ? getBooleanSetting(credentialData.responses_passthrough)
            ? 'responses'
            : 'chat'
          : existingPayload.upstream_protocol === 'responses'
            ? 'responses'
            : getBooleanSetting(existingPayload.responses_passthrough)
              ? 'responses'
              : 'chat';

  const payload = {
    ...existingPayload,
    ...credentialData,
    created_at:
      typeof existingPayload.created_at === 'number'
        ? existingPayload.created_at
        : now,
    responses_passthrough: upstreamProtocol === 'responses',
    upstream_protocol: upstreamProtocol,
    first_message_role_to_system: getBooleanSetting(
      credentialData.first_message_role_to_system ??
        existingPayload.first_message_role_to_system,
    ),
    first_system_message_role_to_user: getBooleanSetting(
      credentialData.first_system_message_role_to_user ??
        existingPayload.first_system_message_role_to_user,
    ),
  };

  await writeStorageJson('credentials', jsonFilename, payload);
  // Saving a credential is an explicit human action (re-login, fix), so drop a
  // previous rate limit mark and let the credential rejoin the rotation.
  await clearCredentialLimits([jsonFilename]);
  await saveRuntimeState();

  return {
    filename: jsonFilename,
    success: true,
  };
};

export const deleteCredentialByIndex = async (
  index: number,
): Promise<{ message: string; success: boolean }> => {
  const records = await readCredentialRecords();

  if (index < 0 || index >= records.length) {
    return { message: 'Invalid credential index', success: false };
  }

  await deleteStorageJson('credentials', records[index].filename);
  await removeCredentialReferencesFromAccessKeys(records[index].filename);

  const state = await getRuntimeState();
  const deletedFilename = records[index].filename;

  if (state.globalNextFilename === deletedFilename) {
    state.globalNextFilename = null;
  }

  Object.entries(state.keyNextFilenameByAccessKeyId).forEach(([key, value]) => {
    if (value === deletedFilename) {
      state.keyNextFilenameByAccessKeyId[key] = null;
    }
  });
  Object.entries(state.affinityAssignmentsByKey).forEach(([key, value]) => {
    if (value.credentialFilename === deletedFilename) {
      delete state.affinityAssignmentsByKey[key];
    }
  });
  delete state.limitedCredentials[deletedFilename];
  await saveRuntimeState();

  return { message: 'Credential deleted', success: true };
};

export const updateCredentialByIndex = async (
  index: number,
  credentialData: CredentialData,
): Promise<{ filename: string; success: boolean }> => {
  const records = await readCredentialRecords();

  if (index < 0 || index >= records.length) {
    throw new Error('Invalid credential index');
  }

  return addCredential(credentialData, records[index].filename);
};

export const updateCredentialSupportedModels = async (
  filename: string,
  models: string[],
): Promise<void> => {
  const credential = await findCredentialRecordByFilename(filename);

  if (!credential) {
    throw new Error('Credential is unavailable');
  }

  await writeStorageJson('credentials', filename, {
    ...credential.data,
    supported_models: [
      ...new Set(models.map((model) => model.trim()).filter(Boolean)),
    ].join(','),
  });
};

export const selectCredential = async (
  index: number,
): Promise<{ message: string; success: boolean }> => {
  const records = await readCredentialRecords();

  if (index < 0 || index >= records.length) {
    return { message: 'Invalid credential index', success: false };
  }

  const state = await getRuntimeState();
  state.globalNextFilename = records[index].filename;
  await saveRuntimeState();

  return {
    message: 'Next credential updated for round-robin',
    success: true,
  };
};

export const resumeAutoRotation = (): { message: string; success: boolean } => {
  return {
    message: 'Round-robin is always enabled',
    success: true,
  };
};

export const toggleAutoRotation = (): {
  auto_rotation_enabled: boolean;
  success: boolean;
} => {
  return {
    auto_rotation_enabled: true,
    success: true,
  };
};

export const resolveCredentialForRequest = async ({
  accessKeyId,
  affinityKey,
  allowedCredentialFilenames,
  excludeCredentialFilenames,
  model,
}: {
  accessKeyId?: string;
  affinityKey?: string;
  allowedCredentialFilenames?: string[];
  excludeCredentialFilenames?: string[];
  model?: string;
} = {}): Promise<CredentialRecord | null> => {
  const records = await readCredentialRecords();
  const requestedModel = model?.trim();
  const eligibleRecords = getEligibleRecords(
    records,
    allowedCredentialFilenames,
  ).filter((record) => {
    if (!requestedModel) return true;

    const supportedModels = getCredentialSupportedModels(record.data);
    return (
      supportedModels.length === 0 || supportedModels.includes(requestedModel)
    );
  });

  if (!eligibleRecords.length) {
    void logEvent({
      level: 'WARN',
      message: 'No eligible credential available',
      payload: {
        accessKeyId: accessKeyId ?? null,
        affinityKey: affinityKey ?? null,
        model: requestedModel ?? null,
        restrictedToAccessKey: Boolean(allowedCredentialFilenames),
        totalCredentials: records.length,
      },
    });

    return null;
  }

  const state = await getRuntimeState();
  state.affinityAssignmentsByKey = pruneAffinityAssignments(
    state.affinityAssignmentsByKey,
  );

  // Credentials already tried inside the same client request are excluded, so a
  // rotation retry never lands on the same account again.
  const excludedFilenames = new Set(excludeCredentialFilenames ?? []);
  const rotatableRecords = excludedFilenames.size
    ? eligibleRecords.filter(
        (record) => !excludedFilenames.has(record.filename),
      )
    : eligibleRecords;

  if (!rotatableRecords.length) {
    void logEvent({
      level: 'WARN',
      message: 'No credential left for rotation retry',
      payload: {
        accessKeyId: accessKeyId ?? null,
        excludedFilenames: [...excludedFilenames],
        model: requestedModel ?? null,
      },
    });

    return null;
  }

  // Rate limited credentials stay out of the rotation until their mark expires.
  // Affinity is intentionally evaluated against the filtered pool: a pinned
  // conversation on a throttled credential is reassigned on the next request.
  const limitedCredentials = state.limitedCredentials;
  const availableRecords = rotatableRecords.filter(
    (record) => !limitedCredentials[record.filename],
  );
  const limitedCandidates = rotatableRecords.length - availableRecords.length;
  // Every otherwise eligible credential is cooling down: reuse the one that
  // recovers first instead of failing the request outright.
  const allLimited = availableRecords.length === 0;
  const selectionPool = allLimited
    ? [...rotatableRecords].sort(
        (left, right) =>
          (limitedCredentials[left.filename]?.resumeAt ?? 0) -
          (limitedCredentials[right.filename]?.resumeAt ?? 0),
      )
    : availableRecords;

  if (allLimited) {
    void logEvent({
      level: 'WARN',
      message: 'All eligible credentials are rate limited',
      payload: {
        accessKeyId: accessKeyId ?? null,
        affinityKey: affinityKey ?? null,
        earliestResumeAt: new Date(
          limitedCredentials[selectionPool[0].filename]?.resumeAt ?? Date.now(),
        ).toISOString(),
        limitedCandidates,
        model: requestedModel ?? null,
        selectedCredentialFilename: selectionPool[0].filename,
      },
    });
  }

  if (affinityKey) {
    const assignment = state.affinityAssignmentsByKey[affinityKey];
    const assignedRecord = selectionPool.find(
      (record) => record.filename === assignment?.credentialFilename,
    );

    if (assignedRecord) {
      state.affinityAssignmentsByKey[affinityKey] = {
        credentialFilename: assignedRecord.filename,
        updatedAt: Date.now(),
      };
      scheduleRuntimeStateSave();
      void logEvent({
        level: 'INFO',
        message: 'Credential selected',
        payload: {
          accessKeyId: accessKeyId ?? null,
          affinityHit: true,
          affinityKey,
          candidateCount: selectionPool.length,
          credentialFilename: assignedRecord.filename,
          limitedCandidates,
          credentialUserId: String(assignedRecord.data.user_id ?? 'unknown'),
          model: requestedModel ?? null,
        },
      });

      return assignedRecord;
    }

    if (assignment) {
      delete state.affinityAssignmentsByKey[affinityKey];
    }
  }

  const currentNextFilename = accessKeyId
    ? (state.keyNextFilenameByAccessKeyId[accessKeyId] ?? null)
    : state.globalNextFilename;
  const { current, nextFilename } = chooseNextRecord(
    selectionPool,
    currentNextFilename,
  );

  if (accessKeyId) {
    state.keyNextFilenameByAccessKeyId[accessKeyId] = nextFilename;
  } else {
    state.globalNextFilename = nextFilename;
  }

  if (affinityKey) {
    state.affinityAssignmentsByKey[affinityKey] = {
      credentialFilename: current.filename,
      updatedAt: Date.now(),
    };
  }

  scheduleRuntimeStateSave();
  void logEvent({
    level: 'INFO',
    message: 'Credential selected',
    payload: {
      accessKeyId: accessKeyId ?? null,
      affinityHit: false,
      affinityKey: affinityKey ?? null,
      candidateCount: selectionPool.length,
      credentialFilename: current.filename,
      credentialUserId: String(current.data.user_id ?? 'unknown'),
      limitedCandidates,
      model: requestedModel ?? null,
      rotatedFrom: currentNextFilename,
    },
  });

  return current;
};

export const resetCredentialRuntimeState = (): void => {
  pendingRotationCount = 0;
  if (runtimeStateFlushTimer) {
    clearTimeout(runtimeStateFlushTimer);
    runtimeStateFlushTimer = null;
  }
  delete globalCredentialState.__codebuddy2apiCredentialState__;
};

export const getCredentialProxySettings = (
  credential: CredentialData | null | undefined,
): {
  firstMessageRoleToSystem: boolean;
  firstSystemMessageRoleToUser: boolean;
  upstreamProtocol: 'chat' | 'responses';
} => {
  return {
    firstMessageRoleToSystem: getBooleanSetting(
      credential?.first_message_role_to_system,
    ),
    firstSystemMessageRoleToUser: getBooleanSetting(
      credential?.first_system_message_role_to_user,
    ),
    upstreamProtocol:
      credential?.upstream_protocol === 'responses' ||
      (credential?.upstream_protocol !== 'chat' &&
        getBooleanSetting(credential?.responses_passthrough))
        ? 'responses'
        : 'chat',
  };
};
