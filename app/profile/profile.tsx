'use client';

import { Block, Input } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { Alert, Popconfirm, Table, Tag } from 'antd';
import type { TableColumnsType } from 'antd';
import { atom } from 'jotai';
import {
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  UserRound,
  Wallet,
  X,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { createContext, useContext, useState } from 'react';

import { useConsoleClipboard, useConsoleMessages } from '@/app/console-notify';
import { SectionTitle } from '@/app/credentials/section-title';

export interface ProfileUser {
  createdAt: number;
  displayName: string;
  hasPassword: boolean;
  role: 'admin' | 'member' | 'owner';
  status: 'active' | 'disabled';
  userId: string;
  username: string;
}

export interface ProfileBalance {
  configured: boolean;
  degraded: boolean;
  maxCalls: number | null;
  maxTokens: number | null;
  period: string;
  periodStart: string;
  remainingCalls: number | null;
  remainingTokens: number | null;
  resetAt: string | null;
  usedCalls: number;
  usedTokens: number;
}

export interface ProfileApplication {
  createdAt: string;
  credentialFilenames: string[];
  description: string;
  id: string;
  name: string;
  secret: string;
  status: 'active' | 'disabled';
  updatedAt: string;
}

export interface ProfileState {
  applications: ProfileApplication[];
  balance: ProfileBalance | null;
  error: string | null;
  loading: boolean;
  saving: boolean;
  user: ProfileUser | null;
}

export const defaultProfileState: ProfileState = {
  applications: [],
  balance: null,
  error: null,
  loading: true,
  saving: false,
  user: null,
};

export const profileStateAtom = atom<ProfileState>(defaultProfileState);

export interface ProfileApplicationDraft {
  description: string;
  name: string;
}

export interface ProfileController {
  onChangePassword: (
    currentPassword: string,
    newPassword: string,
  ) => Promise<boolean>;
  /** `applicationId` null creates a key, otherwise the draft patches that key. */
  onSaveApplication: (
    applicationId: string | null,
    draft: ProfileApplicationDraft,
  ) => Promise<boolean>;
  onDeleteApplication: (applicationId: string) => void;
  onToggleApplication: (
    applicationId: string,
    status: ProfileApplication['status'],
  ) => Promise<boolean>;
  onRefresh: () => void;
  onSaveProfile: (displayName: string) => Promise<boolean>;
  state: ProfileState;
}

const ProfileContext = createContext<ProfileController | null>(null);

export const ProfileProvider = ProfileContext.Provider;

const useProfile = (): ProfileController => {
  const controller = useContext(ProfileContext);

  if (!controller) {
    throw new Error('Profile controller is unavailable');
  }

  return controller;
};

const Profile = () => {
  const {
    onChangePassword,
    onDeleteApplication,
    onRefresh,
    onSaveApplication,
    onSaveProfile,
    onToggleApplication,
    state,
  } = useProfile();
  const translations = useTranslations('Admin');
  const consoleMessages = useConsoleMessages();
  const copyToClipboard = useConsoleClipboard();
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [revealedSecrets, setRevealedSecrets] = useState<
    Record<string, boolean>
  >({});
  const [applicationFormOpen, setApplicationFormOpen] = useState(false);
  const [editingApplicationId, setEditingApplicationId] = useState<
    string | null
  >(null);
  const [applicationDraft, setApplicationDraft] =
    useState<ProfileApplicationDraft>({ description: '', name: '' });

  const openApplicationForm = (application: ProfileApplication | null) => {
    setEditingApplicationId(application?.id ?? null);
    setApplicationDraft({
      description: application?.description ?? '',
      name: application?.name ?? '',
    });
    setApplicationFormOpen(true);
  };

  const submitApplication = async () => {
    if (await onSaveApplication(editingApplicationId, applicationDraft)) {
      setApplicationFormOpen(false);
    }
  };

  const roleLabels = {
    admin: translations('usersPage.roleAdmin'),
    member: translations('usersPage.roleMember'),
    owner: translations('usersPage.roleOwner'),
  };

  const columns: TableColumnsType<ProfileApplication> = [
    {
      dataIndex: 'name',
      key: 'name',
      render: (name: string, application) => (
        <div className="grid gap-1">
          <span>{name}</span>
          {application.description ? (
            <span className="text-secondary">{application.description}</span>
          ) : null}
        </div>
      ),
      title: translations('profilePage.applicationName'),
    },
    {
      dataIndex: 'status',
      key: 'status',
      render: (status: ProfileApplication['status']) => (
        <Tag color={status === 'active' ? 'green' : 'default'}>
          {status === 'active'
            ? translations('usersPage.statusActive')
            : translations('usersPage.statusDisabled')}
        </Tag>
      ),
      title: translations('profilePage.applicationStatus'),
    },
    {
      dataIndex: 'secret',
      key: 'secret',
      render: (secret: string, application) => (
        <div className="flex items-center gap-2">
          <code className="profile-secret">
            {revealedSecrets[application.id] ? secret : '••••••••••••'}
          </code>
          <Button
            icon={revealedSecrets[application.id] ? EyeOff : Eye}
            onClick={() =>
              setRevealedSecrets((current) => ({
                ...current,
                [application.id]: !current[application.id],
              }))
            }
            size="small"
          >
            {revealedSecrets[application.id]
              ? translations('profilePage.hide')
              : translations('profilePage.reveal')}
          </Button>
          <Button
            icon={Copy}
            onClick={() =>
              void copyToClipboard(secret, consoleMessages.copyContent)
            }
            size="small"
          >
            {translations('common.copy')}
          </Button>
        </div>
      ),
      title: translations('profilePage.secret'),
    },
    {
      key: 'actions',
      render: (_, application) => (
        <div className="flex gap-2">
          <Button
            icon={Pencil}
            onClick={() => openApplicationForm(application)}
            size="small"
          >
            {translations('profilePage.editApplication')}
          </Button>
          <Button
            icon={application.status === 'active' ? EyeOff : Eye}
            onClick={() =>
              void onToggleApplication(
                application.id,
                application.status === 'active' ? 'disabled' : 'active',
              )
            }
            size="small"
          >
            {application.status === 'active'
              ? translations('profilePage.disableApplication')
              : translations('profilePage.enableApplication')}
          </Button>
          <Popconfirm
            cancelText={translations('common.cancel')}
            description={translations('profilePage.deleteApplicationConfirm')}
            okText={translations('profilePage.deleteApplication')}
            onConfirm={() => onDeleteApplication(application.id)}
            title={translations('profilePage.deleteApplication')}
          >
            <Button danger icon={Trash2} size="small">
              {translations('profilePage.deleteApplication')}
            </Button>
          </Popconfirm>
        </div>
      ),
      title: translations('profilePage.actions'),
    },
  ];

  const user = state.user;
  const balance = state.balance;
  const loadFailed = state.error && !user;

  return (
    <div className="block" id="profile">
      <Block direction="vertical" gap={16} padding={24} variant="outlined">
        <div className="flex items-center justify-between gap-3">
          <SectionTitle
            icon={UserRound}
            title={translations('profilePage.profileTitle')}
          />
          <Button icon={RefreshCw} onClick={onRefresh}>
            {translations('common.refresh')}
          </Button>
        </div>
        {loadFailed ? (
          <Alert showIcon title={state.error} type="error" />
        ) : null}
        {state.loading ? (
          <div className="py-8 text-center text-secondary">
            <LoaderCircle />
            <div>{translations('common.loading')}</div>
          </div>
        ) : user ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="grid gap-1">
                <span className="text-secondary">
                  {translations('profilePage.username')}
                </span>
                <span>{user.username}</span>
              </label>
              <label className="grid gap-1">
                <span className="text-secondary">
                  {translations('profilePage.role')}
                </span>
                <span>{roleLabels[user.role]}</span>
              </label>
              <label className="grid gap-1">
                <span className="text-secondary">
                  {translations('profilePage.displayName')}
                </span>
                <Input
                  onChange={(event) => setDisplayName(event.target.value)}
                  value={displayName ?? user.displayName}
                />
              </label>
            </div>
            <div className="flex gap-2">
              <Button
                disabled={state.saving}
                icon={Save}
                loading={state.saving}
                onClick={() =>
                  void onSaveProfile(displayName ?? user.displayName)
                }
                type="primary"
              >
                {translations('common.save')}
              </Button>
            </div>
          </>
        ) : null}
      </Block>
      <Block direction="vertical" gap={16} padding={24} variant="outlined">
        <SectionTitle
          icon={Wallet}
          title={translations('profilePage.balanceTitle')}
        />
        {balance ? (
          <>
            {balance.degraded ? (
              <Alert
                description={translations('profilePage.degraded')}
                showIcon
                type="warning"
              />
            ) : null}
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1">
                <span className="text-secondary">
                  {translations('profilePage.calls')}
                </span>
                <span>
                  {balance.usedCalls.toLocaleString()}
                  {balance.maxCalls === null
                    ? ` / ${translations('quotasPage.unlimited')}`
                    : ` / ${balance.maxCalls.toLocaleString()}`}
                </span>
              </div>
              <div className="grid gap-1">
                <span className="text-secondary">
                  {translations('profilePage.tokens')}
                </span>
                <span>
                  {balance.usedTokens.toLocaleString()}
                  {balance.maxTokens === null
                    ? ` / ${translations('quotasPage.unlimited')}`
                    : ` / ${balance.maxTokens.toLocaleString()}`}
                </span>
              </div>
              <div className="grid gap-1">
                <span className="text-secondary">
                  {translations('profilePage.resetAt')}
                </span>
                <span>
                  {balance.resetAt
                    ? new Date(balance.resetAt).toLocaleString()
                    : translations('quotasPage.never')}
                </span>
              </div>
              <div className="grid gap-1">
                <span className="text-secondary">
                  {translations('profilePage.period')}
                </span>
                <span>{balance.period}</span>
              </div>
            </div>
          </>
        ) : (
          <span className="text-secondary">
            {translations('profilePage.noBalance')}
          </span>
        )}
      </Block>
      <Block direction="vertical" gap={16} padding={24} variant="outlined">
        <div className="flex items-center justify-between gap-3">
          <SectionTitle
            icon={KeyRound}
            title={translations('profilePage.applicationsTitle')}
          />
          <Button
            icon={Plus}
            onClick={() => openApplicationForm(null)}
            type="primary"
          >
            {translations('profilePage.createApplication')}
          </Button>
        </div>
        {applicationFormOpen ? (
          <Block direction="vertical" gap={12} padding={16} variant="outlined">
            <h4 className="section-title">
              {editingApplicationId
                ? translations('profilePage.editApplication')
                : translations('profilePage.formCreateApplication')}
            </h4>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="grid gap-1">
                <span className="text-secondary">
                  {translations('profilePage.applicationName')}
                </span>
                <Input
                  onChange={(event) =>
                    setApplicationDraft((current) => ({
                      ...current,
                      name: event.target.value,
                    }))
                  }
                  value={applicationDraft.name}
                />
              </label>
              <label className="grid gap-1">
                <span className="text-secondary">
                  {translations('profilePage.applicationDescription')}
                </span>
                <Input
                  onChange={(event) =>
                    setApplicationDraft((current) => ({
                      ...current,
                      description: event.target.value,
                    }))
                  }
                  value={applicationDraft.description}
                />
              </label>
            </div>
            <div className="flex gap-2">
              <Button
                disabled={state.saving}
                icon={Save}
                loading={state.saving}
                onClick={() => void submitApplication()}
                type="primary"
              >
                {translations('common.save')}
              </Button>
              <Button icon={X} onClick={() => setApplicationFormOpen(false)}>
                {translations('common.cancel')}
              </Button>
            </div>
          </Block>
        ) : null}
        <Table<ProfileApplication>
          columns={columns}
          dataSource={state.applications}
          pagination={false}
          rowKey="id"
          scroll={{ x: 'max-content' }}
          size="middle"
        />
      </Block>
      <Block direction="vertical" gap={16} padding={24} variant="outlined">
        <SectionTitle
          icon={KeyRound}
          title={translations('profilePage.passwordTitle')}
        />
        {state.error && user ? (
          <Alert showIcon title={state.error} type="error" />
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1">
            <span className="text-secondary">
              {translations('profilePage.currentPassword')}
            </span>
            <Input
              onChange={(event) => setCurrentPassword(event.target.value)}
              type="password"
              value={currentPassword}
            />
          </label>
          <label className="grid gap-1">
            <span className="text-secondary">
              {translations('profilePage.newPassword')}
            </span>
            <Input
              onChange={(event) => setNewPassword(event.target.value)}
              type="password"
              value={newPassword}
            />
          </label>
        </div>
        <div className="flex gap-2">
          <Button
            disabled={state.saving}
            icon={Save}
            loading={state.saving}
            onClick={() =>
              void onChangePassword(currentPassword, newPassword).then(
                (changed) => {
                  if (changed) {
                    setCurrentPassword('');
                    setNewPassword('');
                  }
                },
              )
            }
            type="primary"
          >
            {translations('common.save')}
          </Button>
        </div>
      </Block>
    </div>
  );
};

export default Profile;
