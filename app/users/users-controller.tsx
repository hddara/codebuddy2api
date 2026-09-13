'use client';

import { useAtom } from 'jotai';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect } from 'react';
import type { ReactNode } from 'react';

import { showConsoleNotification } from '@/app/console-notify';
import {
  getErrorCode,
  getErrorMessage,
  requestJson,
} from '@/app/console-request';
import {
  type ConsoleBillingAccount,
  type ConsoleUser,
  type UserDraft,
  type UserPatch,
  UsersProvider,
  usersStateAtom,
} from '@/app/users/users';

interface UsersTabControllerProps {
  children: ReactNode;
}

const errorKeys: Record<string, string> = {
  admin_role_required: 'usersPage.errorForbidden',
  cannot_delete_self: 'usersPage.errorDeleteSelf',
  conflict: 'usersPage.errorConflict',
  console_owner_credentials: 'usersPage.errorConsoleOwner',
  last_owner: 'usersPage.errorLastOwner',
};

export const UsersTabController = ({ children }: UsersTabControllerProps) => {
  const [state, setState] = useAtom(usersStateAtom);
  const translations = useTranslations('Admin');

  const resolveMessage = useCallback(
    (payload: unknown, fallbackKey: string): string => {
      const code = getErrorCode(payload);
      const key = code ? errorKeys[code] : undefined;

      if (key) {
        return translations(key);
      }

      return getErrorMessage(payload, translations(fallbackKey));
    },
    [translations],
  );

  /** Billing accounts drive the balance column and the edit form. */
  const loadBilling = useCallback(
    async (
      users: ConsoleUser[],
    ): Promise<Record<string, ConsoleBillingAccount | null>> => {
      const entries = await Promise.all(
        users.map(async (user) => {
          const result = await requestJson<{
            account?: ConsoleBillingAccount | null;
          }>(`/admin-api/billing/${encodeURIComponent(user.userId)}`);

          return [
            user.userId,
            result.ok ? (result.data?.account ?? null) : null,
          ] as const;
        }),
      );

      return Object.fromEntries(entries);
    },
    [],
  );

  const loadCredentialOptions = useCallback(async (): Promise<string[]> => {
    const result = await requestJson<{
      credentials?: Array<{ filename?: string; is_expired?: boolean }>;
    }>('/admin-api/credentials');

    return (result.data?.credentials ?? [])
      .filter((credential) => !credential.is_expired && credential.filename)
      .map((credential) => credential.filename as string);
  }, []);

  const loadUsers = useCallback(async () => {
    setState((current) => ({ ...current, error: null, loading: true }));

    const result = await requestJson<{ users?: ConsoleUser[] }>(
      '/admin-api/users',
    );

    if (!result.ok) {
      setState((current) => ({
        ...current,
        error: resolveMessage(result.data, 'usersPage.errorLoad'),
        loading: false,
        users: [],
      }));
      return;
    }

    const users = result.data?.users ?? [];
    const [billing, credentialOptions] = await Promise.all([
      loadBilling(users),
      loadCredentialOptions(),
    ]);

    setState((current) => ({
      ...current,
      billing,
      credentialOptions,
      error: null,
      loading: false,
      users,
    }));
  }, [loadBilling, loadCredentialOptions, resolveMessage, setState]);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  const onSubmit = async (
    userId: string | null,
    draft: UserDraft,
  ): Promise<boolean> => {
    const existing = userId
      ? state.users.find((user) => user.userId === userId)
      : null;
    const username = draft.username.trim();
    const patch: UserPatch = {
      displayName: draft.displayName.trim() || undefined,
      preferences: {
        allowedCredentialFilenames: draft.allowedCredentialFilenames,
        allowedModels: draft.allowedModels,
      },
      role: draft.role,
      status: draft.status,
    };

    // Only send the username when it really changed: the API rejects the
    // built-in owner's credentials, so an untouched field must not be sent.
    if (!existing || username !== existing.username) {
      patch.username = username || undefined;
    }

    if (draft.password) {
      patch.password = draft.password;
    }

    setState((current) => ({ ...current, saving: true }));

    const result = await requestJson<{ user?: ConsoleUser }>(
      userId ? `/admin-api/users/${userId}` : '/admin-api/users',
      {
        body: JSON.stringify(patch),
        headers: { 'Content-Type': 'application/json' },
        method: userId ? 'PATCH' : 'POST',
      },
    );

    setState((current) => ({ ...current, saving: false }));

    if (!result.ok) {
      setState((current) => ({
        ...current,
        error: resolveMessage(result.data, 'usersPage.errorSave'),
      }));
      return false;
    }

    // A new user only exists after the POST, so the balance is written last.
    const targetUserId = userId ?? result.data?.user?.userId ?? null;
    const balanceTokens = draft.balanceTokens.trim();

    if (targetUserId && balanceTokens) {
      const parsed = Number(balanceTokens);

      if (!Number.isInteger(parsed) || parsed < 0) {
        setState((current) => ({
          ...current,
          error: translations('usersPage.errorBalance'),
        }));
        await loadUsers();

        return false;
      }

      const billingResult = await requestJson<{
        account?: ConsoleBillingAccount | null;
      }>(`/admin-api/billing/${encodeURIComponent(targetUserId)}`, {
        body: JSON.stringify({ balanceTokens: parsed }),
        headers: { 'Content-Type': 'application/json' },
        method: 'PUT',
      });

      if (!billingResult.ok) {
        setState((current) => ({
          ...current,
          error: resolveMessage(billingResult.data, 'usersPage.errorBalance'),
        }));
        await loadUsers();

        return false;
      }
    }

    showConsoleNotification(
      'success',
      translations(userId ? 'usersPage.updated' : 'usersPage.created'),
    );
    await loadUsers();

    return true;
  };

  const onDelete = async (userId: string) => {
    const result = await requestJson<{ success?: boolean }>(
      `/admin-api/users/${userId}`,
      { method: 'DELETE' },
    );

    if (!result.ok) {
      showConsoleNotification(
        'error',
        resolveMessage(result.data, 'usersPage.errorDelete'),
      );
      return;
    }

    showConsoleNotification('success', translations('usersPage.deleted'));
    await loadUsers();
  };

  return (
    <UsersProvider
      value={{
        onDelete: (userId) => {
          void onDelete(userId);
        },
        onRefresh: () => {
          void loadUsers();
        },
        onSubmit,
        state,
      }}
    >
      {children}
    </UsersProvider>
  );
};
