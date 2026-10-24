import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NextRequest } from 'next/server';

import {
  addCredential,
  resetCredentialRuntimeState,
} from '@/lib/server/domain/credentials';
import { proxyChatCompletions } from '@/lib/server/proxy/codebuddy';
import {
  DispatchCeilingExceededError,
  getDispatchCeilingBytes,
  getEffectiveTargetBytes,
} from '@/lib/server/shared/http';
import { resetStorageRuntime } from '@/lib/server/storage';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const tempRootDir = path.join(repoRoot, '.tmp-test-dispatch-ceiling');

const cleanup = (): void => {
  fs.rmSync(tempRootDir, { force: true, recursive: true, maxRetries: 5 });
};

const makeNextRequest = (): NextRequest =>
  new NextRequest('http://localhost/v1/chat/completions', { method: 'POST' });

describe('dispatch ceiling', () => {
  beforeEach(() => {
    cleanup();
    resetCredentialRuntimeState();
    resetStorageRuntime();
    vi.restoreAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(process, 'cwd').mockReturnValue(tempRootDir);
    delete process.env.CODEBUDDY_STORAGE_BACKEND;
    delete process.env.CODEBUDDY_STORAGE_FILE_DIR;
    delete process.env.CODEBUDDY_REQUEST_TARGET_BYTES;
    process.env.CODEBUDDY_AUTH_MODE = 'auto';
  });

  afterEach(() => {
    cleanup();
  });

  it('sits at a multiple of the dispatch target rather than at the target', () => {
    // The target is a policy knob that production exceeded by 15% without
    // incident, so the refusal point has to be strictly above it.
    expect(getDispatchCeilingBytes()).toBeGreaterThan(
      getEffectiveTargetBytes(),
    );
    expect(getDispatchCeilingBytes()).toBe(getEffectiveTargetBytes() * 4);
  });

  it('names the size and the ceiling in the error it reports', () => {
    const error = new DispatchCeilingExceededError(
      6 * 1024 * 1024,
      4 * 1024 * 1024,
    );

    expect(error.name).toBe('DispatchCeilingExceededError');
    expect(error.bytes).toBe(6 * 1024 * 1024);
    expect(error.limitBytes).toBe(4 * 1024 * 1024);
    expect(error.message).toContain('6.0MB');
    expect(error.message).toContain('4.0MB');
    expect(error.message).toContain('Send fewer messages');
  });

  it('answers 413 without calling upstream when the pinned turn alone is past the ceiling', async () => {
    await addCredential(
      { bearer_token: 'token-a', user_id: 'a@example.com' },
      'a',
    );
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    // The newest user turn is pinned, so no stage may shrink it: whatever it
    // weighs survives compression and is what the ceiling has to judge.
    const response = await proxyChatCompletions(makeNextRequest(), {
      messages: [
        { content: 'the current turn', role: 'system' },
        { content: 'Q'.repeat(6 * 1024 * 1024), role: 'user' },
      ],
      model: 'deepseek-v4.1-flash',
    });

    expect(response.status).toBe(413);

    const payload = (await response.json()) as {
      error: {
        code: string;
        message: string;
        detail: { bytes: number; limit_bytes: number };
      };
    };

    expect(payload.error.code).toBe('request_too_large');
    expect(payload.error.message).toContain('dispatch ceiling');
    expect(payload.error.detail.bytes).toBeGreaterThan(
      payload.error.detail.limit_bytes,
    );
    // Refusing locally is the whole point: an unsendable body must not cost a
    // credential or an upstream round trip.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
