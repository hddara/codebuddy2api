import {
  type ApplicationRecord,
  type ApplicationSummary,
  createApplication,
  deleteApplication,
  findApplicationById,
  findApplicationBySecret,
  getApplicationSecret,
  getApplicationsStorageError,
  hasApplications,
  listApplicationRecords,
  listApplicationSummaries,
  removeCredentialReferences,
  updateApplication,
} from './applications';

/**
 * Compatibility surface kept for the `/admin-api/access-keys` routes and the
 * callers that still use the access key naming. Every function delegates to
 * `applications`, which owns the storage layout.
 */
export type AccessKeyRecord = ApplicationRecord;

export type AccessKeySummary = ApplicationSummary;

export const hasAccessKeys = async (): Promise<boolean> => {
  return hasApplications();
};

export const getAccessKeyStoreError = async (): Promise<string | null> => {
  return getApplicationsStorageError();
};

export const listAccessKeys = async (): Promise<{
  access_keys: AccessKeySummary[];
}> => {
  return {
    access_keys: await listApplicationSummaries(),
  };
};

export const listStoredAccessKeys = async (): Promise<AccessKeyRecord[]> => {
  return listApplicationRecords();
};

export const findAccessKeyById = async (
  id: string,
): Promise<AccessKeyRecord | null> => {
  return findApplicationById(id);
};

export const findAccessKeyBySecret = async (
  secret: string,
): Promise<AccessKeyRecord | null> => {
  return findApplicationBySecret(secret);
};

export const createAccessKey = async ({
  credentialFilenames,
  name,
}: {
  credentialFilenames: string[];
  name: string;
}): Promise<{
  access_key: AccessKeySummary;
  secret: string;
}> => {
  const { application, secret } = await createApplication({
    credentialFilenames,
    name,
  });

  return { access_key: application, secret };
};

export const updateAccessKey = async (
  id: string,
  {
    credentialFilenames,
    name,
  }: {
    credentialFilenames: string[];
    name: string;
  },
): Promise<AccessKeySummary> => {
  return updateApplication(id, { credentialFilenames, name });
};

export const deleteAccessKey = async (id: string): Promise<boolean> => {
  return deleteApplication(id);
};

export const removeCredentialReferencesFromAccessKeys = async (
  credentialFilename: string,
): Promise<boolean> => {
  return removeCredentialReferences(credentialFilename);
};

export const getAccessKeySecret = async (
  id: string,
): Promise<{ id: string; name: string; secret: string } | null> => {
  return getApplicationSecret(id);
};
