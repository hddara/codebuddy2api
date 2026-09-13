import { randomUUID } from 'node:crypto';

import {
  createPasswordHash,
  normalizeUsername,
  PASSWORD_MIN_LENGTH,
  verifyPasswordHash,
} from '@/lib/server/admin/password';
import {
  deleteStorageJson,
  listStorageJson,
  readStorageJson,
  writeStorageJson,
} from '@/lib/server/storage';

export const USERS_NAMESPACE = 'users';

export type UserRole = 'admin' | 'member' | 'owner';

export type UserStatus = 'active' | 'disabled';

export interface UserPreferences {
  /**
   * Upstream credential filenames this user may route through. `null` or an
   * absent value means every credential is allowed; `[]` means none.
   */
  allowedCredentialFilenames?: string[] | null;
  /** Model ids this user may call. `null` or absent means every model. */
  allowedModels?: string[] | null;
  /** Whether this user wants their own sessions recorded. */
  sessionLogEnabled?: boolean;
  /** Default range preselected on the usage page. */
  usageRange?: string;
  /** IANA time zone used when rendering timestamps. */
  timeZone?: string;
}

/** Persisted record. Password material never leaves this module. */
export interface UserRecord {
  createdAt: number;
  displayName: string;
  passwordHash: string | null;
  passwordSalt: string | null;
  preferences: UserPreferences;
  role: UserRole;
  status: UserStatus;
  updatedAt: number;
  userId: string;
  username: string;
}

/** Shape returned to the admin API. */
export interface PublicUser {
  createdAt: number;
  displayName: string;
  hasPassword: boolean;
  preferences: UserPreferences;
  role: UserRole;
  status: UserStatus;
  updatedAt: number;
  userId: string;
  username: string;
}

export interface CreateUserInput {
  displayName?: string;
  password?: string;
  /**
   * Pre-computed scrypt material, used when migrating a credential that is
   * already hashed and whose plaintext is unknown. `password` wins when both
   * are provided.
   */
  passwordHash?: { hash: string; salt: string };
  preferences?: UserPreferences;
  role: UserRole;
  username: string;
}

export interface UpdateUserInput {
  displayName?: string;
  password?: string;
  preferences?: UserPreferences;
  role?: UserRole;
  status?: UserStatus;
  username?: string;
}

const isUserRecord = (value: unknown): value is UserRecord => {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const record = value as Record<string, unknown>;

  return (
    typeof record.userId === 'string' &&
    typeof record.username === 'string' &&
    typeof record.role === 'string'
  );
};

export const toPublicUser = (user: UserRecord): PublicUser => ({
  createdAt: user.createdAt,
  displayName: user.displayName,
  hasPassword: Boolean(user.passwordHash && user.passwordSalt),
  preferences: user.preferences,
  role: user.role,
  status: user.status,
  updatedAt: user.updatedAt,
  userId: user.userId,
  username: user.username,
});

export const listUsers = async (): Promise<UserRecord[]> => {
  const documents = await listStorageJson<UserRecord>(USERS_NAMESPACE);

  return documents
    .map((document) => document.value)
    .filter(isUserRecord)
    .sort((left, right) => left.createdAt - right.createdAt);
};

export const listPublicUsers = async (): Promise<PublicUser[]> => {
  const users = await listUsers();

  return users.map(toPublicUser);
};

export const getUser = async (userId: string): Promise<UserRecord | null> => {
  const value = await readStorageJson<UserRecord>(USERS_NAMESPACE, userId);

  return isUserRecord(value) ? value : null;
};

/** Which upstream credentials and models one user is allowed to use. */
export interface UserResourceAccess {
  /** `null` means every credential of the platform. */
  allowedCredentialFilenames: string[] | null;
  /** `null` means every model. */
  allowedModels: string[] | null;
}

/**
 * `null` fields mean unrestricted. Unknown users stay unrestricted as well so
 * that a missing record never locks the platform out.
 */
export const getUserResourceAccess = async (
  userId: string | null | undefined,
): Promise<UserResourceAccess> => {
  const user = userId ? await getUser(userId) : null;

  return {
    allowedCredentialFilenames:
      user?.preferences.allowedCredentialFilenames ?? null,
    allowedModels: user?.preferences.allowedModels ?? null,
  };
};

export const getUserByUsername = async (
  username: string,
): Promise<UserRecord | null> => {
  const normalized = normalizeUsername(username);

  if (!normalized) {
    return null;
  }

  const lowered = normalized.toLowerCase();
  const users = await listUsers();

  return users.find((user) => user.username.toLowerCase() === lowered) ?? null;
};

export const countUsers = async (): Promise<number> => {
  const users = await listUsers();

  return users.length;
};

export const hasOwner = async (): Promise<boolean> => {
  const users = await listUsers();

  return users.some((user) => user.role === 'owner');
};

export const isUserRole = (value: unknown): value is UserRole => {
  return value === 'admin' || value === 'member' || value === 'owner';
};

export const isUserStatus = (value: unknown): value is UserStatus => {
  return value === 'active' || value === 'disabled';
};

/**
 * Keeps only the known preference keys so a request body can never persist
 * arbitrary JSON on the user record.
 */
/**
 * `undefined` keeps the stored value, `null` clears the restriction and an
 * array (possibly empty) replaces it.
 */
const normalizeOptionalStringList = (
  value: unknown,
): string[] | null | undefined => {
  if (value === null) {
    return null;
  }

  if (!Array.isArray(value)) {
    return undefined;
  }

  return Array.from(
    new Set(
      value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    ),
  );
};

export const normalizeUserPreferences = (value: unknown): UserPreferences => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const record = value as UserPreferences;
  const preferences: UserPreferences = {};

  const allowedCredentialFilenames = normalizeOptionalStringList(
    record.allowedCredentialFilenames,
  );

  if (allowedCredentialFilenames !== undefined) {
    preferences.allowedCredentialFilenames = allowedCredentialFilenames;
  }

  const allowedModels = normalizeOptionalStringList(record.allowedModels);

  if (allowedModels !== undefined) {
    preferences.allowedModels = allowedModels;
  }

  if (typeof record.sessionLogEnabled === 'boolean') {
    preferences.sessionLogEnabled = record.sessionLogEnabled;
  }

  if (typeof record.usageRange === 'string' && record.usageRange.trim()) {
    preferences.usageRange = record.usageRange.trim();
  }

  if (typeof record.timeZone === 'string' && record.timeZone.trim()) {
    preferences.timeZone = record.timeZone.trim();
  }

  return preferences;
};

/** Active owners are the only role that can manage the account. */
export const countActiveOwners = async (): Promise<number> => {
  const users = await listUsers();

  return users.filter(
    (user) => user.role === 'owner' && user.status === 'active',
  ).length;
};

/**
 * True when demoting or deleting this user would leave the account without an
 * active owner, which would permanently lock everyone out of the admin API.
 */
export const isLastActiveOwner = async (userId: string): Promise<boolean> => {
  const users = await listUsers();
  const target = users.find((user) => user.userId === userId);

  if (!target || target.role !== 'owner' || target.status !== 'active') {
    return false;
  }

  return (
    users.filter((user) => user.role === 'owner' && user.status === 'active')
      .length <= 1
  );
};

const assertPassword = (password: string): void => {
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new Error(
      `Password must be at least ${PASSWORD_MIN_LENGTH} characters long`,
    );
  }
};

/**
 * Strictly increasing creation timestamps keep the order of `listUsers`
 * deterministic even when two accounts are created within the same
 * millisecond (or when a test freezes the clock). Without it the order falls
 * back to the storage enumeration order, which the file backend does not
 * guarantee.
 */
const nextUserTimestamp = async (): Promise<number> => {
  const users = await listUsers();
  const latest = users.reduce((max, user) => Math.max(max, user.createdAt), 0);

  return Math.max(Date.now(), latest + 1);
};

export const createUser = async (
  input: CreateUserInput,
): Promise<UserRecord> => {
  const username = normalizeUsername(input.username);

  if (!username) {
    throw new Error('Username must be between 3 and 64 characters long');
  }

  if (input.password !== undefined) {
    assertPassword(input.password);
  }

  const existing = await getUserByUsername(username);

  if (existing) {
    throw new Error(`Username "${username}" is already taken`);
  }

  const now = await nextUserTimestamp();
  const password = input.password
    ? createPasswordHash(input.password)
    : (input.passwordHash ?? { hash: null, salt: null });
  const user: UserRecord = {
    createdAt: now,
    displayName: input.displayName?.trim() || username,
    passwordHash: password.hash,
    passwordSalt: password.salt,
    preferences: input.preferences ?? {},
    role: input.role,
    status: 'active',
    updatedAt: now,
    userId: randomUUID(),
    username,
  };

  await writeStorageJson(USERS_NAMESPACE, user.userId, user);

  return user;
};

export const updateUser = async (
  userId: string,
  patch: UpdateUserInput,
): Promise<UserRecord> => {
  const current = await getUser(userId);

  if (!current) {
    throw new Error(`User "${userId}" does not exist`);
  }

  if (patch.password !== undefined) {
    assertPassword(patch.password);
  }

  let username = current.username;

  if (patch.username !== undefined) {
    const normalized = normalizeUsername(patch.username);

    if (!normalized) {
      throw new Error('Username must be between 3 and 64 characters long');
    }

    const existing = await getUserByUsername(normalized);

    if (existing && existing.userId !== userId) {
      throw new Error(`Username "${normalized}" is already taken`);
    }

    username = normalized;
  }

  const password =
    patch.password !== undefined
      ? createPasswordHash(patch.password)
      : { hash: current.passwordHash, salt: current.passwordSalt };
  const next: UserRecord = {
    ...current,
    // Keep following the username while the display name was never customized.
    displayName:
      patch.displayName !== undefined
        ? patch.displayName.trim() || username
        : current.displayName === current.username
          ? username
          : current.displayName,
    passwordHash: password.hash,
    passwordSalt: password.salt,
    preferences: patch.preferences ?? current.preferences,
    role: patch.role ?? current.role,
    status: patch.status ?? current.status,
    updatedAt: Date.now(),
    username,
  };

  await writeStorageJson(USERS_NAMESPACE, userId, next);

  return next;
};

export const deleteUser = async (userId: string): Promise<void> => {
  await deleteStorageJson(USERS_NAMESPACE, userId);
};

/** Returns the user only when the password matches and the account is active. */
export const authenticateUser = async (
  username: string,
  password: string,
): Promise<UserRecord | null> => {
  const user = await getUserByUsername(username);

  if (!user || user.status !== 'active') {
    return null;
  }

  const stored =
    user.passwordHash && user.passwordSalt
      ? {
          hash: user.passwordHash,
          salt: user.passwordSalt,
          updatedAt: new Date(user.updatedAt).toISOString(),
        }
      : null;

  if (!verifyPasswordHash(password, stored)) {
    return null;
  }

  return user;
};
