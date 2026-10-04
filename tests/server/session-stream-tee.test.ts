import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NextRequest } from 'next/server';

import {
  resetSessionStreamRuntime,
  subscribeToSessionEvents,
  type SessionEvent,
} from '@/lib/server/domain/session-stream';

vi.mock('@/lib/server/domain/credentials', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/server/domain/credentials')
  >('@/lib/server/domain/credentials');

  return actual;
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Verifies the observability tee end to end inside the proxy: a streaming
 * completion must publish live deltas on `x-conversation-id` while the client
 * still receives the untouched SSE bytes.
 */
describe('session stream tee', () => {
  beforeEach(() => {
    resetSessionStreamRuntime();
  });

  it('publishes deltas for a streamed completion without altering the response', async () => {
    const { proxyChatCompletions } =
      await import('@/lib/server/proxy/codebuddy');
    const { addCredential, resetCredentialRuntimeState } =
      await import('@/lib/server/domain/credentials');

    resetCredentialRuntimeState();
    await addCredential({ bearer_token: 'token-a' }, 'a');

    const events: SessionEvent[] = [];

    subscribeToSessionEvents({
      conversationIds: new Set(['conv-tee']),
      send: (event) => {
        events.push(event);

        return true;
      },
    });

    // Upstream answers one OpenAI-style chat chunk with text, then finishes.
    const sse = [
      'data: {"choices":[{"index":0,"delta":{"content":"你"},"finish_reason":null}]}',
      '',
      'data: {"choices":[{"index":0,"delta":{"content":"好"},"finish_reason":null}]}',
      '',
      'data: [DONE]',
      '',
      '',
    ].join('\n');

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(sse, {
        headers: { 'Content-Type': 'text/event-stream' },
        status: 200,
      }),
    );

    const response = await proxyChatCompletions(
      new NextRequest('http://localhost/v1/chat/completions', {
        body: JSON.stringify({
          messages: [{ content: 'hi', role: 'user' }],
          model: 'deepseek-v4.1-flash',
          stream: true,
        }),
        headers: {
          'Content-Type': 'application/json',
          'x-conversation-id': 'conv-tee',
        },
        method: 'POST',
      }),
      {
        messages: [{ content: 'hi', role: 'user' }],
        model: 'deepseek-v4-flash',
        stream: true,
      },
    );

    const body = await response.text();

    await flush();

    // The client bytes are the upstream frames, untouched by the tee.
    expect(response.status).toBe(200);
    expect(body).toContain('"content":"你"');
    expect(body).toContain('"content":"好"');

    const types = events.map((event) => event.type);

    expect(types).toContain('session.started');
    expect(types).toContain('session.completed');
    expect(
      events.filter((event) => event.type === 'session.delta'),
    ).toHaveLength(2);
    // The conversation id comes from the request header, and the accumulated
    // text lets a late subscriber render the full reply.
    expect(events[0]?.conversationId).toBe('conv-tee');
    expect(events.at(-1)?.text).toBe('你好');
  });
});
