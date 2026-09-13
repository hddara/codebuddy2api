'use client';

import { useAtom, useSetAtom } from 'jotai';
import { useCallback } from 'react';

import { apiTestStateAtom } from '@/app/api-test/api-test';
import {
  type AccessKeysResponse,
  type CredentialModelsResponse,
  type CredentialsResponse,
  type CurrentCredentialResponse,
  requestJson,
} from '@/app/console-request';
import {
  type AccessKeyQuota,
  credentialsStateAtom,
} from '@/app/credentials/credentials';

interface QuotaBalanceResponse {
  balances?: Array<{
    maxTokens: number | null;
    ownerId: string;
    ownerType: string;
    usedTokens: number;
  }>;
}

/** Token limits are stored per API key (`ownerType: 'app'`). */
const fetchAccessKeyQuotas = async (): Promise<
  Record<string, AccessKeyQuota>
> => {
  const result = await requestJson<QuotaBalanceResponse>('/admin-api/quotas');

  return Object.fromEntries(
    (result.data?.balances ?? [])
      .filter((balance) => balance.ownerType === 'app')
      .map((balance) => [
        balance.ownerId,
        { maxTokens: balance.maxTokens, usedTokens: balance.usedTokens },
      ]),
  );
};

export const useCredentialLoaders = () => {
  const setCredentials = useSetAtom(credentialsStateAtom);
  const [, setApiTest] = useAtom(apiTestStateAtom);

  const loadCredentials = useCallback(async () => {
    setCredentials((current) => ({
      ...current,
      accessKeysLoading: true,
      currentLoading: true,
      loading: true,
    }));

    const [listResult, currentResult, accessKeyResult, accessKeyQuotas] =
      await Promise.all([
        requestJson<CredentialsResponse>('/admin-api/credentials'),
        requestJson<CurrentCredentialResponse>(
          '/admin-api/credentials/current',
        ),
        requestJson<AccessKeysResponse>('/admin-api/access-keys'),
        fetchAccessKeyQuotas(),
      ]);

    setCredentials((current) => ({
      ...current,
      accessKeyActionId: null,
      accessKeyQuotas,
      accessKeys: accessKeyResult.data?.access_keys ?? [],
      accessKeysLoading: false,
      actionIndex: null,
      current: currentResult.data
        ? {
            available_credential_count:
              currentResult.data.available_credential_count,
            filename: currentResult.data.filename,
            index: currentResult.data.index,
            next_filename: currentResult.data.next_filename,
            status: currentResult.data.status ?? 'no_credentials',
            user_id: currentResult.data.user_id,
          }
        : {
            status: 'no_credentials',
          },
      currentLoading: false,
      items: listResult.data?.credentials ?? [],
      loading: false,
    }));

    setApiTest((current) => {
      const validCredentials = (listResult.data?.credentials ?? []).filter(
        (item) => !item.is_expired,
      );

      if (
        current.credentialFilename &&
        validCredentials.some(
          (credential) => credential.filename === current.credentialFilename,
        )
      ) {
        return current;
      }

      return {
        ...current,
        credentialFilename: validCredentials[0]?.filename ?? '',
      };
    });
  }, [setApiTest, setCredentials]);

  /**
   * The credentials tab can be rendered with server-side initial data, which
   * never runs `loadCredentials`; quotas still have to be fetched on mount.
   */
  const refreshAccessKeyQuotas = useCallback(async () => {
    const accessKeyQuotas = await fetchAccessKeyQuotas();

    setCredentials((current) => ({ ...current, accessKeyQuotas }));
  }, [setCredentials]);

  const refreshAccessKeys = useCallback(async () => {
    setCredentials((current) => ({ ...current, accessKeysLoading: true }));
    const [result, accessKeyQuotas] = await Promise.all([
      requestJson<AccessKeysResponse>('/admin-api/access-keys'),
      fetchAccessKeyQuotas(),
    ]);

    setCredentials((current) => ({
      ...current,
      accessKeyActionId: current.accessKeyActionId ?? null,
      accessKeyQuotas,
      accessKeys: result.data?.access_keys ?? [],
      accessKeysLoading: false,
    }));
  }, [setCredentials]);

  const loadCredentialModels = useCallback(async () => {
    setCredentials((current) => ({ ...current, modelsLoading: true }));
    const result = await requestJson<CredentialModelsResponse>(
      '/admin-api/credentials/models',
    );
    const modelRows = Object.fromEntries(
      Object.entries(result.data?.models ?? {}).map(([key, value]) => [
        key,
        {
          error: value.error ?? null,
          models: (value.models ?? [])
            .map((model) => model.id)
            .filter((model): model is string => Boolean(model)),
        },
      ]),
    );

    setCredentials((current) => ({
      ...current,
      modelRows,
      modelsLoading: false,
    }));
    setApiTest((current) => {
      const models = modelRows[current.credentialFilename]?.models;

      if (!models) return current;

      return {
        ...current,
        model: models.includes(current.model)
          ? current.model
          : (models[0] ?? ''),
      };
    });
  }, [setApiTest, setCredentials]);

  const refreshCredentialList = useCallback(async () => {
    setCredentials((current) => ({
      ...current,
      currentLoading: true,
      loading: true,
    }));

    const [listResult, currentResult] = await Promise.all([
      requestJson<CredentialsResponse>('/admin-api/credentials'),
      requestJson<CurrentCredentialResponse>('/admin-api/credentials/current'),
    ]);

    setCredentials((current) => ({
      ...current,
      actionIndex: null,
      current: currentResult.data
        ? {
            available_credential_count:
              currentResult.data.available_credential_count,
            filename: currentResult.data.filename,
            index: currentResult.data.index,
            next_filename: currentResult.data.next_filename,
            status: currentResult.data.status ?? 'no_credentials',
            user_id: currentResult.data.user_id,
          }
        : { status: 'no_credentials' },
      currentLoading: false,
      items: listResult.data?.credentials ?? [],
      loading: false,
    }));

    setApiTest((current) => {
      const validCredentials = (listResult.data?.credentials ?? []).filter(
        (item) => !item.is_expired,
      );

      return current.credentialFilename &&
        validCredentials.some(
          (credential) => credential.filename === current.credentialFilename,
        )
        ? current
        : {
            ...current,
            credentialFilename: validCredentials[0]?.filename ?? '',
          };
    });
  }, [setApiTest, setCredentials]);

  return {
    loadCredentialModels,
    loadCredentials,
    refreshAccessKeyQuotas,
    refreshAccessKeys,
    refreshCredentialList,
  };
};
