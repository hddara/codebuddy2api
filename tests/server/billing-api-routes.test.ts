import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DELETE, GET, PUT } from '@/app/admin-api/billing/[userId]/route';
import { loginWithAdminPassword } from '@/lib/server/admin/session';
import { createUser } from '@/lib/server/domain/users';

import {
  getCookieHeader,
  makeRequest,
  paramsContext,
  setupOwnerSession,
  useTempStorage,
} from './api-route-helpers';

const OWNER_PASSWORD = 'correct horse battery staple';
const MEMBER_PASSWORD = 'member-password';

describe('admin billing API', () => {
  let cleanupTempState: () => void;

  beforeEach(() => {
    cleanupTempState = useTempStorage('.tmp-test-billing-api');
  });

  afterEach(() => {
    cleanupTempState();
  });

  const billingPath = (userId: string): string =>
    `/admin-api/billing/${userId}`;

  it('requires a session and an owner role for writes', async () => {
    await setupOwnerSession(OWNER_PASSWORD);

    const member = await createUser({
      password: MEMBER_PASSWORD,
      role: 'member',
      username: 'worker',
    });
    const context = paramsContext({ userId: member.userId });

    expect(
      (
        await GET(
          makeRequest({ pathname: billingPath(member.userId) }),
          context,
        )
      ).status,
    ).toBe(401);

    const memberCookie = getCookieHeader(
      await loginWithAdminPassword(
        makeRequest({ method: 'POST', pathname: '/admin-api/auth/session' }),
        'worker',
        MEMBER_PASSWORD,
      ),
    );

    expect(
      (
        await PUT(
          makeRequest({
            body: { topUpTokens: 10 },
            cookie: memberCookie,
            method: 'PUT',
            pathname: billingPath(member.userId),
          }),
          context,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await GET(
          makeRequest({
            cookie: memberCookie,
            pathname: billingPath(member.userId),
          }),
          context,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await DELETE(
          makeRequest({
            cookie: memberCookie,
            method: 'DELETE',
            pathname: billingPath(member.userId),
          }),
          context,
        )
      ).status,
    ).toBe(403);
  });

  it('tops up the balance, sets and clears a plan, then deletes the account', async () => {
    const cookie = await setupOwnerSession(OWNER_PASSWORD);
    const user = await createUser({
      password: MEMBER_PASSWORD,
      role: 'member',
      username: 'paid',
    });
    const context = paramsContext({ userId: user.userId });
    const json = (response: Response) =>
      response.json() as Promise<{
        account: {
          balanceTokens: number;
          plan: {
            expiresAt: string;
            name: string;
            period: string;
            startedAt: string;
            tokens: number;
          } | null;
        } | null;
      }>;

    expect(
      (
        await json(
          await GET(
            makeRequest({ cookie, pathname: billingPath(user.userId) }),
            context,
          ),
        )
      ).account,
    ).toBeNull();

    const put = (body: unknown) =>
      PUT(
        makeRequest({
          body,
          cookie,
          method: 'PUT',
          pathname: billingPath(user.userId),
        }),
        context,
      );

    // Top-ups accumulate on top of the stored balance.
    await put({ topUpTokens: 100 });

    expect(
      (await json(await put({ topUpTokens: 50 }))).account?.balanceTokens,
    ).toBe(150);

    // A plan without an expiry derives one from its period.
    const planPayload = await json(
      await put({
        plan: { name: 'VIP monthly', period: 'monthly', tokens: 1000 },
      }),
    );

    expect(planPayload.account?.plan).toMatchObject({
      name: 'VIP monthly',
      period: 'monthly',
      tokens: 1000,
    });
    expect(
      Date.parse(planPayload.account?.plan?.expiresAt ?? ''),
    ).toBeGreaterThan(Date.parse(planPayload.account?.plan?.startedAt ?? ''));

    // balanceTokens replaces the balance instead of accumulating.
    expect(
      (await json(await put({ balanceTokens: 7 }))).account?.balanceTokens,
    ).toBe(7);

    // `plan: null` revokes the plan and keeps the balance.
    const revoked = await json(await put({ plan: null }));

    expect(revoked.account?.plan).toBeNull();
    expect(revoked.account?.balanceTokens).toBe(7);

    const stored = await json(
      await GET(
        makeRequest({ cookie, pathname: billingPath(user.userId) }),
        context,
      ),
    );

    expect(stored.account?.balanceTokens).toBe(7);

    expect(
      (
        await DELETE(
          makeRequest({
            cookie,
            method: 'DELETE',
            pathname: billingPath(user.userId),
          }),
          context,
        )
      ).status,
    ).toBe(200);

    const afterDelete = await json(
      await GET(
        makeRequest({ cookie, pathname: billingPath(user.userId) }),
        context,
      ),
    );

    expect(afterDelete.account).toBeNull();
  });

  it('rejects invalid payloads and unknown users', async () => {
    const cookie = await setupOwnerSession(OWNER_PASSWORD);
    const user = await createUser({
      password: MEMBER_PASSWORD,
      role: 'member',
      username: 'paid-errors',
    });
    const context = paramsContext({ userId: user.userId });
    const put = (body: unknown) =>
      PUT(
        makeRequest({
          body,
          cookie,
          method: 'PUT',
          pathname: billingPath(user.userId),
        }),
        context,
      );

    expect((await put({ balanceTokens: -1 })).status).toBe(400);
    expect((await put({ topUpTokens: 1.5 })).status).toBe(400);
    expect((await put({ plan: { tokens: 10 } })).status).toBe(400);
    expect((await put({ plan: { name: 'x', tokens: -5 } })).status).toBe(400);

    expect(
      (
        await GET(
          makeRequest({ cookie, pathname: billingPath('missing-user') }),
          paramsContext({ userId: 'missing-user' }),
        )
      ).status,
    ).toBe(404);
  });
});
