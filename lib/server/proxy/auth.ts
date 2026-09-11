import type { NextRequest } from 'next/server';

import {
  findAccessKeyBySecret,
  getAccessKeyStoreError,
  hasAccessKeys,
  type AccessKeyRecord,
} from '../domain/access-keys';
import { getAccessKeyQuotaViolation } from '../domain/quotas';

const QUOTA_ENFORCEMENT_ENV = 'CODEBUDDY_QUOTA_ENFORCEMENT';

/**
 * Quotas reject by default. `CODEBUDDY_QUOTA_ENFORCEMENT=warn` keeps evaluating
 * the balance but only logs, which is the escape hatch the design reserved for
 * a rollout where usage still has to be observed before it is enforced.
 */
const isQuotaEnforcementEnabled = (): boolean => {
  return process.env[QUOTA_ENFORCEMENT_ENV]?.trim().toLowerCase() !== 'warn';
};

const getQuotaExceededResponse = async (
  accessKey: AccessKeyRecord,
  protocol: 'anthropic' | 'openai',
): Promise<Response | null> => {
  const violation = await getAccessKeyQuotaViolation(accessKey);

  if (!violation) {
    return null;
  }

  if (!isQuotaEnforcementEnabled()) {
    console.warn(
      `[CodeBuddy2API] Quota exceeded but enforcement is off: ${violation.message}`,
    );

    return null;
  }

  if (protocol === 'anthropic') {
    return Response.json(
      {
        type: 'error',
        error: {
          type: 'rate_limit_error',
          message: violation.message,
        },
      },
      { status: 429 },
    );
  }

  return Response.json(
    {
      error: {
        message: violation.message,
        type: 'insufficient_quota',
      },
    },
    { status: 429 },
  );
};

const extractBearerToken = (request: NextRequest): string | null => {
  const header = request.headers.get('authorization')?.trim();

  if (!header) {
    return null;
  }

  const [scheme, token] = header.split(/\s+/, 2);

  if (!scheme || !token || scheme.toLowerCase() !== 'bearer') {
    return null;
  }

  return token;
};

const extractApiKeyToken = (request: NextRequest): string | null => {
  return request.headers.get('x-api-key')?.trim() || null;
};

const extractAccessKeyToken = (request: NextRequest): string | null => {
  return extractBearerToken(request) ?? extractApiKeyToken(request);
};

const isDisabledAccessKey = (record: AccessKeyRecord | null): boolean => {
  return record?.status === 'disabled';
};

const getAccessKeyStoreErrorResponse = async (): Promise<Response | null> => {
  if (!(await getAccessKeyStoreError())) {
    return null;
  }

  return Response.json(
    {
      error: {
        message:
          'Access key storage is unreadable. Fix the applications storage first.',
      },
    },
    { status: 503 },
  );
};

export const resolveRequestAccessKey = (
  request: NextRequest,
): Promise<AccessKeyRecord | null> => {
  return (async () => {
    if (await getAccessKeyStoreError()) {
      return null;
    }

    if (!(await hasAccessKeys())) {
      return null;
    }

    const token = extractAccessKeyToken(request);

    if (!token) {
      return null;
    }

    return findAccessKeyBySecret(token);
  })();
};

export const getClientAuthErrorResponse = (
  request: NextRequest,
): Promise<Response | null> => {
  return (async () => {
    const storeError = await getAccessKeyStoreErrorResponse();

    if (storeError) {
      return storeError;
    }

    if (!(await hasAccessKeys())) {
      return null;
    }

    const token = extractAccessKeyToken(request);

    if (!token) {
      return Response.json(
        { error: { message: 'x-api-key or Authorization header is required' } },
        { status: 401 },
      );
    }

    const accessKey = await findAccessKeyBySecret(token);

    if (!accessKey) {
      return Response.json(
        { error: { message: 'Invalid access key' } },
        { status: 403 },
      );
    }

    if (isDisabledAccessKey(accessKey)) {
      return Response.json(
        { error: { message: 'Access key is disabled' } },
        { status: 403 },
      );
    }

    return getQuotaExceededResponse(accessKey, 'openai');
  })();
};

export const getAdminAuthErrorResponse = (
  request: NextRequest,
): Promise<Response | null> => {
  return (async () => {
    const storeError = await getAccessKeyStoreErrorResponse();

    if (storeError) {
      return storeError;
    }

    if (!(await hasAccessKeys())) {
      return null;
    }

    const token = extractAccessKeyToken(request);

    if (!token) {
      return Response.json(
        { error: { message: 'x-api-key or Authorization header is required' } },
        { status: 401 },
      );
    }

    const accessKey = await findAccessKeyBySecret(token);

    if (!accessKey) {
      return Response.json(
        { error: { message: 'Invalid access key' } },
        { status: 403 },
      );
    }

    if (isDisabledAccessKey(accessKey)) {
      return Response.json(
        { error: { message: 'Access key is disabled' } },
        { status: 403 },
      );
    }

    return getQuotaExceededResponse(accessKey, 'openai');
  })();
};

export const getAuthErrorResponse = (
  request: NextRequest,
): Promise<Response | null> => {
  return getClientAuthErrorResponse(request);
};

export const getAnthropicAuthErrorResponse = (
  request: NextRequest,
): Promise<Response | null> => {
  return (async () => {
    const storeError = await getAccessKeyStoreErrorResponse();

    if (storeError) {
      return Response.json(
        {
          type: 'error',
          error: {
            type: 'authentication_error',
            message: 'Access key storage is unreadable.',
          },
        },
        { status: 503 },
      );
    }

    if (!(await hasAccessKeys())) {
      return null;
    }

    const token = extractAccessKeyToken(request);

    if (!token) {
      return Response.json(
        {
          type: 'error',
          error: {
            type: 'authentication_error',
            message: 'x-api-key or Authorization header is required',
          },
        },
        { status: 401 },
      );
    }

    const accessKey = await findAccessKeyBySecret(token);

    if (!accessKey) {
      return Response.json(
        {
          type: 'error',
          error: { type: 'authentication_error', message: 'Invalid API key' },
        },
        { status: 403 },
      );
    }

    if (isDisabledAccessKey(accessKey)) {
      return Response.json(
        {
          type: 'error',
          error: {
            type: 'authentication_error',
            message: 'API key is disabled',
          },
        },
        { status: 403 },
      );
    }

    return getQuotaExceededResponse(accessKey, 'anthropic');
  })();
};
