'use client';

import { useAtom } from 'jotai';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

import {
  showConsoleNotification,
  useConsoleClipboard,
  useConsoleMessages,
} from '@/app/console-notify';
import {
  type AccessKeySecretResponse,
  getErrorMessage,
  type PollAuthResponse,
  requestJson,
  type StartAuthResponse,
} from '@/app/console-request';
import {
  type AccessKeySummary,
  authStateAtom,
  CredentialsProvider,
  credentialsStateAtom,
} from '@/app/credentials/credentials';
import { useCredentialLoaders } from '@/app/credentials/use-credential-loaders';
import { dashboardRefreshSignalAtom } from '@/app/dashboard/dashboard';

interface CredentialsTabControllerProps {
  children: ReactNode;
  hasInitialData: boolean;
}

export const CredentialsTabController = ({
  children,
  hasInitialData,
}: CredentialsTabControllerProps) => {
  const [credentials, setCredentials] = useAtom(credentialsStateAtom);
  const [auth, setAuth] = useAtom(authStateAtom);
  const consoleMessages = useConsoleMessages();
  const copyText = useConsoleClipboard();
  const translations = useTranslations('Admin');
  const [, setDashboardRefreshSignal] = useAtom(dashboardRefreshSignalAtom);
  const {
    loadCredentialModels,
    loadCredentials,
    refreshAccessKeys,
    refreshCredentialList,
  } = useCredentialLoaders();

  const authPollTimerRef = useRef<number | null>(null);
  const clearAuthTimer = () => {
    if (authPollTimerRef.current !== null) {
      window.clearTimeout(authPollTimerRef.current);
      authPollTimerRef.current = null;
    }
  };
  const refreshAdminData = useCallback(async () => {
    setDashboardRefreshSignal((current) => current + 1);
    await loadCredentials();
    await loadCredentialModels();
  }, [loadCredentialModels, loadCredentials, setDashboardRefreshSignal]);

  const pollAuth = async (overrideState?: string) => {
    const authState = overrideState ?? auth.authState;

    if (!authState.trim()) {
      showConsoleNotification('warning', consoleMessages.authCheckMissing);
      return;
    }

    clearAuthTimer();
    setAuth((current) => ({
      ...current,
      message: consoleMessages.authChecking,
      polling: true,
    }));

    const result = await requestJson<PollAuthResponse>('/codebuddy/auth/poll', {
      body: JSON.stringify({
        auth_state: authState,
      }),
      headers: {
        'Content-Type': 'application/json',
      },
      method: 'POST',
    });

    if (result.ok && result.data?.access_token) {
      setAuth((current) => ({
        ...current,
        completed: true,
        message: result.data?.message ?? consoleMessages.authSuccess,
        polling: false,
      }));
      showConsoleNotification(
        'success',
        result.data.message ?? consoleMessages.authSaved,
      );
      await refreshAdminData();
      return;
    }

    if (result.data?.error === 'authorization_pending') {
      setAuth((current) => ({
        ...current,
        message: consoleMessages.authPending,
        polling: false,
      }));
      authPollTimerRef.current = window.setTimeout(() => {
        void pollAuth(authState);
      }, auth.intervalSeconds * 1000);
      return;
    }

    const message = getErrorMessage(
      result.data,
      consoleMessages.authPollFailed,
    );
    setAuth((current) => ({
      ...current,
      message,
      polling: false,
    }));
    showConsoleNotification('error', message);
  };

  const startAuth = async () => {
    clearAuthTimer();
    setAuth((current) => ({
      ...current,
      authState: '',
      authUrl: '',
      callbackUrl: '',
      completed: false,
      message: '',
      polling: false,
      showManualCallback: false,
      starting: true,
    }));

    const result = await requestJson<StartAuthResponse>(
      '/codebuddy/auth/start',
    );

    if (
      !result.ok ||
      !result.data?.auth_state ||
      !result.data?.verification_uri_complete
    ) {
      const message = getErrorMessage(
        result.data,
        consoleMessages.authStartFailed,
      );
      setAuth((current) => ({
        ...current,
        message,
        starting: false,
      }));
      showConsoleNotification('error', message);
      return;
    }

    setAuth((current) => ({
      ...current,
      authState: result.data?.auth_state ?? '',
      authUrl: result.data?.verification_uri_complete ?? '',
      completed: false,
      intervalSeconds: result.data?.interval ?? 5,
      message: consoleMessages.authStarted,
      starting: false,
    }));
    showConsoleNotification('success', consoleMessages.authCreated);
    authPollTimerRef.current = window.setTimeout(
      () => {
        void pollAuth(result.data?.auth_state);
      },
      (result.data?.interval ?? 5) * 1000,
    );
  };

  const addCredential = async () => {
    const isEditing = credentials.form.editingIndex !== null;

    if (!isEditing && !credentials.form.bearerToken.trim()) {
      showConsoleNotification('warning', consoleMessages.credentialRequired);
      return;
    }

    setCredentials((current) => ({
      ...current,
      actionIndex: -1,
    }));

    const result = await requestJson<{ filename?: string; success?: boolean }>(
      '/admin-api/credentials',
      {
        body: JSON.stringify(
          isEditing
            ? {
                index: credentials.form.editingIndex,
                first_message_role_to_system:
                  credentials.form.firstMessageRoleToSystem,
                first_system_message_role_to_user:
                  credentials.form.firstSystemMessageRoleToUser,
                upstream_protocol: credentials.form.upstreamProtocol,
              }
            : {
                access_token: credentials.form.bearerToken.trim(),
                bearer_token: credentials.form.bearerToken.trim(),
                first_message_role_to_system:
                  credentials.form.firstMessageRoleToSystem,
                first_system_message_role_to_user:
                  credentials.form.firstSystemMessageRoleToUser,
                upstream_protocol: credentials.form.upstreamProtocol,
                user_id: credentials.form.userId.trim() || undefined,
              },
        ),
        headers: {
          'Content-Type': 'application/json',
        },
        method: 'POST',
      },
    );

    if (!result.ok || !result.data?.success) {
      showConsoleNotification(
        'error',
        getErrorMessage(result.data, consoleMessages.credentialSaveFailed),
      );
      setCredentials((current) => ({
        ...current,
        actionIndex: null,
      }));
      return;
    }

    setCredentials((current) => ({
      ...current,
      actionIndex: null,
      form: {
        bearerToken: '',
        editingIndex: null,
        firstMessageRoleToSystem: false,
        firstSystemMessageRoleToUser: false,
        upstreamProtocol: 'chat',
        userId: '',
      },
    }));
    showConsoleNotification(
      'success',
      translations('console.credentialSaved', {
        name: result.data.filename ?? 'unknown',
      }),
    );
    await refreshAdminData();
  };

  const deleteCredential = async (index: number) => {
    setCredentials((current) => ({
      ...current,
      actionIndex: index,
    }));

    const result = await requestJson<{ success?: boolean }>(
      '/admin-api/credentials/delete',
      {
        body: JSON.stringify({ index }),
        headers: {
          'Content-Type': 'application/json',
        },
        method: 'POST',
      },
    );

    if (!result.ok || !result.data?.success) {
      showConsoleNotification(
        'error',
        getErrorMessage(result.data, consoleMessages.credentialDeleteFailed),
      );
      setCredentials((current) => ({
        ...current,
        actionIndex: null,
      }));
      return;
    }

    showConsoleNotification('success', consoleMessages.credentialDeleted);
    await refreshAdminData();
  };

  const saveAccessKey = async () => {
    const { credentialFilenames, editingId, name } = credentials.accessKeyForm;

    setCredentials((current) => ({
      ...current,
      accessKeyActionId: editingId ?? '__new__',
    }));

    const endpoint = editingId
      ? `/admin-api/access-keys/${editingId}`
      : '/admin-api/access-keys';
    const method = editingId ? 'PATCH' : 'POST';
    const result = await requestJson<{
      access_key?: AccessKeySummary;
      secret?: string;
    }>(endpoint, {
      body: JSON.stringify({
        credential_filenames: credentialFilenames,
        name,
      }),
      headers: {
        'Content-Type': 'application/json',
      },
      method,
    });

    if (!result.ok) {
      showConsoleNotification(
        'error',
        getErrorMessage(
          result.data,
          editingId
            ? consoleMessages.apiKeyUpdated
            : consoleMessages.apiKeyCreated,
        ),
      );
      setCredentials((current) => ({
        ...current,
        accessKeyActionId: null,
      }));
      return;
    }

    setCredentials((current) => ({
      ...current,
      accessKeyActionId: null,
      accessKeyCreating: false,
      accessKeyForm: {
        credentialFilenames: [],
        editingId: null,
        name: '',
      },
      revealedSecret:
        result.data?.access_key && result.data.secret
          ? {
              id: result.data.access_key.id,
              name: result.data.access_key.name,
              secret: result.data.secret,
            }
          : current.revealedSecret,
    }));
    showConsoleNotification(
      'success',
      editingId ? consoleMessages.apiKeyUpdated : consoleMessages.apiKeyCreated,
    );
    await loadCredentials();
  };

  const deleteAccessKey = async (id: string) => {
    setCredentials((current) => ({
      ...current,
      accessKeyActionId: id,
    }));

    const result = await requestJson<{ success?: boolean }>(
      `/admin-api/access-keys/${id}`,
      {
        method: 'DELETE',
      },
    );

    if (!result.ok || !result.data?.success) {
      showConsoleNotification(
        'error',
        getErrorMessage(result.data, consoleMessages.apiKeyDeleteFailed),
      );
      setCredentials((current) => ({
        ...current,
        accessKeyActionId: null,
      }));
      return;
    }

    setCredentials((current) => ({
      ...current,
      accessKeyActionId: null,
      revealedSecret:
        current.revealedSecret?.id === id ? null : current.revealedSecret,
    }));
    showConsoleNotification('success', consoleMessages.apiKeyDeleted);
    await loadCredentials();
  };

  const revealAccessKeySecret = async (id: string) => {
    setCredentials((current) => ({
      ...current,
      accessKeyActionId: id,
    }));

    const result = await requestJson<AccessKeySecretResponse>(
      `/admin-api/access-keys/${id}/secret`,
    );

    if (!result.ok || !result.data?.secret || !result.data?.name) {
      showConsoleNotification(
        'error',
        getErrorMessage(result.data, consoleMessages.apiKeyReadFailed),
      );
      setCredentials((current) => ({
        ...current,
        accessKeyActionId: null,
      }));
      return;
    }

    const secretPayload = result.data as {
      id?: string;
      name: string;
      secret: string;
    };

    setCredentials((current) => ({
      ...current,
      accessKeyActionId: null,
      revealedSecret: {
        id: secretPayload.id ?? id,
        name: secretPayload.name,
        secret: secretPayload.secret,
      },
    }));
    showConsoleNotification('success', consoleMessages.apiKeyDisplayed);
  };

  const submitCallbackUrl = async () => {
    if (!auth.callbackUrl.trim()) {
      showConsoleNotification('warning', consoleMessages.authPending);
      return;
    }

    try {
      const url = new URL(auth.callbackUrl);
      const state = url.searchParams.get('state') ?? auth.authState;

      setAuth((current) => ({
        ...current,
        authState: state,
        showManualCallback: false,
      }));
      await pollAuth(state);
    } catch {
      showConsoleNotification('error', consoleMessages.authInvalidCallback);
    }
  };

  useEffect(() => {
    if (!hasInitialData) {
      void loadCredentials();
    }

    return () => {
      clearAuthTimer();
    };
  }, [hasInitialData, loadCredentials]);

  return (
    <CredentialsProvider
      value={{
        auth,
        credentials,
        onAddAccessKey: () => {
          setCredentials((current) => ({
            ...current,
            accessKeyCreating: true,
            accessKeyForm: {
              credentialFilenames: [],
              editingId: null,
              name: '',
            },
          }));
        },
        onAddCredential: () => {
          void addCredential();
        },
        onAuthAction: () => {
          void startAuth();
        },
        onCallbackUrlChange: (value) => {
          setAuth((current) => ({
            ...current,
            callbackUrl: value,
          }));
        },
        onCopyAuthUrl: () => {
          void copyText(auth.authUrl, consoleMessages.authCopy);
        },
        onCredentialFirstMessageRoleToSystemChange: (value) => {
          setCredentials((current) => ({
            ...current,
            form: {
              ...current.form,
              firstMessageRoleToSystem: value,
            },
          }));
        },
        onCredentialFirstSystemMessageRoleToUserChange: (value) => {
          setCredentials((current) => ({
            ...current,
            form: {
              ...current.form,
              firstSystemMessageRoleToUser: value,
            },
          }));
        },
        onCredentialUpstreamProtocolChange: (value) => {
          setCredentials((current) => ({
            ...current,
            form: {
              ...current.form,
              upstreamProtocol: value,
            },
          }));
        },
        onCredentialTokenChange: (value) => {
          setCredentials((current) => ({
            ...current,
            form: {
              ...current.form,
              bearerToken: value,
            },
          }));
        },
        onCredentialUserIdChange: (value) => {
          setCredentials((current) => ({
            ...current,
            form: {
              ...current.form,
              userId: value,
            },
          }));
        },
        onDeleteCredential: (index) => {
          void deleteCredential(index);
        },
        onEditCredential: (credential) => {
          setCredentials((current) => ({
            ...current,
            form: {
              bearerToken: '',
              editingIndex: credential.index,
              firstMessageRoleToSystem: credential.first_message_role_to_system,
              firstSystemMessageRoleToUser: Boolean(
                credential.first_system_message_role_to_user,
              ),
              upstreamProtocol: credential.upstream_protocol,
              userId: credential.user_id ?? '',
            },
          }));
        },
        onDeleteAccessKey: (id) => {
          void deleteAccessKey(id);
        },
        onEditAccessKey: (accessKey) => {
          setCredentials((current) => ({
            ...current,
            accessKeyCreating: false,
            accessKeyForm: {
              credentialFilenames: accessKey.credentialFilenames.filter(
                (filename) =>
                  current.items.some(
                    (credential) =>
                      !credential.is_expired &&
                      credential.filename === filename,
                  ),
              ),
              editingId: accessKey.id,
              name: accessKey.name,
            },
          }));
        },
        onOpenAuthUrl: () => {
          if (!auth.authUrl) {
            showConsoleNotification('warning', consoleMessages.authLinkMissing);
            return;
          }

          window.open(auth.authUrl, '_blank', 'noopener,noreferrer');
        },
        onPollAuth: () => {
          void pollAuth();
        },
        onRefreshAccessKeys: () => {
          void refreshAccessKeys();
        },
        onRefreshCredentialList: () => {
          void refreshCredentialList();
        },
        onResetCredentialForm: () => {
          setCredentials((current) => ({
            ...current,
            form: {
              bearerToken: '',
              editingIndex: null,
              firstMessageRoleToSystem: false,
              firstSystemMessageRoleToUser: false,
              upstreamProtocol: 'chat',
              userId: '',
            },
          }));
        },
        onRevealAccessKeySecret: (id) => {
          void revealAccessKeySecret(id);
        },
        onSaveAccessKey: () => {
          void saveAccessKey();
        },
        onSubmitCallbackUrl: () => {
          void submitCallbackUrl();
        },
        onToggleCallbackMode: (showManual) => {
          setAuth((current) => ({
            ...current,
            showManualCallback: showManual,
          }));
        },
        onToggleCredentialSelection: (filename) => {
          setCredentials((current) => {
            const selected =
              current.accessKeyForm.credentialFilenames.includes(filename);

            return {
              ...current,
              accessKeyForm: {
                ...current.accessKeyForm,
                credentialFilenames: selected
                  ? current.accessKeyForm.credentialFilenames.filter(
                      (item) => item !== filename,
                    )
                  : [...current.accessKeyForm.credentialFilenames, filename],
              },
            };
          });
        },
        onUpdateAccessKeyName: (value) => {
          setCredentials((current) => ({
            ...current,
            accessKeyForm: {
              ...current.accessKeyForm,
              name: value,
            },
          }));
        },
        onResetAccessKeyForm: () => {
          setCredentials((current) => ({
            ...current,
            accessKeyCreating: false,
            accessKeyForm: {
              credentialFilenames: [],
              editingId: null,
              name: '',
            },
          }));
        },
      }}
    >
      {children}
    </CredentialsProvider>
  );
};
