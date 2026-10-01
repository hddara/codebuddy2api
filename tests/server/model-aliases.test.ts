import fs from 'node:fs';
import path from 'node:path';

import { NextRequest } from 'next/server';

import {
  createAccessKey,
  listAccessKeys,
  listStoredAccessKeys,
  updateAccessKey,
} from '@/lib/server/domain/access-keys';
import { addCredential } from '@/lib/server/domain/credentials';
import {
  areModelAliasesEqual,
  assertModelAliasTargets,
  normalizeModelAliases,
  resolveModelAlias,
} from '@/lib/server/domain/model-aliases';
import { resetCredentialRuntimeState } from '@/lib/server/domain/credentials';
import { proxyChatCompletions } from '@/lib/server/proxy/codebuddy';
import { handleResponsesRequest } from '@/lib/server/proxy/responses';
import { resetStorageRuntime, writeStorageJson } from '@/lib/server/storage';

const tempRootDir = path.join(process.cwd(), '.tmp-test-model-aliases');

const cleanup = (): void => {
  fs.rmSync(tempRootDir, { force: true, recursive: true, maxRetries: 5 });
};

const makeRequest = (url: string, secret?: string): NextRequest =>
  new NextRequest(url, {
    ...(secret ? { headers: { authorization: `Bearer ${secret}` } } : {}),
    method: 'POST',
  });

const makeChatCompletionResponse = (content = 'ok'): Response =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content, role: 'assistant' } }],
      usage: { completion_tokens: 2, prompt_tokens: 1, total_tokens: 3 },
    }),
    {
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      status: 200,
    },
  );

const readUpstreamModel = (
  fetchMock: {
    mock: { calls: unknown[][] };
  },
  index = 0,
): string => {
  const init = fetchMock.mock.calls[index]?.[1] as RequestInit | undefined;
  const body = JSON.parse(String(init?.body)) as { model?: string };

  return String(body.model);
};

describe('model alias helpers', () => {
  it('normalizes alias maps and drops invalid entries', () => {
    expect(normalizeModelAliases(undefined)).toEqual({});
    expect(normalizeModelAliases(null)).toEqual({});
    expect(normalizeModelAliases('not-an-object')).toEqual({});
    expect(normalizeModelAliases(['nope'])).toEqual({});

    expect(
      normalizeModelAliases({
        '  alias-a  ': ' real-model ',
        '': 'real-model',
        'alias-b': '',
        'alias-c': 'alias-c',
        'alias-d': 42,
        alias_e: 'real-model-2',
      }),
    ).toEqual({
      'alias-a': 'real-model',
      alias_e: 'real-model-2',
    });
  });

  it('caps alias maps and skips oversized names', () => {
    const many: Record<string, string> = {};

    for (let index = 0; index < 60; index += 1) {
      many[`alias-${index}`] = 'real-model';
    }

    expect(Object.keys(normalizeModelAliases(many))).toHaveLength(50);

    expect(
      normalizeModelAliases({
        ['a'.repeat(201)]: 'real-model',
        'alias-f': 'b'.repeat(201),
      }),
    ).toEqual({});
  });

  it('compares alias maps', () => {
    expect(areModelAliasesEqual({}, {})).toBe(true);
    expect(areModelAliasesEqual({ a: 'b' }, { a: 'b' })).toBe(true);
    expect(areModelAliasesEqual({ a: 'b' }, { a: 'c' })).toBe(false);
    expect(areModelAliasesEqual({ a: 'b' }, { a: 'b', c: 'd' })).toBe(false);
  });

  it('resolves aliases while preserving unaliased requests', () => {
    expect(resolveModelAlias(undefined, undefined)).toBeUndefined();
    expect(resolveModelAlias({ a: 'b' }, null)).toBeUndefined();
    expect(resolveModelAlias({ a: 'b' }, '   ')).toBeUndefined();
    expect(resolveModelAlias({ a: 'b' }, 'plain-model')).toBe('plain-model');
    expect(resolveModelAlias({ a: 'b' }, ' a ')).toBe('b');
    expect(resolveModelAlias({}, 'plain-model')).toBe('plain-model');
  });

  it('validates alias targets against the bound credentials', () => {
    expect(() => assertModelAliasTargets({ a: 'b' }, [])).not.toThrow();
    expect(() => assertModelAliasTargets({ a: 'b' }, ['b', 'c'])).not.toThrow();
    expect(() => assertModelAliasTargets({ a: 'b' }, ['c'])).toThrow(
      'Model alias "a" points to "b", which is not supported by the bound credentials',
    );
  });
});

describe('access key model aliases', () => {
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
  });

  afterEach(() => {
    cleanup();
  });

  it('persists aliases on create and update', async () => {
    const credential = await addCredential({ bearer_token: 'token-a' }, 'a');
    const created = await createAccessKey({
      credentialFilenames: [credential.filename],
      modelAliases: { 'flash-a': 'deepseek-v4.1-flash', '   ': 'ignored' },
      name: 'Alias Key',
    });

    expect(created.access_key.modelAliases).toEqual({
      'flash-a': 'deepseek-v4.1-flash',
    });

    const listed = await listAccessKeys();
    expect(listed.access_keys[0]?.modelAliases).toEqual({
      'flash-a': 'deepseek-v4.1-flash',
    });

    const updated = await updateAccessKey(created.access_key.id, {
      credentialFilenames: [credential.filename],
      modelAliases: { 'flash-b': 'glm-5.1' },
      name: 'Alias Key',
    });
    expect(updated.modelAliases).toEqual({ 'flash-b': 'glm-5.1' });

    const cleared = await updateAccessKey(created.access_key.id, {
      credentialFilenames: [credential.filename],
      name: 'Alias Key',
    });
    expect(cleared.modelAliases).toEqual({});
    expect((await listStoredAccessKeys())[0]?.modelAliases).toBeUndefined();
  });

  it('keeps legacy records without aliases usable', async () => {
    const credential = await addCredential({ bearer_token: 'token-a' }, 'a');
    const now = '2026-09-30T00:00:00.000Z';

    await writeStorageJson('access-keys', 'store', {
      accessKeys: [
        {
          createdAt: now,
          credentialFilenames: [credential.filename],
          id: 'legacy-key',
          name: 'Legacy',
          secret: 'cb2_legacy',
          updatedAt: now,
        },
      ],
    });

    const listed = await listAccessKeys();
    expect(listed.access_keys[0]?.modelAliases).toEqual({});
    expect((await listStoredAccessKeys())[0]?.modelAliases).toBeUndefined();
  });
});

describe('model aliases in the proxy path', () => {
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
  });

  afterEach(() => {
    cleanup();
  });

  it('sends the alias target upstream and uses it for credential filtering', async () => {
    const credential = await addCredential({
      bearer_token: 'alias-token',
      responses_passthrough: true,
      supported_models: 'glm-credential-scoped',
      user_id: 'alias@example.com',
    });
    const accessKey = await createAccessKey({
      credentialFilenames: [credential.filename],
      modelAliases: { 'flash-a': 'glm-credential-scoped' },
      name: 'Alias Key',
    });
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(makeChatCompletionResponse());

    const response = await proxyChatCompletions(
      makeRequest('http://localhost/v1/chat/completions', accessKey.secret),
      { messages: [{ content: 'hi', role: 'user' }], model: 'flash-a' },
    );

    expect(response.status).toBe(200);
    expect(readUpstreamModel(fetchMock)).toBe('glm-credential-scoped');
  });

  it('rejects a model name that is neither aliased nor supported', async () => {
    const credential = await addCredential({
      bearer_token: 'alias-token',
      supported_models: 'glm-credential-scoped',
      user_id: 'alias@example.com',
    });
    const accessKey = await createAccessKey({
      credentialFilenames: [credential.filename],
      modelAliases: { 'flash-a': 'glm-credential-scoped' },
      name: 'Alias Key',
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    const response = await proxyChatCompletions(
      makeRequest('http://localhost/v1/chat/completions', accessKey.secret),
      { messages: [{ content: 'hi', role: 'user' }], model: 'flash-c' },
    );

    expect(response.status).toBe(500);
    expect(await response.text()).toContain('No valid CodeBuddy credentials');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps aliases scoped to the key that declares them', async () => {
    const credential = await addCredential({
      bearer_token: 'alias-token',
      supported_models: 'glm-credential-scoped',
      user_id: 'alias@example.com',
    });
    await createAccessKey({
      credentialFilenames: [credential.filename],
      modelAliases: { 'flash-a': 'glm-credential-scoped' },
      name: 'Alias Key',
    });
    const otherKey = await createAccessKey({
      credentialFilenames: [credential.filename],
      name: 'Plain Key',
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    const response = await proxyChatCompletions(
      makeRequest('http://localhost/v1/chat/completions', otherKey.secret),
      { messages: [{ content: 'hi', role: 'user' }], model: 'flash-a' },
    );

    expect(response.status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('applies aliases on the Responses passthrough path', async () => {
    const credential = await addCredential({
      bearer_token: 'alias-token',
      responses_passthrough: true,
      supported_models: 'glm-credential-scoped',
      user_id: 'alias@example.com',
    });
    const accessKey = await createAccessKey({
      credentialFilenames: [credential.filename],
      modelAliases: { 'flash-a': 'glm-credential-scoped' },
      name: 'Alias Key',
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ output_text: 'ok' }), {
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        status: 200,
      }),
    );

    const response = await handleResponsesRequest(
      makeRequest('http://localhost/v1/responses', accessKey.secret),
      { input: 'hello', model: 'flash-a' },
    );

    expect(response.status).toBe(200);
    expect(readUpstreamModel(fetchMock)).toBe('glm-credential-scoped');
  });

  it('applies aliases on the Responses adapter path', async () => {
    const credential = await addCredential({
      bearer_token: 'alias-token',
      supported_models: 'glm-credential-scoped',
      user_id: 'alias@example.com',
    });
    const accessKey = await createAccessKey({
      credentialFilenames: [credential.filename],
      modelAliases: { 'flash-a': 'glm-credential-scoped' },
      name: 'Alias Key',
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
        {
          headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
          status: 200,
        },
      ),
    );

    const response = await handleResponsesRequest(
      makeRequest('http://localhost/v1/responses', accessKey.secret),
      { input: 'hello', model: 'flash-a' },
    );

    expect(response.status).toBe(200);
    expect(
      ((await response.json()) as { output_text?: string }).output_text,
    ).toBe('ok');
    expect(readUpstreamModel(fetchMock)).toBe('glm-credential-scoped');
  });
});
