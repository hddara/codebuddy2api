import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NextRequest } from 'next/server';

import {
  addCredential,
  clearCredentialLimits,
  deleteCredentialByIndex,
  flushCredentialRuntimeState,
  isCredentialLimited,
  listCredentialLimits,
  listCredentials,
  markCredentialLimited,
  resetCredentialRuntimeState,
  resolveCredentialForRequest,
} from '@/lib/server/domain/credentials';
import {
  getCredentialLimitCooldownMs,
  updateSettings,
} from '@/lib/server/domain/config';
import {
  proxyChatCompletions,
  resolveProxyContextByCredentialFilename,
} from '@/lib/server/proxy/codebuddy';
import {
  readStorageJson,
  resetStorageRuntime,
  writeStorageJson,
} from '@/lib/server/storage';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const tempRootDir = path.join(repoRoot, '.tmp-test-credential-limits');

/** Captured from production on 2026-09-30 (HTTP 429, code 6004). */
const PRODUCTION_QUOTA_DETAIL = JSON.stringify({
  code: 6004,
  msg: '您的使用量已超出频率限制，将在 2026-10-01 00:36:46 UTC+8 重置，您也可以切换其他模型继续使用。',
  requestId: '213bf21bcb314451b5876ce7f6576ee5',
});

const cleanup = (): void => {
  fs.rmSync(tempRootDir, { force: true, recursive: true, maxRetries: 5 });
};

/**
 * Builds the observed production payload with a reset instant measured from
 * now, so clamping assertions stay valid no matter when the suite runs.
 */
const quotaDetailResettingIn = (offsetMs: number): string => {
  const utc8 = new Date(Date.now() + offsetMs + 8 * 60 * 60 * 1000);
  const pad = (value: number): string => String(value).padStart(2, '0');
  const stamp = [
    `${utc8.getUTCFullYear()}-${pad(utc8.getUTCMonth() + 1)}-${pad(utc8.getUTCDate())}`,
    `${pad(utc8.getUTCHours())}:${pad(utc8.getUTCMinutes())}:${pad(utc8.getUTCSeconds())}`,
  ].join(' ');

  return JSON.stringify({
    code: 6004,
    msg: `您的使用量已超出频率限制，将在 ${stamp} UTC+8 重置，您也可以切换其他模型继续使用。`,
    requestId: 'test-request-id',
  });
};

const makeNextRequest = (url: string): NextRequest =>
  new NextRequest(url, { method: 'POST' });

const resolveMany = async (count: number): Promise<Set<string>> => {
  const filenames = new Set<string>();

  for (let index = 0; index < count; index += 1) {
    filenames.add((await resolveCredentialForRequest())?.filename ?? '');
  }

  return filenames;
};

describe('credential rate limit tracking', () => {
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

  afterEach(async () => {
    // Flush the debounced runtime state write so no pending timer can restore
    // stale marks into the next test.
    await flushCredentialRuntimeState().catch(() => undefined);
    cleanup();
    vi.useRealTimers();
  });

  it('rotates away from a limited credential and restores it after expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-30T09:00:00.000Z'));
    await addCredential({ bearer_token: 'a' }, 'a');
    await addCredential({ bearer_token: 'b' }, 'b');
    await markCredentialLimited({
      code: 6004,
      filename: 'a.json',
      kind: 'quota',
      reason: 'quota exceeded',
      resumeAt: Date.now() + 60_000,
      status: 429,
    });

    expect(await resolveMany(4)).toEqual(new Set(['b.json']));
    expect(await listCredentialLimits()).toEqual([
      expect.objectContaining({ filename: 'a.json', kind: 'quota' }),
    ]);

    vi.setSystemTime(new Date('2026-09-30T09:02:00.000Z'));

    expect((await resolveMany(4)).has('a.json')).toBe(true);
    expect(await listCredentialLimits()).toEqual([]);
  });

  it('falls back to the earliest recovery when every credential is limited', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-30T09:00:00.000Z'));
    await addCredential({ bearer_token: 'a' }, 'a');
    await addCredential({ bearer_token: 'b' }, 'b');
    await markCredentialLimited({
      filename: 'a.json',
      kind: 'quota',
      resumeAt: Date.now() + 600_000,
      status: 429,
    });
    await markCredentialLimited({
      filename: 'b.json',
      kind: 'frequency',
      resumeAt: Date.now() + 120_000,
      status: 429,
    });

    const selected = await resolveCredentialForRequest();

    expect(selected?.filename).toBe('b.json');
    expect(console.warn).toHaveBeenCalledWith(
      '[CodeBuddy2API][WARN] All eligible credentials are rate limited',
      expect.objectContaining({
        limitedCandidates: 2,
        selectedCredentialFilename: 'b.json',
      }),
    );
  });

  it('keeps the longest observed cooldown and counts observations', async () => {
    const first = await markCredentialLimited({
      filename: 'a.json',
      kind: 'frequency',
      resumeAt: Date.now() + 180_000,
      status: 429,
    });
    const second = await markCredentialLimited({
      filename: 'a.json',
      kind: 'frequency',
      reason: 'still limited',
      resumeAt: Date.now() + 60_000,
      status: 429,
    });

    expect(second.hits).toBe(2);
    expect(second.resumeAt).toBe(first.resumeAt);
    expect(second.reason).toBe('still limited');
  });

  it('persists marks across runtime resets and clears them when re-saved', async () => {
    await addCredential({ bearer_token: 'a' }, 'a');
    await markCredentialLimited({
      filename: 'a.json',
      kind: 'quota',
      resumeAt: Date.now() + 900_000,
      status: 429,
    });
    await flushCredentialRuntimeState();

    expect(
      (
        await readStorageJson<{
          limitedCredentials?: Record<string, unknown>;
        }>('credentials', 'manager_state.json')
      )?.limitedCredentials,
    ).toMatchObject({ 'a.json': { kind: 'quota' } });

    resetCredentialRuntimeState();
    expect(await isCredentialLimited('a.json')).toBe(true);

    await addCredential({ bearer_token: 'a-refreshed' }, 'a');

    expect(await isCredentialLimited('a.json')).toBe(false);
    expect(await clearCredentialLimits()).toBe(0);
    await flushCredentialRuntimeState();
  });

  it('exposes marks in the credential list and drops them with the credential', async () => {
    await addCredential(
      { bearer_token: 'a', user_info: { email: 'a@example.com' } },
      'a',
    );
    await markCredentialLimited({
      code: 6004,
      filename: 'a.json',
      kind: 'quota',
      reason: 'quota exceeded',
      resumeAt: Date.now() + 900_000,
      status: 429,
    });

    expect((await listCredentials()).credentials[0]).toMatchObject({
      filename: 'a.json',
      rate_limited_hits: 1,
      rate_limited_kind: 'quota',
      rate_limited_reason: 'quota exceeded',
      rate_limited_until: expect.any(Number),
    });
    expect(await clearCredentialLimits(['missing.json'])).toBe(0);

    await deleteCredentialByIndex(0);

    expect(await listCredentialLimits()).toEqual([]);
  });

  it('reassigns a pinned conversation away from a limited credential', async () => {
    await addCredential({ bearer_token: 'a' }, 'a');
    await addCredential({ bearer_token: 'b' }, 'b');
    await writeStorageJson('credentials', 'manager_state.json', {
      affinityAssignmentsByKey: {
        conversation: {
          credentialFilename: 'a.json',
          updatedAt: Date.now(),
        },
      },
    });
    resetCredentialRuntimeState();
    await markCredentialLimited({
      filename: 'a.json',
      kind: 'quota',
      resumeAt: Date.now() + 600_000,
      status: 429,
    });

    const resolved = await resolveCredentialForRequest({
      affinityKey: 'conversation',
    });

    expect(resolved?.filename).toBe('b.json');
  });

  it('marks the credential behind a 429 upstream response', async () => {
    const created = await addCredential(
      { bearer_token: 'token-a', user_id: 'a@example.com' },
      'a',
    );
    const context = await resolveProxyContextByCredentialFilename(
      created.filename,
    );
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(PRODUCTION_QUOTA_DETAIL, {
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        status: 429,
      }),
    );

    const response = await proxyChatCompletions(
      makeNextRequest('http://localhost/v1/chat/completions'),
      {
        messages: [{ content: 'hi', role: 'user' }],
        model: 'deepseek-v4.1-flash',
      },
      context,
    );

    expect(response.status).toBe(429);
    expect(await response.text()).toContain('6004');
    expect(await listCredentialLimits()).toEqual([
      expect.objectContaining({
        code: 6004,
        filename: 'a.json',
        kind: 'quota',
        status: 429,
      }),
    ]);
  });

  it('retries the request on another credential after a 429', async () => {
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
      .mockResolvedValueOnce(
        new Response(PRODUCTION_QUOTA_DETAIL, {
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          status: 429,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'ok', role: 'assistant' } }],
            usage: { completion_tokens: 2, prompt_tokens: 1, total_tokens: 3 },
          }),
          {
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
            status: 200,
          },
        ),
      );

    const response = await proxyChatCompletions(
      makeNextRequest('http://localhost/v1/chat/completions'),
      {
        messages: [{ content: 'hi', role: 'user' }],
        model: 'deepseek-v4.1-flash',
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(200);

    const bearerOf = (index: number): string | null =>
      new Headers(
        (fetchMock.mock.calls[index]?.[1] as RequestInit).headers,
      ).get('authorization');

    // The retry has to leave on a different account.
    expect(bearerOf(0)).not.toBe(bearerOf(1));
    expect(console.warn).toHaveBeenCalledWith(
      '[CodeBuddy2API][WARN] Retrying upstream request with another credential',
      expect.objectContaining({
        fromCredentialFilename: expect.any(String),
        toCredentialFilename: expect.any(String),
      }),
    );

    const limits = await listCredentialLimits();

    expect(limits).toHaveLength(1);
    expect(bearerOf(1)).toContain('token-');
  });

  it('keeps the upstream 429 when no other credential is available', async () => {
    await addCredential({ bearer_token: 'token-a' }, 'a');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(PRODUCTION_QUOTA_DETAIL, {
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        status: 429,
      }),
    );

    const response = await proxyChatCompletions(
      makeNextRequest('http://localhost/v1/chat/completions'),
      {
        messages: [{ content: 'hi', role: 'user' }],
        model: 'deepseek-v4.1-flash',
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(429);
    expect(console.warn).toHaveBeenCalledWith(
      '[CodeBuddy2API][WARN] No credential available for rotation retry',
      expect.objectContaining({ fromCredentialFilename: expect.any(String) }),
    );
    expect(await listCredentialLimits()).toHaveLength(1);
  });

  it('does not rotate away from a credential pinned by the caller', async () => {
    const created = await addCredential(
      { bearer_token: 'token-a', user_id: 'a@example.com' },
      'a',
    );
    await addCredential({ bearer_token: 'token-b' }, 'b');
    const context = await resolveProxyContextByCredentialFilename(
      created.filename,
    );
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(PRODUCTION_QUOTA_DETAIL, {
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        status: 429,
      }),
    );

    const response = await proxyChatCompletions(
      makeNextRequest('http://localhost/v1/chat/completions'),
      {
        messages: [{ content: 'hi', role: 'user' }],
        model: 'deepseek-v4.1-flash',
      },
      context,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(429);
    expect(await isCredentialLimited(created.filename)).toBe(true);
  });

  it('uses the configured auto-release window', async () => {
    expect(await getCredentialLimitCooldownMs()).toBe(12 * 60 * 60 * 1000);

    await updateSettings({ CODEBUDDY_CREDENTIAL_LIMIT_HOURS: '3' });
    expect(await getCredentialLimitCooldownMs()).toBe(3 * 60 * 60 * 1000);

    await updateSettings({ CODEBUDDY_CREDENTIAL_LIMIT_HOURS: 'nope' });
    expect(await getCredentialLimitCooldownMs()).toBe(12 * 60 * 60 * 1000);
  });

  it('auto-releases a limited credential after the configured window', async () => {
    const twoHours = 2 * 60 * 60 * 1000;
    const tenHours = 10 * 60 * 60 * 1000;
    // A dedicated filename keeps this case independent from marks left behind
    // by the other cases in this file.
    const filename = 'auto-release.json';
    await updateSettings({ CODEBUDDY_CREDENTIAL_LIMIT_HOURS: '2' });
    expect(await getCredentialLimitCooldownMs()).toBe(twoHours);
    await addCredential({ bearer_token: 'token-a' }, 'auto-release');
    const reportedResetAt = Date.now() + tenHours;
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(quotaDetailResettingIn(tenHours), {
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        status: 429,
      }),
    );

    const response = await proxyChatCompletions(
      makeNextRequest('http://localhost/v1/chat/completions'),
      {
        messages: [{ content: 'hi', role: 'user' }],
        model: 'deepseek-v4.1-flash',
      },
    );

    expect(response.status).toBe(429);

    const limit = (await listCredentialLimits()).find(
      (entry) => entry.filename === filename,
    );

    expect(limit?.hits).toBe(1);
    expect(limit?.kind).toBe('quota');
    // The upstream reports a reset ~10h out; the configured 2h window wins.
    expect(limit?.resumeAt).toBeLessThanOrEqual(Date.now() + twoHours);
    expect(limit?.resumeAt).toBeGreaterThan(Date.now() + twoHours - 60_000);
    expect(reportedResetAt - (limit?.resumeAt ?? 0)).toBeGreaterThan(
      4 * 60 * 60 * 1000,
    );
  });

  it('does not mark credentials when the upstream fails with 5xx', async () => {
    const created = await addCredential({ bearer_token: 'token-a' }, 'a');
    const context = await resolveProxyContextByCredentialFilename(
      created.filename,
    );
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('upstream exploded', { status: 500 }),
    );

    const response = await proxyChatCompletions(
      makeNextRequest('http://localhost/v1/chat/completions'),
      {
        messages: [{ content: 'hi', role: 'user' }],
        model: 'deepseek-v4.1-flash',
      },
      context,
    );

    expect(response.status).toBe(500);
    expect(await listCredentialLimits()).toEqual([]);
  });
});
