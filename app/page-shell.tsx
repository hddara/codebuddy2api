'use client';

import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { createStore, Provider, useAtom } from 'jotai';
import { useHydrateAtoms } from 'jotai/utils';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import type { Route } from 'next';
import { ToastHost, toast } from '@lobehub/ui/base-ui';
import { Alert, Modal } from 'antd';
import {
  ChartLine,
  CircleUserRound,
  Gauge,
  KeyRound,
  LayoutDashboard,
  MessagesSquare,
  Users,
} from 'lucide-react';

import type {
  AdminConsoleInitialData,
  AdminProfile,
  AdminRole,
} from '@/app/page-data';
import {
  createDashboardState,
  dashboardStateAtom,
} from '@/app/dashboard/dashboard';
import { ApiTestTabController } from '@/app/api-test/api-test-controller';
import { CredentialsTabController } from '@/app/credentials/credentials-controller';
import { DashboardTabController } from '@/app/dashboard/dashboard-controller';
import Debug from '@/app/debug/debug';
import { createDebugState, debugStateAtom } from '@/app/debug/debug';
import { DebugTabController } from '@/app/debug/debug-controller';
import {
  createSettingsState,
  settingsStateAtom,
} from '@/app/settings/settings';
import { SettingsTabController } from '@/app/settings/settings-controller';
import { createUsageState, usageStateAtom } from '@/app/usage/usage';
import { UsageTabController } from '@/app/usage/usage-controller';
import ApiTest, {
  apiTestStateAtom,
  createApiTestState,
} from '@/app/api-test/api-test';
import {
  authStateAtom,
  createCredentialsState,
  credentialsStateAtom,
  defaultAuthState,
} from '@/app/credentials/credentials';
import { type TabKey } from '@/app/page-data';
import { themeAtom, type ThemeMode } from '@/app/page-state';
import { AdminHeader } from '@/app/header';
import { isTabVisibleForRole } from '@/app/console-navigation';
import { ProfileTabController } from '@/app/profile/profile-controller';
import { QuotasTabController } from '@/app/quotas/quotas-controller';
import { SessionsTabController } from '@/app/sessions/sessions-controller';
import { UsersTabController } from '@/app/users/users-controller';
import { UserMenu } from '@/app/user-menu';
import {
  SettingsDialog,
  type SettingsSection,
} from '@/app/settings/settings-dialog';
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
    | 'credentials'
    | 'dashboard'
    | 'accountStatus'
    | 'settings'
    | 'usage'
    | 'users'
    | 'quotas'
    | 'sessions';
  roles?: AdminRole[];
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
    roles: ['owner', 'admin'],
  },
  {
    icon: KeyRound,
    key: 'credentials',
    labelKey: 'credentials',
    roles: ['owner', 'admin'],
  },
  {
    icon: Users,
    key: 'users',
    labelKey: 'users',
    roles: ['owner', 'admin'],
  },
  {
    icon: Gauge,
    key: 'quotas',
    labelKey: 'quotas',
    roles: ['owner', 'admin'],
  },
  { icon: ChartLine, key: 'usage', labelKey: 'usage' },
  {
    icon: MessagesSquare,
    key: 'sessions',
    labelKey: 'sessions',
  },
];

/**
 * Tabs that only administrators may open. They are either hidden from the
 * navigation or reachable through the header menu, but a deep link must not
 * render them for a member either.
 */
const adminOnlyTabs: TabKey[] = [
  'account-status',
  'api-test',
  'credentials',
  'debug',
  'quotas',
  'settings',
  'users',
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
  const [toolDialog, setToolDialog] = useState<'api-test' | 'debug' | null>(
    null,
  );
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection | null>(null);
  const activeTab = initialTab;
  const translations = useTranslations('Admin');
  const visibleTabs = tabs.filter((tab) =>
    isTabVisibleForRole(tab, profile.role),
  );
  const allowedToUseActiveTab =
    profile.role !== 'member' || !adminOnlyTabs.includes(activeTab);
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
          navigationItems={visibleTabs.map(({ icon, key, labelKey }) => ({
            icon,
            key,
            label: translations(`tabs.${labelKey}`),
            onClick: () => {
              router.push(`/${key}` as Route);
            },
          }))}
          userArea={
            <UserMenu
              canUseAdminTools={profile.role !== 'member'}
              localePreference={initialLocalePreference}
              onLocaleChange={changeLocale}
              onLogout={() => void logout()}
              onOpenApiTest={() => setToolDialog('api-test')}
              onOpenDebug={() => setToolDialog('debug')}
              onOpenSettings={setSettingsSection}
              onThemeChange={setTheme}
              profile={profile}
              showLogout={showLogout}
              theme={theme}
            />
          }
        />
        <main className="console-main">
          {allowedToUseActiveTab ? (
            <>
              {activeTab === 'dashboard' ? (
                <DashboardTabController
                  canViewCredentials={profile.role !== 'member'}
                  hasInitialData={Boolean(initialData)}
                >
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
              {activeTab === 'users' ? (
                <UsersTabController>{children}</UsersTabController>
              ) : null}
              {activeTab === 'quotas' ? (
                <QuotasTabController>{children}</QuotasTabController>
              ) : null}
              {activeTab === 'profile' ? (
                <ProfileTabController>{children}</ProfileTabController>
              ) : null}
              {activeTab === 'sessions' ? (
                <SessionsTabController canClear={profile.role === 'owner'}>
                  {children}
                </SessionsTabController>
              ) : null}
            </>
          ) : (
            <Alert showIcon title={translations('noPermission')} type="error" />
          )}
        </main>
      </div>
      <SettingsDialog
        onClose={() => setSettingsSection(null)}
        onSectionChange={setSettingsSection}
        section={settingsSection}
      />
      <Modal
        destroyOnHidden
        footer={null}
        onCancel={() => setToolDialog(null)}
        open={toolDialog !== null}
        styles={{ body: { maxHeight: '70vh', overflow: 'auto' } }}
        title={
          toolDialog === 'debug'
            ? translations('tabs.debug')
            : translations('tabs.apiTest')
        }
        width={960}
      >
        {toolDialog === 'api-test' ? (
          <ApiTestTabController>
            <ApiTest />
          </ApiTestTabController>
        ) : null}
        {toolDialog === 'debug' ? (
          <DebugTabController hasInitialData={false}>
            <Debug />
          </DebugTabController>
        ) : null}
      </Modal>
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
