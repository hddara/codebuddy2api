import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NextRequest } from 'next/server';

import {
  addCredential,
  resetCredentialRuntimeState,
} from '@/lib/server/domain/credentials';
import { proxyChatCompletions } from '@/lib/server/proxy/codebuddy';
import { resetStorageRuntime } from '@/lib/server/storage';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const tempRootDir = path.join(repoRoot, '.tmp-test-connection-reset');

const cleanup = (): void => {
  fs.rmSync(tempRootDir, { force: true, recursive: true, maxRetries: 5 });
};

const makeNextRequest = (): NextRequest =>
  new NextRequest('http://localhost/v1/chat/completions', { method: 'POST' });

const okResponse = (): Response =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content: 'ok', role: 'assistant' } }],
      usage: { completion_tokens: 2, prompt_tokens: 1, total_tokens: 3 },
    }),
    {
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      status: 200,
    },
  );

/** The exact shape `fetch` throws when the peer closes before answering. */
const connectionResetError = (): Error => {
  const error = new TypeError(
    'ECONNRESET: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()',
  );
  (error as { code?: string }).code = 'ECONNRESET';

  return error;
};

const body = {
  messages: [{ content: 'hi', role: 'user' }],
  model: 'deepseek-v4.1-flash',
};

describe('upstream connection reset', () => {
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
    process.env.CODEBUDDY_AUTH_MODE = 'auto';
  });

  afterEach(() => {
    cleanup();
  });

  it('resends the request when the socket closed before any response', async () => {
    await addCredential(
      { bearer_token: 'token-a', user_id: 'a@example.com' },
      'a',
    );
    await addCredential(
      { bearer_token: 'token-b', user_id: 'b@example.com' },
      'b',
    );
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(connectionResetError())
      .mockResolvedValueOnce(okResponse());

    const response = await proxyChatCompletions(makeNextRequest(), body);

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(console.warn).toHaveBeenCalledWith(
      '[CodeBuddy2API][WARN] Retrying after the upstream connection reset',
      expect.objectContaining({ connectionRetries: 1 }),
    );
  });

  it('gives up after two connection retries instead of looping forever', async () => {
    await addCredential(
      { bearer_token: 'token-a', user_id: 'a@example.com' },
      'a',
    );
    await addCredential(
      { bearer_token: 'token-b', user_id: 'b@example.com' },
      'b',
    );
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(connectionResetError());

    const response = await proxyChatCompletions(makeNextRequest(), body);

    // The proxy answers a spent retry budget with a 500, as it did before the
    // retry existed; the gain is that two transient resets no longer reach it.
    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toContain('ECONNRESET');

    // The original send plus MAX_CONNECTION_RETRIES, and no more.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not retry an error that is not a connection reset', async () => {
    await addCredential(
      { bearer_token: 'token-a', user_id: 'a@example.com' },
      'a',
    );
    await addCredential(
      { bearer_token: 'token-b', user_id: 'b@example.com' },
      'b',
    );
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new TypeError('Invalid URL'));

    const response = await proxyChatCompletions(makeNextRequest(), body);

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toContain('Invalid URL');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
