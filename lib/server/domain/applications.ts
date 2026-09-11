import crypto from 'node:crypto';

import {
  deleteStorageJson,
  listStorageJsonResult,
  readStorageJsonResult,
  writeStorageJson,
} from '../storage';

export const APPLICATIONS_NAMESPACE = 'applications';

export type ApplicationStatus = 'active' | 'disabled';

/**
 * One application = one inference credential holder. Replaces the legacy
 * single-document access key store so concurrent edits cannot race each other.
 */
export interface ApplicationRecord {
  createdAt: string;
  credentialFilenames: string[];
  description: string;
  id: string;
  name: string;
  ownerUserId: string | null;
  secret: string;
  status: ApplicationStatus;
  updatedAt: string;
}

export interface ApplicationSummary {
  createdAt: string;
  credentialFilenames: string[];
  description: string;
  id: string;
  maskedSecret: string;
  name: string;
  ownerUserId: string | null;
  status: ApplicationStatus;
  updatedAt: string;
}

export interface CreateApplicationInput {
  credentialFilenames: string[];
  description?: string;
  name: string;
  ownerUserId?: string | null;
  status?: ApplicationStatus;
}

export interface UpdateApplicationInput {
  credentialFilenames?: string[];
  description?: string;
  name?: string;
  ownerUserId?: string | null;
  status?: ApplicationStatus;
}

const MIGRATION_STATE_KEY = 'migration-state';
const MIGRATION_ID = 'access-keys-to-applications';
const LEGACY_NAMESPACE = 'access-keys';
const LEGACY_KEY = 'store';

interface MigrationStateRecord {
  appliedAt: string;
  id: string;
  imported: number;
}

const normalizeCredentialFilenames = (
  credentialFilenames: string[],
): string[] => {
  return Array.from(
    new Set(credentialFilenames.map((item) => item.trim()).filter(Boolean)),
  ).sort((left, right) => left.localeCompare(right));
};

const isApplicationStatus = (value: unknown): value is ApplicationStatus => {
  return value === 'active' || value === 'disabled';
};

const isMigrationStateRecord = (value: unknown): boolean => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const record = value as Partial<MigrationStateRecord>;

  return typeof record.id === 'string' && typeof record.appliedAt === 'string';
};

const parseApplicationRecord = (value: unknown): ApplicationRecord | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const record = value as Partial<ApplicationRecord>;

  if (
    typeof record.id !== 'string' ||
    !record.id ||
    typeof record.name !== 'string' ||
    typeof record.secret !== 'string' ||
    typeof record.createdAt !== 'string' ||
    typeof record.updatedAt !== 'string' ||
    !Array.isArray(record.credentialFilenames)
  ) {
    return null;
  }

  return {
    createdAt: record.createdAt,
    credentialFilenames: record.credentialFilenames.filter(
      (item): item is string => typeof item === 'string',
    ),
    description:
      typeof record.description === 'string' ? record.description : '',
    id: record.id,
    name: record.name,
    ownerUserId:
      typeof record.ownerUserId === 'string' ? record.ownerUserId : null,
    secret: record.secret,
    status: isApplicationStatus(record.status) ? record.status : 'active',
    updatedAt: record.updatedAt,
  };
};

/** Drops references to credentials that no longer exist (corrupt ones stay). */
const pruneCredentialFilenames = async (
  credentialFilenames: string[],
): Promise<string[]> => {
  const normalized = normalizeCredentialFilenames(credentialFilenames);
  const available = await Promise.all(
    normalized.map(async (filename) => {
      const result = await readStorageJsonResult<unknown>(
        'credentials',
        filename,
      );

      return result.exists || result.error ? filename : null;
    }),
  );

  return available.filter((filename): filename is string => filename !== null);
};

const pruneApplicationRecord = async (
  record: ApplicationRecord,
): Promise<ApplicationRecord> => {
  const credentialFilenames = await pruneCredentialFilenames(
    record.credentialFilenames,
  );

  if (
    credentialFilenames.length === record.credentialFilenames.length &&
    credentialFilenames.every(
      (filename, index) => filename === record.credentialFilenames[index],
    )
  ) {
    return record;
  }

  return { ...record, credentialFilenames };
};

const importLegacyAccessKeys = async (): Promise<{
  error: string | null;
  found: boolean;
  imported: ApplicationRecord[];
}> => {
  const legacy = await readStorageJsonResult<{ accessKeys?: unknown }>(
    LEGACY_NAMESPACE,
    LEGACY_KEY,
  );

  if (legacy.error) {
    return {
      error: `${LEGACY_NAMESPACE}/${LEGACY_KEY}: ${legacy.error}`,
      found: true,
      imported: [],
    };
  }

  if (!legacy.exists) {
    return { error: null, found: false, imported: [] };
  }

  if (!Array.isArray(legacy.value?.accessKeys)) {
    return {
      error: 'Legacy access key store has an invalid shape',
      found: true,
      imported: [],
    };
  }

  const imported: ApplicationRecord[] = [];

  try {
    for (const item of legacy.value.accessKeys) {
      const record = parseApplicationRecord(item);

      if (!record) {
        continue;
      }

      await writeStorageJson(APPLICATIONS_NAMESPACE, record.id, record);
      imported.push(record);
    }
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? `Failed to import legacy access keys: ${error.message}`
          : 'Failed to import legacy access keys',
      found: true,
      imported: [],
    };
  }

  return { error: null, found: true, imported };
};

interface ApplicationsState {
  applications: ApplicationRecord[];
  error: string | null;
}

/**
 * Loads every application, importing the legacy access key store on first use.
 * Unreadable documents are reported through `error` so auth can fail closed.
 */
const readApplicationsState = async (): Promise<ApplicationsState> => {
  const listed = await listStorageJsonResult<unknown>(APPLICATIONS_NAMESPACE);
  let error = listed.error;
  let migrated = false;
  const applications: ApplicationRecord[] = [];

  for (const document of listed.documents) {
    if (document.key === MIGRATION_STATE_KEY) {
      migrated = isMigrationStateRecord(document.value);
      continue;
    }

    const record = parseApplicationRecord(document.value);

    if (!record) {
      error = error ?? `applications/${document.key} is not a valid record`;
      continue;
    }

    applications.push(record);
  }

  if (!migrated) {
    const migration = await importLegacyAccessKeys();

    if (migration.error) {
      return { applications, error: migration.error };
    }

    applications.push(...migration.imported);

    // Installs without legacy data keep the marker absent, so a legacy document
    // appearing later (restored backup, downgrade) still gets imported.
    if (migration.found) {
      const state: MigrationStateRecord = {
        appliedAt: new Date().toISOString(),
        id: MIGRATION_ID,
        imported: migration.imported.length,
      };

      await writeStorageJson(
        APPLICATIONS_NAMESPACE,
        MIGRATION_STATE_KEY,
        state,
      );
    }
  }

  return {
    applications: await Promise.all(applications.map(pruneApplicationRecord)),
    error,
  };
};

const maskSecret = (secret: string): string => {
  if (secret.length <= 4) {
    return '****';
  }

  if (secret.length <= 12) {
    return `${secret.slice(0, 4)}${'*'.repeat(Math.max(4, secret.length - 4))}`;
  }

  return `${secret.slice(0, 8)}${'*'.repeat(secret.length - 12)}${secret.slice(-4)}`;
};

export const toApplicationSummary = (
  record: ApplicationRecord,
): ApplicationSummary => {
  return {
    createdAt: record.createdAt,
    credentialFilenames: [...record.credentialFilenames],
    description: record.description,
    id: record.id,
    maskedSecret: maskSecret(record.secret),
    name: record.name,
    ownerUserId: record.ownerUserId,
    status: record.status,
    updatedAt: record.updatedAt,
  };
};

const generateSecret = (): string => {
  return `cb2_${crypto.randomBytes(32).toString('base64url')}`;
};

const assertApplicationName = (name: string): string => {
  const trimmedName = name.trim();

  if (!trimmedName) {
    throw new Error('Application name is required');
  }

  return trimmedName;
};

/** Storage-level failure of the application documents, if any. */
export const getApplicationsStorageError = async (): Promise<string | null> => {
  return (await readApplicationsState()).error;
};

export const hasApplications = async (): Promise<boolean> => {
  return (await readApplicationsState()).applications.length > 0;
};

export const listApplicationRecords = async (): Promise<
  ApplicationRecord[]
> => {
  return (await readApplicationsState()).applications.map((record) => ({
    ...record,
    credentialFilenames: [...record.credentialFilenames],
  }));
};

export const listApplicationSummaries = async (): Promise<
  ApplicationSummary[]
> => {
  return (await readApplicationsState()).applications.map(toApplicationSummary);
};

export const findApplicationById = async (
  id: string,
): Promise<ApplicationRecord | null> => {
  return (
    (await readApplicationsState()).applications.find(
      (record) => record.id === id,
    ) ?? null
  );
};

export const findApplicationBySecret = async (
  secret: string,
): Promise<ApplicationRecord | null> => {
  if (!secret.trim()) {
    return null;
  }

  return (
    (await readApplicationsState()).applications.find(
      (record) => record.secret === secret,
    ) ?? null
  );
};

export const createApplication = async (
  input: CreateApplicationInput,
): Promise<{ application: ApplicationSummary; secret: string }> => {
  const name = assertApplicationName(input.name);
  const now = new Date().toISOString();
  const record: ApplicationRecord = {
    createdAt: now,
    credentialFilenames: normalizeCredentialFilenames(
      input.credentialFilenames,
    ),
    description: input.description?.trim() ?? '',
    id: crypto.randomUUID(),
    name,
    ownerUserId: input.ownerUserId ?? null,
    secret: generateSecret(),
    status: input.status ?? 'active',
    updatedAt: now,
  };

  await writeStorageJson(APPLICATIONS_NAMESPACE, record.id, record);

  return { application: toApplicationSummary(record), secret: record.secret };
};

export const updateApplication = async (
  id: string,
  patch: UpdateApplicationInput,
): Promise<ApplicationSummary> => {
  const current = await findApplicationById(id);

  if (!current) {
    throw new Error('Application not found');
  }

  const next: ApplicationRecord = {
    ...current,
    credentialFilenames:
      patch.credentialFilenames === undefined
        ? current.credentialFilenames
        : normalizeCredentialFilenames(patch.credentialFilenames),
    description: patch.description?.trim() ?? current.description,
    name:
      patch.name === undefined
        ? current.name
        : assertApplicationName(patch.name),
    ownerUserId:
      patch.ownerUserId === undefined ? current.ownerUserId : patch.ownerUserId,
    status: patch.status ?? current.status,
    updatedAt: new Date().toISOString(),
  };

  await writeStorageJson(APPLICATIONS_NAMESPACE, id, next);

  return toApplicationSummary(next);
};

export const deleteApplication = async (id: string): Promise<boolean> => {
  if (!(await findApplicationById(id))) {
    return false;
  }

  await deleteStorageJson(APPLICATIONS_NAMESPACE, id);
  return true;
};

export const getApplicationSecret = async (
  id: string,
): Promise<{ id: string; name: string; secret: string } | null> => {
  const record = await findApplicationById(id);

  if (!record) {
    return null;
  }

  return {
    id: record.id,
    name: record.name,
    secret: record.secret,
  };
};

export const removeCredentialReferences = async (
  credentialFilename: string,
): Promise<boolean> => {
  const applications = await readApplicationsState();
  let changed = false;

  for (const record of applications.applications) {
    const credentialFilenames = normalizeCredentialFilenames(
      record.credentialFilenames,
    ).filter((filename) => filename !== credentialFilename);

    if (credentialFilenames.length === record.credentialFilenames.length) {
      continue;
    }

    await writeStorageJson(APPLICATIONS_NAMESPACE, record.id, {
      ...record,
      credentialFilenames,
      updatedAt: new Date().toISOString(),
    });
    changed = true;
  }

  return changed;
};
