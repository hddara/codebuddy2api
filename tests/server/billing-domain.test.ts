import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApplication } from '@/lib/server/domain/applications';
import {
  resetBillingRuntimeState,
  saveBillingAccount,
} from '@/lib/server/domain/billing';
import {
  getAccessKeyQuotaViolation,
  resetQuotaRuntimeState,
} from '@/lib/server/domain/quotas';
import { clearUsageHistory, recordUsageEvent } from '@/lib/server/domain/usage';
import { resetStorageRuntime } from '@/lib/server/storage';

const repoRoot = process.cwd();
const tempRootDir = path.join(repoRoot, '.tmp-test-billing-domain');

const cleanupTempState = (): void => {
  fs.rmSync(tempRootDir, { force: true, recursive: true, maxRetries: 5 });
};

const recordCall = async (
  accessKeyId: string,
  totalTokens: number,
): Promise<void> => {
  await recordUsageEvent({
    accessKeyId,
    accessKeyName: 'billing-key',
    credentialFilename: 'billing-credential.json',
    model: 'claude-sonnet-4',
    route: '/v1/chat/completions',
    usage: { total_tokens: totalTokens },
  });
};

const createKey = async (name: string, ownerUserId: string) => {
  const { application } = await createApplication({
    credentialFilenames: [],
    name,
    ownerUserId,
  });

  return { id: application.id, name, ownerUserId };
};

describe('billing domain', () => {
  beforeEach(() => {
    cleanupTempState();
    resetStorageRuntime();
    resetBillingRuntimeState();
    resetQuotaRuntimeState();
    vi.restoreAllMocks();
    vi.spyOn(process, 'cwd').mockReturnValue(tempRootDir);
    delete process.env.CODEBUDDY_STORAGE_BACKEND;
    delete process.env.CODEBUDDY_STORAGE_FILE_DIR;
    delete process.env.CODEBUDDY_STORAGE_PG_URL;
    delete process.env.DATABASE_URL;
    delete process.env.CODEBUDDY_USAGE_RETENTION_DAYS;
    delete process.env.CODEBUDDY_QUOTA_ENFORCEMENT;
  });

  afterEach(async () => {
    await clearUsageHistory();
    cleanupTempState();
  });

  it('leaves a user without a billing account unrestricted', async () => {
    const accessKey = await createKey('key-no-billing', 'user-1');

    await recordCall(accessKey.id, 10_000);

    expect(await getAccessKeyQuotaViolation(accessKey)).toBeNull();
  });

  it('charges the plan first and then the balance', async () => {
    const accessKey = await createKey('key-plan', 'user-2');

    await saveBillingAccount('user-2', {
      balanceTokens: 500,
      plan: {
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        name: 'VIP monthly',
        period: 'monthly',
        startedAt: new Date().toISOString(),
        tokens: 100,
      },
    });

    // Inside the plan: 50 of 100 plan tokens used.
    await recordCall(accessKey.id, 50);

    expect(await getAccessKeyQuotaViolation(accessKey)).toBeNull();

    // Plan exhausted (250 >= 100) but the balance still covers it (250 < 500).
    await recordCall(accessKey.id, 200);

    expect(await getAccessKeyQuotaViolation(accessKey)).toBeNull();

    // Balance exhausted too (550 >= 500) → rejected on the user level.
    await recordCall(accessKey.id, 300);

    expect(await getAccessKeyQuotaViolation(accessKey)).toMatchObject({
      limit: 'tokens',
      ownerType: 'user',
    });
  });

  it('skips an expired plan and falls back to the balance', async () => {
    const accessKey = await createKey('key-expired', 'user-3');

    await saveBillingAccount('user-3', {
      balanceTokens: 1_000,
      plan: {
        expiresAt: new Date(Date.now() - 86_400_000).toISOString(),
        name: 'VIP expired',
        period: 'monthly',
        startedAt: new Date(Date.now() - 86_400_000 * 2).toISOString(),
        tokens: 5,
      },
    });

    await recordCall(accessKey.id, 100);

    // The plan expired, so the balance of 1000 covers the usage.
    expect(await getAccessKeyQuotaViolation(accessKey)).toBeNull();

    // Shrinking the balance below the usage rejects the request.
    await saveBillingAccount('user-3', { balanceTokens: 50 });

    expect(await getAccessKeyQuotaViolation(accessKey)).toMatchObject({
      message: expect.stringContaining('no remaining tokens'),
      ownerType: 'user',
    });
  });
});
