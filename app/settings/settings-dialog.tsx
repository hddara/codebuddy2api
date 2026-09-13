'use client';

import { Modal, Tabs } from 'antd';
import { useTranslations } from 'next-intl';

import Security from './security';
import {
  CredentialModels,
  SettingsMaintenancePanel,
  SettingsServicePanel,
} from './settings';
import { SettingsTabController } from './settings-controller';

/** Categories of the settings dialog, in the order they are listed. */
export type SettingsSection = 'maintenance' | 'models' | 'security' | 'service';

interface SettingsDialogProps {
  onClose: () => void;
  onSectionChange: (section: SettingsSection) => void;
  /** null keeps the dialog closed; otherwise the category to show. */
  section: SettingsSection | null;
}

/** Fully controlled by the header menu, which also selects the category. */
export const SettingsDialog = ({
  onClose,
  onSectionChange,
  section,
}: SettingsDialogProps) => {
  const translations = useTranslations('Admin');

  return (
    <Modal
      destroyOnHidden
      footer={null}
      onCancel={onClose}
      open={section !== null}
      styles={{ body: { maxHeight: '70vh', overflow: 'auto' } }}
      title={translations('tabs.settings')}
      width={960}
    >
      <SettingsTabController hasInitialData={false}>
        <Tabs
          activeKey={section ?? 'service'}
          items={[
            {
              children: <SettingsServicePanel />,
              key: 'service',
              label: translations('settingsPanel.title'),
            },
            {
              children: <CredentialModels />,
              key: 'models',
              label: translations('credentials.modelTableTitle'),
            },
            {
              children: <Security />,
              key: 'security',
              label: translations('securityPanel.title'),
            },
            {
              children: <SettingsMaintenancePanel />,
              key: 'maintenance',
              label: translations('settingsPanel.usageCacheTitle'),
            },
          ]}
          onChange={(key) => onSectionChange(key as SettingsSection)}
        />
      </SettingsTabController>
    </Modal>
  );
};
