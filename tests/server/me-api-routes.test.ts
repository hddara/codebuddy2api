import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GET as LIST_OWNED_APPLICATIONS } from '@/app/me/applications/route';
import { POST as CHANGE_PASSWORD } from '@/app/me/password/route';
import { GET as GET_ME, PATCH as PATCH_ME } from '@/app/me/route';
import { loginWithAdminPassword } from '@/lib/server/admin/session';
import {
  createApplication,
  listApplicationRecords,
} from '@/lib/server/domain/applications';
import {
  authenticateUser,
  createUser,
  listPublicUsers,
} from '@/lib/server/domain/users';

import {
  getCookieHeader,
  makeRequest,
  setupOwnerSession,
  useTempStorage,
} from './api-route-helpers';

const OWNER_PASSWORD = 'correct horse battery staple';
const MEMBER_PASSWORD = 'member-password';

interface MePayload {
  balance: { configured: boolean; ownerId: string; period: string };
  user: {
    displayName: string;
    preferences: Record<string, unknown>;
    role: string;
    status: string;
    userId: string;
    username: string;
  };
}

describe('self service API', () => {
  let cleanupTempState: () => void;

  beforeEach(() => {
    cleanupTempState = useTempStorage('.tmp-test-me-api');
  });

  afterEach(() => {
    cleanupTempState();
  });

  const loginAsMember = async (
    username: string,
    password: string,
  ): Promise<string> => {
    return getCookieHeader(
      await loginWithAdminPassword(
        makeRequest({ method: 'POST', pathname: '/admin-api/auth/session' }),
        username,
        password,
      ),
    );
  };

  it('requires a session', async () => {
    expect((await GET_ME(makeRequest({ pathname: '/me' }))).status).toBe(401);

    const response = await PATCH_ME(
      makeRequest({
        body: { displayName: 'Nope' },
        method: 'PATCH',
        pathname: '/me',
      }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'admin_auth_required' },
    });
    expect(
      (
        await LIST_OWNED_APPLICATIONS(
          makeRequest({ pathname: '/me/applications' }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await CHANGE_PASSWORD(
          makeRequest({
            body: { currentPassword: 'a', newPassword: 'b' },
            method: 'POST',
            pathname: '/me/password',
          }),
        )
      ).status,
    ).toBe(401);
  });

  it('returns the profile and the user level balance', async () => {
    const cookie = await setupOwnerSession(OWNER_PASSWORD);
    const response = await GET_ME(makeRequest({ cookie, pathname: '/me' }));

    expect(response.status).toBe(200);

    const payload = (await response.json()) as MePayload;

    expect(payload.user).toMatchObject({
      role: 'owner',
      status: 'active',
      username: 'admin',
    });
    expect(payload.user).not.toHaveProperty('passwordHash');
    expect(payload.balance).toMatchObject({
      configured: false,
      ownerId: payload.user.userId,
      period: 'monthly',
    });
  });

  it('updates safe profile fields only', async () => {
    await setupOwnerSession(OWNER_PASSWORD);
    const member = await createUser({
      password: MEMBER_PASSWORD,
      role: 'member',
      username: 'worker',
    });
    const cookie = await loginAsMember('worker', MEMBER_PASSWORD);

    expect(cookie).toContain('codebuddy_admin_session=');

    const response = await PATCH_ME(
      makeRequest({
        body: {
          displayName: 'Worker Two',
          preferences: {
            ignored: 'x',
            sessionLogEnabled: true,
            timeZone: 'Asia/Shanghai',
          },
          role: 'owner',
          status: 'disabled',
        },
        cookie,
        method: 'PATCH',
        pathname: '/me',
      }),
    );

    expect(response.status).toBe(200);

    const payload = (await response.json()) as MePayload;

    expect(payload.user).toMatchObject({
      displayName: 'Worker Two',
      preferences: { sessionLogEnabled: true, timeZone: 'Asia/Shanghai' },
      role: 'member',
      status: 'active',
      userId: member.userId,
    });
    expect(payload.user.preferences).not.toHaveProperty('ignored');

    expect(
      (
        await PATCH_ME(
          makeRequest({
            body: { displayName: 42 },
            cookie,
            method: 'PATCH',
            pathname: '/me',
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await PATCH_ME(
          makeRequest({
            body: '{',
            cookie,
            method: 'PATCH',
            pathname: '/me',
          }),
        )
      ).status,
    ).toBe(400);

    // Only the member was touched; the owner keeps its own profile.
    const users = await listPublicUsers();

    expect(
      users.find((user) => user.userId === member.userId)?.displayName,
    ).toBe('Worker Two');
    expect(users.find((user) => user.username === 'admin')?.displayName).toBe(
      'admin',
    );
  });

  it('lists only the owned applications with plaintext secrets', async () => {
    const ownerCookie = await setupOwnerSession(OWNER_PASSWORD);
    const member = await createUser({
      password: MEMBER_PASSWORD,
      role: 'member',
      username: 'worker',
    });

    await createApplication({
      credentialFilenames: [],
      name: 'Other app',
      ownerUserId: '00000000-0000-0000-0000-000000000000',
    });

    const { secret } = await createApplication({
      credentialFilenames: [],
      description: 'Mine',
      name: 'Owned app',
      ownerUserId: member.userId,
    });
    const cookie = await loginAsMember('worker', MEMBER_PASSWORD);
    const response = await LIST_OWNED_APPLICATIONS(
      makeRequest({ cookie, pathname: '/me/applications' }),
    );

    expect(response.status).toBe(200);

    const { applications } = (await response.json()) as {
      applications: Array<Record<string, unknown>>;
    };

    expect(applications).toHaveLength(1);
    expect(applications[0]).toMatchObject({
      description: 'Mine',
      name: 'Owned app',
      ownerUserId: member.userId,
      secret,
    });
    expect(applications[0]).not.toHaveProperty('maskedSecret');
    expect(await listApplicationRecords()).toHaveLength(2);

    // The owner does not see applications owned by somebody else either.
    const adminList = await LIST_OWNED_APPLICATIONS(
      makeRequest({ cookie: ownerCookie, pathname: '/me/applications' }),
    );

    expect(
      ((await adminList.json()) as { applications: unknown[] }).applications,
    ).toHaveLength(0);
  });

  it('changes a member password without touching admin sessions', async () => {
    await setupOwnerSession(OWNER_PASSWORD);
    await createUser({
      password: MEMBER_PASSWORD,
      role: 'member',
      username: 'worker',
    });
    const cookie = await loginAsMember('worker', MEMBER_PASSWORD);
    const change = (body: unknown) =>
      CHANGE_PASSWORD(
        makeRequest({ body, cookie, method: 'POST', pathname: '/me/password' }),
      );

    expect((await change({ currentPassword: MEMBER_PASSWORD })).status).toBe(
      400,
    );
    expect(
      (
        await change({
          currentPassword: MEMBER_PASSWORD,
          newPassword: 'short',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await change({
          currentPassword: 'wrong-password',
          newPassword: 'member-password-two',
        })
      ).status,
    ).toBe(401);
    expect(
      (await change({ currentPassword: MEMBER_PASSWORD, newPassword: '{' }))
        .status,
    ).toBe(400);

    const changed = await change({
      currentPassword: MEMBER_PASSWORD,
      newPassword: 'member-password-two',
    });

    expect(changed.status).toBe(200);
    await expect(changed.json()).resolves.toEqual({ success: true });
    expect(
      await authenticateUser('worker', 'member-password-two'),
    ).not.toBeNull();
    expect(await authenticateUser('worker', MEMBER_PASSWORD)).toBeNull();

    // The session stays valid and the new password works for a fresh login.
    expect(
      (await GET_ME(makeRequest({ cookie, pathname: '/me' }))).status,
    ).toBe(200);
    const relogin = await loginWithAdminPassword(
      makeRequest({ method: 'POST', pathname: '/admin-api/auth/session' }),
      'worker',
      'member-password-two',
    );

    expect(relogin.status).toBe(200);
  });

  it('keeps the owner credential in sync with the admin auth state', async () => {
    const cookie = await setupOwnerSession(OWNER_PASSWORD);
    const change = (body: unknown) =>
      CHANGE_PASSWORD(
        makeRequest({ body, cookie, method: 'POST', pathname: '/me/password' }),
      );

    expect(
      (
        await change({
          currentPassword: 'wrong-password',
          newPassword: 'owner-password-two',
        })
      ).status,
    ).toBe(401);

    const changed = await change({
      currentPassword: OWNER_PASSWORD,
      newPassword: 'owner-password-two',
    });

    expect(changed.status).toBe(200);
    expect(
      await authenticateUser('admin', 'owner-password-two'),
    ).not.toBeNull();

    const relogin = await loginWithAdminPassword(
      makeRequest({ method: 'POST', pathname: '/admin-api/auth/session' }),
      'admin',
      'owner-password-two',
    );
    const staleLogin = await loginWithAdminPassword(
      makeRequest({ method: 'POST', pathname: '/admin-api/auth/session' }),
      'admin',
      OWNER_PASSWORD,
    );

    expect(relogin.status).toBe(200);
    expect(staleLogin.status).toBe(401);
    expect(
      (await GET_ME(makeRequest({ cookie, pathname: '/me' }))).status,
    ).toBe(200);
  });
});
