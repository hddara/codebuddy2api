import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { UsageEventRecord } from '@/lib/server/domain/usage';

vi.mock('@/lib/server/admin/session', () => ({
  getAdminSessionErrorResponse: vi.fn(),
}));
vi.mock('@/lib/server/domain/sessions', () => ({
  getSessionSummaries: vi.fn(),
  normalizeSessionWindowMinutes: vi.fn(),
}));
vi.mock('../lib/server/storage', () => ({
  getStorageBackendMeta: vi.fn(() => ({
    backend: 'pg',
    schema: 'codebuddy2api',
  })),
}));

const { getAdminSessionErrorResponse } =
  await import('@/lib/server/admin/session');
const { getSessionSummaries, normalizeSessionWindowMinutes } =
  await import('@/lib/server/domain/sessions');
const { GET } = await import('@/app/admin-api/sessions/route');
const { summarizeSessions, normalizeSessionWindowMinutes: normalizeWindow } =
  await vi.importActual<typeof import('@/lib/server/domain/sessions')>(
    '@/lib/server/domain/sessions',
  );

const makeEvent = (
  overrides: Partial<UsageEventRecord> = {},
): UsageEventRecord => ({
  accessKeyId: 'key-1',
  accessKeyName: 'HDdaraSuper',
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  callCount: 1,
  completionChars: 10,
  conversationId: 'conv-a',
  credentialFilename: 'cred-a.json',
  inputTokens: 10,
  model: 'deepseek-v4.1-flash',
  outputTokens: 5,
  promptChars: 20,
  route: '/v1/chat/completions',
  timestamp: new Date().toISOString(),
  totalTokens: 15,
  ...overrides,
});

describe('session summaries', () => {
  it('groups events by conversation id and sums their usage', () => {
    // `conv-a` is pinned as the most recent so the ordering assertion is not a
    // race between two `new Date()` calls inside `makeEvent`.
    const summary = summarizeSessions(
      [
        makeEvent({ conversationId: 'conv-a', totalTokens: 15 }),
        makeEvent({
          conversationId: 'conv-a',
          credentialFilename: 'cred-b.json',
          model: 'glm-5.3-flash',
          promptChars: 5,
          totalTokens: 25,
        }),
        makeEvent({
          conversationId: 'conv-b',
          timestamp: new Date(Date.now() - 60_000).toISOString(),
          totalTokens: 7,
        }),
      ],
      { windowMinutes: 60 },
    );

    expect(summary.sessions).toHaveLength(2);
    expect(summary.totals).toEqual({
      calls: 3,
      sessions: 2,
      totalTokens: 47,
    });

    const first = summary.sessions[0];

    expect(first?.conversationId).toBe('conv-a');
    expect(first?.callCount).toBe(2);
    expect(first?.totalTokens).toBe(40);
    expect(first?.credentialFilenames).toEqual(['cred-a.json', 'cred-b.json']);
    expect(first?.models).toEqual(['deepseek-v4.1-flash', 'glm-5.3-flash']);
  });

  it('reports events without a conversation id as ungrouped', () => {
    const summary = summarizeSessions(
      [
        makeEvent({ conversationId: null }),
        makeEvent({ conversationId: 'conv-a' }),
      ],
      { windowMinutes: 60 },
    );

    expect(summary.ungroupedEvents).toBe(1);
    expect(summary.sessions).toHaveLength(1);
  });

  it('drops events older than the requested window', () => {
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const summary = summarizeSessions(
      [
        makeEvent({ conversationId: 'conv-old', timestamp: old }),
        makeEvent({ conversationId: 'conv-new' }),
      ],
      { windowMinutes: 60 },
    );

    expect(summary.sessions.map((item) => item.conversationId)).toEqual([
      'conv-new',
    ]);
  });

  it('sorts sessions by most recent activity', () => {
    const older = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const summary = summarizeSessions(
      [
        makeEvent({ conversationId: 'conv-old', timestamp: older }),
        makeEvent({ conversationId: 'conv-new' }),
      ],
      { windowMinutes: 60 },
    );

    expect(summary.sessions.map((item) => item.conversationId)).toEqual([
      'conv-new',
      'conv-old',
    ]);
  });

  it('normalizes the requested window', () => {
    expect(normalizeWindow('30')).toBe(30);
    expect(normalizeWindow('')).toBe(24 * 60);
    expect(normalizeWindow('abc')).toBe(24 * 60);
    expect(normalizeWindow(-5)).toBe(24 * 60);
    expect(normalizeWindow(999_999_999)).toBe(30 * 24 * 60);
  });
});

describe('sessions admin route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAdminSessionErrorResponse).mockResolvedValue(null);
    vi.mocked(getSessionSummaries).mockResolvedValue({
      sessions: [],
      totals: { calls: 0, sessions: 0, totalTokens: 0 },
      ungroupedEvents: 0,
      windowMinutes: 60,
    });
    vi.mocked(normalizeSessionWindowMinutes).mockReturnValue(60);
  });

  it('returns the session list for an authenticated admin', async () => {
    const response = await GET(
      new Request('http://localhost/admin-api/sessions?windowMinutes=60'),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ windowMinutes: 60 });
    expect(getSessionSummaries).toHaveBeenCalledWith({ windowMinutes: 60 });
  });

  it('defaults the window when the query parameter is absent', async () => {
    await GET(new Request('http://localhost/admin-api/sessions'));

    expect(normalizeSessionWindowMinutes).toHaveBeenCalledWith(undefined);
  });

  it('short-circuits with the auth error response', async () => {
    const unauthorized = new Response('nope', { status: 401 });

    vi.mocked(getAdminSessionErrorResponse).mockResolvedValue(unauthorized);

    const response = await GET(
      new Request('http://localhost/admin-api/sessions'),
    );

    expect(response.status).toBe(401);
    expect(getSessionSummaries).not.toHaveBeenCalled();
  });
});
