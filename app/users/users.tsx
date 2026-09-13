'use client';

import { Block, Input } from '@lobehub/ui';
import { Button, Select } from '@lobehub/ui/base-ui';
import { Alert, Popconfirm, Select as AntSelect, Table, Tag } from 'antd';
import type { TableColumnsType } from 'antd';
import { atom } from 'jotai';
import {
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  Users as UsersIcon,
  X,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { createContext, useContext, useState } from 'react';
import type { ReactNode } from 'react';

import { SectionTitle } from '@/app/credentials/section-title';

export type ConsoleUserRole = 'admin' | 'member' | 'owner';

export type ConsoleUserStatus = 'active' | 'disabled';

export interface ConsoleBillingPlan {
  expiresAt: string;
  name: string;
  period: 'monthly' | 'yearly';
  tokens: number;
}

export interface ConsoleBillingAccount {
  balanceTokens: number;
  plan: ConsoleBillingPlan | null;
}

export interface ConsoleUserPreferences {
  allowedCredentialFilenames?: string[] | null;
  allowedModels?: string[] | null;
}

export interface ConsoleUser {
  createdAt: number;
  displayName: string;
  hasPassword: boolean;
  preferences?: ConsoleUserPreferences;
  role: ConsoleUserRole;
  status: ConsoleUserStatus;
  updatedAt: number;
  userId: string;
  username: string;
}

export interface UsersState {
  billing: Record<string, ConsoleBillingAccount | null>;
  credentialOptions: string[];
  error: string | null;
  loading: boolean;
  saving: boolean;
  users: ConsoleUser[];
}

export const defaultUsersState: UsersState = {
  billing: {},
  credentialOptions: [],
  error: null,
  loading: true,
  saving: false,
  users: [],
};

export const usersStateAtom = atom<UsersState>(defaultUsersState);

export interface UserDraft {
  /** `null` means every upstream account, `[]` means none. */
  allowedCredentialFilenames: string[] | null;
  /** `null` means every model. */
  allowedModels: string[] | null;
  /** Empty string keeps the stored billing account untouched. */
  balanceTokens: string;
  displayName: string;
  password: string;
  role: ConsoleUserRole;
  status: ConsoleUserStatus;
  username: string;
}

export interface UserPatch {
  displayName?: string;
  password?: string;
  preferences?: ConsoleUserPreferences;
  role?: ConsoleUserRole;
  status?: ConsoleUserStatus;
  username?: string;
}

export interface UsersController {
  onDelete: (userId: string) => void;
  onRefresh: () => void;
  /** `userId` null creates a user, otherwise the draft patches that user. */
  onSubmit: (userId: string | null, draft: UserDraft) => Promise<boolean>;
  state: UsersState;
}

const UsersContext = createContext<UsersController | null>(null);

export const UsersProvider = UsersContext.Provider;

const useUsers = (): UsersController => {
  const controller = useContext(UsersContext);

  if (!controller) {
    throw new Error('Users controller is unavailable');
  }

  return controller;
};

const emptyDraft: UserDraft = {
  allowedCredentialFilenames: null,
  allowedModels: null,
  balanceTokens: '',
  displayName: '',
  password: '',
  role: 'member',
  status: 'active',
  username: '',
};

const Field = ({ children, label }: { children: ReactNode; label: string }) => (
  <label className="grid gap-1">
    <span className="text-secondary">{label}</span>
    {children}
  </label>
);

/** antd does not narrow the value of a multiple select for us. */
const toValueList = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((item) => String(item)) : [];

const Users = () => {
  const { onDelete, onRefresh, onSubmit, state } = useUsers();
  const translations = useTranslations('Admin');
  const [formOpen, setFormOpen] = useState(false);
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [draft, setDraft] = useState<UserDraft>(emptyDraft);

  const roleLabels: Record<ConsoleUserRole, string> = {
    admin: translations('usersPage.roleAdmin'),
    member: translations('usersPage.roleMember'),
    owner: translations('usersPage.roleOwner'),
  };
  const statusLabels: Record<ConsoleUserStatus, string> = {
    active: translations('usersPage.statusActive'),
    disabled: translations('usersPage.statusDisabled'),
  };
  const roleOptions = (['owner', 'admin', 'member'] as ConsoleUserRole[]).map(
    (role) => ({ label: roleLabels[role], value: role }),
  );
  const statusOptions = (['active', 'disabled'] as ConsoleUserStatus[]).map(
    (status) => ({ label: statusLabels[status], value: status }),
  );

  const openCreate = () => {
    setEditingUserId(null);
    setDraft(emptyDraft);
    setFormOpen(true);
  };

  const openEdit = (user: ConsoleUser) => {
    const account = state.billing[user.userId];

    setEditingUserId(user.userId);
    setDraft({
      allowedCredentialFilenames:
        user.preferences?.allowedCredentialFilenames ?? null,
      allowedModels: user.preferences?.allowedModels ?? null,
      balanceTokens: account ? String(account.balanceTokens) : '',
      displayName: user.displayName,
      password: '',
      role: user.role,
      status: user.status,
      username: user.username,
    });
    setFormOpen(true);
  };

  const submit = async () => {
    if (await onSubmit(editingUserId, draft)) {
      setFormOpen(false);
    }
  };

  const columns: TableColumnsType<ConsoleUser> = [
    {
      dataIndex: 'username',
      key: 'username',
      render: (username: string, user) => (
        <div className="grid gap-1">
          <span>{username}</span>
          {user.hasPassword ? null : (
            <span className="text-secondary">
              {translations('usersPage.noPassword')}
            </span>
          )}
        </div>
      ),
      title: translations('usersPage.username'),
    },
    {
      dataIndex: 'displayName',
      key: 'displayName',
      title: translations('usersPage.displayName'),
    },
    {
      dataIndex: 'role',
      key: 'role',
      render: (role: ConsoleUserRole) => <Tag>{roleLabels[role]}</Tag>,
      title: translations('usersPage.role'),
    },
    {
      dataIndex: 'status',
      key: 'status',
      render: (status: ConsoleUserStatus) => (
        <Tag color={status === 'active' ? 'green' : 'default'}>
          {statusLabels[status]}
        </Tag>
      ),
      title: translations('usersPage.status'),
    },
    {
      dataIndex: 'userId',
      key: 'balance',
      render: (userId: string) => {
        const account = state.billing[userId];

        if (!account) {
          return (
            <span className="text-secondary">
              {translations('usersPage.notLimited')}
            </span>
          );
        }

        return (
          <div className="grid gap-1">
            <span>{account.balanceTokens.toLocaleString()}</span>
            {account.plan ? (
              <span className="text-secondary">
                {translations('usersPage.planSummary', {
                  date: new Date(account.plan.expiresAt).toLocaleDateString(),
                  name: account.plan.name,
                  tokens: account.plan.tokens.toLocaleString(),
                })}
              </span>
            ) : null}
          </div>
        );
      },
      title: translations('usersPage.balance'),
    },
    {
      dataIndex: 'updatedAt',
      key: 'updatedAt',
      render: (updatedAt: number) => new Date(updatedAt).toLocaleString(),
      title: translations('usersPage.updatedAt'),
    },
    {
      key: 'actions',
      render: (_, user) => (
        <div className="flex gap-2">
          <Button icon={Pencil} onClick={() => openEdit(user)} size="small">
            {translations('usersPage.edit')}
          </Button>
          <Popconfirm
            cancelText={translations('common.cancel')}
            description={translations('usersPage.deleteConfirm')}
            okText={translations('usersPage.delete')}
            onConfirm={() => onDelete(user.userId)}
            title={translations('usersPage.delete')}
          >
            <Button danger icon={Trash2} size="small">
              {translations('usersPage.delete')}
            </Button>
          </Popconfirm>
        </div>
      ),
      title: translations('usersPage.actions'),
    },
  ];

  return (
    <div className="block" id="users">
      <Block direction="vertical" gap={16} padding={24} variant="outlined">
        <div className="flex items-center justify-between gap-3">
          <SectionTitle
            icon={UsersIcon}
            title={translations('usersPage.title')}
          />
          <div className="flex gap-2">
            <Button icon={RefreshCw} onClick={onRefresh}>
              {translations('common.refresh')}
            </Button>
            <Button icon={Plus} onClick={openCreate} type="primary">
              {translations('usersPage.create')}
            </Button>
          </div>
        </div>
        {state.error ? (
          <Alert showIcon title={state.error} type="error" />
        ) : null}
        {formOpen ? (
          <Block direction="vertical" gap={12} padding={16} variant="outlined">
            <h4 className="section-title">
              {editingUserId
                ? translations('usersPage.formEdit')
                : translations('usersPage.formCreate')}
            </h4>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={translations('usersPage.username')}>
                <Input
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      username: event.target.value,
                    }))
                  }
                  value={draft.username}
                />
              </Field>
              <Field label={translations('usersPage.displayName')}>
                <Input
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      displayName: event.target.value,
                    }))
                  }
                  value={draft.displayName}
                />
              </Field>
              <Field label={translations('usersPage.password')}>
                <Input
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      password: event.target.value,
                    }))
                  }
                  placeholder={translations('usersPage.passwordHint')}
                  type="password"
                  value={draft.password}
                />
              </Field>
              <Field label={translations('usersPage.role')}>
                <Select
                  className="w-full"
                  onChange={(value) =>
                    setDraft((current) => ({
                      ...current,
                      role: value as ConsoleUserRole,
                    }))
                  }
                  options={roleOptions}
                  value={draft.role}
                />
              </Field>
              <Field label={translations('usersPage.status')}>
                <Select
                  className="w-full"
                  onChange={(value) =>
                    setDraft((current) => ({
                      ...current,
                      status: value as ConsoleUserStatus,
                    }))
                  }
                  options={statusOptions}
                  value={draft.status}
                />
              </Field>
              <Field label={translations('usersPage.balance')}>
                <Input
                  min={0}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      balanceTokens: event.target.value,
                    }))
                  }
                  placeholder={translations('usersPage.notLimited')}
                  type="number"
                  value={draft.balanceTokens}
                />
              </Field>
              <Field label={translations('usersPage.allowedAccounts')}>
                <AntSelect
                  allowClear
                  className="w-full"
                  mode="multiple"
                  onChange={(value) =>
                    setDraft((current) => {
                      const list = toValueList(value);

                      return {
                        ...current,
                        allowedCredentialFilenames: list.length ? list : null,
                      };
                    })
                  }
                  options={state.credentialOptions.map((filename) => ({
                    label: filename,
                    value: filename,
                  }))}
                  placeholder={translations('usersPage.notLimited')}
                  value={draft.allowedCredentialFilenames ?? []}
                />
              </Field>
              <Field label={translations('usersPage.allowedModels')}>
                <AntSelect
                  allowClear
                  className="w-full"
                  mode="tags"
                  onChange={(value) =>
                    setDraft((current) => {
                      const list = toValueList(value);

                      return {
                        ...current,
                        allowedModels: list.length ? list : null,
                      };
                    })
                  }
                  placeholder={translations('usersPage.notLimited')}
                  value={draft.allowedModels ?? []}
                />
              </Field>
            </div>
            <div className="flex gap-2">
              <Button
                disabled={state.saving}
                icon={Save}
                loading={state.saving}
                onClick={() => void submit()}
                type="primary"
              >
                {translations('common.save')}
              </Button>
              <Button icon={X} onClick={() => setFormOpen(false)}>
                {translations('common.cancel')}
              </Button>
            </div>
          </Block>
        ) : null}
        {state.loading ? (
          <div className="py-8 text-center text-secondary">
            <LoaderCircle />
            <div>{translations('common.loading')}</div>
          </div>
        ) : (
          <Table<ConsoleUser>
            columns={columns}
            dataSource={state.users}
            pagination={false}
            rowKey="userId"
            scroll={{ x: 'max-content' }}
            size="middle"
          />
        )}
      </Block>
    </div>
  );
};

export default Users;
