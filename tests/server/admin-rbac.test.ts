import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { createPasswordHash } from '@/lib/server/admin/password';
import { requireRole, type RoleGuardResult } from '@/lib/server/admin/rbac';
import {
  getAdminSessionSummary,
  loginWithAdminPassword,
  setupAdminPassword,
} from '@/lib/server/admin/session';
import {
  authenticateUser,
  createUser,
  getUserByUsername,
  listPublicUsers,
} from '@/lib/server/domain/users';
import { readStorageJson, resetStorageRuntime } from '@/lib/server/storage';

const repoRoot = process.cwd();
const tempRootDir = path.join(repoRoot, '.tmp-test-admin-rbac');
const dataDir = path.join(tempRootDir, '.codebuddy_data');
const ADMIN_COOKIE = 'codebuddy_admin_session';

const cleanupTempState = (): void => {
  fs.rmSync(tempRootDir, { force: true, recursive: true, maxRetries: 5 });
};

const makeRequest = (pathname: string, cookie?: string) => {
  const host = 'localhost:3000';

  return new Request(`http://${host}${pathname}`, {
    headers: {
      ...(cookie ? { cookie } : {}),
      host,
      'x-forwarded-host': host,
      'x-forwarded-proto': 'http',
    },
  });
};

const getCookieHeader = (response: Response): string => {
  return response.headers.get('set-cookie') ?? '';
};

const expectRejection = (guard: RoleGuardResult): Response => {
  if (guard.ok) {
    throw new Error('Expected the role guard to reject the request');
  }

  return guard.response;
};

const expectUser = (guard: RoleGuardResult) => {
  if (!guard.ok) {
    throw new Error('Expected the role guard to accept the request');
  }

  return guard.user;
};

describe('admin role guard', () => {
  beforeEach(() => {
    cleanupTempState();
    resetStorageRuntime();
    vi.restoreAllMocks();
    vi.spyOn(process, 'cwd').mockReturnValue(tempRootDir);
    delete process.env.CODEBUDDY_STORAGE_BACKEND;
    delete process.env.CODEBUDDY_STORAGE_FILE_DIR;
    delete process.env.CODEBUDDY_STORAGE_PERSISTENCE;
    delete process.env.CODEBUDDY_STORAGE_PG_URL;
    delete process.env.CODEBUDDY_STORAGE_ENCRYPTION_KEY;
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    cleanupTempState();
  });

  it('requires an admin session before guarded routes can be used', async () => {
    const unconfigured = expectRejection(
      await requireRole(makeRequest('/admin-api/users'), ['owner']),
    );

    expect(unconfigured.status).toBe(401);
    await expect(unconfigured.json()).resolves.toEqual({
      error: {
        code: 'admin_auth_required',
        message: 'Admin session required',
      },
    });

    const setupResponse = await setupAdminPassword(
      makeRequest('/admin-api/auth/setup'),
      'correct horse battery staple',
    );
    const sessionCookie = getCookieHeader(setupResponse);

    const anonymous = expectRejection(
      await requireRole(makeRequest('/admin-api/users'), ['owner']),
    );

    expect(anonymous.status).toBe(401);

    const ownerGuard = await requireRole(
      makeRequest('/admin-api/users', sessionCookie),
      ['owner'],
    );

    expect(expectUser(ownerGuard)).toMatchObject({
      role: 'owner',
      status: 'active',
      username: 'admin',
    });
  });

  it('blocks members from owner-only routes while allowing their own', async () => {
    const setupResponse = await setupAdminPassword(
      makeRequest('/admin-api/auth/setup'),
      'correct horse battery staple',
    );
    const ownerCookie = getCookieHeader(setupResponse);
    const member = await createUser({
      password: 'member-password',
      role: 'member',
      username: 'worker',
    });

    const loginResponse = await loginWithAdminPassword(
      makeRequest('/admin-api/auth/session'),
      'worker',
      'member-password',
    );

    expect(loginResponse.status).toBe(200);

    const memberCookie = getCookieHeader(loginResponse);
    const summary = await getAdminSessionSummary(
      makeRequest('/admin-api/me', memberCookie),
    );

    expect(summary.authenticated).toBe(true);
    expect(summary.user).toMatchObject({
      role: 'member',
      userId: member.userId,
      username: 'worker',
    });

    const blocked = expectRejection(
      await requireRole(makeRequest('/admin-api/users', memberCookie), [
        'owner',
      ]),
    );

    expect(blocked.status).toBe(403);
    await expect(blocked.json()).resolves.toEqual({
      error: {
        code: 'admin_role_required',
        message: 'Role "member" is not allowed for this resource',
      },
    });

    const allowed = await requireRole(
      makeRequest('/admin-api/me', memberCookie),
      ['member'],
    );

    expect(expectUser(allowed).userId).toBe(member.userId);
    expect(
      expectUser(
        await requireRole(makeRequest('/admin-api/users', ownerCookie), [
          'owner',
          'admin',
        ]),
      ).role,
    ).toBe('owner');
  });

  it('passes storage failures through as a 503 response', async () => {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'admin-auth.json'), '{');

    const failure = expectRejection(
      await requireRole(makeRequest('/admin-api/users'), ['owner']),
    );

    expect(failure.status).toBe(503);
    await expect(failure.json()).resolves.toEqual({
      error: {
        code: 'admin_auth_storage_unavailable',
        message: 'Admin authentication storage is unreadable',
      },
    });
  });

  it('migrates a legacy admin account into an owner user without breaking sessions', async () => {
    const password = 'legacy horse battery staple';
    const credential = createPasswordHash(password);
    const token = 'legacy-session-token';
    const tokenHash = createHash('sha256').update(token).digest('hex');

    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, 'admin-auth.json'),
      JSON.stringify({
        enabled: true,
        passkeys: [],
        password: {
          hash: credential.hash,
          salt: credential.salt,
          updatedAt: new Date().toISOString(),
        },
        pendingChallenges: [],
        sessions: [
          {
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            id: 'legacy-session',
            lastUsedAt: new Date().toISOString(),
            tokenHash,
          },
        ],
        username: 'legacy-admin',
      }),
    );

    expect(await listPublicUsers()).toEqual([]);

    const guard = await requireRole(
      makeRequest('/admin-api/users', `${ADMIN_COOKIE}=${token}`),
      ['owner'],
    );
    const owner = expectUser(guard);

    expect(owner).toMatchObject({
      role: 'owner',
      status: 'active',
      username: 'legacy-admin',
    });
    expect(owner).not.toHaveProperty('passwordHash');

    const stored = await getUserByUsername('legacy-admin');

    expect(stored?.passwordHash).toBe(credential.hash);
    expect(stored?.passwordSalt).toBe(credential.salt);
    expect(await authenticateUser('legacy-admin', password)).not.toBeNull();

    const state = await readStorageJson<{
      sessions: Array<{ userId?: string }>;
    }>('admin-auth', 'state');

    expect(state?.sessions[0]?.userId).toBe(stored?.userId);
    expect(
      (
        await loginWithAdminPassword(
          makeRequest('/admin-api/auth/session'),
          'legacy-admin',
          password,
        )
      ).status,
    ).toBe(200);
  });
});
