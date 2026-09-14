import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  available: { value: true },
  latest: { value: null as { sessionId: string } | null },
  chainRef: { value: null as string | null },
  findLatest: vi.fn(),
  resolveChain: vi.fn(),
}));

vi.mock('@/lib/server/storage', () => ({
  findStorageSessionByExternalRef: mocks.findLatest,
  getSessionStorageAvailability: () => ({
    available: mocks.available.value,
    backend: mocks.available.value ? 'sqlite' : 'file',
    reason: mocks.available.value ? null : 'file backend',
  }),
}));

vi.mock('@/lib/server/proxy/responses', () => ({
  resolveResponsesConversationRef: mocks.resolveChain,
}));

import {
  SESSION_RESOLUTION_WINDOW_MS,
  extractFirstUserText,
  resolveSessionIdentity,
} from '@/lib/server/domain/session-identity';

const NOW_MS = Date.parse('2026-09-14T08:00:00.000Z');

const buildHeaders = (
  values: Record<string, string> = {},
): { get(name: string): string | null } => ({
  get: (name) => values[name.toLowerCase()] ?? null,
});

const resolve = (
  overrides: {
    accessKeyId?: string | null;
    body?: Record<string, unknown> | null;
    headers?: Record<string, string>;
    route?: string;
  } = {},
) => {
  return resolveSessionIdentity({
    accessKeyId:
      overrides.accessKeyId === undefined ? 'key-1' : overrides.accessKeyId,
    body: overrides.body ?? {
      messages: [{ role: 'user', content: 'Hello there' }],
      model: 'gpt-5.5',
    },
    headers: buildHeaders(overrides.headers),
    nowMs: NOW_MS,
    route: overrides.route ?? '/v1/chat/completions',
  });
};

describe('session identity resolution', () => {
  beforeEach(() => {
    mocks.available.value = true;
    mocks.latest.value = null;
    mocks.chainRef.value = null;
    mocks.findLatest.mockReset();
    mocks.findLatest.mockImplementation(async () => mocks.latest.value);
    mocks.resolveChain.mockReset();
    mocks.resolveChain.mockImplementation(async () => mocks.chainRef.value);
  });

  it('returns no identity when the backend cannot store sessions', async () => {
    mocks.available.value = false;

    await expect(resolve()).resolves.toBeNull();
    expect(mocks.findLatest).not.toHaveBeenCalled();
  });

  describe('priority 1: explicit headers', () => {
    it('uses x-conversation-id and keeps the session stable', async () => {
      const first = await resolve({
        headers: { 'x-conversation-id': 'conv-42' },
      });
      const second = await resolve({
        body: { messages: [{ role: 'user', content: 'Later turn' }] },
        headers: { 'x-conversation-id': 'conv-42' },
      });

      expect(first).toMatchObject({
        externalRef: 'conv-42',
        model: 'gpt-5.5',
        strategy: 'header',
        title: 'Hello there',
      });
      expect(first?.sessionId).toMatch(/^h_/);
      expect(second?.sessionId).toBe(first?.sessionId);
      // An explicit header already answers the question, so no window lookup.
      expect(mocks.findLatest).not.toHaveBeenCalled();
    });

    it('accepts x-session-id as an alias', async () => {
      const identity = await resolve({ headers: { 'x-session-id': 'sess-7' } });

      expect(identity).toMatchObject({
        externalRef: 'sess-7',
        strategy: 'header',
      });
    });

    it('ignores a header value that cannot be a storage key', async () => {
      const identity = await resolve({
        headers: { 'x-conversation-id': 'not/valid id!' },
      });

      expect(identity?.strategy).toBe('fallback');
    });
  });

  describe('priority 2: responses chain', () => {
    it('reuses the chain binding from the responses proxy', async () => {
      mocks.chainRef.value = 'root-response';

      const identity = await resolve({
        body: {
          input: 'Hello there',
          model: 'gpt-5.5',
          previous_response_id: 'resp_2',
        },
        route: '/v1/responses',
      });

      expect(mocks.resolveChain).toHaveBeenCalledWith('resp_2', 'key-1');
      expect(identity).toMatchObject({
        externalRef: 'responses:root-response',
        strategy: 'responses-chain',
        title: 'Hello there',
      });
      expect(identity?.sessionId).toMatch(/^r_/);
      expect(mocks.findLatest).not.toHaveBeenCalled();
    });

    it('falls through when the previous response id is unknown', async () => {
      const identity = await resolve({
        body: {
          input: 'Hello there',
          previous_response_id: 'resp_missing',
        },
        route: '/v1/responses',
      });

      expect(mocks.resolveChain).toHaveBeenCalled();
      expect(identity?.strategy).toBe('fallback');
    });
  });

  describe('priority 3: anthropic metadata', () => {
    it('fingerprints the user id together with the system prompt', async () => {
      const identity = await resolve({
        body: {
          messages: [{ role: 'user', content: 'Hello there' }],
          metadata: { user_id: 'user-9' },
          model: 'claude-sonnet-4',
          system: 'You are terse.',
        },
        route: '/v1/messages',
      });

      expect(identity?.strategy).toBe('anthropic-metadata');
      expect(identity?.externalRef).toMatch(/^anthropic:[0-9a-f]{32}$/);
      expect(mocks.findLatest).toHaveBeenCalledWith(
        'key-1',
        identity?.externalRef,
        NOW_MS - SESSION_RESOLUTION_WINDOW_MS,
      );
    });

    it('separates two agents that share one user id', async () => {
      const base = {
        messages: [{ role: 'user', content: 'Hello there' }],
        metadata: { user_id: 'user-9' },
      };

      const terse = await resolve({
        body: { ...base, system: 'You are terse.' },
        route: '/v1/messages',
      });
      const chatty = await resolve({
        body: { ...base, system: 'You are chatty.' },
        route: '/v1/messages',
      });

      expect(terse?.externalRef).not.toBe(chatty?.externalRef);
    });

    it('does not apply to non-anthropic routes', async () => {
      const identity = await resolve({
        body: {
          messages: [{ role: 'user', content: 'Hello there' }],
          metadata: { user_id: 'user-9' },
        },
      });

      expect(identity?.strategy).toBe('fallback');
    });
  });

  describe('priority 4: fallback window', () => {
    it('groups turns that share an access key and first message', async () => {
      const first = await resolve();
      const second = await resolve({
        body: {
          messages: [
            { role: 'user', content: 'Hello there' },
            { role: 'assistant', content: 'Hi' },
            { role: 'user', content: 'More' },
          ],
        },
      });

      expect(first?.strategy).toBe('fallback');
      expect(second?.externalRef).toBe(first?.externalRef);
    });

    it('separates conversations started by a different first message', async () => {
      const first = await resolve();
      const second = await resolve({
        body: { messages: [{ role: 'user', content: 'Something else' }] },
      });

      expect(second?.externalRef).not.toBe(first?.externalRef);
    });

    it('separates conversations of different access keys', async () => {
      const first = await resolve();
      const second = await resolve({ accessKeyId: 'key-2' });

      expect(second?.externalRef).not.toBe(first?.externalRef);
    });

    it('continues the newest session still inside the window', async () => {
      mocks.latest.value = { sessionId: 'f_existing' };

      const identity = await resolve();

      expect(identity?.sessionId).toBe('f_existing');
    });

    it('starts a new session once the previous one went stale', async () => {
      const identity = await resolve();

      expect(mocks.findLatest).toHaveBeenCalledWith(
        'key-1',
        identity?.externalRef,
        NOW_MS - SESSION_RESOLUTION_WINDOW_MS,
      );
      expect(identity?.sessionId).toMatch(/^f_[0-9a-f]{32}$/);
    });

    it('still resolves an identity when the request carries no user text', async () => {
      const identity = await resolve({
        body: { messages: [{ role: 'system', content: 'Only a system turn' }] },
      });

      expect(identity).not.toBeNull();
      expect(identity?.title).toBeNull();
    });
  });

  describe('title', () => {
    it('collapses whitespace and truncates the first user message', async () => {
      const identity = await resolve({
        body: {
          messages: [
            { role: 'user', content: `  a\n\n  b ${'x'.repeat(200)}` },
          ],
        },
      });

      expect(identity?.title?.startsWith('a b xxx')).toBe(true);
      expect(identity?.title?.length).toBe(80);
    });
  });
});

describe('tolerant input handling', () => {
  const identityFor = (body: Record<string, unknown> | null) =>
    resolveSessionIdentity({
      accessKeyId: 'key-1',
      body,
      headers: buildHeaders(),
      nowMs: NOW_MS,
      route: '/v1/chat/completions',
    });

  it('joins plain string parts inside a content array', () => {
    expect(
      extractFirstUserText({
        messages: [{ role: 'user', content: ['first', 'second'] }],
      }),
    ).toBe('first\nsecond');
  });

  it('skips blocks that carry no text inside a content array', () => {
    expect(
      extractFirstUserText({
        messages: [{ role: 'user', content: [] }],
      }),
    ).toBeNull();
    expect(
      extractFirstUserText({
        messages: [{ role: 'user', content: [7, { text: 'kept' }] }],
      }),
    ).toBe('kept');
    expect(
      extractFirstUserText({ messages: [{ role: 'user', content: {} }] }),
    ).toBeNull();
  });

  it('skips input items that belong to another role', () => {
    expect(
      extractFirstUserText({
        input: [
          { content: 'assistant words', role: 'assistant' },
          { content: [{ text: 'user words', type: 'input_text' }] },
        ],
      }),
    ).toBe('user words');
  });

  it('accepts a system prompt given as blocks', async () => {
    const identity = await resolveSessionIdentity({
      accessKeyId: 'key-1',
      body: {
        messages: [{ role: 'user', content: 'Hello there' }],
        metadata: { user_id: 'user-9' },
        system: [{ text: 'You are terse.', type: 'text' }],
      },
      headers: buildHeaders(),
      nowMs: NOW_MS,
      route: '/v1/messages',
    });

    expect(identity?.strategy).toBe('anthropic-metadata');
  });

  it('falls back when metadata carries no usable user id', async () => {
    const bodies: Record<string, unknown>[] = [
      { messages: [{ role: 'user', content: 'x' }], metadata: 'nope' },
      { messages: [{ role: 'user', content: 'x' }], metadata: { user_id: 12 } },
      {
        messages: [{ role: 'user', content: 'x' }],
        metadata: { user_id: '   ' },
      },
    ];

    for (const body of bodies) {
      const identity = await resolve({ body, route: '/v1/messages' });

      expect(identity?.strategy).toBe('fallback');
    }
  });

  it('ignores non-string previous_response_id and model values', async () => {
    const identity = await resolve({
      body: {
        messages: [{ role: 'user', content: 'Hello there' }],
        model: 42,
        previous_response_id: 7,
      },
      route: '/v1/responses',
    });

    expect(mocks.resolveChain).not.toHaveBeenCalled();
    expect(identity).toMatchObject({ model: null, strategy: 'fallback' });
  });

  it('resolves an empty body through the fallback', async () => {
    const identity = await identityFor(null);

    expect(identity?.strategy).toBe('fallback');
    expect(identity?.model).toBeNull();
    expect(identity?.title).toBeNull();
  });
});

describe('extractFirstUserText', () => {
  it('reads string content', () => {
    expect(
      extractFirstUserText({ messages: [{ role: 'user', content: 'plain' }] }),
    ).toBe('plain');
  });

  it('reads text blocks and skips non-text blocks', () => {
    expect(
      extractFirstUserText({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'from block' },
              { type: 'image', source: {} },
            ],
          },
        ],
      }),
    ).toBe('from block');
  });

  it('reads a bare responses input string', () => {
    expect(extractFirstUserText({ input: 'bare input' })).toBe('bare input');
  });

  it('reads a responses input item list', () => {
    expect(
      extractFirstUserText({
        input: [
          { type: 'additional_tools', tools: [] },
          {
            content: [{ text: 'item text', type: 'input_text' }],
            role: 'user',
          },
        ],
      }),
    ).toBe('item text');
  });

  it('returns null when nothing carries text', () => {
    expect(extractFirstUserText(null)).toBeNull();
    expect(extractFirstUserText({ messages: [] })).toBeNull();
  });
});
