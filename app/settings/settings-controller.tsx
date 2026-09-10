'use client';

import { useAtom } from 'jotai';
import { useCallback, useEffect } from 'react';
import type { ReactNode } from 'react';

import {
  showConsoleNotification,
  useConsoleMessages,
} from '@/app/console-notify';
import {
  getErrorMessage,
  requestJson,
  type SettingsResponse,
} from '@/app/console-request';
import { SettingsProvider, settingsStateAtom } from '@/app/settings/settings';

interface SettingsTabControllerProps {
  children: ReactNode;
  hasInitialData: boolean;
}

export const SettingsTabController = ({
  children,
  hasInitialData,
}: SettingsTabControllerProps) => {
  const [settings, setSettings] = useAtom(settingsStateAtom);
  const consoleMessages = useConsoleMessages();

  const loadSettings = useCallback(async () => {
    setSettings((current) => ({
      ...current,
      loading: true,
    }));

    const result = await requestJson<SettingsResponse>('/admin-api/settings');

    const nextValues = result.data?.settings ?? {};

    setSettings((current) => ({
      ...current,
      labels: result.data?.labels ?? {},
      loading: false,
      values: nextValues,
    }));
  }, [setSettings]);

  const saveSettings = async () => {
    setSettings((current) => ({
      ...current,
      saving: true,
    }));

    const result = await requestJson<{
      message?: string;
      settings?: Record<string, string | number | null>;
    }>('/admin-api/settings', {
      body: JSON.stringify({
        settings: settings.values,
      }),
      headers: {
        'Content-Type': 'application/json',
      },
      method: 'POST',
    });

    if (!result.ok) {
      setSettings((current) => ({
        ...current,
        saving: false,
      }));
      showConsoleNotification(
        'error',
        getErrorMessage(result.data, consoleMessages.settingsSaveFailed),
      );
      return;
    }

    setSettings((current) => ({
      ...current,
      saving: false,
      values: result.data?.settings ?? current.values,
    }));
    showConsoleNotification(
      'success',
      result.data?.message ?? consoleMessages.settingsSaved,
    );
  };

  useEffect(() => {
    if (!hasInitialData) {
      void loadSettings();
    }
  }, [hasInitialData, loadSettings]);

  return (
    <SettingsProvider
      value={{
        onChange: (key, value) => {
          setSettings((current) => ({
            ...current,
            values: { ...current.values, [key]: value },
          }));
        },
        onSave: () => {
          void saveSettings();
        },
        settings,
      }}
    >
      {children}
    </SettingsProvider>
  );
};
