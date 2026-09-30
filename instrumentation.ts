export const register = async (): Promise<void> => {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { scheduleAutoCheckin } =
    await import('@/lib/server/domain/auto-checkin');
  const { refreshMissingCredentialModels } =
    await import('@/lib/server/domain/credential-models');
  const { scheduleQuotaSnapshots } =
    await import('@/lib/server/domain/quota-snapshot');

  void refreshMissingCredentialModels();
  void scheduleAutoCheckin();
  void scheduleQuotaSnapshots();
};
