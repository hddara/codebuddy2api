import fs from 'node:fs';
import path from 'node:path';

import { createPasswordHash } from '@/lib/server/admin/password';
import {
  authenticateUser,
  countUsers,
  createUser,
  deleteUser,
  getUser,
  getUserByUsername,
  hasOwner,
  listPublicUsers,
  listUsers,
  toPublicUser,
  updateUser,
} from '@/lib/server/domain/users';
import { resetStorageRuntime } from '@/lib/server/storage';

const repoRoot = process.cwd();
const tempRootDir = path.join(repoRoot, '.tmp-test-users-domain');
const dataDir = path.join(tempRootDir, '.codebuddy_data');

const cleanupTempState = (): void => {
  fs.rmSync(tempRootDir, { force: true, recursive: true, maxRetries: 5 });
};

describe('users domain', () => {
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

  it('creates users and exposes them without password material', async () => {
    const owner = await createUser({
      displayName: 'Ada',
      password: 'secret-password',
      role: 'owner',
      username: 'ada',
    });

    expect(owner.username).toBe('ada');
    expect(owner.displayName).toBe('Ada');
    expect(owner.role).toBe('owner');
    expect(owner.status).toBe('active');
    expect(owner.passwordHash).not.toBeNull();
    expect(owner.passwordSalt).not.toBeNull();

    const publicUser = toPublicUser(owner);

    expect(publicUser).not.toHaveProperty('passwordHash');
    expect(publicUser.hasPassword).toBe(true);

    const loaded = await getUser(owner.userId);

    expect(loaded?.username).toBe('ada');
    expect(await getUser('missing-user')).toBeNull();
  });

  it('defaults the display name to the username and allows password-less users', async () => {
    const member = await createUser({ role: 'member', username: 'bob' });

    expect(member.displayName).toBe('bob');
    expect(member.passwordHash).toBeNull();
    expect(toPublicUser(member).hasPassword).toBe(false);
  });

  it('rejects invalid input and duplicate usernames', async () => {
    await expect(
      createUser({ role: 'member', username: 'ab' }),
    ).rejects.toThrow('Username must be between 3 and 64 characters long');
    await expect(
      createUser({
        password: 'short',
        role: 'member',
        username: 'valid-name',
      }),
    ).rejects.toThrow('Password must be at least');

    await createUser({ role: 'owner', username: 'ada' });

    await expect(
      createUser({ role: 'member', username: 'ADA' }),
    ).rejects.toThrow('is already taken');

    expect(await getUserByUsername('  ')).toBeNull();
    expect(await getUserByUsername('not-created')).toBeNull();
  });

  it('looks up usernames case-insensitively and reports owners', async () => {
    await createUser({ role: 'member', username: 'bob' });

    expect(await hasOwner()).toBe(false);
    expect(await countUsers()).toBe(1);

    await createUser({ role: 'owner', username: 'Ada' });

    expect((await getUserByUsername('ada'))?.username).toBe('Ada');
    expect(await hasOwner()).toBe(true);
    expect(await countUsers()).toBe(2);

    const publicUsers = await listPublicUsers();

    expect(publicUsers.map((user) => user.username)).toEqual(['bob', 'Ada']);
    expect(await listUsers()).toHaveLength(2);
  });

  it('updates profile fields, role, status and password', async () => {
    const user = await createUser({
      password: 'initial-password',
      role: 'member',
      username: 'carol',
    });

    const renamed = await updateUser(user.userId, { displayName: 'Carol K' });

    expect(renamed.displayName).toBe('Carol K');

    const blanked = await updateUser(user.userId, { displayName: '   ' });

    expect(blanked.displayName).toBe('carol');

    const promoted = await updateUser(user.userId, {
      password: 'rotated-password',
      role: 'admin',
      status: 'disabled',
    });

    expect(promoted.role).toBe('admin');
    expect(promoted.status).toBe('disabled');
    expect(promoted.passwordHash).not.toBe(user.passwordHash);

    await expect(
      updateUser(user.userId, { password: 'short' }),
    ).rejects.toThrow('Password must be at least');
    await expect(updateUser('missing-user', { role: 'owner' })).rejects.toThrow(
      'does not exist',
    );
  });

  it('authenticates only active users with a matching password', async () => {
    const user = await createUser({
      password: 'correct-password',
      role: 'member',
      username: 'dave',
    });

    expect(await authenticateUser('dave', 'correct-password')).not.toBeNull();
    expect(await authenticateUser('DAVE', 'correct-password')).not.toBeNull();
    expect(await authenticateUser('dave', 'wrong-password')).toBeNull();
    expect(await authenticateUser('nobody', 'correct-password')).toBeNull();

    await updateUser(user.userId, { status: 'disabled' });

    expect(await authenticateUser('dave', 'correct-password')).toBeNull();

    const passwordless = await createUser({
      role: 'member',
      username: 'erin',
    });

    expect(passwordless.passwordHash).toBeNull();
    expect(await authenticateUser('erin', 'anything')).toBeNull();
  });

  it('deletes users and keeps the rest intact', async () => {
    const first = await createUser({ role: 'owner', username: 'ada' });

    await createUser({ role: 'member', username: 'bob' });

    await deleteUser(first.userId);

    expect(await getUser(first.userId)).toBeNull();
    expect(await countUsers()).toBe(1);
    expect(fs.existsSync(path.join(dataDir, 'users'))).toBe(true);
  });

  it('accepts pre-hashed credentials and keeps them authenticating', async () => {
    const credential = createPasswordHash('migrated-password');
    const user = await createUser({
      passwordHash: { hash: credential.hash, salt: credential.salt },
      role: 'owner',
      username: 'migrated',
    });

    expect(user.passwordHash).toBe(credential.hash);
    expect(user.passwordSalt).toBe(credential.salt);
    expect(
      await authenticateUser('migrated', 'migrated-password'),
    ).not.toBeNull();
    expect(await authenticateUser('migrated', 'other-password')).toBeNull();
  });

  it('renames users, rejects taken usernames, and follows a default display name', async () => {
    const first = await createUser({ role: 'owner', username: 'ada' });

    await createUser({ role: 'member', username: 'bob' });

    const renamed = await updateUser(first.userId, {
      username: 'ada-lovelace',
    });

    expect(renamed.username).toBe('ada-lovelace');
    expect(renamed.displayName).toBe('ada-lovelace');
    expect(await getUserByUsername('ada')).toBeNull();

    await updateUser(first.userId, { displayName: 'Ada L' });

    expect(
      (await updateUser(first.userId, { username: 'ada-l' })).displayName,
    ).toBe('Ada L');
    expect(
      (await updateUser(first.userId, { username: 'ADA-L' })).username,
    ).toBe('ADA-L');

    await expect(updateUser(first.userId, { username: 'ab' })).rejects.toThrow(
      'Username must be between 3 and 64 characters long',
    );
    await expect(updateUser(first.userId, { username: 'BOB' })).rejects.toThrow(
      'is already taken',
    );
    await expect(
      updateUser('missing-user', { username: 'nobody' }),
    ).rejects.toThrow('does not exist');
  });
});
