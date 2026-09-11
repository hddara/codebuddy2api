import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const PASSWORD_MIN_LENGTH = 8;

export interface StoredPasswordRecord {
  hash: string;
  salt: string;
  updatedAt: string;
}

export const createPasswordHash = (password: string, salt?: string) => {
  const resolvedSalt = salt ?? randomBytes(16).toString('hex');
  const hash = scryptSync(password, resolvedSalt, 64).toString('hex');

  return {
    hash,
    salt: resolvedSalt,
  };
};

export const normalizeUsername = (username: string): string | null => {
  const normalized = username.trim();

  if (normalized.length < 3 || normalized.length > 64) {
    return null;
  }

  return normalized;
};

export const verifyPasswordHash = (
  password: string,
  stored: StoredPasswordRecord | null,
): boolean => {
  if (!stored) {
    return false;
  }

  const candidate = createPasswordHash(password, stored.salt);
  const storedBuffer = Buffer.from(stored.hash, 'hex');
  const candidateBuffer = Buffer.from(candidate.hash, 'hex');

  if (storedBuffer.length !== candidateBuffer.length) {
    return false;
  }

  return timingSafeEqual(storedBuffer, candidateBuffer);
};
