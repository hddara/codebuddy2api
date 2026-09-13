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
  type ProfileApplication,
  type ProfileApplicationDraft,
  type ProfileBalance,
  type ProfileUser,
  ProfileProvider,
  profileStateAtom,
} from '@/app/profile/profile';

interface ProfileTabControllerProps {
  children: ReactNode;
}

const errorKeys: Record<string, string> = {
  admin_role_required: 'profilePage.errorForbidden',
  invalid_credentials: 'profilePage.errorWrongPassword',
  not_found: 'profilePage.errorApplicationMissing',
};

export const ProfileTabController = ({
  children,
}: ProfileTabControllerProps) => {
  const [state, setState] = useAtom(profileStateAtom);
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

  const loadProfile = useCallback(async () => {
    setState((current) => ({ ...current, error: null, loading: true }));

    const [profileResult, applicationsResult] = await Promise.all([
      requestJson<{ balance?: ProfileBalance; user?: ProfileUser }>('/me'),
      requestJson<{ applications?: ProfileApplication[] }>('/me/applications'),
    ]);

    if (!profileResult.ok || !applicationsResult.ok) {
      setState((current) => ({
        ...current,
        error: resolveMessage(
          profileResult.ok ? applicationsResult.data : profileResult.data,
          'profilePage.errorLoad',
        ),
        loading: false,
      }));
      return;
    }

    setState((current) => ({
      ...current,
      applications: applicationsResult.data?.applications ?? [],
      balance: profileResult.data?.balance ?? null,
      error: null,
      loading: false,
      user: profileResult.data?.user ?? null,
    }));
  }, [resolveMessage, setState]);

  useEffect(() => {
    void loadProfile();
  }, [loadProfile]);

  const onSaveProfile = async (displayName: string): Promise<boolean> => {
    setState((current) => ({ ...current, saving: true }));

    const result = await requestJson<{ user?: ProfileUser }>('/me', {
      body: JSON.stringify({ displayName }),
      headers: { 'Content-Type': 'application/json' },
      method: 'PATCH',
    });

    setState((current) => ({ ...current, saving: false }));

    if (!result.ok) {
      showConsoleNotification(
        'error',
        resolveMessage(result.data, 'profilePage.errorSave'),
      );
      return false;
    }

    setState((current) => ({
      ...current,
      error: null,
      user: result.data?.user ?? current.user,
    }));
    showConsoleNotification('success', translations('profilePage.saved'));

    return true;
  };

  const onSaveApplication = async (
    applicationId: string | null,
    draft: ProfileApplicationDraft,
  ): Promise<boolean> => {
    setState((current) => ({ ...current, saving: true }));

    const result = await requestJson<{ application?: ProfileApplication }>(
      applicationId ? `/me/applications/${applicationId}` : '/me/applications',
      {
        body: JSON.stringify({
          description: draft.description.trim(),
          name: draft.name.trim(),
        }),
        headers: { 'Content-Type': 'application/json' },
        method: applicationId ? 'PATCH' : 'POST',
      },
    );

    setState((current) => ({ ...current, saving: false }));

    if (!result.ok) {
      showConsoleNotification(
        'error',
        resolveMessage(result.data, 'profilePage.errorApplicationSave'),
      );
      return false;
    }

    showConsoleNotification(
      'success',
      translations(
        applicationId
          ? 'profilePage.applicationUpdated'
          : 'profilePage.applicationCreated',
      ),
    );
    await loadProfile();

    return true;
  };

  const onToggleApplication = async (
    applicationId: string,
    status: ProfileApplication['status'],
  ): Promise<boolean> => {
    const result = await requestJson<{ application?: ProfileApplication }>(
      `/me/applications/${applicationId}`,
      {
        body: JSON.stringify({ status }),
        headers: { 'Content-Type': 'application/json' },
        method: 'PATCH',
      },
    );

    if (!result.ok) {
      showConsoleNotification(
        'error',
        resolveMessage(result.data, 'profilePage.errorApplicationSave'),
      );
      return false;
    }

    showConsoleNotification(
      'success',
      translations('profilePage.applicationUpdated'),
    );
    await loadProfile();

    return true;
  };

  const onDeleteApplication = async (applicationId: string) => {
    const result = await requestJson<{ success?: boolean }>(
      `/me/applications/${applicationId}`,
      { method: 'DELETE' },
    );

    if (!result.ok) {
      showConsoleNotification(
        'error',
        resolveMessage(result.data, 'profilePage.errorApplicationDelete'),
      );
      return;
    }

    showConsoleNotification(
      'success',
      translations('profilePage.applicationDeleted'),
    );
    await loadProfile();
  };

  const onChangePassword = async (
    currentPassword: string,
    newPassword: string,
  ): Promise<boolean> => {
    setState((current) => ({ ...current, saving: true }));

    const result = await requestJson<{ success?: boolean }>('/me/password', {
      body: JSON.stringify({ currentPassword, newPassword }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });

    setState((current) => ({ ...current, saving: false }));

    if (!result.ok) {
      showConsoleNotification(
        'error',
        resolveMessage(result.data, 'profilePage.errorPassword'),
      );
      return false;
    }

    showConsoleNotification(
      'success',
      translations('profilePage.passwordChanged'),
    );

    return true;
  };

  return (
    <ProfileProvider
      value={{
        onChangePassword,
        onDeleteApplication: (applicationId) => {
          void onDeleteApplication(applicationId);
        },
        onRefresh: () => {
          void loadProfile();
        },
        onSaveApplication,
        onSaveProfile,
        onToggleApplication,
        state,
      }}
    >
      {children}
    </ProfileProvider>
  );
};
