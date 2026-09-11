import fs from 'node:fs';
import path from 'node:path';

import {
  deleteStorageJson,
  ensureStorageReady,
  listStorageJson,
  readStorageJson,
  resetStorageRuntime,
  writeStorageJson,
} from '@/lib/server/storage';

const repoRoot = process.cwd();
const tempRootDir = path.join(repoRoot, '.tmp-test-user-storage');
const dataDir = path.join(tempRootDir, '.codebuddy_data');

const cleanupTempState = (): void => {
  fs.rmSync(tempRootDir, { force: true, recursive: true, maxRetries: 5 });
};

describe('user storage namespaces', () => {
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

  it('round-trips user documents on the real file backend', async () => {
    await ensureStorageReady();

    await writeStorageJson('users', 'user-1', {
      role: 'owner',
      username: 'alice',
    });
    await writeStorageJson('users', 'user-2', {
      role: 'member',
      username: 'bob',
    });

    expect(await readStorageJson('users', 'user-1')).toEqual({
      role: 'owner',
      username: 'alice',
    });
    expect(fs.existsSync(path.join(dataDir, 'users', 'user-1.json'))).toBe(
      true,
    );

    const listed = await listStorageJson<{ username: string }>('users');

    expect(listed.map((document) => document.key).sort()).toEqual([
      'user-1',
      'user-2',
    ]);
    expect(
      listed.find((document) => document.key === 'user-2')?.value.username,
    ).toBe('bob');

    await deleteStorageJson('users', 'user-1');

    expect(await readStorageJson('users', 'user-1')).toBeNull();
    expect(fs.existsSync(path.join(dataDir, 'users', 'user-1.json'))).toBe(
      false,
    );
    expect(await listStorageJson('users')).toHaveLength(1);
  });

  it('round-trips user session documents on the real file backend', async () => {
    await ensureStorageReady();

    await writeStorageJson('user-sessions', 'session-1', {
      messages: [{ content: 'hello', role: 'user' }],
      userId: 'user-1',
    });

    expect(await readStorageJson('user-sessions', 'session-1')).toEqual({
      messages: [{ content: 'hello', role: 'user' }],
      userId: 'user-1',
    });
    expect(
      fs.existsSync(path.join(dataDir, 'user-sessions', 'session-1.json')),
    ).toBe(true);
    expect(await listStorageJson('user-sessions')).toHaveLength(1);

    await deleteStorageJson('user-sessions', 'session-1');

    expect(await readStorageJson('user-sessions', 'session-1')).toBeNull();
  });

  it('returns an empty list when the namespace directory does not exist', async () => {
    await ensureStorageReady();

    expect(await listStorageJson('users')).toEqual([]);
  });

  it('rejects keys that would escape the namespace directory', async () => {
    await ensureStorageReady();

    await expect(
      writeStorageJson('users', '../escaped', { role: 'owner' }),
    ).rejects.toThrow('must not contain path separators');
    await expect(
      writeStorageJson('user-sessions', 'nested/session', {}),
    ).rejects.toThrow('must not contain path separators');

    expect(fs.existsSync(path.join(dataDir, 'escaped.json'))).toBe(false);
  });

  it('rejects namespaces that are not registered for the file backend', async () => {
    await ensureStorageReady();

    await expect(
      writeStorageJson('not-registered', 'key', { value: 1 }),
    ).rejects.toThrow('Unsupported storage document: not-registered/key');
  });
});
