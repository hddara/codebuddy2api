import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DELETE,
  GET,
  PUT,
} from '@/app/admin-api/quotas/[ownerType]/[ownerId]/route';
import { GET as LIST_BALANCES } from '@/app/admin-api/quotas/route';
import { loginWithAdminPassword } from '@/lib/server/admin/session';
import { createApplication } from '@/lib/server/domain/applications';
import { createUser, listPublicUsers } from '@/lib/server/domain/users';

import {
  getCookieHeader,
  makeRequest,
  paramsContext,
  readApiError,
  setupOwnerSession,
  useTempStorage,
} from './api-route-helpers';

const OWNER_PASSWORD = 'correct horse battery staple';
const MEMBER_PASSWORD = 'member-password';

interface QuotaBalancePayload {
  balance: {
    configured: boolean;
    maxCalls: number | null;
    maxTokens: number | null;
    ownerId: string;
    ownerType: string;
    period: string;
    remainingCalls: number | null;
    usedCalls: number;
  };
  quota?: { maxCalls: number | null; maxTokens: number | null };
}

describe('admin quotas API', () => {
  let cleanupTempState: () => void;

  beforeEach(() => {
    cleanupTempState = useTempStorage('.tmp-test-quotas-api');
  });

  afterEach(() => {
    cleanupTempState();
  });

  const quotaPath = (
    ownerType: string,
    ownerId: string,
    period?: string,
  ): string => {
    const search = period ? `?period=${period}` : '';

    return `/admin-api/quotas/${ownerType}/${ownerId}${search}`;
  };

  it('requires a session and an owner role for writes', async () => {
    expect(
      (await LIST_BALANCES(makeRequest({ pathname: '/admin-api/quotas' })))
        .status,
    ).toBe(401);

    const cookie = await setupOwnerSession(OWNER_PASSWORD);
    const member = await createUser({
      password: MEMBER_PASSWORD,
      role: 'member',
      username: 'worker',
    });
    const memberCookie = getCookieHeader(
      await loginWithAdminPassword(
        makeRequest({ method: 'POST', pathname: '/admin-api/auth/session' }),
        'worker',
        MEMBER_PASSWORD,
      ),
    );

    expect(
      (
        await LIST_BALANCES(
          makeRequest({ cookie: memberCookie, pathname: '/admin-api/quotas' }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await PUT(
          makeRequest({
            body: { maxCalls: 10 },
            cookie: memberCookie,
            method: 'PUT',
            pathname: quotaPath('user', member.userId),
          }),
          paramsContext({ ownerId: member.userId, ownerType: 'user' }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await DELETE(
          makeRequest({
            cookie: memberCookie,
            method: 'DELETE',
            pathname: quotaPath('user', member.userId),
          }),
          paramsContext({ ownerId: member.userId, ownerType: 'user' }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await GET(
          makeRequest({
            cookie: memberCookie,
            pathname: quotaPath('user', member.userId),
          }),
          paramsContext({ ownerId: member.userId, ownerType: 'user' }),
        )
      ).status,
    ).toBe(403);

    expect(
      (
        await GET(
          makeRequest({
            cookie,
            pathname: quotaPath('user', member.userId),
          }),
          paramsContext({ ownerId: member.userId, ownerType: 'user' }),
        )
      ).status,
    ).toBe(200);
  });

  it('lists the balance of every application and user', async () => {
    const cookie = await setupOwnerSession(OWNER_PASSWORD);
    const member = await createUser({
      password: MEMBER_PASSWORD,
      role: 'member',
      username: 'worker',
    });

    await createApplication({
      credentialFilenames: [],
      name: 'Owned app',
      ownerUserId: member.userId,
    });

    const response = await LIST_BALANCES(
      makeRequest({ cookie, pathname: '/admin-api/quotas' }),
    );

    expect(response.status).toBe(200);

    const { balances } = (await response.json()) as {
      balances: Array<{
        configured: boolean;
        name: string;
        ownerId: string;
        ownerType: string;
        period: string;
      }>;
    };

    expect(balances).toHaveLength(3);
    expect(
      balances
        .map((item) => `${item.ownerType}:${item.name}`)
        .sort((left, right) => left.localeCompare(right)),
    ).toEqual(['app:Owned app', 'user:admin', 'user:worker']);
    expect(balances.every((item) => item.configured === false)).toBe(true);
    expect(balances.every((item) => item.period === 'monthly')).toBe(true);

    const invalidPeriod = await LIST_BALANCES(
      makeRequest({ cookie, pathname: '/admin-api/quotas?period=yearly' }),
    );

    expect(invalidPeriod.status).toBe(400);
    expect((await readApiError(invalidPeriod))?.code).toBe('invalid_request');
  });

  it('sets, reads and deletes a quota', async () => {
    const cookie = await setupOwnerSession(OWNER_PASSWORD);
    const member = await createUser({
      password: MEMBER_PASSWORD,
      role: 'member',
      username: 'worker',
    });
    const context = paramsContext({
      ownerId: member.userId,
      ownerType: 'user',
    });

    const created = await PUT(
      makeRequest({
        body: { maxCalls: 10 },
        cookie,
        method: 'PUT',
        pathname: quotaPath('user', member.userId),
      }),
      context,
    );

    expect(created.status).toBe(200);

    const payload = (await created.json()) as QuotaBalancePayload;

    expect(payload.quota).toMatchObject({ maxCalls: 10, maxTokens: null });
    expect(payload.balance).toMatchObject({
      configured: true,
      maxCalls: 10,
      maxTokens: null,
      ownerId: member.userId,
      ownerType: 'user',
      remainingCalls: 10,
      usedCalls: 0,
    });

    const merged = await PUT(
      makeRequest({
        body: { maxTokens: 1000 },
        cookie,
        method: 'PUT',
        pathname: quotaPath('user', member.userId),
      }),
      context,
    );
    const mergedPayload = (await merged.json()) as QuotaBalancePayload;

    expect(mergedPayload.quota).toMatchObject({
      maxCalls: 10,
      maxTokens: 1000,
    });

    const unlimited = await PUT(
      makeRequest({
        body: { maxCalls: null },
        cookie,
        method: 'PUT',
        pathname: quotaPath('user', member.userId),
      }),
      context,
    );
    const unlimitedPayload = (await unlimited.json()) as QuotaBalancePayload;

    expect(unlimitedPayload.quota).toMatchObject({
      maxCalls: null,
      maxTokens: 1000,
    });
    expect(unlimitedPayload.balance.remainingCalls).toBeNull();

    // A different period is a different document.
    const daily = await GET(
      makeRequest({
        cookie,
        pathname: quotaPath('user', member.userId, 'daily'),
      }),
      context,
    );

    expect((await daily.json()) as QuotaBalancePayload).toMatchObject({
      balance: { configured: false, period: 'daily' },
    });

    const monthly = await GET(
      makeRequest({
        cookie,
        pathname: quotaPath('user', member.userId, 'monthly'),
      }),
      context,
    );

    expect((await monthly.json()) as QuotaBalancePayload).toMatchObject({
      balance: { configured: true, period: 'monthly' },
    });

    const removed = await DELETE(
      makeRequest({
        cookie,
        method: 'DELETE',
        pathname: quotaPath('user', member.userId),
      }),
      context,
    );

    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ success: true });

    expect(
      (
        await DELETE(
          makeRequest({
            cookie,
            method: 'DELETE',
            pathname: quotaPath('user', member.userId),
          }),
          context,
        )
      ).status,
    ).toBe(404);
  });

  it('supports application owners', async () => {
    const cookie = await setupOwnerSession(OWNER_PASSWORD);
    const { application } = await createApplication({
      credentialFilenames: [],
      name: 'Owned app',
    });
    const context = paramsContext({
      ownerId: application.id,
      ownerType: 'app',
    });
    const response = await PUT(
      makeRequest({
        body: { maxCalls: 0 },
        cookie,
        method: 'PUT',
        pathname: quotaPath('app', application.id),
      }),
      context,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      balance: {
        configured: true,
        maxCalls: 0,
        ownerType: 'app',
        remainingCalls: 0,
      },
    });
  });

  it('validates the owner, period and limits', async () => {
    const cookie = await setupOwnerSession(OWNER_PASSWORD);
    const missingId = '00000000-0000-0000-0000-000000000000';
    const put = (
      pathname: string,
      params: { ownerId: string; ownerType: string },
      body: unknown,
    ) =>
      PUT(
        makeRequest({
          body,
          cookie,
          method: 'PUT',
          pathname,
        }),
        paramsContext(params),
      );

    expect(
      (
        await GET(
          makeRequest({
            cookie,
            pathname: quotaPath('team', missingId),
          }),
          paramsContext({ ownerId: missingId, ownerType: 'team' }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await GET(
          makeRequest({
            cookie,
            pathname: quotaPath('user', missingId, 'weekly'),
          }),
          paramsContext({ ownerId: missingId, ownerType: 'user' }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await GET(
          makeRequest({
            cookie,
            pathname: quotaPath('user', missingId),
          }),
          paramsContext({ ownerId: missingId, ownerType: 'user' }),
        )
      ).status,
    ).toBe(404);

    const ownerId = (await listPublicUsers())[0].userId;

    for (const body of [
      { maxCalls: -1 },
      { maxCalls: 1.5 },
      { maxCalls: 'ten' },
      { maxTokens: -1 },
    ]) {
      const invalid = await put(
        quotaPath('user', ownerId),
        { ownerId, ownerType: 'user' },
        body,
      );

      expect(invalid.status).toBe(400);
      expect((await readApiError(invalid))?.code).toBe('invalid_request');
    }

    const malformed = await put(
      quotaPath('user', ownerId),
      { ownerId, ownerType: 'user' },
      '{',
    );

    expect(malformed.status).toBe(400);
    expect((await readApiError(malformed))?.code).toBe('invalid_json');
  });
});
