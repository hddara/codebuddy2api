import type { AdminRole, TabKey } from '@/app/page-data';

export interface ConsoleTabVisibility {
  key: TabKey;
  /**
   * Roles allowed to use the tab. Omitted means every role. The admin API
   * rejects members on these routes, so hiding the entry keeps the navigation
   * free of links that can only answer 403.
   */
  roles?: AdminRole[];
}

export const isTabVisibleForRole = (
  tab: ConsoleTabVisibility,
  role: AdminRole,
): boolean => {
  return !tab.roles || tab.roles.includes(role);
};
