'use client';

import { useAtom } from 'jotai';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

import {
  showConsoleNotification,
  useConsoleClipboard,
  useConsoleMessages,
} from '@/app/console-notify';
import {
  type DebugDetailResponse,
  type DebugResponse,
  getErrorMessage,
  requestJson,
} from '@/app/console-request';
import { DebugProvider, debugStateAtom } from '@/app/debug/debug';

interface DebugTabControllerProps {
  children: ReactNode;
  hasInitialData: boolean;
}

export const DebugTabController = ({
  children,
  hasInitialData,
}: DebugTabControllerProps) => {
  const [debug, setDebug] = useAtom(debugStateAtom);
  const translations = useTranslations('Admin');
  const consoleMessages = useConsoleMessages();
  const copyText = useConsoleClipboard();
  const debugAutoRefreshTimerRef = useRef<number | null>(null);

  const debugAutoRefreshOptions = [
    {
      label: translations('console.debugAutoRefreshOff'),
      value: 0,
    },
    {
      label: translations('console.debugAutoRefresh5Seconds'),
      value: 5,
    },
    {
      label: translations('console.debugAutoRefresh10Seconds'),
      value: 10,
    },
    {
      label: translations('console.debugAutoRefresh15Seconds'),
      value: 15,
    },
    {
      label: translations('console.debugAutoRefresh30Seconds'),
      value: 30,
    },
    {
      label: translations('console.debugAutoRefresh1Minute'),
      value: 60,
    },
    {
      label: translations('console.debugAutoRefresh2Minutes'),
      value: 120,
    },
    {
      label: translations('console.debugAutoRefresh5Minutes'),
      value: 300,
    },
  ] as const;

  const clearDebugAutoRefreshTimer = useCallback(() => {
    if (debugAutoRefreshTimerRef.current !== null) {
      window.clearInterval(debugAutoRefreshTimerRef.current);
      debugAutoRefreshTimerRef.current = null;
    }
  }, []);

  const loadDebug = useCallback(
    async ({
      preserveSettings = false,
    }: { preserveSettings?: boolean } = {}) => {
      setDebug((current) => ({
        ...current,
        loading: true,
      }));

      const result = await requestJson<DebugResponse>('/admin-api/debug');

      if (!result.ok) {
        setDebug((current) => ({
          ...current,
          loading: false,
        }));
        showConsoleNotification(
          'error',
          getErrorMessage(result.data, consoleMessages.debugLoadFailed),
        );
        return;
      }

      setDebug((current) => {
        const nextItems = result.data?.items ?? current.items;
        const currentItems = new Map(
          current.items.map((item) => [item.id, item]),
        );
        const activeIds = new Set(nextItems.map((item) => item.id));
        const keepDetailState = (ids: Record<string, boolean>) => {
          return Object.fromEntries(
            Object.entries(ids).filter(([id]) => activeIds.has(id)),
          );
        };

        return {
          autoRefreshSeconds: preserveSettings
            ? current.autoRefreshSeconds
            : typeof result.data?.autoRefreshSeconds === 'number'
              ? result.data.autoRefreshSeconds
              : 0,
          detailLoadedIds: keepDetailState(current.detailLoadedIds),
          detailLoadingIds: keepDetailState(current.detailLoadingIds),
          enabled: preserveSettings
            ? current.enabled
            : Boolean(result.data?.enabled),
          items: nextItems.map((item) => {
            const previous = currentItems.get(item.id);
            return current.detailLoadedIds[item.id] && previous
              ? {
                  ...item,
                  requestBody: previous.requestBody,
                  transformedResponse: previous.transformedResponse,
                  upstreamRequest: previous.upstreamRequest,
                  upstreamResponse: previous.upstreamResponse,
                }
              : item;
          }),
          loading: false,
          maxEntries: preserveSettings
            ? current.maxEntries
            : typeof result.data?.maxEntries === 'number'
              ? result.data.maxEntries
              : 100,
          saving: false,
        };
      });
    },
    [consoleMessages.debugLoadFailed, setDebug],
  );

  const loadDebugDetail = useCallback(
    async (id: string) => {
      setDebug((current) => ({
        ...current,
        detailLoadingIds: { ...current.detailLoadingIds, [id]: true },
      }));
      const result = await requestJson<DebugDetailResponse>(
        `/admin-api/debug?id=${encodeURIComponent(id)}`,
      );

      if (!result.ok || !result.data?.item) {
        setDebug((current) => {
          const { [id]: _loading, ...detailLoadingIds } =
            current.detailLoadingIds;
          return { ...current, detailLoadingIds };
        });
        showConsoleNotification(
          'error',
          getErrorMessage(result.data, consoleMessages.debugLoadFailed),
        );
        return;
      }

      const detail = result.data.item;

      setDebug((current) => ({
        ...current,
        detailLoadedIds: { ...current.detailLoadedIds, [id]: true },
        detailLoadingIds: Object.fromEntries(
          Object.entries(current.detailLoadingIds).filter(
            ([loadingId]) => loadingId !== id,
          ),
        ),
        items: current.items.map((item) => (item.id === id ? detail : item)),
      }));
    },
    [consoleMessages.debugLoadFailed, setDebug],
  );

  const saveDebugSettings = async () => {
    setDebug((current) => ({
      ...current,
      saving: true,
    }));

    const result = await requestJson<DebugResponse>('/admin-api/debug', {
      body: JSON.stringify({
        autoRefreshSeconds: debug.autoRefreshSeconds,
        enabled: debug.enabled,
        maxEntries: debug.maxEntries,
      }),
      headers: {
        'Content-Type': 'application/json',
      },
      method: 'POST',
    });

    if (!result.ok) {
      setDebug((current) => ({
        ...current,
        saving: false,
      }));
      showConsoleNotification(
        'error',
        getErrorMessage(result.data, consoleMessages.debugSaveFailed),
      );
      return;
    }

    setDebug({
      autoRefreshSeconds:
        typeof result.data?.autoRefreshSeconds === 'number'
          ? result.data.autoRefreshSeconds
          : debug.autoRefreshSeconds,
      enabled: Boolean(result.data?.enabled),
      detailLoadedIds: debug.detailLoadedIds,
      detailLoadingIds: debug.detailLoadingIds,
      items: result.data?.items ?? debug.items,
      loading: false,
      maxEntries:
        typeof result.data?.maxEntries === 'number'
          ? result.data.maxEntries
          : debug.maxEntries,
      saving: false,
    });
    showConsoleNotification(
      'success',
      result.data?.message ?? consoleMessages.debugSaved,
    );
  };

  const saveDebugEnabled = async (enabled: boolean) => {
    setDebug((current) => ({
      ...current,
      enabled,
      saving: true,
    }));

    const result = await requestJson<DebugResponse>('/admin-api/debug', {
      body: JSON.stringify({ enabled }),
      headers: {
        'Content-Type': 'application/json',
      },
      method: 'POST',
    });

    if (!result.ok) {
      setDebug((current) => ({
        ...current,
        enabled: debug.enabled,
        saving: false,
      }));
      showConsoleNotification(
        'error',
        getErrorMessage(result.data, consoleMessages.debugSaveFailed),
      );
      return;
    }

    setDebug((current) => ({
      ...current,
      enabled: Boolean(result.data?.enabled),
      saving: false,
    }));
  };

  const clearDebugItems = async () => {
    setDebug((current) => ({
      ...current,
      saving: true,
    }));

    const result = await requestJson<DebugResponse>('/admin-api/debug', {
      method: 'DELETE',
    });

    if (!result.ok) {
      setDebug((current) => ({
        ...current,
        saving: false,
      }));
      showConsoleNotification(
        'error',
        getErrorMessage(result.data, consoleMessages.debugClearFailed),
      );
      return;
    }

    setDebug((current) => ({
      ...current,
      items: [],
      saving: false,
    }));
    showConsoleNotification(
      'success',
      result.data?.message ?? consoleMessages.debugCleared,
    );
  };

  useEffect(() => {
    if (!hasInitialData) {
      void loadDebug();
    }
  }, [hasInitialData, loadDebug]);

  useEffect(() => {
    if (debug.loading) {
      void loadDebug();
    }
  }, [debug.loading, loadDebug]);

  useEffect(() => {
    clearDebugAutoRefreshTimer();

    if (!debug.enabled || debug.autoRefreshSeconds <= 0) {
      return;
    }

    debugAutoRefreshTimerRef.current = window.setInterval(() => {
      void loadDebug({ preserveSettings: true });
    }, debug.autoRefreshSeconds * 1000);

    return () => {
      clearDebugAutoRefreshTimer();
    };
  }, [
    clearDebugAutoRefreshTimer,
    debug.autoRefreshSeconds,
    debug.enabled,
    loadDebug,
  ]);

  return (
    <DebugProvider
      value={{
        autoRefreshOptions: [...debugAutoRefreshOptions],
        debug,
        onAutoRefreshSecondsChange: (value) => {
          setDebug((current) => ({
            ...current,
            autoRefreshSeconds: value,
          }));
        },
        onClear: () => {
          void clearDebugItems();
        },
        onCopy: (value) => {
          void copyText(value, consoleMessages.copyContent);
        },
        onEnabledChange: (value) => {
          void saveDebugEnabled(value);
        },
        onLoadDetail: (id) => {
          void loadDebugDetail(id);
        },
        onMaxEntriesChange: (value) => {
          setDebug((current) => ({
            ...current,
            maxEntries: value,
          }));
        },
        onRefresh: () => {
          void loadDebug({ preserveSettings: true });
        },
        onSave: () => {
          void saveDebugSettings();
        },
      }}
    >
      {children}
    </DebugProvider>
  );
};
