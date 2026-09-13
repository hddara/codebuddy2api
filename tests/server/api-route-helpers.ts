import fs from 'node:fs';
import path from 'node:path';

import { vi } from 'vitest';

import { setupAdminPassword } from '@/lib/server/admin/session';
import { resetStorageRuntime } from '@/lib/server/storage';

const repoRoot = process.cwd();
const host = 'localhost:3000';

/**
 * Points the storage layer at an isolated directory so the admin API routes can
 * run against the real file backend instead of mocks.
 */
export const useTempStorage = (name: string): (() => void) => {
  const rootDir = path.join(repoRoot, name);
  const cleanup = (): void => {
    fs.rmSync(rootDir, { force: true, recursive: true, maxRetries: 5 });
  };

  cleanup();
  resetStorageRuntime();
  vi.restoreAllMocks();
  vi.spyOn(process, 'cwd').mockReturnValue(rootDir);

  [
    'CODEBUDDY_STORAGE_BACKEND',
    'CODEBUDDY_STORAGE_FILE_DIR',
    'CODEBUDDY_STORAGE_PERSISTENCE',
    'CODEBUDDY_STORAGE_PG_URL',
    'CODEBUDDY_STORAGE_ENCRYPTION_KEY',
    'DATABASE_URL',
  ].forEach((key) => {
    delete process.env[key];
  });

  return cleanup;
};

export const makeRequest = ({
  body,
  cookie,
  method = 'GET',
  pathname,
}: {
  body?: unknown;
  cookie?: string;
  method?: string;
  pathname: string;
}): Request => {
  const headers: Record<string, string> = {
    host,
    'x-forwarded-host': host,
    'x-forwarded-proto': 'http',
  };

  if (cookie) {
    headers.cookie = cookie;
  }

  if (body !== undefined) {
    headers['content-type'] = 'application/json';
  }

  return new Request(`http://${host}${pathname}`, {
    headers,
    method,
    ...(body === undefined
      ? {}
      : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
};

export const paramsContext = <T extends Record<string, string>>(params: T) => ({
  params: Promise.resolve(params),
});

export const getCookieHeader = (response: Response): string => {
  return response.headers.get('set-cookie') ?? '';
};

export const readApiError = async (
  response: Response,
): Promise<{ code?: string; message?: string } | undefined> => {
  const payload = (await response.json()) as {
    error?: { code?: string; message?: string };
  };

  return payload.error;
};

/** Creates the built-in administrator and returns its session cookie. */
export const setupOwnerSession = async (password: string): Promise<string> => {
  return getCookieHeader(
    await setupAdminPassword(
      makeRequest({ method: 'POST', pathname: '/admin-api/auth/setup' }),
      password,
    ),
  );
};
