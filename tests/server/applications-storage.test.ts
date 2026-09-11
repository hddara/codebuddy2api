import fs from 'node:fs';
import path from 'node:path';

import {
  createApplication,
  deleteApplication,
  findApplicationById,
  findApplicationBySecret,
  getApplicationsStorageError,
  hasApplications,
  listApplicationSummaries,
  removeCredentialReferences,
  updateApplication,
} from '@/lib/server/domain/applications';
import {
  addCredential,
  resetCredentialRuntimeState,
} from '@/lib/server/domain/credentials';
import { resetStorageRuntime } from '@/lib/server/storage';

const repoRoot = process.cwd();
const tempRootDir = path.join(repoRoot, '.tmp-test-applications-storage');
const dataDir = path.join(tempRootDir, '.codebuddy_data');
const applicationsDir = path.join(dataDir, 'applications');

const cleanupTempState = (): void => {
  fs.rmSync(tempRootDir, { force: true, recursive: true, maxRetries: 5 });
};

const writeLegacyStore = (accessKeys: unknown[]): void => {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'access-keys.json'),
    JSON.stringify({ accessKeys }),
  );
};

const legacyRecord = (id: string, credentialFilenames: string[]) => {
  return {
    createdAt: '2026-07-10T00:00:00.000Z',
    credentialFilenames,
    id,
    name: `Legacy ${id}`,
    secret: `cb2_legacy_${id}`,
    updatedAt: '2026-07-10T00:00:00.000Z',
  };
};

describe('applications storage', () => {
  beforeEach(() => {
    cleanupTempState();
    resetStorageRuntime();
    resetCredentialRuntimeState();
    vi.restoreAllMocks();
    vi.spyOn(process, 'cwd').mockReturnValue(tempRootDir);
    process.env.CODEBUDDY_AUTH_MODE = 'auto';
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

  it('round-trips one document per application on the real file backend', async () => {
    const firstCredential = await addCredential({
      bearer_token: 'token-first',
      user_id: 'first@example.com',
    });
    const secondCredential = await addCredential({
      bearer_token: 'token-second',
      user_id: 'second@example.com',
    });
    const expectedFilenames = [
      firstCredential.filename,
      secondCredential.filename,
    ].sort();

    const created = await createApplication({
      credentialFilenames: [
        secondCredential.filename,
        ` ${firstCredential.filename} `,
        firstCredential.filename,
      ],
      name: '  Contract App  ',
    });

    expect(created.application.name).toBe('Contract App');
    expect([...created.application.credentialFilenames].sort()).toEqual(
      expectedFilenames,
    );
    expect(created.application.status).toBe('active');
    expect(created.application.description).toBe('');
    expect(created.application.ownerUserId).toBeNull();
    expect(created.application.maskedSecret).not.toContain(created.secret);
    expect(created.secret.startsWith('cb2_')).toBe(true);

    const documentPath = path.join(
      applicationsDir,
      `${created.application.id}.json`,
    );

    expect(fs.existsSync(documentPath)).toBe(true);
    expect(await findApplicationById(created.application.id)).toMatchObject({
      name: 'Contract App',
      secret: created.secret,
    });
    expect(await findApplicationBySecret(created.secret)).toMatchObject({
      id: created.application.id,
    });
    expect(await findApplicationBySecret('   ')).toBeNull();
    expect(await findApplicationById('missing-app')).toBeNull();

    const updated = await updateApplication(created.application.id, {
      description: 'Owned by the console',
      name: 'Renamed App',
      ownerUserId: 'user-1',
      status: 'disabled',
    });

    expect(updated).toMatchObject({
      description: 'Owned by the console',
      name: 'Renamed App',
      ownerUserId: 'user-1',
      status: 'disabled',
    });
    expect([...updated.credentialFilenames].sort()).toEqual(expectedFilenames);

    await expect(
      updateApplication('missing-app', { name: 'x' }),
    ).rejects.toThrow('Application not found');
    await expect(
      createApplication({ credentialFilenames: [], name: ' ' }),
    ).rejects.toThrow('Application name is required');

    expect(await deleteApplication(created.application.id)).toBe(true);
    expect(await deleteApplication(created.application.id)).toBe(false);
    expect(fs.existsSync(documentPath)).toBe(false);
  });

  it('imports the legacy access key store exactly once', async () => {
    writeLegacyStore([
      legacyRecord('legacy-one', ['cred-a.json']),
      legacyRecord('legacy-two', ['cred-b.json']),
      { id: 'invalid-record', name: 'Broken', credentialFilenames: 'nope' },
    ]);

    const imported = await listApplicationSummaries();

    expect(imported.map((application) => application.id).sort()).toEqual([
      'legacy-one',
      'legacy-two',
    ]);
    expect(imported[0]).toMatchObject({
      description: '',
      ownerUserId: null,
      status: 'active',
    });
    expect(
      fs.existsSync(path.join(applicationsDir, 'migration-state.json')),
    ).toBe(true);
    expect(fs.existsSync(path.join(applicationsDir, 'legacy-one.json'))).toBe(
      true,
    );

    // Later legacy edits are ignored: the migration already ran.
    writeLegacyStore([legacyRecord('legacy-three', ['cred-c.json'])]);

    expect(await hasApplications()).toBe(true);
    expect(await findApplicationById('legacy-three')).toBeNull();
    expect(await getApplicationsStorageError()).toBeNull();
  });

  it('reports unreadable application documents without dropping readable ones', async () => {
    const created = await createApplication({
      credentialFilenames: [],
      name: 'Readable App',
    });

    fs.writeFileSync(path.join(applicationsDir, 'broken.json'), '{');

    expect(await getApplicationsStorageError()).toContain(
      'applications/broken',
    );
    expect(await listApplicationSummaries()).toEqual([
      expect.objectContaining({ id: created.application.id }),
    ]);
    expect(await hasApplications()).toBe(true);

    fs.rmSync(path.join(applicationsDir, 'broken.json'), { force: true });

    expect(await getApplicationsStorageError()).toBeNull();
  });

  it('fails closed when the legacy store cannot be migrated', async () => {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'access-keys.json'), '{');

    expect(await getApplicationsStorageError()).toContain('access-keys/store');

    fs.writeFileSync(
      path.join(dataDir, 'access-keys.json'),
      JSON.stringify({ accessKeys: 'invalid' }),
    );

    expect(await getApplicationsStorageError()).toBe(
      'Legacy access key store has an invalid shape',
    );
  });

  it('keeps applications created concurrently and prunes deleted credentials', async () => {
    const credential = await addCredential({
      bearer_token: 'token-app',
      user_id: 'app@example.com',
    });

    const [first, second] = await Promise.all([
      createApplication({
        credentialFilenames: [credential.filename],
        name: 'First App',
      }),
      createApplication({
        credentialFilenames: [credential.filename],
        name: 'Second App',
      }),
    ]);

    expect(await listApplicationSummaries()).toHaveLength(2);
    expect(
      (await findApplicationById(first.application.id))?.credentialFilenames,
    ).toEqual([credential.filename]);

    expect(await removeCredentialReferences(credential.filename)).toBe(true);
    expect(
      (await findApplicationById(first.application.id))?.credentialFilenames,
    ).toEqual([]);
    expect(await removeCredentialReferences('missing.json')).toBe(false);
    expect(await findApplicationById(second.application.id)).not.toBeNull();
  });
});
