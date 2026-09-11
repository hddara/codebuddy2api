import fs from 'node:fs';
import path from 'node:path';

import { createApplication } from '@/lib/server/domain/applications';
import {
  deleteQuotaRecord,
  getAccessKeyQuotaViolation,
  getBalance,
  getQuotaKey,
  getQuotaPeriodWindow,
  getQuotaRecord,
  listQuotaRecords,
  parseQuotaRecord,
  resetQuotaRuntimeState,
  setQuotaRecord,
} from '@/lib/server/domain/quotas';
import {
  clearUsageHistory,
  getUsageRetentionStartMs,
  recordUsageEvent,
} from '@/lib/server/domain/usage';
import { resetStorageRuntime } from '@/lib/server/storage';

const repoRoot = process.cwd();
const tempRootDir = path.join(repoRoot, '.tmp-test-quotas-domain');
const dataDir = path.join(tempRootDir, '.codebuddy_data');
const quotasDir = path.join(dataDir, 'quotas');

const cleanupTempState = (): void => {
  fs.rmSync(tempRootDir, { force: true, recursive: true, maxRetries: 5 });
};

const recordCall = async (
  accessKeyId: string,
  accessKeyName: string,
  totalTokens: number,
): Promise<void> => {
  await recordUsageEvent({
    accessKeyId,
    accessKeyName,
    credentialFilename: 'quota-credential.json',
    model: 'claude-sonnet-4',
    route: '/v1/chat/completions',
    usage: { total_tokens: totalTokens },
  });
};

describe('quotas domain', () => {
  beforeEach(() => {
    cleanupTempState();
    resetStorageRuntime();
    resetQuotaRuntimeState();
    vi.restoreAllMocks();
    vi.spyOn(process, 'cwd').mockReturnValue(tempRootDir);
    delete process.env.CODEBUDDY_STORAGE_BACKEND;
    delete process.env.CODEBUDDY_STORAGE_FILE_DIR;
    delete process.env.CODEBUDDY_STORAGE_PG_URL;
    delete process.env.DATABASE_URL;
    delete process.env.CODEBUDDY_USAGE_RETENTION_DAYS;
  });

  afterEach(async () => {
    await clearUsageHistory();
    cleanupTempState();
  });

  it('round-trips one quota document per owner on the real file backend', async () => {
    const record = await setQuotaRecord({
      maxCalls: 120,
      maxTokens: 50_000,
      ownerId: 'app-1',
      ownerType: 'app',
      period: 'monthly',
    });

    expect(record.createdAt).toBe(record.updatedAt);
    expect(fs.existsSync(path.join(quotasDir, 'app-monthly-app-1.json'))).toBe(
      true,
    );

    resetQuotaRuntimeState();
    await expect(
      getQuotaRecord({
        ownerId: 'app-1',
        ownerType: 'app',
        period: 'monthly',
      }),
    ).resolves.toMatchObject({ maxCalls: 120, maxTokens: 50_000 });

    const updated = await setQuotaRecord({
      maxCalls: 5,
      ownerId: 'app-1',
      ownerType: 'app',
      period: 'monthly',
    });
    expect(updated.createdAt).toBe(record.createdAt);
    expect(updated.maxCalls).toBe(5);
    expect(updated.maxTokens).toBeNull();
    expect(await listQuotaRecords()).toHaveLength(1);

    await expect(
      deleteQuotaRecord({
        ownerId: 'app-1',
        ownerType: 'app',
        period: 'monthly',
      }),
    ).resolves.toBe(true);
    expect(fs.existsSync(path.join(quotasDir, 'app-monthly-app-1.json'))).toBe(
      false,
    );
    await expect(
      deleteQuotaRecord({
        ownerId: 'app-1',
        ownerType: 'app',
        period: 'monthly',
      }),
    ).resolves.toBe(false);
  });

  it('rejects unusable owner ids and only parses well-formed documents', async () => {
    expect(getQuotaKey('app', 'nested/app', 'monthly')).toBeNull();
    expect(getQuotaKey('user', 'user-1', 'daily')).toBe('user-daily-user-1');

    await expect(
      setQuotaRecord({
        ownerId: 'nested/app',
        ownerType: 'app',
        period: 'monthly',
      }),
    ).rejects.toThrow('Quota owner id must be a simple identifier');

    await expect(
      getQuotaRecord({
        ownerId: 'nested/app',
        ownerType: 'app',
        period: 'monthly',
      }),
    ).resolves.toBeNull();

    expect(parseQuotaRecord(null)).toBeNull();
    expect(parseQuotaRecord([])).toBeNull();
    expect(parseQuotaRecord({ ownerId: 'app-1' })).toBeNull();
    expect(
      parseQuotaRecord({
        ownerId: 'app-1',
        ownerType: 'team',
        period: 'monthly',
      }),
    ).toBeNull();
    expect(
      parseQuotaRecord({
        ownerId: 'app-1',
        ownerType: 'app',
        period: 'yearly',
      }),
    ).toBeNull();

    const parsed = parseQuotaRecord({
      maxCalls: -3,
      maxTokens: 12.7,
      ownerId: 'app-1',
      ownerType: 'app',
      period: 'monthly',
    });
    expect(parsed).toMatchObject({ maxCalls: null, maxTokens: 12 });
    expect(parsed?.createdAt).toBe(new Date(0).toISOString());
  });

  it('skips unreadable quota documents instead of failing', async () => {
    fs.mkdirSync(quotasDir, { recursive: true });
    fs.writeFileSync(path.join(quotasDir, 'app-monthly-broken.json'), '{');

    await expect(
      getQuotaRecord({
        ownerId: 'broken',
        ownerType: 'app',
        period: 'monthly',
      }),
    ).resolves.toBeNull();
    await expect(listQuotaRecords()).resolves.toEqual([]);
  });

  it('keeps a shorter usage window on the file backend and honors the override', () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const nowMs = Date.now();

    expect(nowMs - getUsageRetentionStartMs(nowMs)).toBe(7 * dayMs);

    process.env.CODEBUDDY_USAGE_RETENTION_DAYS = '10';

    expect(nowMs - getUsageRetentionStartMs(nowMs)).toBe(10 * dayMs);

    delete process.env.CODEBUDDY_USAGE_RETENTION_DAYS;
  });

  it('computes the balance window for every period', () => {
    const now = new Date('2026-03-15T10:30:00.000Z');

    expect(getQuotaPeriodWindow('daily', now)).toEqual({
      endMs: Date.UTC(2026, 2, 16),
      resetAt: '2026-03-16T00:00:00.000Z',
      startMs: Date.UTC(2026, 2, 15),
    });
    expect(getQuotaPeriodWindow('monthly', now)).toEqual({
      endMs: Date.UTC(2026, 3, 1),
      resetAt: '2026-04-01T00:00:00.000Z',
      startMs: Date.UTC(2026, 2, 1),
    });
    expect(getQuotaPeriodWindow('total', now)).toEqual({
      endMs: now.getTime(),
      resetAt: null,
      startMs: 0,
    });
  });

  it('derives the balance from the usage events of the application', async () => {
    const created = await createApplication({
      credentialFilenames: [],
      name: 'Quota App',
    });
    await recordCall(created.application.id, 'Quota App', 40);
    await recordCall(created.application.id, 'Quota App', 60);
    await recordCall('someone-else', 'Other App', 900);

    await setQuotaRecord({
      maxCalls: 5,
      maxTokens: 100,
      ownerId: created.application.id,
      ownerType: 'app',
      period: 'monthly',
    });
    resetQuotaRuntimeState();

    const balance = await getBalance({
      ownerId: created.application.id,
      ownerType: 'app',
      period: 'monthly',
    });

    expect(balance).toMatchObject({
      configured: true,
      // The file backend keeps a 7 day window, so a monthly balance can only be
      // a lower bound and says so.
      degraded: true,
      maxCalls: 5,
      maxTokens: 100,
      remainingCalls: 3,
      remainingTokens: 0,
      usedCalls: 2,
      usedTokens: 100,
    });
    expect(balance.resetAt).not.toBeNull();
    expect(balance.periodStart).toBe(
      new Date(
        Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1),
      ).toISOString(),
    );

    const unlimited = await getBalance({
      ownerId: 'unconfigured-app',
      ownerType: 'app',
      period: 'total',
    });
    expect(unlimited).toMatchObject({
      configured: false,
      degraded: true,
      maxCalls: null,
      remainingCalls: null,
      remainingTokens: null,
      resetAt: null,
      usedCalls: 0,
      usedTokens: 0,
    });
  });

  it('adds up every application owned by a user', async () => {
    const first = await createApplication({
      credentialFilenames: [],
      name: 'First',
      ownerUserId: 'user-1',
    });
    const second = await createApplication({
      credentialFilenames: [],
      name: 'Second',
      ownerUserId: 'user-1',
    });
    const foreign = await createApplication({
      credentialFilenames: [],
      name: 'Foreign',
      ownerUserId: 'user-2',
    });

    await recordCall(first.application.id, 'First', 10);
    await recordCall(second.application.id, 'Second', 15);
    await recordCall(foreign.application.id, 'Foreign', 700);

    await setQuotaRecord({
      maxTokens: 1000,
      ownerId: 'user-1',
      ownerType: 'user',
      period: 'monthly',
    });
    resetQuotaRuntimeState();

    const balance = await getBalance({
      ownerId: 'user-1',
      ownerType: 'user',
      period: 'monthly',
    });

    expect(balance).toMatchObject({
      configured: true,
      maxCalls: null,
      remainingCalls: null,
      remainingTokens: 975,
      usedCalls: 2,
      usedTokens: 25,
    });
  });

  it('reports the first exceeded dimension of an application quota', async () => {
    const created = await createApplication({
      credentialFilenames: [],
      name: 'Guard App',
    });

    await expect(
      getAccessKeyQuotaViolation({
        id: created.application.id,
        name: created.application.name,
        ownerUserId: null,
      }),
    ).resolves.toBeNull();

    await setQuotaRecord({
      maxCalls: 1,
      ownerId: created.application.id,
      ownerType: 'app',
      period: 'monthly',
    });
    resetQuotaRuntimeState();
    await expect(
      getAccessKeyQuotaViolation({
        id: created.application.id,
        name: created.application.name,
        ownerUserId: null,
      }),
    ).resolves.toBeNull();

    await recordCall(created.application.id, 'Guard App', 3);
    resetQuotaRuntimeState();

    const callViolation = await getAccessKeyQuotaViolation({
      id: created.application.id,
      name: created.application.name,
      ownerUserId: null,
    });
    expect(callViolation).toMatchObject({
      limit: 'calls',
      max: 1,
      ownerType: 'app',
      period: 'monthly',
      used: 1,
    });
    expect(callViolation?.message).toContain('Guard App');

    await setQuotaRecord({
      maxCalls: 100,
      maxTokens: 2,
      ownerId: created.application.id,
      ownerType: 'app',
      period: 'monthly',
    });
    resetQuotaRuntimeState();

    const tokenViolation = await getAccessKeyQuotaViolation({
      id: created.application.id,
      name: created.application.name,
      ownerUserId: null,
    });
    expect(tokenViolation).toMatchObject({ limit: 'tokens', max: 2, used: 3 });
    expect(tokenViolation?.message).toContain('token quota');
  });

  it('falls back to the user quota of the application owner', async () => {
    const created = await createApplication({
      credentialFilenames: [],
      name: 'Owned App',
      ownerUserId: 'user-9',
    });

    await setQuotaRecord({
      maxCalls: 1,
      ownerId: 'user-9',
      ownerType: 'user',
      period: 'monthly',
    });
    resetQuotaRuntimeState();
    await recordCall(created.application.id, 'Owned App', 5);
    resetQuotaRuntimeState();

    const violation = await getAccessKeyQuotaViolation({
      id: created.application.id,
      name: created.application.name,
      ownerUserId: 'user-9',
    });

    expect(violation).toMatchObject({ limit: 'calls', ownerType: 'user' });
    expect(violation?.message).toContain('Your account');

    // The owner check follows the caller's record, so an application without an
    // owner is not charged against that user quota.
    await expect(
      getAccessKeyQuotaViolation({
        id: created.application.id,
        name: created.application.name,
        ownerUserId: null,
      }),
    ).resolves.toBeNull();
  });

  it('ignores quotas without any usable limit', async () => {
    const created = await createApplication({
      credentialFilenames: [],
      name: 'Unlimited App',
    });

    await setQuotaRecord({
      maxCalls: null,
      maxTokens: null,
      ownerId: created.application.id,
      ownerType: 'app',
      period: 'monthly',
    });
    resetQuotaRuntimeState();

    await expect(
      getAccessKeyQuotaViolation({
        id: created.application.id,
        name: created.application.name,
        ownerUserId: null,
      }),
    ).resolves.toBeNull();
  });
});
