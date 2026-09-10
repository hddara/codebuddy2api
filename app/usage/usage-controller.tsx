'use client';

import { useAtom } from 'jotai';
import { useLocale } from 'next-intl';
import { useCallback, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

import {
  showConsoleNotification,
  useConsoleMessages,
} from '@/app/console-notify';
import {
  getErrorMessage,
  requestJson,
  type UsageResponse,
} from '@/app/console-request';
import {
  type CredentialUsageRow,
  type UsageFiltersState,
  UsageProvider,
  usageStateAtom,
} from '@/app/usage/usage';

interface UsageTabControllerProps {
  children: ReactNode;
  hasInitialData: boolean;
}

export const UsageTabController = ({
  children,
  hasInitialData,
}: UsageTabControllerProps) => {
  const [usage, setUsage] = useAtom(usageStateAtom);
  const locale = useLocale();
  const consoleMessages = useConsoleMessages();
  const usageAutoRefreshTimerRef = useRef<number | null>(null);
  const usageRequestRef = useRef(usage.request);

  const clearUsageTimer = () => {
    if (usageAutoRefreshTimerRef.current !== null) {
      window.clearTimeout(usageAutoRefreshTimerRef.current);
      usageAutoRefreshTimerRef.current = null;
    }
  };

  const loadUsage = useCallback(
    async (
      requestOverride?: Partial<UsageFiltersState>,
      autoRefreshSecondsOverride?: number,
    ) => {
      const nextRequest = {
        ...usageRequestRef.current,
        ...requestOverride,
      };
      const nextAutoRefreshSeconds =
        autoRefreshSecondsOverride ?? usage.autoRefreshSeconds;
      usageRequestRef.current = nextRequest;

      setUsage((current) => ({
        ...current,
        loading: true,
        request: nextRequest,
      }));

      const result = await requestJson<UsageResponse>('/admin-api/usage', {
        body: JSON.stringify({
          ...nextRequest,
          autoRefreshSeconds: nextAutoRefreshSeconds,
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'PATCH',
      });

      if (!result.ok) {
        setUsage((current) => ({
          ...current,
          loading: false,
          request: nextRequest,
        }));
        showConsoleNotification(
          'error',
          getErrorMessage(result.data, consoleMessages.usageLoadFailed),
        );
        return;
      }

      const resolvedRequest: UsageFiltersState = {
        accessKey: nextRequest.accessKey,
        credential: nextRequest.credential,
        range: result.data?.range ?? nextRequest.range,
      };
      usageRequestRef.current = resolvedRequest;

      setUsage((current) => ({
        ...current,
        callSeries: result.data?.callSeries ?? [],
        credentialRows: (result.data?.credentialRows ?? []).map(
          (row): CredentialUsageRow => ({
            cacheHitTokens: row.cacheHitTokens ?? 0,
            callCount: row.callCount ?? 0,
            credentialFilename: row.credentialFilename ?? 'unknown',
            totalTokens: row.totalTokens ?? 0,
          }),
        ),
        autoRefreshSeconds: nextAutoRefreshSeconds,
        filters: {
          accessKeys: result.data?.filters?.accessKeys ?? [],
          credentials: result.data?.filters?.credentials ?? [],
        },
        hoveredPoint: null,
        lastUpdatedAt: new Date().toLocaleTimeString(locale),
        loading: false,
        request: resolvedRequest,
        tableRows: (result.data?.tableRows ?? []).map((row) => ({
          callCount: row.callCount ?? 0,
          cacheHitTokens: row.cacheHitTokens ?? 0,
          model: row.model ?? 'unknown',
          totalTokens: row.totalTokens ?? 0,
        })),
        rangeSummary: {
          cacheHitTokens: result.data?.rangeSummary?.cacheHitTokens ?? 0,
          callCount: result.data?.rangeSummary?.callCount ?? 0,
          totalTokens: result.data?.rangeSummary?.totalTokens ?? 0,
        },
        tokenSeries: result.data?.tokenSeries ?? [],
      }));
    },
    [
      consoleMessages.usageLoadFailed,
      locale,
      setUsage,
      usage.autoRefreshSeconds,
    ],
  );

  const clearUsageHistory = async () => {
    setUsage((current) => ({
      ...current,
      loading: true,
    }));

    const result = await requestJson<{ success?: boolean }>(
      '/admin-api/usage/clear',
      {
        method: 'POST',
      },
    );

    if (!result.ok || !result.data?.success) {
      setUsage((current) => ({
        ...current,
        loading: false,
      }));
      showConsoleNotification(
        'error',
        getErrorMessage(result.data, consoleMessages.usageClearFailed),
      );
      return;
    }

    showConsoleNotification('success', consoleMessages.usageCleared);
    await loadUsage();
  };

  useEffect(() => {
    if (!hasInitialData) {
      void loadUsage();
    }
  }, [hasInitialData, loadUsage]);

  useEffect(() => {
    clearUsageTimer();

    if (usage.autoRefreshSeconds <= 0) {
      return;
    }

    usageAutoRefreshTimerRef.current = window.setTimeout(() => {
      void loadUsage();
    }, usage.autoRefreshSeconds * 1000);

    return () => {
      clearUsageTimer();
    };
  }, [loadUsage, usage.autoRefreshSeconds, usage.request]);

  return (
    <UsageProvider
      value={{
        onAccessKeyChange: (value) => {
          void loadUsage({ accessKey: value });
        },
        onAutoRefreshSecondsChange: (value) => {
          void loadUsage(undefined, value);
        },
        onClearHistory: () => {
          void clearUsageHistory();
        },
        onCredentialChange: (value) => {
          void loadUsage({ credential: value });
        },
        onHoverPoint: (point) => {
          setUsage((current) => ({ ...current, hoveredPoint: point }));
        },
        onRangeChange: (value) => {
          void loadUsage({ range: value });
        },
        onRefresh: () => {
          void loadUsage();
        },
        usage,
      }}
    >
      {children}
    </UsageProvider>
  );
};
