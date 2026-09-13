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
  type SessionLogEntry,
  type SessionLogState,
  type SessionLogSummary,
  SessionsProvider,
  sessionsStateAtom,
} from '@/app/sessions/sessions';

interface SessionsTabControllerProps {
  canClear: boolean;
  children: ReactNode;
}

const errorKeys: Record<string, string> = {
  admin_role_required: 'sessionsPage.errorForbidden',
  invalid_request: 'sessionsPage.errorRequest',
};

export const SessionsTabController = ({
  canClear,
  children,
}: SessionsTabControllerProps) => {
  const [state, setState] = useAtom(sessionsStateAtom);
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

  const loadLogs = useCallback(async () => {
    setState((current) => ({ ...current, error: null, loading: true }));

    const result = await requestJson<{
      logs?: SessionLogSummary[];
      state?: SessionLogState;
    }>('/admin-api/sessions?limit=50');

    if (!result.ok) {
      setState((current) => ({
        ...current,
        error: resolveMessage(result.data, 'sessionsPage.errorLoad'),
        loading: false,
        logs: [],
      }));
      return;
    }

    setState((current) => ({
      ...current,
      error: null,
      loading: false,
      logs: result.data?.logs ?? [],
      state: result.data?.state ?? current.state,
    }));
  }, [resolveMessage, setState]);

  useEffect(() => {
    void loadLogs();
  }, [loadLogs]);

  const onSelect = async (id: string | null) => {
    if (!id) {
      setState((current) => ({ ...current, selected: null }));
      return;
    }

    const result = await requestJson<{ log?: SessionLogEntry }>(
      `/admin-api/sessions/${id}`,
    );

    if (!result.ok || !result.data?.log) {
      showConsoleNotification(
        'error',
        resolveMessage(result.data, 'sessionsPage.errorLoad'),
      );
      return;
    }

    setState((current) => ({ ...current, selected: result.data?.log ?? null }));
  };

  const onClear = async () => {
    const result = await requestJson<{ removed?: number }>(
      '/admin-api/sessions',
      { method: 'DELETE' },
    );

    if (!result.ok) {
      showConsoleNotification(
        'error',
        resolveMessage(result.data, 'sessionsPage.errorClear'),
      );
      return;
    }

    showConsoleNotification('success', translations('sessionsPage.cleared'));
    setState((current) => ({ ...current, selected: null }));
    await loadLogs();
  };

  return (
    <SessionsProvider
      value={{
        canClear,
        onClear: () => {
          void onClear();
        },
        onRefresh: () => {
          void loadLogs();
        },
        onSelect: (id) => {
          void onSelect(id);
        },
        state,
      }}
    >
      {children}
    </SessionsProvider>
  );
};
