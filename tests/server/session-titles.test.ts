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
    backendKind: 'pg' as 'file' | 'pg',
    bucket,
    namespaces,
    reset: () => {
      namespaces.clear();
      storage.backendKind = 'pg';
    },
  };
});

vi.mock('@/lib/server/storage', () => ({
  deleteStorageJson: async (namespace: string, key: string) => {
    storage.bucket(namespace).delete(key);
  },
  getStorageBackendMeta: () => ({ backend: storage.backendKind }),
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

const {
  buildFallbackTitle,
  buildTitlePrompt,
  cleanTitleForStorage,
  clearSessionTitles,
  ensureFallbackTitle,
  getSessionTitle,
  listSessionTitles,
  needsAiTitle,
  renameSession,
  resetSessionTitleRuntime,
  setSessionTitle,
} = await import('@/lib/server/domain/session-titles');

const CONVERSATION = 'ce2e73703f8d46fea58a4b86bffe5977';

beforeEach(() => {
  storage.reset();
  resetSessionTitleRuntime();
});

describe('buildFallbackTitle', () => {
  it('keeps a short question whole', () => {
    expect(buildFallbackTitle('修复登录白屏')).toBe('修复登录白屏');
  });

  it('truncates a long question with an ellipsis', () => {
    const question = '这是一段特别长的提问内容'.repeat(4);
    const title = buildFallbackTitle(question);

    // 24 characters plus the ellipsis.
    expect([...title].length).toBe(25);
    expect(title.endsWith('…')).toBe(true);
  });

  it('takes only the first line of a multi-line question', () => {
    expect(buildFallbackTitle('会话标题怎么加\n这是第二行细节')).toBe(
      '会话标题怎么加',
    );
  });

  it('collapses runs of whitespace', () => {
    expect(buildFallbackTitle('修复   登录\n\n白屏')).toBe('修复 登录');
  });

  it('returns an empty string when there is nothing to show', () => {
    expect(buildFallbackTitle('   ')).toBe('');
    expect(buildFallbackTitle('')).toBe('');
  });
});

describe('cleanTitleForStorage', () => {
  it('strips a leading label the model added anyway', () => {
    expect(cleanTitleForStorage('标题：登录白屏排查')).toBe('登录白屏排查');
    expect(cleanTitleForStorage('Title: fix login')).toBe('fix login');
  });

  it('strips a matching pair of quotes', () => {
    expect(cleanTitleForStorage('"登录白屏排查"')).toBe('登录白屏排查');
    expect(cleanTitleForStorage('“登录白屏排查”')).toBe('登录白屏排查');
    expect(cleanTitleForStorage('「登录白屏排查」')).toBe('登录白屏排查');
  });

  it('strips a trailing period', () => {
    expect(cleanTitleForStorage('登录白屏排查。')).toBe('登录白屏排查');
    expect(cleanTitleForStorage('fix login.')).toBe('fix login');
  });

  it('caps the length', () => {
    expect([...cleanTitleForStorage('标'.repeat(80))].length).toBe(40);
  });

  it('does not empty out a title that is only punctuation inside quotes', () => {
    expect(cleanTitleForStorage('""')).toBe('""');
  });
});

describe('buildTitlePrompt', () => {
  it('asks for a short title and forbids decoration', () => {
    const prompt = buildTitlePrompt('会话标题怎么加');

    expect(prompt).toContain('不超过 12 个字');
    expect(prompt).toContain('不要引号');
    expect(prompt).toContain('会话标题怎么加');
  });

  it('caps the input so a pasted document cannot balloon the prompt', () => {
    const prompt = buildTitlePrompt('长'.repeat(2000));

    // The instruction block plus at most 500 characters of question.
    expect(prompt.length).toBeLessThan(700);
    expect(prompt).toContain('长'.repeat(500));
  });
});

describe('needsAiTitle', () => {
  it('is true when there is no title at all', () => {
    expect(needsAiTitle(null)).toBe(true);
    expect(needsAiTitle(undefined)).toBe(true);
  });

  it('is true for the truncated fallback, which is meant to be replaced', () => {
    expect(
      needsAiTitle({
        conversationId: CONVERSATION,
        createdAt: 'x',
        source: 'truncate',
        title: '会话标题',
        updatedAt: 'x',
      }),
    ).toBe(true);
  });

  it('is false once the model or the user has named it', () => {
    for (const source of ['ai', 'manual'] as const) {
      expect(
        needsAiTitle({
          conversationId: CONVERSATION,
          createdAt: 'x',
          source,
          title: '已命名',
          updatedAt: 'x',
        }),
      ).toBe(false);
    }
  });
});

describe('ensureFallbackTitle', () => {
  it('records the truncated question', async () => {
    const record = await ensureFallbackTitle({
      conversationId: CONVERSATION,
      question: '修复登录白屏',
    });

    expect(record?.title).toBe('修复登录白屏');
    expect(record?.source).toBe('truncate');
    expect((await getSessionTitle(CONVERSATION))?.source).toBe('truncate');
  });

  it('does not downgrade an AI title', async () => {
    await setSessionTitle({
      conversationId: CONVERSATION,
      source: 'ai',
      title: 'AI 起的名字',
    });

    const record = await ensureFallbackTitle({
      conversationId: CONVERSATION,
      question: '另一个提问',
    });

    expect(record?.title).toBe('AI 起的名字');
    expect(record?.source).toBe('ai');
  });

  it('does not downgrade a manual title', async () => {
    await renameSession({ conversationId: CONVERSATION, title: '我起的名字' });

    const record = await ensureFallbackTitle({
      conversationId: CONVERSATION,
      question: '另一个提问',
    });

    expect(record?.title).toBe('我起的名字');
    expect(record?.source).toBe('manual');
  });

  it('writes nothing when the question is blank', async () => {
    expect(
      await ensureFallbackTitle({
        conversationId: CONVERSATION,
        question: '  ',
      }),
    ).toBeNull();
    expect(await getSessionTitle(CONVERSATION)).toBeNull();
  });
});

describe('setSessionTitle', () => {
  it('stores an AI title over a truncated fallback', async () => {
    await ensureFallbackTitle({
      conversationId: CONVERSATION,
      question: '修复登录白屏',
    });

    const record = await setSessionTitle({
      conversationId: CONVERSATION,
      source: 'ai',
      title: '登录白屏排查',
    });

    expect(record?.title).toBe('登录白屏排查');
    expect(record?.source).toBe('ai');
  });

  it('refuses to let the model overwrite a manual rename', async () => {
    await renameSession({ conversationId: CONVERSATION, title: '我起的名字' });

    const record = await setSessionTitle({
      conversationId: CONVERSATION,
      source: 'ai',
      title: '模型想改成这个',
    });

    // Returns what is actually in force, not what was passed in.
    expect(record?.title).toBe('我起的名字');
    expect(record?.source).toBe('manual');
    expect((await getSessionTitle(CONVERSATION))?.title).toBe('我起的名字');
  });

  it('keeps the original createdAt when a title is replaced', async () => {
    const first = await ensureFallbackTitle({
      conversationId: CONVERSATION,
      question: '第一轮提问',
    });
    const second = await setSessionTitle({
      conversationId: CONVERSATION,
      source: 'ai',
      title: 'AI 标题',
    });

    expect(second?.createdAt).toBe(first?.createdAt);
    // Not `!== createdAt`: both writes can land inside one millisecond, and the
    // assertion that matters is that `updatedAt` never moves backwards.
    expect(Date.parse(second?.updatedAt ?? '')).toBeGreaterThanOrEqual(
      Date.parse(second?.createdAt ?? ''),
    );
  });

  it('does not rewrite a record that is already identical', async () => {
    const first = await setSessionTitle({
      conversationId: CONVERSATION,
      source: 'ai',
      title: '同一个名字',
    });
    const second = await setSessionTitle({
      conversationId: CONVERSATION,
      source: 'ai',
      title: '同一个名字',
    });

    expect(second).toEqual(first);
  });

  it('ignores an empty title', async () => {
    expect(
      await setSessionTitle({
        conversationId: CONVERSATION,
        source: 'ai',
        title: '   ',
      }),
    ).toBeNull();
    expect(await getSessionTitle(CONVERSATION)).toBeNull();
  });
});

describe('renameSession', () => {
  it('marks the record manual so nothing overwrites it', async () => {
    const record = await renameSession({
      conversationId: CONVERSATION,
      title: '手动改名',
    });

    expect(record?.source).toBe('manual');
  });

  it('normalises quotes and trailing punctuation like any other title', async () => {
    const record = await renameSession({
      conversationId: CONVERSATION,
      title: '“手动改名”。',
    });

    expect(record?.title).toBe('手动改名');
  });
});

describe('listSessionTitles', () => {
  it('returns every stored title keyed by conversation', async () => {
    await renameSession({ conversationId: 'aaa', title: '第一个' });
    await renameSession({ conversationId: 'bbb', title: '第二个' });

    const titles = await listSessionTitles();

    expect(titles.aaa?.title).toBe('第一个');
    expect(titles.bbb?.title).toBe('第二个');
  });
});

describe('clearSessionTitles', () => {
  it('removes every title and reports how many were dropped', async () => {
    await renameSession({ conversationId: 'aaa', title: '第一个' });
    await renameSession({ conversationId: 'bbb', title: '第二个' });

    expect(await clearSessionTitles()).toBe(2);
    expect(await listSessionTitles()).toEqual({});
  });
});

describe('attachSessionTitles (via getSessionSummaries)', () => {
  it('adds the stored title and its source to the matching session', async () => {
    await renameSession({ conversationId: CONVERSATION, title: '手动命名' });

    const { getSessionSummaries } =
      await import('@/lib/server/domain/sessions');
    const usage = await import('@/lib/server/domain/usage');

    const spy = vi.spyOn(usage, 'listUsageEventsSince').mockResolvedValue([
      {
        accessKeyId: 'key-1',
        accessKeyName: 'k',
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        callCount: 1,
        completionChars: 1,
        conversationId: CONVERSATION,
        credentialFilename: 'c.json',
        inputTokens: 1,
        model: 'm',
        outputTokens: 1,
        promptChars: 1,
        route: '/v1/chat/completions',
        timestamp: new Date().toISOString(),
        totalTokens: 2,
      },
    ]);

    try {
      const payload = await getSessionSummaries({ windowMinutes: 60 });
      const session = payload.sessions.find(
        (row) => row.conversationId === CONVERSATION,
      );

      expect(session?.title).toBe('手动命名');
      expect(session?.titleSource).toBe('manual');
    } finally {
      spy.mockRestore();
    }
  });

  it('leaves a conversation without a title untouched', async () => {
    const { getSessionSummaries } =
      await import('@/lib/server/domain/sessions');
    const usage = await import('@/lib/server/domain/usage');

    const spy = vi.spyOn(usage, 'listUsageEventsSince').mockResolvedValue([
      {
        accessKeyId: 'key-1',
        accessKeyName: 'k',
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        callCount: 1,
        completionChars: 1,
        conversationId: 'untitled-conversation',
        credentialFilename: 'c.json',
        inputTokens: 1,
        model: 'm',
        outputTokens: 1,
        promptChars: 1,
        route: '/v1/chat/completions',
        timestamp: new Date().toISOString(),
        totalTokens: 2,
      },
    ]);

    try {
      const payload = await getSessionSummaries({ windowMinutes: 60 });
      const session = payload.sessions[0];

      // Absent rather than empty: the client decides how to label it.
      expect(session?.title).toBeUndefined();
      expect(session?.titleSource).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('file backend', () => {
  beforeEach(() => {
    storage.backendKind = 'file';
  });

  it('degrades to storing nothing rather than throwing', async () => {
    expect(
      await ensureFallbackTitle({
        conversationId: CONVERSATION,
        question: '修复登录白屏',
      }),
    ).toBeNull();
    expect(
      await setSessionTitle({
        conversationId: CONVERSATION,
        source: 'ai',
        title: '标题',
      }),
    ).toBeNull();
    expect(
      await renameSession({ conversationId: CONVERSATION, title: 'x' }),
    ).toBeNull();
    expect(await getSessionTitle(CONVERSATION)).toBeNull();
    expect(await listSessionTitles()).toEqual({});
    expect(await clearSessionTitles()).toBe(0);
  });
});
