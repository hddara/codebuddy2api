'use client';

import { Flexbox, Text } from '@lobehub/ui';
import { Button, DropdownMenu } from '@lobehub/ui/base-ui';
import { Menu } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';

export interface AdminNavigationItem {
  icon?: LucideIcon;
  key: string;
  label: string;
  onClick: () => void;
}

interface AdminHeaderProps {
  activeNavigationKey?: string;
  brand?: string;
  className?: string;
  navigationItems?: AdminNavigationItem[];
  settingsArea?: ReactNode;
  userArea?: ReactNode;
}

export const AdminHeader = ({
  activeNavigationKey,
  brand,
  className,
  navigationItems,
  settingsArea,
  userArea,
}: AdminHeaderProps) => {
  const translations = useTranslations('Admin');
  const items = navigationItems ?? [];

  const renderTab = (item: AdminNavigationItem, showIcon: boolean) => (
    <Button
      className="admin-header-tab"
      data-active={item.key === activeNavigationKey ? true : undefined}
      data-nav-key={item.key}
      htmlType="button"
      icon={showIcon ? item.icon : undefined}
      key={item.key}
      onClick={item.onClick}
    >
      {item.label}
    </Button>
  );

  return (
    <header className={`admin-header ${className}`}>
      <Text as="div" className="admin-header-brand" strong>
        {brand ?? translations('brand')}
      </Text>
      {items.length ? (
        <>
          <nav
            aria-label={translations('tabsLabel')}
            className="admin-header-navigation admin-header-navigation-full"
          >
            {items.map((item) => renderTab(item, true))}
          </nav>
          <nav
            aria-label={translations('tabsLabel')}
            className="admin-header-navigation admin-header-navigation-compact"
          >
            {items.map((item) => renderTab(item, false))}
          </nav>
        </>
      ) : null}
      <Flexbox
        align="center"
        className="admin-header-controls"
        gap={8}
        horizontal
      >
        {settingsArea}
        {userArea}
      </Flexbox>
      <div className="admin-header-mobile-menu">
        <DropdownMenu
          items={items.map(({ icon, key, label, onClick }) => ({
            icon,
            key,
            label,
            onClick,
          }))}
          nativeButton
          placement="bottomRight"
        >
          <Button aria-label={translations('tabsLabel')} icon={Menu} />
        </DropdownMenu>
      </div>
    </header>
  );
};
