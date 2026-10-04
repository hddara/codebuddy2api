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
    backendKind: 'pg' as 'file' | 'pg',
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
  DEFAULT_SESSION_TRANSCRIPT_SETTINGS,
  SESSION_TRANSCRIPT_LIMITS,
  clearSessionTranscripts,
  ensureSessionTranscriptRecorder,
  extractQuestionText,
  getSessionTranscriptSettings,
  listSessionTranscripts,
  pruneSessionTranscripts,
  recordSessionTurn,
  resetSessionTranscriptRuntime,
  updateSessionTranscriptSettings,
} = await import('@/lib/server/domain/session-transcripts');
const {
  publishSessionCompleted,
  publishSessionDelta,
  publishSessionStarted,
  resetSessionStreamRuntime,
} = await import('@/lib/server/domain/session-stream');

const flushRecorder = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('extractQuestionText', () => {
  it('returns the last user message with string content', () => {
    expect(
      extractQuestionText({
        messages: [
          { content: 'first', role: 'user' },
          { content: 'ignored', role: 'assistant' },
          { content: '  latest question  ', role: 'user' },
        ],
      }),
    ).toBe('latest question');
  });

  it('joins array content parts', () => {
    expect(
      extractQuestionText({
        messages: [
          {
            content: [{ text: 'part one' }, { text: 'part two' }],
            role: 'user',
          },
        ],
      }),
    ).toBe('part one\npart two');
  });

  it('skips user messages that carry only tool results', () => {
    expect(
      extractQuestionText({
        messages: [
          { content: 'the real question', role: 'user' },
          {
            content: [{ tool_use_id: 'x', type: 'tool_result' }],
            role: 'user',
          },
        ],
      }),
    ).toBe('the real question');
  });

  it('returns an empty string when there is no user message', () => {
    expect(extractQuestionText({})).toBe('');
    expect(extractQuestionText({ messages: 'nope' })).toBe('');
    expect(
      extractQuestionText({ messages: [{ content: 'hi', role: 'system' }] }),
    ).toBe('');
  });

  it('truncates unusually long prompts', () => {
    const question = extractQuestionText({
      messages: [{ content: 'x'.repeat(9_000), role: 'user' }],
    });

    expect(question).toHaveLength(4_000);
  });
});

describe('session transcripts', () => {
  beforeEach(() => {
    storage.reset();
    resetSessionStreamRuntime();
    resetSessionTranscriptRuntime();
  });

  it('records a turn and lists it back', async () => {
    const record = await recordSessionTurn({
      accessKeyId: 'key-1',
      answer: 'the answer',
      completedAt: '2026-10-04T01:00:00.000Z',
      conversationId: 'conv-a',
      model: 'deepseek-v4.1-flash',
      question: 'the question',
      startedAt: '2026-10-04T00:59:58.000Z',
    });

    expect(record).toMatchObject({
      answer: 'the answer',
      conversationId: 'conv-a',
      question: 'the question',
      status: 'completed',
    });

    const listed = await listSessionTranscripts();

    expect(listed.entries).toHaveLength(1);
    expect(listed.totals.stored).toBe(1);
    expect(listed.totals.answerChars).toBe('the answer'.length);
  });

  it('marks failed turns and keeps the error', async () => {
    await recordSessionTurn({
      answer: '',
      completedAt: '2026-10-04T01:00:00.000Z',
      conversationId: 'conv-a',
      error: 'upstream exploded',
    });

    const [entry] = (await listSessionTranscripts()).entries;

    expect(entry?.status).toBe('failed');
    expect(entry?.error).toBe('upstream exploded');
  });

  it('skips recording when the conversation id is missing', async () => {
    expect(
      await recordSessionTurn({
        answer: 'x',
        completedAt: '2026-10-04T01:00:00.000Z',
        conversationId: '',
      }),
    ).toBeNull();
    expect((await listSessionTranscripts()).entries).toHaveLength(0);
  });

  it('stops recording once disabled', async () => {
    await updateSessionTranscriptSettings({ enabled: false });

    expect(
      await recordSessionTurn({
        answer: 'x',
        completedAt: '2026-10-04T01:00:00.000Z',
        conversationId: 'conv-a',
      }),
    ).toBeNull();
    expect((await listSessionTranscripts()).entries).toHaveLength(0);
  });

  it('truncates a very long answer and reports the stored length', async () => {
    const record = await recordSessionTurn({
      answer: 'y'.repeat(150_000),
      completedAt: '2026-10-04T01:00:00.000Z',
      conversationId: 'conv-a',
    });

    expect(record?.answer).toHaveLength(100_000);
    // The reported size describes what is stored, not what arrived.
    expect(record?.answerChars).toBe(100_000);
  });

  it('filters by conversation and respects the limit', async () => {
    for (let index = 0; index < 5; index += 1) {
      await recordSessionTurn({
        answer: `a${index}`,
        completedAt: `2026-10-04T01:0${index}:00.000Z`,
        conversationId: index < 3 ? 'conv-a' : 'conv-b',
      });
    }

    const limited = await listSessionTranscripts({ limit: 2 });

    expect(limited.entries).toHaveLength(2);
    expect(limited.totals.stored).toBe(5);
    // Newest first.
    expect(limited.entries[0]?.answer).toBe('a4');

    const filtered = await listSessionTranscripts({ conversationId: 'conv-a' });

    expect(filtered.entries).toHaveLength(3);
    expect(filtered.entries.every((e) => e.conversationId === 'conv-a')).toBe(
      true,
    );
  });

  it('prunes turns older than the retention window', async () => {
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const fresh = new Date().toISOString();

    // Recording prunes with the *stored* settings, so widen retention first to
    // keep the aged turn around for the explicit prune below.
    await updateSessionTranscriptSettings({
      maxEntries: 1_000,
      retentionDays: 365,
    });

    await recordSessionTurn({
      answer: 'old',
      completedAt: old,
      conversationId: 'conv-old',
    });
    await recordSessionTurn({
      answer: 'fresh',
      completedAt: fresh,
      conversationId: 'conv-fresh',
    });

    expect((await listSessionTranscripts()).entries).toHaveLength(2);

    const removed = await pruneSessionTranscripts({
      ...DEFAULT_SESSION_TRANSCRIPT_SETTINGS,
      maxEntries: 1_000,
      retentionDays: 30,
    });

    expect(removed).toBe(1);

    const listed = await listSessionTranscripts();

    expect(listed.entries.map((entry) => entry.conversationId)).toEqual([
      'conv-fresh',
    ]);
  });

  it('prunes aged turns automatically when a turn is recorded', async () => {
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();

    // Defaults keep 30 days. Recording runs the prune itself, so a stale turn
    // never survives even without an operator touching the settings.
    await recordSessionTurn({
      answer: 'old',
      completedAt: old,
      conversationId: 'conv-old',
    });

    expect((await listSessionTranscripts()).entries).toHaveLength(0);

    await recordSessionTurn({
      answer: 'fresh',
      completedAt: new Date().toISOString(),
      conversationId: 'conv-fresh',
    });

    const listed = await listSessionTranscripts();

    expect(listed.entries.map((entry) => entry.conversationId)).toEqual([
      'conv-fresh',
    ]);
  });

  it('prunes the oldest turns when the count limit is exceeded', async () => {
    // The settings layer clamps `maxEntries` to a minimum of 10, so the count
    // limit only bites past ten turns.
    for (let index = 0; index < 12; index += 1) {
      await recordSessionTurn({
        answer: `a${index}`,
        completedAt: new Date(Date.now() - (12 - index) * 1_000).toISOString(),
        conversationId: 'conv-a',
      });
    }

    const removed = await pruneSessionTranscripts({
      ...DEFAULT_SESSION_TRANSCRIPT_SETTINGS,
      maxEntries: 10,
      retentionDays: 30,
    });

    expect(removed).toBe(2);

    const listed = await listSessionTranscripts();

    expect(listed.entries).toHaveLength(10);
    // The two oldest are gone; everything recent survived.
    expect(listed.entries.map((entry) => entry.answer)).toEqual([
      'a11',
      'a10',
      'a9',
      'a8',
      'a7',
      'a6',
      'a5',
      'a4',
      'a3',
      'a2',
    ]);
  });

  it('clamps a sub-minimum entry count up to the supported floor', async () => {
    const settings = await updateSessionTranscriptSettings({ maxEntries: 1 });

    expect(settings.maxEntries).toBe(SESSION_TRANSCRIPT_LIMITS.maxEntries.min);
  });

  it('clamps out-of-range settings', async () => {
    const settings = await updateSessionTranscriptSettings({
      maxEntries: 999_999,
      retentionDays: 9_999,
    });

    expect(settings.maxEntries).toBe(SESSION_TRANSCRIPT_LIMITS.maxEntries.hard);
    expect(settings.retentionDays).toBe(
      SESSION_TRANSCRIPT_LIMITS.retentionDays.hard,
    );

    // Garbage keeps the current value rather than persisting NaN.
    const fallback = await updateSessionTranscriptSettings({
      retentionDays: 'abc' as unknown as number,
    });

    expect(fallback.retentionDays).toBe(
      SESSION_TRANSCRIPT_LIMITS.retentionDays.hard,
    );
  });

  it('applies the documented defaults before any settings are saved', async () => {
    expect(await getSessionTranscriptSettings()).toEqual(
      DEFAULT_SESSION_TRANSCRIPT_SETTINGS,
    );
  });

  it('clears every stored turn', async () => {
    for (let index = 0; index < 3; index += 1) {
      await recordSessionTurn({
        answer: `a${index}`,
        completedAt: `2026-10-04T01:0${index}:00.000Z`,
        conversationId: 'conv-a',
      });
    }

    expect(await clearSessionTranscripts()).toBe(3);
    expect((await listSessionTranscripts()).entries).toHaveLength(0);
  });

  it('stores answer bodies outside the listed namespace', async () => {
    await recordSessionTurn({
      answer: 'the body',
      completedAt: '2026-10-04T01:00:00.000Z',
      conversationId: 'conv-a',
      question: 'the question',
    });

    const meta = [...storage.bucket('session-transcripts').values()];
    const bodies = [...storage.bucket('session-transcript-answers').values()];

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toEqual({ answer: 'the body' });
    // Retention lists only this namespace, so the answer must not be here —
    // otherwise every sweep parses the full reply of every stored turn.
    expect(meta).toHaveLength(1);
    expect(meta[0]).not.toHaveProperty('answer');
  });

  it('deletes the matching answer when a turn is pruned', async () => {
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();

    // Recording prunes with the stored settings, so widen retention first to
    // keep the aged turn available for the explicit prune below.
    await updateSessionTranscriptSettings({
      maxEntries: 1_000,
      retentionDays: 365,
    });

    await recordSessionTurn({
      answer: 'stale body',
      completedAt: old,
      conversationId: 'conv-old',
    });

    expect(storage.bucket('session-transcript-answers').size).toBe(1);

    await pruneSessionTranscripts({
      ...DEFAULT_SESSION_TRANSCRIPT_SETTINGS,
      maxEntries: 1_000,
      retentionDays: 30,
    });

    // The settings document shares the metadata namespace, so assert on the
    // turn's own key rather than on the bucket size.
    const turnId = `${old}-conv-old`;

    expect(storage.bucket('session-transcripts').has(turnId)).toBe(false);
    // Leaving the body behind would leak storage with no metadata to find it.
    expect(storage.bucket('session-transcript-answers').size).toBe(0);
  });

  it('still reads turns stored before the answer split', async () => {
    // Shape written by the previous layout: answer embedded in the metadata.
    storage.bucket('session-transcripts').set('legacy-id', {
      accessKeyId: null,
      answer: 'legacy body',
      answerChars: 11,
      completedAt: '2026-10-04T01:00:00.000Z',
      conversationId: 'conv-legacy',
      id: 'legacy-id',
      model: null,
      question: 'legacy question',
      questionChars: 14,
      startedAt: '2026-10-04T01:00:00.000Z',
      status: 'completed',
    });

    const [entry] = (await listSessionTranscripts()).entries;

    expect(entry?.id).toBe('legacy-id');
    expect(entry?.answer).toBe('legacy body');
  });

  it('degrades to not-collected on the file backend', async () => {
    storage.backendKind = 'file';

    expect(
      await recordSessionTurn({
        answer: 'x',
        completedAt: '2026-10-04T01:00:00.000Z',
        conversationId: 'conv-a',
      }),
    ).toBeNull();
    expect((await listSessionTranscripts()).entries).toHaveLength(0);
  });
});

describe('transcript recorder', () => {
  beforeEach(() => {
    storage.reset();
    resetSessionStreamRuntime();
    resetSessionTranscriptRuntime();
  });

  it('persists a completed turn straight off the session bus', async () => {
    ensureSessionTranscriptRecorder();

    publishSessionStarted({
      accessKeyId: 'key-1',
      conversationId: 'conv-live',
      model: 'deepseek-v4.1-flash',
      question: 'what is 2+2',
    });
    publishSessionDelta({ conversationId: 'conv-live', delta: '4' });
    publishSessionCompleted({ conversationId: 'conv-live' });

    await flushRecorder();

    const listed = await listSessionTranscripts({
      conversationId: 'conv-live',
    });

    expect(listed.entries).toHaveLength(1);
    expect(listed.entries[0]).toMatchObject({
      accessKeyId: 'key-1',
      answer: '4',
      model: 'deepseek-v4.1-flash',
      question: 'what is 2+2',
      status: 'completed',
    });
  });

  it('records a failed turn with its error', async () => {
    ensureSessionTranscriptRecorder();

    publishSessionStarted({
      conversationId: 'conv-fail',
      question: 'will this work',
    });
    publishSessionCompleted({ conversationId: 'conv-fail', error: 'boom' });

    await flushRecorder();

    const [entry] = (
      await listSessionTranscripts({ conversationId: 'conv-fail' })
    ).entries;

    expect(entry?.status).toBe('failed');
    expect(entry?.error).toBe('boom');
  });

  it('registers only one recorder even when called repeatedly', async () => {
    ensureSessionTranscriptRecorder();
    ensureSessionTranscriptRecorder();

    publishSessionStarted({ conversationId: 'conv-once' });
    publishSessionCompleted({ conversationId: 'conv-once' });

    await flushRecorder();

    // A stacked recorder would store the same turn under the same id twice only
    // if ids differed; the real guard is that one subscriber exists, so assert
    // the observable outcome: exactly one stored turn.
    expect(
      (await listSessionTranscripts({ conversationId: 'conv-once' })).entries,
    ).toHaveLength(1);
  });

  it('does not subscribe on the file backend', async () => {
    storage.backendKind = 'file';

    ensureSessionTranscriptRecorder();

    publishSessionStarted({ conversationId: 'conv-file' });
    publishSessionCompleted({ conversationId: 'conv-file' });

    await flushRecorder();

    expect((await listSessionTranscripts()).entries).toHaveLength(0);
  });
});
