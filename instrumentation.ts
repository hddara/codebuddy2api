export const register = async (): Promise<void> => {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { installProcessDiagnostics, logRuntimeLimits, startMemoryWatchdog } =
    await import('@/lib/server/shared/diagnostics');
  const { scheduleAutoCheckin } =
    await import('@/lib/server/domain/auto-checkin');
  const { refreshMissingCredentialModels } =
    await import('@/lib/server/domain/credential-models');
  const { scheduleQuotaSnapshots } =
    await import('@/lib/server/domain/quota-snapshot');
  const { ensureSessionTranscriptRecorder } =
    await import('@/lib/server/domain/session-transcripts');
  const { ensureSessionTitleRecorder } =
    await import('@/lib/server/domain/session-title-recorder');

  // Samples resident memory every minute and marks the snapshot WARN/ERROR
  // once it approaches the point where the host OOM killer steps in.
  startMemoryWatchdog();
  installProcessDiagnostics();

  // One line at boot that records which guard settings this process actually
  // got. Without it, "did the deploy pick up the new limits" is guesswork: the
  // process reads its configuration from the environment, and the stack file is
  // not proof of what a running task received.
  logRuntimeLimits();

  void refreshMissingCredentialModels();
  void scheduleAutoCheckin();
  void scheduleQuotaSnapshots();
  // Subscribes to the session event bus so finished turns are persisted.
  ensureSessionTranscriptRecorder();
  // Second subscriber on the same bus: names conversations so lists are
  // readable. Independent of the transcript recorder by design — either can
  // fail without affecting the other.
  ensureSessionTitleRecorder();
};
