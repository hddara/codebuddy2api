'use client';

import { Avatar, DropdownMenu } from '@lobehub/ui/base-ui';
import {
  Bug,
  ChartLine,
  LogOut,
  Send,
  Settings2,
  UserRound,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { Route } from 'next';
import { useRouter } from 'next/navigation';

import { getAvatarColor } from '@/app/avatar';
import type { AdminProfile } from '@/app/page-data';
import type { ThemeMode } from '@/app/page-state';
import { buildAppearanceItems } from '@/app/settings-menu-items';
import type { SettingsSection } from '@/app/settings/settings-dialog';
import type { LocalePreference } from '@/lib/i18n/routing';

interface UserMenuProps {
  /** Credential tooling and runtime configuration are administrator only. */
  canUseAdminTools: boolean;
  localePreference: LocalePreference;
  onLocaleChange: (locale: string) => void;
  onLogout: () => void;
  onOpenApiTest: () => void;
  onOpenDebug: () => void;
  onOpenSettings: (section: SettingsSection) => void;
  onThemeChange: (theme: ThemeMode) => void;
  profile: AdminProfile;
  showLogout: boolean;
  theme: ThemeMode;
}

/**
 * The single menu in the top right corner: appearance, account, console
 * configuration and session actions all live here, and the configuration
 * categories open a dialog instead of a page.
 */
export const UserMenu = ({
  canUseAdminTools,
  localePreference,
  onLocaleChange,
  onLogout,
  onOpenApiTest,
  onOpenDebug,
  onOpenSettings,
  onThemeChange,
  profile,
  showLogout,
  theme,
}: UserMenuProps) => {
  const router = useRouter();
  const translations = useTranslations('Admin');
  const roleLabels = {
    admin: translations('userMenu.roleAdmin'),
    member: translations('userMenu.roleMember'),
    owner: translations('userMenu.roleOwner'),
  };
  const settingsEntries: Array<{ key: SettingsSection; label: string }> = [
    { key: 'service', label: translations('settingsPanel.title') },
    { key: 'models', label: translations('credentials.modelTableTitle') },
    { key: 'security', label: translations('securityPanel.title') },
    {
      key: 'maintenance',
      label: translations('settingsPanel.usageCacheTitle'),
    },
  ];

  return (
    <DropdownMenu
      items={[
        ...buildAppearanceItems({
          localePreference,
          onLocaleChange,
          onThemeChange,
          t: (key) => translations(key),
          theme,
        }),
        { key: 'appearance-divider', type: 'divider' as const },
        {
          icon: UserRound,
          key: 'profile',
          label: translations('userMenu.profile'),
          onClick: () => {
            router.push('/profile' as Route);
          },
        },
        {
          icon: ChartLine,
          key: 'my-usage',
          label: translations('userMenu.myUsage'),
          onClick: () => {
            router.push('/usage' as Route);
          },
        },
        ...(canUseAdminTools
          ? [
              {
                children: settingsEntries.map(({ key, label }) => ({
                  key: `settings-${key}`,
                  label,
                  onClick: () => onOpenSettings(key),
                })),
                icon: Settings2,
                key: 'settings',
                label: translations('tabs.settings'),
                type: 'submenu' as const,
              },
              {
                icon: Send,
                key: 'api-test',
                label: translations('tabs.apiTest'),
                onClick: onOpenApiTest,
              },
              {
                icon: Bug,
                key: 'debug',
                label: translations('tabs.debug'),
                onClick: onOpenDebug,
              },
            ]
          : []),
        { key: 'user-divider', type: 'divider' as const },
        ...(showLogout
          ? [
              {
                icon: LogOut,
                key: 'logout',
                label: translations('logoutLabel'),
                onClick: onLogout,
              },
            ]
          : [
              {
                key: 'no-session',
                label: translations('userMenu.noSession'),
              },
            ]),
      ]}
      nativeButton
      placement="bottomRight"
    >
      <button className="admin-header-user" type="button">
        <Avatar
          // Avatar derives its visible initials from `avatar`; passing the
          // display name here yields the name initials, while a URL renders
          // the image instead.
          avatar={profile.avatarUrl ?? profile.displayName}
          background={getAvatarColor(profile.id)}
          shape="circle"
          size={26}
          title={profile.displayName}
          variant="filled"
        />
        <span className="admin-header-user-meta">
          <span className="admin-header-user-name">{profile.displayName}</span>
          <span className="admin-header-user-role">
            {roleLabels[profile.role]}
          </span>
        </span>
      </button>
    </DropdownMenu>
  );
};
