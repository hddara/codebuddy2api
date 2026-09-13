import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearSessionLogs,
  getSessionLog,
  getSessionLogState,
  listSessionLogs,
  recordSessionLog,
  resetSessionLogRuntimeState,
} from '@/lib/server/domain/session-logs';
import { createApplication } from '@/lib/server/domain/applications';
import {
  readStorageJson,
  resetStorageRuntime,
  writeStorageJson,
} from '@/lib/server/storage';

const repoRoot = process.cwd();
const tempRootDir = path.join(repoRoot, '.tmp-test-session-logs');
const databasePath = path.join(tempRootDir, 'storage.sqlite');

const cleanupTempState = (): void => {
  fs.rmSync(tempRootDir, { force: true, recursive: true, maxRetries: 5 });
};

const clearStorageEnv = (): void => {
  [
    'CODEBUDDY_STORAGE_BACKEND',
    'CODEBUDDY_STORAGE_ENCRYPTION_KEY',
    'CODEBUDDY_STORAGE_FILE_DIR',
    'CODEBUDDY_STORAGE_PERSISTENCE',
    'CODEBUDDY_STORAGE_PG_URL',
    'CODEBUDDY_STORAGE_SQLITE_PATH',
    'CODEBUDDY_SESSION_LOG_ENABLED',
    'CODEBUDDY_SESSION_LOG_RETENTION_DAYS',
    'DATABASE_URL',
  ].forEach((key) => {
    delete process.env[key];
  });
};

const useSqliteBackend = (): void => {
  process.env.CODEBUDDY_STORAGE_BACKEND = 'sqlite';
  process.env.CODEBUDDY_STORAGE_ENCRYPTION_KEY = 'unit-test-encryption-key';
  process.env.CODEBUDDY_STORAGE_SQLITE_PATH = databasePath;
};

const record = (
  overrides: Partial<Parameters<typeof recordSessionLog>[0]> = {},
) =>
  recordSessionLog({
    accessKeyId: null,
    accessKeyName: null,
    messages: [
      { content: 'hello', role: 'user' },
      { content: 'hi', role: 'assistant' },
    ],
    model: 'claude-sonnet-4',
    protocol: 'chat',
    route: '/v1/chat/completions',
    upstreamRequest: { messages: [], model: 'claude-sonnet-4' },
    ...overrides,
  });

describe('session logs', () => {
  beforeEach(() => {
    cleanupTempState();
    resetStorageRuntime();
    resetSessionLogRuntimeState();
    vi.restoreAllMocks();
    clearStorageEnv();
    // Keep the file backend inside the temp directory without mocking
    // `process.cwd`: the sqlite backend resolves its migration folder from it.
    process.env.CODEBUDDY_STORAGE_FILE_DIR = path.join(tempRootDir, 'data');
  });

  afterEach(() => {
    cleanupTempState();
    // Never let the sqlite/file overrides reach another test file.
    clearStorageEnv();
  });

  it('degrades on the file backend', async () => {
    const state = await getSessionLogState();

    expect(state).toMatchObject({
      degraded: true,
      enabled: false,
      retentionDays: 30,
    });

    await record();

    expect(await listSessionLogs()).toEqual([]);
    expect(await getSessionLog('missing')).toBeNull();
    expect(await clearSessionLogs()).toBe(0);
  });

  it('records, lists, reads and clears conversations on a database backend', async () => {
    useSqliteBackend();

    const state = await getSessionLogState();

    expect(state.degraded).toBe(false);
    expect(state.enabled).toBe(true);

    await record({
      accessKeyId: 'app-one',
      accessKeyName: 'App one',
      messages: [
        { content: 'ping', role: 'user' },
        { content: 'pong', role: 'assistant' },
        { content: 'plain text', role: 'user' },
      ],
      protocol: 'anthropic',
      route: '/v1/messages',
      userId: 'user-one',
    });
    await record({ accessKeyId: 'app-two', accessKeyName: 'App two' });

    const logs = await listSessionLogs();

    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatchObject({
      accessKeyName: 'App two',
      messageCount: 2,
      model: 'claude-sonnet-4',
      protocol: 'chat',
      route: '/v1/chat/completions',
      truncated: false,
      userId: null,
    });
    expect(logs[1]).toMatchObject({
      accessKeyName: 'App one',
      messageCount: 3,
      protocol: 'anthropic',
      route: '/v1/messages',
      userId: 'user-one',
    });

    expect(await listSessionLogs({ userId: 'user-one' })).toHaveLength(1);
    expect(await listSessionLogs({ limit: 1 })).toHaveLength(1);

    const detail = await getSessionLog(logs[1].id);

    expect(detail?.messages).toHaveLength(3);
    expect(detail?.upstreamRequest).toEqual({
      messages: [],
      model: 'claude-sonnet-4',
    });
    expect(detail?.messageCount).toBe(3);
    expect(await getSessionLog('missing')).toBeNull();

    expect(await clearSessionLogs()).toBe(2);
    expect(await listSessionLogs()).toEqual([]);
  });

  it('encrypts the stored document on a database backend', async () => {
    useSqliteBackend();

    await record({ upstreamRequest: { prompt: 'secret' } });

    const [summary] = await listSessionLogs();
    const { DrizzleSqliteDatabaseStorageAdapter } =
      await import('@/lib/server/storage/backends/sqlite');
    const adapter = new DrizzleSqliteDatabaseStorageAdapter({
      path: databasePath,
    });

    await adapter.ensureSchema();

    const row = await adapter.getDocument('session-logs', summary.id);

    expect(row?.encryptedPayload).toEqual(expect.any(String));
    expect(row?.payload).toBeNull();
    await expect(
      readStorageJson('session-logs', summary.id),
    ).resolves.toMatchObject({ id: summary.id });
  });

  it('resolves the owning user of an access key', async () => {
    useSqliteBackend();

    const { application } = await createApplication({
      credentialFilenames: [],
      name: 'Owned',
      ownerUserId: 'owner-42',
    });

    await record({
      accessKeyId: application.id,
      accessKeyName: application.name,
    });

    const [summary] = await listSessionLogs();

    expect(summary.userId).toBe('owner-42');
    expect(await listSessionLogs({ userId: 'owner-42' })).toHaveLength(1);
  });

  it('drops entries outside the retention window', async () => {
    useSqliteBackend();

    await record();
    const [summary] = await listSessionLogs();
    const old = {
      ...summary,
      createdAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(),
      id: 'expired',
    };

    await writeStorageJson('session-logs', 'index', { logs: [old, summary] });
    // Old entries disappear from the list even while their document remains.
    expect(await listSessionLogs()).toHaveLength(1);

    process.env.CODEBUDDY_SESSION_LOG_RETENTION_DAYS = '60';
    expect(await listSessionLogs()).toHaveLength(2);
  });

  it('clips oversized conversations instead of storing them whole', async () => {
    useSqliteBackend();

    await record({
      messages: [{ content: 'x'.repeat(250_000), role: 'user' }],
    });

    const [summary] = await listSessionLogs();
    const detail = await getSessionLog(summary.id);

    expect(summary.truncated).toBe(true);
    expect(detail?.messages[0]).toEqual({
      preview: expect.any(String),
      truncated: true,
    });
  });

  it('stays disabled when the feature is switched off', async () => {
    useSqliteBackend();
    process.env.CODEBUDDY_SESSION_LOG_ENABLED = 'false';

    expect((await getSessionLogState()).enabled).toBe(false);

    await record();

    expect(await listSessionLogs()).toEqual([]);
  });

  it('recovers from a malformed index document', async () => {
    useSqliteBackend();
    // A broken index must not break the request that logs the conversation.
    await writeStorageJson('session-logs', 'index', { logs: 'not-an-array' });

    await expect(record()).resolves.toBeUndefined();
    expect(await listSessionLogs()).toHaveLength(1);
  });
});
