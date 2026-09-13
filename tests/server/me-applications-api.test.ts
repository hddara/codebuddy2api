import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GET as GET_ACCESS_KEYS } from '@/app/admin-api/access-keys/route';
import { GET as GET_ACCOUNT_STATUS } from '@/app/admin-api/account-status/route';
import { GET as GET_CREDENTIALS } from '@/app/admin-api/credentials/route';
import { GET as GET_DEBUG } from '@/app/admin-api/debug/route';
import { DELETE, PATCH } from '@/app/me/applications/[id]/route';
import { GET, POST } from '@/app/me/applications/route';
import { loginWithAdminPassword } from '@/lib/server/admin/session';
import {
  createApplication,
  findApplicationById,
  getAllowedCredentialFilenames,
} from '@/lib/server/domain/applications';
import { createUser } from '@/lib/server/domain/users';

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

interface OwnedApplication {
  credentialFilenames: string[];
  description: string;
  id: string;
  name: string;
  ownerUserId: string | null;
  secret: string;
  status: string;
}

describe('member owned API keys', () => {
  let cleanupTempState: () => void;

  beforeEach(() => {
    cleanupTempState = useTempStorage('.tmp-test-me-applications');
  });

  afterEach(() => {
    cleanupTempState();
  });

  const signIn = async (username: string, password: string) => {
    return getCookieHeader(
      await loginWithAdminPassword(
        makeRequest({ method: 'POST', pathname: '/admin-api/auth/session' }),
        username,
        password,
      ),
    );
  };

  const createMember = async (username: string) => {
    return createUser({
      password: MEMBER_PASSWORD,
      role: 'member',
      username,
    });
  };

  it('treats an unbound credential list as unrestricted', () => {
    expect(getAllowedCredentialFilenames(null)).toBeUndefined();
    expect(
      getAllowedCredentialFilenames({ credentialFilenames: [] }),
    ).toBeUndefined();
    expect(
      getAllowedCredentialFilenames({ credentialFilenames: ['one.json'] }),
    ).toEqual(['one.json']);
  });

  it('lets a member create, rename, disable and delete their own key', async () => {
    await setupOwnerSession(OWNER_PASSWORD);
    const member = await createMember('worker');
    const cookie = await signIn('worker', MEMBER_PASSWORD);

    const created = await POST(
      makeRequest({
        body: { description: '我的密钥', name: 'My key' },
        cookie,
        method: 'POST',
        pathname: '/me/applications',
      }),
    );

    expect(created.status).toBe(200);

    const { application } = (await created.json()) as {
      application: OwnedApplication;
    };

    expect(application).toMatchObject({
      description: '我的密钥',
      name: 'My key',
      ownerUserId: member.userId,
      status: 'active',
    });
    expect(application.credentialFilenames).toEqual([]);
    expect(application.secret).toMatch(/^cb2_/);

    // The secret is readable later by its owner.
    const listed = (await (
      await GET(makeRequest({ cookie, pathname: '/me/applications' }))
    ).json()) as { applications: OwnedApplication[] };

    expect(listed.applications.map((item) => item.secret)).toEqual([
      application.secret,
    ]);

    const patched = await PATCH(
      makeRequest({
        body: {
          credentialFilenames: ['someone-else.json'],
          description: '改过的描述',
          name: 'Renamed key',
          ownerUserId: 'attacker',
          status: 'disabled',
        },
        cookie,
        method: 'PATCH',
        pathname: `/me/applications/${application.id}`,
      }),
      paramsContext({ id: application.id }),
    );

    expect(patched.status).toBe(200);

    const updated = (await patched.json()) as {
      application: OwnedApplication;
    };

    expect(updated.application).toMatchObject({
      description: '改过的描述',
      name: 'Renamed key',
      ownerUserId: member.userId,
      status: 'disabled',
    });
    expect(updated.application.credentialFilenames).toEqual([]);

    const stored = await findApplicationById(application.id);

    expect(stored?.ownerUserId).toBe(member.userId);
    expect(stored?.credentialFilenames).toEqual([]);

    const deleted = await DELETE(
      makeRequest({
        cookie,
        method: 'DELETE',
        pathname: `/me/applications/${application.id}`,
      }),
      paramsContext({ id: application.id }),
    );

    expect(deleted.status).toBe(200);
    expect(await findApplicationById(application.id)).toBeNull();
  });

  it('validates the member key payload', async () => {
    await setupOwnerSession(OWNER_PASSWORD);
    await createMember('worker');
    const cookie = await signIn('worker', MEMBER_PASSWORD);
    const create = (body: unknown) =>
      POST(
        makeRequest({
          body,
          cookie,
          method: 'POST',
          pathname: '/me/applications',
        }),
      );

    expect((await create({ description: 'no name' })).status).toBe(400);
    expect((await create({ name: '   ' })).status).toBe(400);
    expect((await create({ description: 42, name: 'Key' })).status).toBe(400);
    expect((await create('{')).status).toBe(400);

    const missingId = '00000000-0000-0000-0000-000000000000';
    const patch = await PATCH(
      makeRequest({
        body: { name: 'Nope' },
        cookie,
        method: 'PATCH',
        pathname: `/me/applications/${missingId}`,
      }),
      paramsContext({ id: missingId }),
    );

    expect(patch.status).toBe(404);
    expect((await readApiError(patch))?.code).toBe('not_found');
  });

  it('hides another member key behind a 404', async () => {
    await setupOwnerSession(OWNER_PASSWORD);
    const worker = await createMember('worker');
    await createMember('other');

    const foreign = await createApplication({
      credentialFilenames: [],
      name: 'Foreign key',
      ownerUserId: worker.userId,
    });
    const cookie = await signIn('other', MEMBER_PASSWORD);
    const listed = (await (
      await GET(makeRequest({ cookie, pathname: '/me/applications' }))
    ).json()) as { applications: OwnedApplication[] };

    expect(listed.applications).toEqual([]);

    const patch = await PATCH(
      makeRequest({
        body: { name: 'Stolen' },
        cookie,
        method: 'PATCH',
        pathname: `/me/applications/${foreign.application.id}`,
      }),
      paramsContext({ id: foreign.application.id }),
    );

    expect(patch.status).toBe(404);

    const remove = await DELETE(
      makeRequest({
        cookie,
        method: 'DELETE',
        pathname: `/me/applications/${foreign.application.id}`,
      }),
      paramsContext({ id: foreign.application.id }),
    );

    expect(remove.status).toBe(404);
    expect(await findApplicationById(foreign.application.id)).not.toBeNull();
  });

  it('keeps codebuddy accounts and console tooling administrator only', async () => {
    await setupOwnerSession(OWNER_PASSWORD);
    await createMember('worker');
    const cookie = await signIn('worker', MEMBER_PASSWORD);
    const adminOnly = [
      ['/admin-api/credentials', GET_CREDENTIALS],
      ['/admin-api/access-keys', GET_ACCESS_KEYS],
      ['/admin-api/account-status', GET_ACCOUNT_STATUS],
      ['/admin-api/debug', GET_DEBUG],
    ] as const;

    for (const [pathname, handler] of adminOnly) {
      const response = await handler(makeRequest({ cookie, pathname }));

      expect(response.status, pathname).toBe(403);
      expect((await readApiError(response))?.code, pathname).toBe(
        'admin_role_required',
      );
    }
  });
});
