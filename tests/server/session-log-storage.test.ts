import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

import type {
  SessionTurnRecord,
  SessionWriteInput,
} from '@/lib/server/storage';

const tempRootDir = path.join(process.cwd(), '.tmp-test-session-log');
const sqlitePath = path.join(tempRootDir, 'storage.sqlite');
const ENCRYPTION_KEY = 'session-log-test-key';

const cleanupTempState = (): void => {
  fs.rmSync(tempRootDir, { force: true, recursive: true, maxRetries: 5 });
};

const loadStorage = async () => {
  vi.resetModules();
  return import('@/lib/server/storage');
};

const loadSessionLog = async () => {
  vi.resetModules();
  return import('@/lib/server/domain/session-log');
};

const readSqlite = <T>(statement: string, ...params: unknown[]): T[] => {
  const database = new Database(sqlitePath, { readonly: true });
  const rows = database.prepare(statement).all(...params) as T[];
  database.close();
  return rows;
};

const buildSession = (
  sessionId: string,
  overrides: Partial<SessionWriteInput> = {},
): SessionWriteInput => ({
  accessKeyId: 'key-1',
  credentialFilename: 'credential.json',
  externalRef: 'chat-1',
  model: 'gpt-5.5',
  sessionId,
  sourceRoute: '/v1/chat/completions',
  startedAt: Date.parse('2026-07-01T00:00:00.000Z'),
  title: 'TOP-SECRET-TITLE',
  updatedAt: Date.parse('2026-07-01T00:01:00.000Z'),
  ...overrides,
});

const buildTurn = (
  sessionId: string,
  turnIndex: number,
  overrides: Partial<SessionTurnRecord> = {},
): SessionTurnRecord => ({
  contentRaw: [{ content: 'TOP-SECRET-PROMPT-TEXT', role: 'user' }],
  contentText: 'TOP-SECRET-PROMPT-TEXT',
  context: { previous_response_id: null },
  createdAt: Date.parse('2026-07-01T00:00:00.000Z') + turnIndex,
  model: 'gpt-5.5',
  reasoning: null,
  role: 'user',
  route: '/v1/chat/completions',
  sessionId,
  toolCalls: null,
  turnId: `${sessionId}-turn-${turnIndex}`,
  turnIndex,
  usage: { total_tokens: 12 },
  ...overrides,
});

describe('storage session logging', () => {
  beforeEach(() => {
    cleanupTempState();
    vi.resetModules();
    process.env.CODEBUDDY_STORAGE_BACKEND = 'sqlite';
    process.env.CODEBUDDY_STORAGE_SQLITE_PATH = sqlitePath;
    process.env.CODEBUDDY_STORAGE_ENCRYPTION_KEY = ENCRYPTION_KEY;
    delete process.env.CODEBUDDY_SESSION_LOG_ENABLED;
    delete process.env.CODEBUDDY_SESSION_MAX_TURNS_PER_SESSION;
    delete process.env.CODEBUDDY_SESSION_RETENTION_DAYS;
  });

  afterEach(() => {
    cleanupTempState();
    delete process.env.CODEBUDDY_STORAGE_BACKEND;
    delete process.env.CODEBUDDY_STORAGE_SQLITE_PATH;
    delete process.env.CODEBUDDY_STORAGE_ENCRYPTION_KEY;
    delete process.env.CODEBUDDY_SESSION_LOG_ENABLED;
    delete process.env.CODEBUDDY_SESSION_MAX_TURNS_PER_SESSION;
    delete process.env.CODEBUDDY_SESSION_RETENTION_DAYS;
  });

  it('round-trips a session and encrypts its content columns on disk', async () => {
    const storage = await loadStorage();
    storage.resetStorageRuntime();

    expect(storage.getSessionStorageAvailability()).toEqual({
      available: true,
      backend: 'sqlite',
      reason: null,
    });

    await storage.appendStorageSessionTurns({
      session: buildSession('session-1'),
      turns: [buildTurn('session-1', 0)],
    });

    const stored = await storage.getStorageSession('session-1');

    expect(stored?.session).toEqual({
      accessKeyId: 'key-1',
      credentialFilename: 'credential.json',
      externalRef: 'chat-1',
      model: 'gpt-5.5',
      sessionId: 'session-1',
      sourceRoute: '/v1/chat/completions',
      startedAt: Date.parse('2026-07-01T00:00:00.000Z'),
      title: 'TOP-SECRET-TITLE',
      totalTokens: 12,
      turnCount: 1,
      updatedAt: Date.parse('2026-07-01T00:01:00.000Z'),
    });
    expect(stored?.turns).toEqual([
      {
        contentRaw: [{ content: 'TOP-SECRET-PROMPT-TEXT', role: 'user' }],
        contentText: 'TOP-SECRET-PROMPT-TEXT',
        context: { previous_response_id: null },
        createdAt: Date.parse('2026-07-01T00:00:00.000Z'),
        model: 'gpt-5.5',
        reasoning: null,
        role: 'user',
        route: '/v1/chat/completions',
        sessionId: 'session-1',
        toolCalls: null,
        turnId: 'session-1-turn-0',
        turnIndex: 0,
        usage: { total_tokens: 12 },
      },
    ]);
    expect(await storage.getStorageSession('missing')).toBeNull();

    // The bundled migration must create all three session indexes.
    const indexes = readSqlite<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('sessions_updated_at_idx', 'sessions_access_key_updated_idx', 'session_turns_session_idx')",
    );

    expect(indexes).toHaveLength(3);

    // Ciphertext is base64, so a marker containing "-" can never survive on disk.
    const sessionRows = readSqlite<{ encryption_mode: string; title: string }>(
      'SELECT title, encryption_mode FROM sessions WHERE session_id = ?',
      'session-1',
    );
    const turnRows = readSqlite<{
      content_raw: string;
      content_text: string;
      encryption_mode: string;
    }>(
      'SELECT content_text, content_raw, encryption_mode FROM session_turns WHERE turn_id = ?',
      'session-1-turn-0',
    );

    expect(sessionRows[0].encryption_mode).toBe('aes-256-gcm');
    expect(sessionRows[0].title).not.toContain('-');
    expect(turnRows[0].encryption_mode).toBe('aes-256-gcm');
    expect(turnRows[0].content_text).not.toContain('-');
    expect(turnRows[0].content_raw).not.toContain('-');
  });

  it('keeps the first title, accumulates counters, and caps turns per session', async () => {
    const storage = await loadStorage();
    storage.resetStorageRuntime();

    await storage.appendStorageSessionTurns({
      session: buildSession('session-1'),
      turns: [buildTurn('session-1', 0), buildTurn('session-1', 1)],
    });
    await storage.appendStorageSessionTurns({
      maxTurnsPerSession: 2,
      session: buildSession('session-1', {
        title: 'SECOND-TITLE',
        updatedAt: Date.parse('2026-07-01T00:05:00.000Z'),
      }),
      turns: [buildTurn('session-1', 2)],
    });

    const stored = await storage.getStorageSession('session-1');

    expect(stored?.session.title).toBe('TOP-SECRET-TITLE');
    expect(stored?.session.turnCount).toBe(3);
    expect(stored?.session.totalTokens).toBe(36);
    expect(stored?.session.startedAt).toBe(
      Date.parse('2026-07-01T00:00:00.000Z'),
    );
    expect(stored?.session.updatedAt).toBe(
      Date.parse('2026-07-01T00:05:00.000Z'),
    );
    expect(stored?.turns.map((turn) => turn.turnIndex)).toEqual([1, 2]);
  });

  it('handles sessions without a title or turn payloads', async () => {
    const storage = await loadStorage();
    storage.resetStorageRuntime();

    await storage.appendStorageSessionTurns({
      session: buildSession('session-blank', { title: null }),
      turns: [
        buildTurn('session-blank', 0, {
          contentRaw: null,
          contentText: null,
          context: null,
          usage: null,
        }),
      ],
    });

    const stored = await storage.getStorageSession('session-blank');

    expect(stored?.session.title).toBeNull();
    expect(stored?.session.totalTokens).toBe(0);
    expect(stored?.turns).toEqual([
      expect.objectContaining({
        contentRaw: null,
        contentText: null,
        context: null,
        reasoning: null,
        toolCalls: null,
        usage: null,
      }),
    ]);
    expect(
      readSqlite<{ encryption_mode: string | null }>(
        'SELECT encryption_mode FROM sessions WHERE session_id = ?',
        'session-blank',
      ),
    ).toEqual([{ encryption_mode: null }]);
  });

  it('tolerates unreadable usage JSON written by an older build', async () => {
    const storage = await loadStorage();
    storage.resetStorageRuntime();

    await storage.appendStorageSessionTurns({
      session: buildSession('session-1'),
      turns: [buildTurn('session-1', 0)],
    });

    const database = new Database(sqlitePath);

    database
      .prepare('UPDATE session_turns SET usage_json = ? WHERE turn_id = ?')
      .run('not-json', 'session-1-turn-0');
    database.close();

    const stored = await storage.getStorageSession('session-1');

    expect(stored?.turns[0].usage).toBeNull();
  });

  it('lists sessions newest first with keyset pagination and application filters', async () => {
    const storage = await loadStorage();
    storage.resetStorageRuntime();

    await storage.appendStorageSessionTurns({
      session: buildSession('session-a', {
        accessKeyId: 'key-a',
        updatedAt: Date.parse('2026-07-01T00:00:00.000Z'),
      }),
      turns: [],
    });
    await storage.appendStorageSessionTurns({
      session: buildSession('session-b', {
        accessKeyId: 'key-b',
        updatedAt: Date.parse('2026-07-02T00:00:00.000Z'),
      }),
      turns: [],
    });
    await storage.appendStorageSessionTurns({
      session: buildSession('session-c', {
        accessKeyId: 'key-a',
        updatedAt: Date.parse('2026-07-03T00:00:00.000Z'),
      }),
      turns: [],
    });

    const firstPage = await storage.listStorageSessions({ limit: 2 });

    expect(firstPage.sessions.map((session) => session.sessionId)).toEqual([
      'session-c',
      'session-b',
    ]);
    expect(firstPage.nextCursor).toEqual({
      sessionId: 'session-b',
      updatedAt: Date.parse('2026-07-02T00:00:00.000Z'),
    });

    const secondPage = await storage.listStorageSessions({
      cursor: firstPage.nextCursor,
      limit: 2,
    });

    expect(secondPage.sessions.map((session) => session.sessionId)).toEqual([
      'session-a',
    ]);
    expect(secondPage.nextCursor).toBeNull();

    expect(
      (
        await storage.listStorageSessions({ accessKeyId: 'key-b' })
      ).sessions.map((session) => session.sessionId),
    ).toEqual(['session-b']);

    // Defaults and clamping: no options, a NaN limit, and an out-of-range limit.
    expect((await storage.listStorageSessions()).sessions).toHaveLength(3);
    expect(
      (await storage.listStorageSessions({ limit: Number.NaN })).sessions,
    ).toHaveLength(1);
    expect(
      (await storage.listStorageSessions({ limit: 10_000 })).sessions,
    ).toHaveLength(3);
  });

  it('deletes, clears, and trims sessions together with their turns', async () => {
    const storage = await loadStorage();
    storage.resetStorageRuntime();

    await storage.appendStorageSessionTurns({
      session: buildSession('session-old', {
        updatedAt: Date.parse('2026-06-01T00:00:00.000Z'),
      }),
      turns: [buildTurn('session-old', 0)],
    });
    await storage.appendStorageSessionTurns({
      session: buildSession('session-keep', {
        updatedAt: Date.parse('2026-07-01T00:00:00.000Z'),
      }),
      turns: [buildTurn('session-keep', 0)],
    });
    await storage.appendStorageSessionTurns({
      session: buildSession('session-drop', {
        updatedAt: Date.parse('2026-07-02T00:00:00.000Z'),
      }),
      turns: [buildTurn('session-drop', 0)],
    });

    await storage.trimStorageSessions(new Date('2026-06-15T00:00:00.000Z'));
    expect(
      (await storage.listStorageSessions()).sessions.map(
        (session) => session.sessionId,
      ),
    ).toEqual(['session-drop', 'session-keep']);
    expect(
      readSqlite<{ turn_id: string }>(
        'SELECT turn_id FROM session_turns WHERE session_id = ?',
        'session-old',
      ),
    ).toEqual([]);

    await storage.deleteStorageSession('session-drop');
    expect(await storage.getStorageSession('session-drop')).toBeNull();
    expect(
      readSqlite<{ turn_id: string }>(
        'SELECT turn_id FROM session_turns WHERE session_id = ?',
        'session-drop',
      ),
    ).toEqual([]);

    await storage.clearStorageSessions();
    expect(await storage.listStorageSessions()).toEqual({
      nextCursor: null,
      sessions: [],
    });
    expect(await storage.getStorageSession('session-keep')).toBeNull();
  });

  it('finds the newest session of a conversation inside the window', async () => {
    const storage = await loadStorage();
    storage.resetStorageRuntime();

    await storage.appendStorageSessionTurns({
      session: buildSession('session-ancient', {
        externalRef: 'fallback:conv',
        updatedAt: Date.parse('2026-07-01T00:00:00.000Z'),
      }),
      turns: [buildTurn('session-ancient', 0)],
    });
    await storage.appendStorageSessionTurns({
      session: buildSession('session-recent', {
        externalRef: 'fallback:conv',
        updatedAt: Date.parse('2026-07-01T00:30:00.000Z'),
      }),
      turns: [buildTurn('session-recent', 0)],
    });
    await storage.appendStorageSessionTurns({
      session: buildSession('session-other-ref', {
        externalRef: 'fallback:other',
        updatedAt: Date.parse('2026-07-01T00:31:00.000Z'),
      }),
      turns: [buildTurn('session-other-ref', 0)],
    });
    await storage.appendStorageSessionTurns({
      session: buildSession('session-other-key', {
        accessKeyId: 'key-2',
        externalRef: 'fallback:conv',
        updatedAt: Date.parse('2026-07-01T00:32:00.000Z'),
      }),
      turns: [buildTurn('session-other-key', 0)],
    });
    await storage.appendStorageSessionTurns({
      session: buildSession('session-anonymous', {
        accessKeyId: null,
        externalRef: 'fallback:anon',
        updatedAt: Date.parse('2026-07-01T00:33:00.000Z'),
      }),
      turns: [buildTurn('session-anonymous', 0)],
    });

    // Both rows are in range, so the newest one wins.
    expect(
      await storage.findStorageSessionByExternalRef(
        'key-1',
        'fallback:conv',
        Date.parse('2026-07-01T00:00:00.000Z'),
      ),
    ).toMatchObject({ sessionId: 'session-recent' });

    // A cutoff past the newest row means the conversation went stale.
    expect(
      await storage.findStorageSessionByExternalRef(
        'key-1',
        'fallback:conv',
        Date.parse('2026-07-01T00:31:00.000Z'),
      ),
    ).toBeNull();

    // Another access key, another fingerprint and unknown refs stay isolated.
    expect(
      await storage.findStorageSessionByExternalRef(
        'key-2',
        'fallback:conv',
        Date.parse('2026-07-01T00:00:00.000Z'),
      ),
    ).toMatchObject({ sessionId: 'session-other-key' });
    expect(
      await storage.findStorageSessionByExternalRef(
        'key-1',
        'fallback:missing',
        Date.parse('2026-07-01T00:00:00.000Z'),
      ),
    ).toBeNull();
    expect(
      await storage.findStorageSessionByExternalRef(
        null,
        'fallback:anon',
        Date.parse('2026-07-01T00:00:00.000Z'),
      ),
    ).toMatchObject({ sessionId: 'session-anonymous' });
  });

  it('refuses session logging on the file backend', async () => {
    process.env.CODEBUDDY_STORAGE_BACKEND = 'file';
    delete process.env.CODEBUDDY_STORAGE_ENCRYPTION_KEY;

    const storage = await loadStorage();
    storage.resetStorageRuntime();

    expect(storage.getSessionStorageAvailability()).toEqual({
      available: false,
      backend: 'file',
      reason: expect.stringContaining('only available'),
    });

    const input = { session: buildSession('session-1'), turns: [] };

    await expect(storage.appendStorageSessionTurns(input)).rejects.toThrow(
      'only available',
    );
    await expect(storage.getStorageSession('session-1')).rejects.toThrow(
      'only available',
    );
    await expect(storage.listStorageSessions()).rejects.toThrow(
      'only available',
    );
    await expect(storage.deleteStorageSession('session-1')).rejects.toThrow(
      'only available',
    );
    await expect(storage.clearStorageSessions()).rejects.toThrow(
      'only available',
    );
    await expect(storage.trimStorageSessions(new Date())).rejects.toThrow(
      'only available',
    );
  });
});

describe('sqlite session adapter edge cases', () => {
  beforeEach(() => {
    cleanupTempState();
    fs.mkdirSync(tempRootDir, { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    cleanupTempState();
  });

  it('no-ops on empty writes and missing rows', async () => {
    const { DrizzleSqliteDatabaseStorageAdapter } =
      await import('@/lib/server/storage/backends/sqlite');
    const adapter = new DrizzleSqliteDatabaseStorageAdapter({
      path: sqlitePath,
    });

    await adapter.ensureSchema();
    await adapter.appendSessionTurns([]);
    await adapter.trimSessionTurns('session-1', 0);
    await adapter.trimSessionTurns('session-1', 5);
    await adapter.trimSessionRecords(new Date());
    await adapter.deleteSessionRecord('session-1');

    expect(await adapter.getSessionRecord('session-1')).toBeNull();
    expect(await adapter.listSessionTurns('session-1')).toEqual([]);
    expect(
      await adapter.listSessionRecords({ accessKeyId: null, limit: 5 }),
    ).toEqual([]);
  });

  it('upserts session rows and ignores duplicate turn ids', async () => {
    const { DrizzleSqliteDatabaseStorageAdapter } =
      await import('@/lib/server/storage/backends/sqlite');
    const adapter = new DrizzleSqliteDatabaseStorageAdapter({
      path: sqlitePath,
    });

    await adapter.ensureSchema();
    await adapter.putSessionRecord({
      accessKeyId: null,
      credentialFilename: null,
      encryptionMode: null,
      externalRef: null,
      model: null,
      sessionId: 'session-1',
      sourceRoute: '/v1/messages',
      startedAt: new Date('2026-07-01T00:00:00.000Z'),
      title: null,
      totalTokens: 0,
      turnCount: 1,
      updatedAt: new Date('2026-07-01T00:00:00.000Z'),
    });
    await adapter.putSessionRecord({
      accessKeyId: 'key-1',
      credentialFilename: null,
      encryptionMode: null,
      externalRef: null,
      model: 'gpt-5.5',
      sessionId: 'session-1',
      sourceRoute: '/v1/messages',
      startedAt: new Date('2026-07-01T00:00:00.000Z'),
      title: null,
      totalTokens: 5,
      turnCount: 2,
      updatedAt: new Date('2026-07-02T00:00:00.000Z'),
    });

    expect(await adapter.listSessionRecords({ limit: 10 })).toEqual([
      expect.objectContaining({
        model: 'gpt-5.5',
        sessionId: 'session-1',
        startedAt: new Date('2026-07-01T00:00:00.000Z'),
        updatedAt: new Date('2026-07-02T00:00:00.000Z'),
      }),
    ]);

    const turn = {
      contentRaw: null,
      contentText: null,
      contextJson: null,
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
      encryptionMode: null,
      model: null,
      reasoning: null,
      role: 'assistant',
      route: '/v1/messages',
      sessionId: 'session-1',
      toolCalls: null,
      turnId: 'turn-1',
      turnIndex: 0,
      usageJson: null,
    };

    await adapter.appendSessionTurns([turn]);
    await adapter.appendSessionTurns([{ ...turn, usageJson: '{"a":1}' }]);

    expect(await adapter.listSessionTurns('session-1')).toHaveLength(1);
  });
});

describe('session log settings', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.CODEBUDDY_SESSION_LOG_ENABLED;
    delete process.env.CODEBUDDY_SESSION_MAX_TURNS_PER_SESSION;
    delete process.env.CODEBUDDY_SESSION_RETENTION_DAYS;
  });

  afterEach(() => {
    delete process.env.CODEBUDDY_SESSION_LOG_ENABLED;
    delete process.env.CODEBUDDY_SESSION_MAX_TURNS_PER_SESSION;
    delete process.env.CODEBUDDY_SESSION_RETENTION_DAYS;
  });

  it('applies defaults, overrides, and fallbacks', async () => {
    const sessionLog = await loadSessionLog();

    expect(sessionLog.getSessionLogSettings()).toEqual({
      enabled: true,
      maxTurnsPerSession: 200,
      retentionDays: 30,
    });
    expect(sessionLog.getSessionRetentionStartMs(1_000_000_000, 1)).toBe(
      1_000_000_000 - 86_400_000,
    );

    process.env.CODEBUDDY_SESSION_LOG_ENABLED = 'false';
    process.env.CODEBUDDY_SESSION_MAX_TURNS_PER_SESSION = '5';
    process.env.CODEBUDDY_SESSION_RETENTION_DAYS = '7';

    expect(sessionLog.getSessionLogSettings()).toEqual({
      enabled: false,
      maxTurnsPerSession: 5,
      retentionDays: 7,
    });

    // A zero retention window disables recording even when the flag is on.
    process.env.CODEBUDDY_SESSION_LOG_ENABLED = 'yes';
    process.env.CODEBUDDY_SESSION_RETENTION_DAYS = '0';

    expect(sessionLog.getSessionLogSettings()).toEqual({
      enabled: false,
      maxTurnsPerSession: 5,
      retentionDays: 0,
    });

    // Unparseable values fall back to the defaults.
    process.env.CODEBUDDY_SESSION_MAX_TURNS_PER_SESSION = '-3';
    process.env.CODEBUDDY_SESSION_RETENTION_DAYS = 'not-a-number';

    expect(sessionLog.getSessionLogSettings()).toEqual({
      enabled: true,
      maxTurnsPerSession: 200,
      retentionDays: 30,
    });

    // Blank values keep the fallbacks too.
    process.env.CODEBUDDY_SESSION_LOG_ENABLED = '   ';
    process.env.CODEBUDDY_SESSION_MAX_TURNS_PER_SESSION = ' ';

    expect(sessionLog.getSessionLogSettings()).toEqual({
      enabled: true,
      maxTurnsPerSession: 200,
      retentionDays: 30,
    });
  });
});
