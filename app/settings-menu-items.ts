import { Languages, SunMoon } from 'lucide-react';

import type { ThemeMode } from '@/app/page-state';
import {
  locales,
  type LocalePreference,
  systemLocalePreference,
} from '@/lib/i18n/routing';

export const localeLabels: Record<string, string> = {
  'en-US': 'English',
  'ja-JP': '日本語',
  'zh-CN': '简体中文',
};

const themeModes: ThemeMode[] = ['light', 'dark', 'system'];

export interface AppearanceItemsInput {
  localePreference: LocalePreference;
  onLocaleChange: (locale: string) => void;
  onThemeChange: (theme: ThemeMode) => void;
  t: (key: string) => string;
  theme: ThemeMode;
}

/**
 * Theme and language entries. They are shared by the console header menu and
 * the pre-login settings button, so both stay in sync.
 */
export const buildAppearanceItems = ({
  localePreference,
  onLocaleChange,
  onThemeChange,
  t,
  theme,
}: AppearanceItemsInput) => {
  const themeLabels: Record<ThemeMode, string> = {
    dark: t('themeDark'),
    light: t('themeLight'),
    system: t('themeSystem'),
  };
  const currentLocaleLabel =
    localePreference === systemLocalePreference
      ? t('languageSystem')
      : (localeLabels[localePreference] ?? localePreference);

  return [
    {
      children: themeModes.map((mode) => ({
        key: `theme-${mode}`,
        label: themeLabels[mode],
        onClick: () => onThemeChange(mode),
      })),
      icon: SunMoon,
      key: 'theme',
      label: `${t('settingsMenu.appearance')} · ${themeLabels[theme]}`,
      type: 'submenu' as const,
    },
    {
      children: [
        {
          key: `locale-${systemLocalePreference}`,
          label: t('languageSystem'),
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
      label: `${t('settingsMenu.language')} · ${currentLocaleLabel}`,
      type: 'submenu' as const,
    },
  ];
};
