'use client';

import { useAtom } from 'jotai';
import { useCallback, useEffect } from 'react';
import type { ReactNode } from 'react';

import {
  buildApiEndpoint,
  type CredentialsResponse,
  requestJson,
  type UsageResponse,
} from '@/app/console-request';
import {
  DashboardProvider,
  dashboardRefreshSignalAtom,
  dashboardStateAtom,
} from '@/app/dashboard/dashboard';

interface DashboardTabControllerProps {
  children: ReactNode;
  hasInitialData: boolean;
}

export const DashboardTabController = ({
  children,
  hasInitialData,
}: DashboardTabControllerProps) => {
  const [dashboard, setDashboard] = useAtom(dashboardStateAtom);
  const [refreshSignal, setRefreshSignal] = useAtom(dashboardRefreshSignalAtom);

  const loadDashboard = useCallback(async () => {
    setDashboard((current) => ({
      ...current,
      loading: true,
    }));

    const [usageResult, credentialsResult] = await Promise.all([
      requestJson<UsageResponse>('/admin-api/usage?range=today'),
      requestJson<CredentialsResponse>('/admin-api/credentials'),
    ]);

    setDashboard({
      apiEndpoint: buildApiEndpoint(),
      loading: false,
      summary: {
        cacheHitTokens: usageResult.data?.rangeSummary?.cacheHitTokens ?? 0,
        callCount: usageResult.data?.rangeSummary?.callCount ?? 0,
        totalTokens: usageResult.data?.rangeSummary?.totalTokens ?? 0,
      },
      totalCredentials: credentialsResult.data?.credentials?.length ?? 0,
      validCredentials:
        credentialsResult.data?.credentials?.filter(
          (credential) => !credential.is_expired,
        ).length ?? 0,
    });
  }, [setDashboard]);

  useEffect(() => {
    // Skip the client fetch when the server already provided this tab's data.
    if (!hasInitialData) {
      void loadDashboard();
    }
  }, [hasInitialData, loadDashboard]);

  useEffect(() => {
    // Another tab marked the dashboard stale. The signal is one-shot so that
    // later visits do not refetch on every mount.
    if (refreshSignal === 0) {
      return;
    }

    setRefreshSignal(0);
    void loadDashboard();
  }, [loadDashboard, refreshSignal, setRefreshSignal]);

  return (
    <DashboardProvider value={{ dashboard }}>{children}</DashboardProvider>
  );
};
