'use client';

import { useAtom } from 'jotai';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect } from 'react';
import type { ReactNode } from 'react';

import { showConsoleNotification } from '@/app/console-notify';
import {
  getErrorCode,
  getErrorMessage,
  requestJson,
} from '@/app/console-request';
import {
  type ConsoleQuotaBalance,
  type QuotaTarget,
  QuotasProvider,
  quotasStateAtom,
} from '@/app/quotas/quotas';

interface QuotasTabControllerProps {
  children: ReactNode;
}

const errorKeys: Record<string, string> = {
  admin_role_required: 'quotasPage.errorForbidden',
  not_found: 'quotasPage.errorOwnerMissing',
};

const quotaPath = ({ ownerId, ownerType }: QuotaTarget): string => {
  return `/admin-api/quotas/${ownerType}/${encodeURIComponent(ownerId)}`;
};

export const QuotasTabController = ({ children }: QuotasTabControllerProps) => {
  const [state, setState] = useAtom(quotasStateAtom);
  const translations = useTranslations('Admin');

  const resolveMessage = useCallback(
    (payload: unknown, fallbackKey: string): string => {
      const code = getErrorCode(payload);
      const key = code ? errorKeys[code] : undefined;

      if (key) {
        return translations(key);
      }

      return getErrorMessage(payload, translations(fallbackKey));
    },
    [translations],
  );

  const loadBalances = useCallback(async () => {
    setState((current) => ({ ...current, error: null, loading: true }));

    const result = await requestJson<{ balances?: ConsoleQuotaBalance[] }>(
      '/admin-api/quotas',
    );

    if (!result.ok) {
      setState((current) => ({
        ...current,
        balances: [],
        error: resolveMessage(result.data, 'quotasPage.errorLoad'),
        loading: false,
      }));
      return;
    }

    setState((current) => ({
      ...current,
      balances: result.data?.balances ?? [],
      error: null,
      loading: false,
    }));
  }, [resolveMessage, setState]);

  useEffect(() => {
    void loadBalances();
  }, [loadBalances]);

  const onSave = async (
    target: QuotaTarget,
    limits: { maxCalls: number | null; maxTokens: number | null },
  ): Promise<boolean> => {
    setState((current) => ({ ...current, saving: true }));

    const result = await requestJson<{ balance?: ConsoleQuotaBalance }>(
      quotaPath(target),
      {
        body: JSON.stringify(limits),
        headers: { 'Content-Type': 'application/json' },
        method: 'PUT',
      },
    );

    setState((current) => ({ ...current, saving: false }));

    if (!result.ok) {
      showConsoleNotification(
        'error',
        resolveMessage(result.data, 'quotasPage.errorSave'),
      );
      return false;
    }

    showConsoleNotification('success', translations('quotasPage.saved'));
    await loadBalances();

    return true;
  };

  const onClear = async (target: QuotaTarget) => {
    const result = await requestJson<{ success?: boolean }>(quotaPath(target), {
      method: 'DELETE',
    });

    if (!result.ok) {
      showConsoleNotification(
        'error',
        resolveMessage(result.data, 'quotasPage.errorClear'),
      );
      return;
    }

    showConsoleNotification('success', translations('quotasPage.cleared'));
    await loadBalances();
  };

  return (
    <QuotasProvider
      value={{
        onClear: (target) => {
          void onClear(target);
        },
        onRefresh: () => {
          void loadBalances();
        },
        onSave,
        state,
      }}
    >
      {children}
    </QuotasProvider>
  );
};
