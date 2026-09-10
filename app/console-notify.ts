// Notification and clipboard helpers shared by the console controllers.
'use client';

import { toast } from '@lobehub/ui/base-ui';
import { useTranslations } from 'next-intl';
import { useCallback } from 'react';

export type ConsoleNotificationType = 'error' | 'info' | 'success' | 'warning';

export const showConsoleNotification = (
  type: ConsoleNotificationType,
  message: string,
) => {
  toast[type]({ description: message, duration: 3000 });
};

export const useConsoleMessages = () => {
  const translations = useTranslations('Admin');

  return translations.raw('console') as Record<string, string>;
};

export const useConsoleClipboard = () => {
  const messages = useConsoleMessages();

  return useCallback(
    async (value: string, successMessage: string) => {
      if (!value.trim()) {
        showConsoleNotification('warning', messages.clipboardEmpty);
        return;
      }

      if (!navigator.clipboard) {
        showConsoleNotification('warning', messages.clipboardUnsupported);
        return;
      }

      await navigator.clipboard.writeText(value);
      showConsoleNotification('success', successMessage);
    },
    [messages],
  );
};
