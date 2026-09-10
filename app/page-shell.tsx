'use client';

import { type ReactNode, useCallback, useEffect, useMemo } from 'react';
import { createStore, Provider, useAtom } from 'jotai';
import { useHydrateAtoms } from 'jotai/utils';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import type { Route } from 'next';
import { ToastHost, toast } from '@lobehub/ui/base-ui';
import {
  Bug,
  ChartLine,
  CircleUserRound,
  KeyRound,
  LayoutDashboard,
  Send,
  Settings2,
} from 'lucide-react';

import type { AdminConsoleInitialData, AdminProfile } from '@/app/page-data';
import {
  createDashboardState,
  dashboardStateAtom,
} from '@/app/dashboard/dashboard';
import { ApiTestTabController } from '@/app/api-test/api-test-controller';
import { CredentialsTabController } from '@/app/credentials/credentials-controller';
import { DashboardTabController } from '@/app/dashboard/dashboard-controller';
import { createDebugState, debugStateAtom } from '@/app/debug/debug';
import { DebugTabController } from '@/app/debug/debug-controller';
import {
  createSettingsState,
  settingsStateAtom,
} from '@/app/settings/settings';
import { SettingsTabController } from '@/app/settings/settings-controller';
import { createUsageState, usageStateAtom } from '@/app/usage/usage';
import { UsageTabController } from '@/app/usage/usage-controller';
import { apiTestStateAtom, createApiTestState } from '@/app/api-test/api-test';
import {
  authStateAtom,
  createCredentialsState,
  credentialsStateAtom,
  defaultAuthState,
} from '@/app/credentials/credentials';
import { type TabKey } from '@/app/page-data';
import { themeAtom, type ThemeMode } from '@/app/page-state';
import { AdminHeader } from '@/app/header';
import { UserMenu } from '@/app/user-menu';
import { UserSettingsMenu } from '@/app/user-settings-menu';
import { themeChangeEventName } from '@/lib/theme';
import { type LocalePreference } from '@/lib/i18n/routing';
import {
  saveLocalePreference,
  saveThemePreference,
} from '@/lib/client/preferences';

const tabs: Array<{
  icon: typeof LayoutDashboard;
  key: TabKey;
  labelKey:
    | 'apiTest'
    | 'credentials'
    | 'dashboard'
    | 'accountStatus'
    | 'debug'
    | 'settings'
    | 'usage';
}> = [
  {
    icon: LayoutDashboard,
    key: 'dashboard',
    labelKey: 'dashboard',
  },
  {
    icon: CircleUserRound,
    key: 'account-status',
    labelKey: 'accountStatus',
  },
  {
    icon: KeyRound,
    key: 'credentials',
    labelKey: 'credentials',
  },
  { icon: ChartLine, key: 'usage', labelKey: 'usage' },
  { icon: Send, key: 'api-test', labelKey: 'apiTest' },
  { icon: Bug, key: 'debug', labelKey: 'debug' },
  {
    icon: Settings2,
    key: 'settings',
    labelKey: 'settings',
  },
];

interface AdminPageLayoutProps {
  children: ReactNode;
  initialData?: AdminConsoleInitialData;
  initialLocalePreference: LocalePreference;
  initialTab: TabKey;
  initialTheme?: ThemeMode;
  profile: AdminProfile;
  showLogout: boolean;
}

type InitialStateAtom =
  | typeof apiTestStateAtom
  | typeof credentialsStateAtom
  | typeof dashboardStateAtom
  | typeof debugStateAtom
  | typeof settingsStateAtom
  | typeof usageStateAtom;

const AdminPageLayoutContent = ({
  children,
  initialData,
  initialLocalePreference,
  initialTab,
  initialTheme = 'system',
  profile,
  showLogout,
}: AdminPageLayoutProps) => {
  const router = useRouter();
  const initialTabAtoms = new Map<InitialStateAtom, unknown>();

  if (initialData?.tab === 'dashboard') {
    initialTabAtoms.set(dashboardStateAtom, createDashboardState(initialData));
  } else if (initialData?.tab === 'credentials') {
    initialTabAtoms.set(
      credentialsStateAtom,
      createCredentialsState(initialData),
    );
  } else if (initialData?.tab === 'debug') {
    initialTabAtoms.set(debugStateAtom, createDebugState(initialData));
  } else if (initialData?.tab === 'usage') {
    initialTabAtoms.set(usageStateAtom, createUsageState(initialData));
  } else if (initialData?.tab === 'settings') {
    initialTabAtoms.set(settingsStateAtom, createSettingsState(initialData));
  } else if (initialData?.tab === 'api-test') {
    initialTabAtoms.set(apiTestStateAtom, createApiTestState(initialData));
  }

  useHydrateAtoms(initialTabAtoms);
  useHydrateAtoms([
    [authStateAtom, defaultAuthState],
    [themeAtom, initialTheme],
  ]);

  const [theme, setTheme] = useAtom(themeAtom);
  const activeTab = initialTab;
  const translations = useTranslations('Admin');
  const showNotification = useCallback(
    (type: 'success' | 'error' | 'warning' | 'info', message: string) => {
      toast[type]({ description: message, duration: 3000 });
    },
    [],
  );

  useEffect(() => {
    const applyTheme = () => {
      const isDark =
        theme === 'dark' ||
        (theme === 'system' &&
          window.matchMedia('(prefers-color-scheme: dark)').matches);

      document.documentElement.classList.toggle('dark', isDark);
      document.body.classList.toggle('dark', isDark);
      document.documentElement.style.colorScheme = isDark ? 'dark' : 'light';
      window.dispatchEvent(
        new CustomEvent(themeChangeEventName, {
          detail: isDark ? 'dark' : 'light',
        }),
      );
      void saveThemePreference(theme, isDark ? 'dark' : 'light');
    };

    applyTheme();

    if (theme !== 'system') {
      return;
    }

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    mediaQuery.addEventListener('change', applyTheme);

    return () => {
      mediaQuery.removeEventListener('change', applyTheme);
    };
  }, [theme]);

  const changeLocale = (nextLocale: string) => {
    void saveLocalePreference(nextLocale as LocalePreference).finally(() => {
      window.location.reload();
    });
  };

  const logout = async () => {
    const response = await fetch('/admin-api/auth/session', {
      method: 'DELETE',
    });

    if (response.ok) {
      window.location.assign('/login');
      return;
    }

    showNotification('error', translations('logoutUnavailable'));
  };

  return (
    <>
      <div id="dashboardPage" className="console-workspace">
        <AdminHeader
          activeNavigationKey={activeTab}
          className="console-header"
          navigationItems={tabs.map(({ icon, key, labelKey }) => ({
            icon,
            key,
            label: translations(`tabs.${labelKey}`),
            onClick: () => {
              router.push(`/${key}` as Route);
            },
          }))}
          settingsArea={
            <UserSettingsMenu
              localePreference={initialLocalePreference}
              onLocaleChange={changeLocale}
              onThemeChange={setTheme}
              theme={theme}
            />
          }
          userArea={
            <UserMenu
              onLogout={() => void logout()}
              profile={profile}
              showLogout={showLogout}
            />
          }
        />
        <main className="console-main">
          {activeTab === 'dashboard' ? (
            <DashboardTabController hasInitialData={Boolean(initialData)}>
              {children}
            </DashboardTabController>
          ) : null}
          {activeTab === 'credentials' ? (
            <CredentialsTabController hasInitialData={Boolean(initialData)}>
              {children}
            </CredentialsTabController>
          ) : null}
          {activeTab === 'account-status' ? children : null}
          {activeTab === 'usage' ? (
            <UsageTabController hasInitialData={Boolean(initialData)}>
              {children}
            </UsageTabController>
          ) : null}
          {activeTab === 'api-test' ? (
            <ApiTestTabController initialData={initialData}>
              {children}
            </ApiTestTabController>
          ) : null}
          {activeTab === 'debug' ? (
            <DebugTabController hasInitialData={Boolean(initialData)}>
              {children}
            </DebugTabController>
          ) : null}
          {activeTab === 'settings' ? (
            <SettingsTabController hasInitialData={Boolean(initialData)}>
              {children}
            </SettingsTabController>
          ) : null}
        </main>
      </div>
      <ToastHost duration={3000} position="top-right" />
    </>
  );
};

const AdminPageLayout = (props: AdminPageLayoutProps) => {
  const store = useMemo(() => createStore(), []);

  return (
    <Provider store={store}>
      <AdminPageLayoutContent {...props} />
    </Provider>
  );
};

export default AdminPageLayout;
