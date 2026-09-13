import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DELETE, GET } from '@/app/admin-api/sessions/route';
import { GET as GET_ONE } from '@/app/admin-api/sessions/[id]/route';
import { loginWithAdminPassword } from '@/lib/server/admin/session';
import {
  recordSessionLog,
  resetSessionLogRuntimeState,
} from '@/lib/server/domain/session-logs';
import { createUser } from '@/lib/server/domain/users';
import { resetStorageRuntime } from '@/lib/server/storage';

import {
  getCookieHeader,
  makeRequest,
  paramsContext,
  setupOwnerSession,
} from './api-route-helpers';

const repoRoot = process.cwd();
const tempRootDir = path.join(repoRoot, '.tmp-test-sessions-api');
const OWNER_PASSWORD = 'correct horse battery staple';
const MEMBER_PASSWORD = 'member-password';

describe('admin sessions API', () => {
  const clearStorageEnv = (): void => {
    [
      'CODEBUDDY_STORAGE_BACKEND',
      'CODEBUDDY_STORAGE_ENCRYPTION_KEY',
      'CODEBUDDY_STORAGE_FILE_DIR',
      'CODEBUDDY_STORAGE_PG_URL',
      'CODEBUDDY_STORAGE_PERSISTENCE',
      'CODEBUDDY_STORAGE_SQLITE_PATH',
      'CODEBUDDY_SESSION_LOG_ENABLED',
      'DATABASE_URL',
    ].forEach((key) => {
      delete process.env[key];
    });
  };

  beforeEach(() => {
    fs.rmSync(tempRootDir, { force: true, recursive: true, maxRetries: 5 });
    resetStorageRuntime();
    resetSessionLogRuntimeState();
    clearStorageEnv();
    process.env.CODEBUDDY_STORAGE_BACKEND = 'sqlite';
    process.env.CODEBUDDY_STORAGE_ENCRYPTION_KEY = 'unit-test-encryption-key';
    process.env.CODEBUDDY_STORAGE_SQLITE_PATH = path.join(
      tempRootDir,
      'sessions.sqlite',
    );
  });

  afterEach(() => {
    fs.rmSync(tempRootDir, { force: true, recursive: true, maxRetries: 5 });
    // Never let the sqlite override reach another test file.
    clearStorageEnv();
  });

  const recordFor = async (userId: string | null) => {
    await recordSessionLog({
      accessKeyId: userId ? `app-${userId}` : null,
      accessKeyName: userId ? `App ${userId}` : null,
      messages: [{ content: 'hello', role: 'user' }],
      model: 'claude-sonnet-4',
      protocol: 'chat',
      route: '/v1/chat/completions',
      upstreamRequest: { model: 'claude-sonnet-4' },
      userId,
    });
  };

  it('requires a session', async () => {
    expect(
      (await GET(makeRequest({ pathname: '/admin-api/sessions' }))).status,
    ).toBe(401);
  });

  it('scopes members to their own conversations', async () => {
    const ownerCookie = await setupOwnerSession(OWNER_PASSWORD);
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

    await recordFor(member.userId);
    await recordFor(null);

    const ownerList = (await (
      await GET(
        makeRequest({ cookie: ownerCookie, pathname: '/admin-api/sessions' }),
      )
    ).json()) as {
      logs: Array<{ id: string; userId: string | null }>;
      state: { degraded: boolean; enabled: boolean };
    };

    expect(ownerList.logs).toHaveLength(2);
    expect(ownerList.state).toMatchObject({ degraded: false, enabled: true });

    const memberList = (await (
      await GET(
        makeRequest({ cookie: memberCookie, pathname: '/admin-api/sessions' }),
      )
    ).json()) as { logs: Array<{ id: string; userId: string | null }> };

    expect(memberList.logs).toHaveLength(1);
    expect(memberList.logs[0].userId).toBe(member.userId);

    const ownDetail = await GET_ONE(
      makeRequest({
        cookie: memberCookie,
        pathname: `/admin-api/sessions/${memberList.logs[0].id}`,
      }),
      paramsContext({ id: memberList.logs[0].id }),
    );

    expect(ownDetail.status).toBe(200);

    const foreignId =
      ownerList.logs.find((log) => log.userId === null)?.id ?? '';

    expect(
      (
        await GET_ONE(
          makeRequest({
            cookie: memberCookie,
            pathname: `/admin-api/sessions/${foreignId}`,
          }),
          paramsContext({ id: foreignId }),
        )
      ).status,
    ).toBe(404);

    expect(
      (
        await GET(
          makeRequest({
            cookie: ownerCookie,
            pathname: '/admin-api/sessions?limit=nope',
          }),
        )
      ).status,
    ).toBe(400);

    expect(
      (
        await DELETE(
          makeRequest({
            cookie: memberCookie,
            method: 'DELETE',
            pathname: '/admin-api/sessions',
          }),
        )
      ).status,
    ).toBe(403);

    const cleared = await DELETE(
      makeRequest({
        cookie: ownerCookie,
        method: 'DELETE',
        pathname: '/admin-api/sessions',
      }),
    );

    expect(cleared.status).toBe(200);
    await expect(cleared.json()).resolves.toMatchObject({ removed: 2 });
    expect(
      (
        await GET(
          makeRequest({ cookie: ownerCookie, pathname: '/admin-api/sessions' }),
        )
      ).status,
    ).toBe(200);

    const afterClear = (await (
      await GET(
        makeRequest({ cookie: ownerCookie, pathname: '/admin-api/sessions' }),
      )
    ).json()) as { logs: unknown[] };

    expect(afterClear.logs).toEqual([]);
  });
});
