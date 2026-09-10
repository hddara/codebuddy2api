'use client';

import { Avatar, DropdownMenu } from '@lobehub/ui/base-ui';
import { ChartLine, LogOut } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { Route } from 'next';
import { useRouter } from 'next/navigation';

import { getAvatarColor } from '@/app/avatar';
import type { AdminProfile } from '@/app/page-data';

interface UserMenuProps {
  onLogout: () => void;
  profile: AdminProfile;
  showLogout: boolean;
}

export const UserMenu = ({ onLogout, profile, showLogout }: UserMenuProps) => {
  const router = useRouter();
  const translations = useTranslations('Admin');
  const roleLabels = {
    admin: translations('userMenu.roleAdmin'),
    member: translations('userMenu.roleMember'),
    owner: translations('userMenu.roleOwner'),
  };

  return (
    <DropdownMenu
      items={[
        {
          icon: ChartLine,
          key: 'my-usage',
          label: translations('userMenu.myUsage'),
          onClick: () => {
            router.push('/usage' as Route);
          },
        },
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
