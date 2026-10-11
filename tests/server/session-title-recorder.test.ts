import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => {
  const namespaces = new Map<string, Map<string, unknown>>();

  const bucket = (namespace: string): Map<string, unknown> => {
    const existing = namespaces.get(namespace);

    if (existing) return existing;

    const created = new Map<string, unknown>();

    namespaces.set(namespace, created);

    return created;
  };

  return {
    bucket,
    namespaces,
    reset: () => namespaces.clear(),
  };
});

vi.mock('@/lib/server/storage', () => ({
  deleteStorageJson: async (namespace: string, key: string) => {
    storage.bucket(namespace).delete(key);
  },
  getStorageBackendMeta: () => ({ backend: 'pg' }),
  listStorageJson: async (namespace: string) =>
    [...storage.bucket(namespace).entries()].map(([key, value]) => ({
      key,
      value,
    })),
  readStorageJson: async (namespace: string, key: string) =>
    storage.bucket(namespace).get(key) ?? null,
  writeStorageJson: async (namespace: string, key: string, value: unknown) => {
    storage.bucket(namespace).set(key, value);
  },
}));

/** Stubs the model call so no test reaches the network. */
const generator = vi.hoisted(() => ({
  calls: [] as Array<{ conversationId: string; question: string }>,
  result: { source: 'ai', title: 'AI 标题' } as {
    source: string;
    title: string;
  } | null,
}));

vi.mock('@/lib/server/domain/session-title-generator', () => ({
  generateSessionTitle: async (input: {
    conversationId: string;
    question: string;
  }) => {
    generator.calls.push(input);

    return generator.result;
  },
}));

const {
  publishSessionCompleted,
  publishSessionStarted,
  resetSessionStreamRuntime,
} = await import('@/lib/server/domain/session-stream');
const { ensureSessionTitleRecorder, resetSessionTitleRecorderRuntime } =
  await import('@/lib/server/domain/session-title-recorder');
const { getSessionTitle, resetSessionTitleRuntime } =
  await import('@/lib/server/domain/session-titles');

const CONVERSATION = 'ce2e73703f8d46fea58a4b86bffe5977';

/** The recorder subscribes once per process and is stored on globalThis. */
const startRecorder = (): void => {
  resetSessionTitleRecorderRuntime();
  resetSessionStreamRuntime();
  ensureSessionTitleRecorder();
};

const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 10));

beforeEach(() => {
  storage.reset();
  generator.calls = [];
  generator.result = { source: 'ai', title: 'AI 标题' };
  resetSessionTitleRuntime();
  startRecorder();
});

describe('session-title-recorder', () => {
  it('writes a truncated label as soon as the question arrives', async () => {
    publishSessionStarted({
      conversationId: CONVERSATION,
      question: '修复登录白屏',
    });
    await settle();

    const record = await getSessionTitle(CONVERSATION);

    expect(record?.title).toBe('修复登录白屏');
    expect(record?.source).toBe('truncate');
  });

  it('does not call the model on start', async () => {
    publishSessionStarted({
      conversationId: CONVERSATION,
      question: '修复登录白屏',
    });
    await settle();

    // Generation waits for the answer: asking while a turn is streaming would
    // fire a second upstream request during the one the user is waiting on.
    expect(generator.calls).toHaveLength(0);
  });

  it('asks for a summary when the turn completes', async () => {
    publishSessionStarted({
      conversationId: CONVERSATION,
      question: '修复登录白屏',
    });
    publishSessionCompleted({ conversationId: CONVERSATION, toolTurn: false });
    await settle();

    expect(generator.calls).toHaveLength(1);
    expect(generator.calls[0]?.conversationId).toBe(CONVERSATION);
    expect(generator.calls[0]?.question).toBe('修复登录白屏');
  });

  it('also summarises a failed turn, because the question is still real', async () => {
    publishSessionStarted({
      conversationId: CONVERSATION,
      question: '修复登录白屏',
    });
    publishSessionCompleted({
      conversationId: CONVERSATION,
      error: 'upstream exploded',
    });
    await settle();

    expect(generator.calls).toHaveLength(1);
  });

  it('skips generation when the turn carried no question', async () => {
    publishSessionCompleted({ conversationId: CONVERSATION, toolTurn: true });
    await settle();

    expect(generator.calls).toHaveLength(0);
  });

  it('leaves the fallback in place when the model returns nothing usable', async () => {
    generator.result = null;

    publishSessionStarted({
      conversationId: CONVERSATION,
      question: '修复登录白屏',
    });
    publishSessionCompleted({ conversationId: CONVERSATION, toolTurn: false });
    await settle();

    // The important half of "truncate first, refine later": a failed summary
    // must not clear the label that already works.
    const record = await getSessionTitle(CONVERSATION);

    expect(record?.title).toBe('修复登录白屏');
    expect(record?.source).toBe('truncate');
  });

  it('does not stack a second subscriber across repeated registration', async () => {
    ensureSessionTitleRecorder();
    ensureSessionTitleRecorder();

    publishSessionStarted({
      conversationId: CONVERSATION,
      question: '修复登录白屏',
    });
    publishSessionCompleted({ conversationId: CONVERSATION, toolTurn: false });
    await settle();

    expect(generator.calls).toHaveLength(1);
  });
});
