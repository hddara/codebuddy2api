import fs from 'node:fs';
import { gunzipSync } from 'node:zlib';
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
const tempRootDir = path.join(repoRoot, '.tmp-test-developer-role');

const cleanup = (): void => {
  fs.rmSync(tempRootDir, { force: true, recursive: true, maxRetries: 5 });
};

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

const upstreamBodyOf = (init: RequestInit | undefined): unknown => {
  const headers = new Headers(init?.headers);
  const raw = init?.body as unknown as Buffer;
  const text =
    headers.get('content-encoding') === 'gzip'
      ? gunzipSync(raw).toString()
      : String(raw);

  return JSON.parse(text);
};

describe('a developer-role prompt', () => {
  beforeEach(() => {
    cleanup();
    resetCredentialRuntimeState();
    resetStorageRuntime();
    vi.restoreAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    process.env.CODEBUDDY_CREDENTIALS_DIR = path.join(tempRootDir, 'creds');
    process.env.CODEBUDDY_AUTH_MODE = 'auto';
    process.env.CODEBUDDY_DEMOTE_SYSTEM_PROMPT = '1';
    process.env.CODEBUDDY_REWRITE_HARNESS_IDENTITY = '1';
  });

  afterEach(() => {
    cleanup();
    delete process.env.CODEBUDDY_DEMOTE_SYSTEM_PROMPT;
    delete process.env.CODEBUDDY_REWRITE_HARNESS_IDENTITY;
  });

  it('never reaches the upstream as a developer message', async () => {
    // Observed from a real harness call: the whole preamble arrived as
    // `role: 'developer'`, so demotion and the identity rewrite both looked at
    // the `system` slot, found nothing, and forwarded the foreign role with the
    // rival harness name untouched.
    await addCredential(
      { bearer_token: 'token-a', user_id: 'a@example.com' },
      'a',
    );
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(okResponse());

    const response = await proxyChatCompletions(
      new NextRequest('http://localhost/v1/chat/completions', {
        method: 'POST',
      }),
      {
        messages: [
          {
            content: 'You are an AI agent powered by DeepSeek Harness.',
            role: 'developer',
          },
          { content: '1+1=?', role: 'user' },
        ],
        model: 'deepseek-v4.1-flash',
        stream: false,
        tools: [
          {
            function: {
              description: 'Read a file',
              name: 'read',
              parameters: { properties: {}, type: 'object' },
            },
            type: 'function',
          },
        ],
      } as never,
    );

    expect(response.status).toBe(200);

    const sent = upstreamBodyOf(
      fetchMock.mock.calls[0]?.[1] as RequestInit,
    ) as {
      messages: Array<{ content: string; role: string }>;
    };

    expect(sent.messages.map((message) => message.role)).toEqual([
      'system',
      'user',
    ]);
    expect(
      sent.messages[0]?.content.startsWith('You are CodeBuddy Code.'),
    ).toBe(true);
    // The caller's instruction survives, with the marker neutralised, in the
    // turn the channel check does not classify.
    expect(sent.messages[1]?.content).toContain(
      'You are an AI agent powered by DeepSeek.',
    );
    expect(JSON.stringify(sent)).not.toContain('DeepSeek Harness');
    expect(JSON.stringify(sent)).not.toContain('"role":"developer"');
  });
});
