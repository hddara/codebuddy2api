import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DELETE, GET, PATCH } from '@/app/admin-api/users/[id]/route';
import { GET as LIST_USERS, POST } from '@/app/admin-api/users/route';
import { loginWithAdminPassword } from '@/lib/server/admin/session';
import { authenticateUser, listPublicUsers } from '@/lib/server/domain/users';

import {
  getCookieHeader,
  makeRequest,
  paramsContext,
  readApiError,
  setupOwnerSession,
  useTempStorage,
} from './api-route-helpers';

const OWNER_PASSWORD = 'correct horse battery staple';

describe('admin users API', () => {
  let cleanupTempState: () => void;

  beforeEach(() => {
    cleanupTempState = useTempStorage('.tmp-test-users-api');
  });

  afterEach(() => {
    cleanupTempState();
  });

  const createMember = async (
    cookie: string,
    username: string,
  ): Promise<string> => {
    const response = await POST(
      makeRequest({
        body: { password: 'member-password', role: 'member', username },
        cookie,
        method: 'POST',
        pathname: '/admin-api/users',
      }),
    );
    const payload = (await response.json()) as { user: { userId: string } };

    return payload.user.userId;
  };

  it('requires an admin session', async () => {
    expect(
      (await LIST_USERS(makeRequest({ pathname: '/admin-api/users' }))).status,
    ).toBe(401);

    const created = await POST(
      makeRequest({
        body: { password: 'member-password', username: 'worker' },
        method: 'POST',
        pathname: '/admin-api/users',
      }),
    );

    expect(created.status).toBe(401);
    await expect(created.json()).resolves.toMatchObject({
      error: { code: 'admin_auth_required' },
    });
  });

  it('creates, lists, reads, updates and deletes users', async () => {
    const cookie = await setupOwnerSession(OWNER_PASSWORD);
    const created = await POST(
      makeRequest({
        body: {
          displayName: 'Worker',
          password: 'member-password',
          role: 'member',
          username: 'worker',
        },
        cookie,
        method: 'POST',
        pathname: '/admin-api/users',
      }),
    );

    expect(created.status).toBe(200);

    const { user } = (await created.json()) as {
      user: Record<string, unknown>;
    };

    expect(user).toMatchObject({
      displayName: 'Worker',
      hasPassword: true,
      role: 'member',
      status: 'active',
      username: 'worker',
    });
    expect(user).not.toHaveProperty('passwordHash');
    expect(user).not.toHaveProperty('passwordSalt');

    const listed = (await (
      await LIST_USERS(makeRequest({ cookie, pathname: '/admin-api/users' }))
    ).json()) as { users: Array<{ username: string }> };

    expect(listed.users.map((item) => item.username).sort()).toEqual([
      'admin',
      'worker',
    ]);

    const userId = String(user.userId);
    const detail = await GET(
      makeRequest({ cookie, pathname: `/admin-api/users/${userId}` }),
      paramsContext({ id: userId }),
    );

    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({ user: { userId } });

    const patched = await PATCH(
      makeRequest({
        body: {
          displayName: 'Worker Two',
          ignoredField: 'nope',
          preferences: { ignored: 'x', sessionLogEnabled: true },
          role: 'admin',
          status: 'disabled',
        },
        cookie,
        method: 'PATCH',
        pathname: `/admin-api/users/${userId}`,
      }),
      paramsContext({ id: userId }),
    );

    expect(patched.status).toBe(200);
    await expect(patched.json()).resolves.toMatchObject({
      user: {
        displayName: 'Worker Two',
        preferences: { sessionLogEnabled: true },
        role: 'admin',
        status: 'disabled',
      },
    });

    const deleted = await DELETE(
      makeRequest({
        cookie,
        method: 'DELETE',
        pathname: `/admin-api/users/${userId}`,
      }),
      paramsContext({ id: userId }),
    );

    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ success: true });
    expect((await listPublicUsers()).map((item) => item.username)).toEqual([
      'admin',
    ]);
  });

  it('validates the create payload', async () => {
    const cookie = await setupOwnerSession(OWNER_PASSWORD);
    const create = (body: unknown) =>
      POST(
        makeRequest({
          body,
          cookie,
          method: 'POST',
          pathname: '/admin-api/users',
        }),
      );

    expect((await create({ password: 'member-password' })).status).toBe(400);
    expect(
      (await create({ password: 'member-password', username: '  ' })).status,
    ).toBe(400);
    expect((await create({ role: 'root', username: 'worker' })).status).toBe(
      400,
    );
    expect((await create({ password: 12, username: 'worker' })).status).toBe(
      400,
    );
    expect((await create({ displayName: {}, username: 'worker' })).status).toBe(
      400,
    );
    expect(
      (await create({ password: 'short', username: 'worker' })).status,
    ).toBe(400);
    expect(
      (await create({ password: 'member-password', username: 'worker' }))
        .status,
    ).toBe(200);
    expect(
      (await create({ password: 'member-password', username: 'WORKER' }))
        .status,
    ).toBe(400);
  });

  it('rejects malformed JSON and unknown users', async () => {
    const cookie = await setupOwnerSession(OWNER_PASSWORD);
    const malformed = await POST(
      makeRequest({
        body: '{',
        cookie,
        method: 'POST',
        pathname: '/admin-api/users',
      }),
    );

    expect(malformed.status).toBe(400);
    expect((await readApiError(malformed))?.code).toBe('invalid_json');

    const missingId = '00000000-0000-0000-0000-000000000000';

    expect(
      (
        await GET(
          makeRequest({ cookie, pathname: `/admin-api/users/${missingId}` }),
          paramsContext({ id: missingId }),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await PATCH(
          makeRequest({
            body: { role: 'member' },
            cookie,
            method: 'PATCH',
            pathname: `/admin-api/users/${missingId}`,
          }),
          paramsContext({ id: missingId }),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await DELETE(
          makeRequest({
            cookie,
            method: 'DELETE',
            pathname: `/admin-api/users/${missingId}`,
          }),
          paramsContext({ id: missingId }),
        )
      ).status,
    ).toBe(404);
  });

  it('validates the update payload', async () => {
    const cookie = await setupOwnerSession(OWNER_PASSWORD);
    const ownerId = (await listPublicUsers())[0].userId;
    const patch = (id: string, body: unknown) =>
      PATCH(
        makeRequest({
          body,
          cookie,
          method: 'PATCH',
          pathname: `/admin-api/users/${id}`,
        }),
        paramsContext({ id }),
      );

    expect((await patch(ownerId, { role: 'root' })).status).toBe(400);
    expect((await patch(ownerId, { status: 'sleeping' })).status).toBe(400);
    expect((await patch(ownerId, { username: 42 })).status).toBe(400);
    expect((await patch(ownerId, { displayName: [] })).status).toBe(400);
    expect((await patch(ownerId, { password: 42 })).status).toBe(400);
    expect((await patch(ownerId, '{')).status).toBe(400);

    // The built-in owner credential belongs to the password settings, because
    // the admin-auth copy would keep accepting the previous password.
    const guarded = await patch(ownerId, {
      password: 'another horse battery staple',
    });

    expect(guarded.status).toBe(409);
    expect((await readApiError(guarded))?.code).toBe(
      'console_owner_credentials',
    );
    expect((await patch(ownerId, { username: 'renamed-admin' })).status).toBe(
      409,
    );

    const workerId = await createMember(cookie, 'worker');
    const otherId = await createMember(cookie, 'other');
    const changed = await patch(workerId, { password: 'worker-password-two' });

    expect(changed.status).toBe(200);
    expect(
      await authenticateUser('worker', 'worker-password-two'),
    ).not.toBeNull();
    expect(await authenticateUser('worker', 'member-password')).toBeNull();

    const conflict = await patch(otherId, { username: 'WORKER' });

    expect(conflict.status).toBe(409);
    expect((await readApiError(conflict))?.code).toBe('conflict');

    const renamed = await patch(otherId, { username: 'renamed-other' });

    expect(renamed.status).toBe(200);
    await expect(renamed.json()).resolves.toMatchObject({
      user: { displayName: 'renamed-other', username: 'renamed-other' },
    });
  });

  it('protects the last active owner', async () => {
    const cookie = await setupOwnerSession(OWNER_PASSWORD);
    const ownerId = (await listPublicUsers())[0].userId;
    const patch = (body: unknown) =>
      PATCH(
        makeRequest({
          body,
          cookie,
          method: 'PATCH',
          pathname: `/admin-api/users/${ownerId}`,
        }),
        paramsContext({ id: ownerId }),
      );

    expect((await patch({ status: 'disabled' })).status).toBe(409);
    expect((await patch({ role: 'member' })).status).toBe(409);
    expect((await readApiError(await patch({ role: 'admin' })))?.code).toBe(
      'last_owner',
    );

    const selfDelete = await DELETE(
      makeRequest({
        cookie,
        method: 'DELETE',
        pathname: `/admin-api/users/${ownerId}`,
      }),
      paramsContext({ id: ownerId }),
    );

    expect(selfDelete.status).toBe(409);
    expect((await readApiError(selfDelete))?.code).toBe('cannot_delete_self');

    const secondOwner = await POST(
      makeRequest({
        body: {
          password: 'second horse battery staple',
          role: 'owner',
          username: 'second-owner',
        },
        cookie,
        method: 'POST',
        pathname: '/admin-api/users',
      }),
    );
    const { user } = (await secondOwner.json()) as { user: { userId: string } };

    const demoted = await PATCH(
      makeRequest({
        body: { role: 'member' },
        cookie,
        method: 'PATCH',
        pathname: `/admin-api/users/${user.userId}`,
      }),
      paramsContext({ id: user.userId }),
    );

    expect(demoted.status).toBe(200);
    await expect(demoted.json()).resolves.toMatchObject({
      user: { role: 'member' },
    });

    expect(
      (
        await DELETE(
          makeRequest({
            cookie,
            method: 'DELETE',
            pathname: `/admin-api/users/${user.userId}`,
          }),
          paramsContext({ id: user.userId }),
        )
      ).status,
    ).toBe(200);
  });

  it('blocks members from managing users', async () => {
    const cookie = await setupOwnerSession(OWNER_PASSWORD);

    await createMember(cookie, 'worker');

    const memberCookie = getCookieHeader(
      await loginWithAdminPassword(
        makeRequest({ method: 'POST', pathname: '/admin-api/auth/session' }),
        'worker',
        'member-password',
      ),
    );

    expect(memberCookie).toContain('codebuddy_admin_session=');

    expect(
      (
        await LIST_USERS(
          makeRequest({ cookie: memberCookie, pathname: '/admin-api/users' }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await POST(
          makeRequest({
            body: { password: 'other-password', username: 'intruder' },
            cookie: memberCookie,
            method: 'POST',
            pathname: '/admin-api/users',
          }),
        )
      ).status,
    ).toBe(403);
    expect((await listPublicUsers()).map((item) => item.username)).toEqual([
      'admin',
      'worker',
    ]);
  });
});
