'use client';

import { Button, DropdownMenu, toast } from '@lobehub/ui/base-ui';
import { KeyRound, Languages, Settings2, SunMoon, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { Route } from 'next';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type { ThemeMode } from '@/app/page-state';
import {
  locales,
  type LocalePreference,
  systemLocalePreference,
} from '@/lib/i18n/routing';

const localeLabels: Record<string, string> = {
  'en-US': 'English',
  'ja-JP': '日本語',
  'zh-CN': '简体中文',
};

const themeModes: ThemeMode[] = ['light', 'dark', 'system'];

interface UserSettingsMenuProps {
  localePreference: LocalePreference;
  onLocaleChange: (locale: string) => void;
  onThemeChange: (theme: ThemeMode) => void;
  theme: ThemeMode;
}

export const UserSettingsMenu = ({
  localePreference,
  onLocaleChange,
  onThemeChange,
  theme,
}: UserSettingsMenuProps) => {
  const router = useRouter();
  const translations = useTranslations('Admin');
  const [clearing, setClearing] = useState(false);
  const themeLabels: Record<ThemeMode, string> = {
    dark: translations('themeDark'),
    light: translations('themeLight'),
    system: translations('themeSystem'),
  };

  const currentLocaleLabel =
    localePreference === systemLocalePreference
      ? translations('languageSystem')
      : (localeLabels[localePreference] ?? localePreference);

  const clearUsageCache = async () => {
    setClearing(true);

    try {
      const response = await fetch('/admin-api/usage/clear', {
        method: 'POST',
      });

      if (!response.ok) {
        throw new Error('Failed to clear usage events');
      }

      toast.success({
        description: translations('settingsMenu.usageCacheCleared'),
        duration: 3000,
      });
      router.refresh();
    } catch {
      toast.error({
        description: translations('settingsMenu.usageCacheClearFailed'),
        duration: 3000,
      });
    } finally {
      setClearing(false);
    }
  };

  const goToSecurity = () => {
    router.push('/settings' as Route);
  };

  return (
    <DropdownMenu
      items={[
        {
          children: themeModes.map((mode) => ({
            key: `theme-${mode}`,
            label: themeLabels[mode],
            onClick: () => onThemeChange(mode),
          })),
          icon: SunMoon,
          key: 'theme',
          label: `${translations('settingsMenu.appearance')} · ${themeLabels[theme]}`,
          type: 'submenu' as const,
        },
        {
          children: [
            {
              key: `locale-${systemLocalePreference}`,
              label: translations('languageSystem'),
              onClick: () => onLocaleChange(systemLocalePreference),
            },
            ...locales.map((locale) => ({
              key: `locale-${locale}`,
              label: localeLabels[locale] ?? locale,
              onClick: () => onLocaleChange(locale),
            })),
          ],
          icon: Languages,
          key: 'locale',
          label: `${translations('settingsMenu.language')} · ${currentLocaleLabel}`,
          type: 'submenu' as const,
        },
        { key: 'settings-divider', type: 'divider' as const },
        {
          children: [
            {
              key: 'clear-usage-cache',
              label: translations('settingsMenu.clearUsageCache'),
              onClick: () => {
                void clearUsageCache();
              },
            },
          ],
          icon: Trash2,
          key: 'maintenance',
          label: translations('settingsMenu.maintenance'),
          type: 'submenu' as const,
        },
        {
          children: [
            {
              key: 'change-password',
              label: translations('settingsMenu.changePassword'),
              onClick: goToSecurity,
            },
            {
              key: 'manage-passkeys',
              label: translations('settingsMenu.passkeys'),
              onClick: goToSecurity,
            },
          ],
          icon: KeyRound,
          key: 'account',
          label: translations('settingsMenu.account'),
          type: 'submenu' as const,
        },
      ]}
      nativeButton
      placement="bottomRight"
    >
      <Button
        aria-label={translations('settingsMenu.open')}
        className="admin-header-settings"
        icon={Settings2}
        loading={clearing}
        title={translations('settingsMenu.open')}
      />
    </DropdownMenu>
  );
};
