import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NextRequest } from 'next/server';

import {
  addCredential,
  listCredentialLimits,
  resetCredentialRuntimeState,
} from '@/lib/server/domain/credentials';
import { proxyChatCompletions } from '@/lib/server/proxy/codebuddy';
import { resetStorageRuntime } from '@/lib/server/storage';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const tempRootDir = path.join(repoRoot, '.tmp-test-channel-rejection');

const cleanup = (): void => {
  fs.rmSync(tempRootDir, { force: true, recursive: true, maxRetries: 5 });
};

const makeNextRequest = (): NextRequest =>
  new NextRequest('http://localhost/v1/chat/completions', { method: 'POST' });

/** Captured from production on 2026-10-24 (HTTP 400, code 11128). */
const CHANNEL_REJECTION_DETAIL = JSON.stringify({
  code: 11128,
  displayMsg: {
    en: 'Request blocked. Please send it again',
    zh: '请求被拦截，请重新发送',
  },
  displayTips: {
    en: 'This call failed channel verification, possibly because it was not sent from an official client.',
  },
  msg: 'Illegal API invocation from an unapproved channel',
  requestId: '975f8f68708248318689530c86e30e2b',
});

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

const rejectionResponse = (): Response =>
  new Response(CHANNEL_REJECTION_DETAIL, {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    status: 400,
  });

const bearerOf = (
  fetchMock: { mock: { calls: unknown[][] } },
  index: number,
): string | null =>
  new Headers((fetchMock.mock.calls[index]?.[1] as RequestInit).headers).get(
    'authorization',
  );

const body = {
  messages: [{ content: 'hi', role: 'user' }],
  model: 'deepseek-v4.1-flash',
};

describe('upstream channel rejection (code 11128)', () => {
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
    // `path.resolve('.')` reads the real working directory, so mocking
    // `process.cwd` does not redirect the credential store: without this the
    // pool under test is whatever `.codebuddy_creds` happens to hold, and a
    // second account left there by another test defeats the single-account case.
    process.env.CODEBUDDY_CREDENTIALS_DIR = path.join(tempRootDir, 'creds');
    process.env.CODEBUDDY_AUTH_MODE = 'auto';
  });

  afterEach(() => {
    cleanup();
  });

  it('retries on another credential instead of returning the 400 to the caller', async () => {
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
      .mockResolvedValueOnce(rejectionResponse())
      .mockResolvedValueOnce(okResponse());

    const response = await proxyChatCompletions(makeNextRequest(), body);

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The retry must leave on a different account: the refusal is a property of
    // the draw, and sending it back to the same credential would just repeat it.
    expect(bearerOf(fetchMock, 0)).not.toBe(bearerOf(fetchMock, 1));
  });

  it('retries the same credential when the pool holds no other account', async () => {
    // A single-account deployment has nothing to rotate to. The refusal is a
    // property of the draw, not of the credential, so re-sending on the same
    // account is the only retry available and it must not be skipped.
    await addCredential(
      { bearer_token: 'token-a', user_id: 'a@example.com' },
      'a',
    );
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(rejectionResponse())
      .mockResolvedValueOnce(okResponse());

    const response = await proxyChatCompletions(makeNextRequest(), body);

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bearerOf(fetchMock, 0)).toBe(bearerOf(fetchMock, 1));
    expect(console.warn).toHaveBeenCalledWith(
      '[CodeBuddy2API][WARN] Retrying the same credential after a channel rejection',
      expect.objectContaining({ channelRetries: 1 }),
    );
  });

  it('does not mark the credential as rate limited', async () => {
    // A channel rejection says nothing about quota, so the account must stay
    // available to the very next request.
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
      .mockResolvedValueOnce(rejectionResponse())
      .mockResolvedValueOnce(okResponse());

    await proxyChatCompletions(makeNextRequest(), body);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(console.warn).toHaveBeenCalledWith(
      '[CodeBuddy2API][WARN] Retrying upstream request with another credential',
      expect.objectContaining({
        reason: expect.stringContaining('rejected the channel'),
      }),
    );
    expect(console.warn).not.toHaveBeenCalledWith(
      '[CodeBuddy2API][WARN] Marked credential as rate limited',
      expect.anything(),
    );
  });

  it('gives up after its own budget instead of retrying forever', async () => {
    // Probes re-send the rejected request, so they are off here: this test is
    // about how many times the *request* is attempted.
    process.env.CODEBUDDY_CHANNEL_PROBES = '0';

    await addCredential(
      { bearer_token: 'token-a', user_id: 'a@example.com' },
      'a',
    );
    await addCredential(
      { bearer_token: 'token-b', user_id: 'b@example.com' },
      'b',
    );
    await addCredential(
      { bearer_token: 'token-c', user_id: 'c@example.com' },
      'c',
    );
    // A fresh Response per attempt: a single instance can only have its body
    // read once, and reusing it would fail for the wrong reason.
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => rejectionResponse());

    const response = await proxyChatCompletions(makeNextRequest(), body);

    expect(response.status).toBe(400);
    // Two retries, so three attempts at most; the point is that it terminates
    // rather than exhausting every credential in the pool.
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(3);

    // The refusal is the one failure that cannot be diagnosed from outside, so
    // the response carries what the gateway actually sent: the headers it shaped
    // the call with, and the claims of the token it used.
    const payload = (await response.json()) as { error?: { detail?: string } };
    const detail = payload.error?.detail ?? '';

    expect(detail).toContain('channel-diagnostics: ');
    const diagnostics = JSON.parse(
      detail.slice(detail.indexOf('channel-diagnostics: ') + 21),
    ) as {
      attempts: number;
      channelHeaders: Record<string, string>;
      tokenClaims: unknown;
    };

    expect(diagnostics.attempts).toBeGreaterThanOrEqual(2);
    expect(diagnostics.channelHeaders['x-ide-type']).toBe('CLI');
    expect(diagnostics.channelHeaders['x-codebuddy-request']).toBe('1');
    expect(diagnostics.channelHeaders['x-domain']).toBe('www.codebuddy.cn');
    // `token-a` is not a JWT, so there is nothing to decode and nothing to leak.
    expect(diagnostics.tokenClaims).toBeNull();

    // An account that burns the whole budget is the one the gate keeps refusing,
    // so it leaves the rotation for a while instead of costing the next caller.
    const limits = await listCredentialLimits();
    const channelLimited = limits.filter((entry) => entry.kind === 'channel');

    expect(channelLimited).toHaveLength(1);
    expect(channelLimited[0]?.code).toBe(11128);
    expect(channelLimited[0]?.resumeAt).toBeGreaterThan(Date.now());
  });

  it('answers with the variant the upstream accepts instead of a 400', async () => {
    delete process.env.CODEBUDDY_CHANNEL_PROBES;
    await addCredential(
      { bearer_token: 'token-a', user_id: 'a@example.com' },
      'a',
    );
    // Every call is refused with the channel code except the probe sent with
    // official sampling parameters, which is the shape under suspicion.
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (_input, init?: RequestInit) => {
        const sent = JSON.parse(String(init?.body)) as { verbosity?: string };
        return sent.verbosity ? okResponse() : rejectionResponse();
      },
    );

    const response = await proxyChatCompletions(makeNextRequest(), body);

    // The caller asked for an answer, not for a diagnosis: once a variant is
    // accepted, its response is the answer.
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      choices: [{ message: { content: 'ok' } }],
    });
    expect(console.warn).toHaveBeenCalledWith(
      '[CodeBuddy2API][WARN] Recovered a channel rejection with a probe variant',
      expect.objectContaining({ variant: 'officialParams' }),
    );
  });

  it('reports every probe when no variant is accepted', async () => {
    delete process.env.CODEBUDDY_CHANNEL_PROBES;
    await addCredential(
      { bearer_token: 'token-a', user_id: 'a@example.com' },
      'a',
    );
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      rejectionResponse(),
    );

    const response = await proxyChatCompletions(makeNextRequest(), body);
    const payload = (await response.json()) as { error?: { detail?: string } };
    const detail = payload.error?.detail ?? '';
    const diagnostics = JSON.parse(
      detail.slice(detail.indexOf('channel-diagnostics: ') + 21),
    ) as {
      bodyShape: { messageCount: number; systemMessages: number };
      probes: Record<string, string>;
    };

    expect(response.status).toBe(400);
    expect(diagnostics.bodyShape.messageCount).toBe(1);
    expect(diagnostics.bodyShape.systemMessages).toBe(0);
    expect(Object.keys(diagnostics.probes).length).toBe(8);
    expect(diagnostics.probes.plainBody).toBe('400/11128');
    expect(diagnostics.probes.webChannel).toBe('400/11128');
  });

  it('sends only the official header set and no caller headers', async () => {
    await addCredential(
      { bearer_token: 'token-a', user_id: 'a@example.com' },
      'a',
    );
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okResponse());
    const request = new NextRequest('http://localhost/v1/chat/completions', {
      headers: {
        cookie: 'session=abc',
        'x-conversation-id': 'DeepSeek Harness',
        'x-dsh-harness': 'deepseek',
        origin: 'https://harness.example',
        referer: 'https://harness.example/app',
        'user-agent': 'DeepSeekHarness/1.0',
      },
      method: 'POST',
    });

    await proxyChatCompletions(request, body);

    // Read from what was actually handed to `fetch`, not from the builder: the
    // bug guarded against is a header surviving the trip, not a missing `set`.
    const sent = new Headers(
      (fetchMock.mock.calls[0]?.[1] as RequestInit).headers,
    );

    for (const name of [
      'cookie',
      'origin',
      'referer',
      'x-dsh-harness',
      'x-session-id',
    ]) {
      expect(sent.get(name)).toBeNull();
    }
    expect(sent.get('user-agent')).toBe('CLI/2.177.1 CodeBuddy/2.177.1');
    expect(sent.get('x-ide-type')).toBe('CLI');
    expect(sent.get('x-codebuddy-request')).toBe('1');
    // A caller's text in an official correlation header would be forwarded under
    // a name the upstream expects to hold an id.
    expect(sent.get('x-conversation-id')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
