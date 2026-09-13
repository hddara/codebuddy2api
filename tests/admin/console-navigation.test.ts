import { describe, expect, it } from 'vitest';

import {
  type ConsoleTabVisibility,
  isTabVisibleForRole,
} from '@/app/console-navigation';

const usersTab: ConsoleTabVisibility = {
  key: 'users',
  roles: ['owner', 'admin'],
};
const quotasTab: ConsoleTabVisibility = {
  key: 'quotas',
  roles: ['owner', 'admin'],
};

describe('console navigation visibility', () => {
  it('shows shared tabs to every role', () => {
    for (const role of ['owner', 'admin', 'member'] as const) {
      expect(isTabVisibleForRole({ key: 'dashboard' }, role)).toBe(true);
      expect(isTabVisibleForRole({ key: 'profile' }, role)).toBe(true);
    }
  });

  it('hides the administration tabs from members', () => {
    expect(isTabVisibleForRole(usersTab, 'member')).toBe(false);
    expect(isTabVisibleForRole(quotasTab, 'member')).toBe(false);
    expect(isTabVisibleForRole(usersTab, 'admin')).toBe(true);
    expect(isTabVisibleForRole(usersTab, 'owner')).toBe(true);
    expect(isTabVisibleForRole(quotasTab, 'admin')).toBe(true);
    expect(isTabVisibleForRole(quotasTab, 'owner')).toBe(true);
  });

  it('treats an empty role list as hidden', () => {
    expect(isTabVisibleForRole({ key: 'users', roles: [] }, 'owner')).toBe(
      false,
    );
  });
});
