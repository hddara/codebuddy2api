import type {
  DatabaseSessionRecord,
  DatabaseSessionTurnRecord,
} from '@/lib/server/storage/backends/types';

type MockRows = unknown[];

interface MockQuery extends Promise<MockRows> {
  limit: () => Promise<MockRows>;
  offset: () => Promise<MockRows>;
  orderBy: () => MockQuery;
}

const pendingRows: { current: MockRows } = { current: [] };

const createQuery = (): MockQuery => {
  const rows = pendingRows.current;
  const query = Promise.resolve(rows) as MockQuery;

  query.limit = async () => rows;
  query.offset = async () => rows;
  query.orderBy = () => createQuery();

  return query;
};

const deleteWhere = vi.fn(async () => undefined);
const deleteTable = vi.fn(() => ({ where: deleteWhere }));
const insertValues = vi.fn(() => ({
  onConflictDoNothing: vi.fn(async () => undefined),
  onConflictDoUpdate: vi.fn(async () => undefined),
}));
const insertTable = vi.fn(() => ({ values: insertValues }));

const drizzleMock = vi.fn(() => ({
  delete: deleteTable,
  insert: insertTable,
  select: vi.fn(() => ({
    from: vi.fn(() => ({ where: () => createQuery() })),
  })),
}));

vi.mock('drizzle-orm/node-postgres', () => ({
  drizzle: drizzleMock,
}));

vi.mock('drizzle-orm/node-postgres/migrator', () => ({
  migrate: vi.fn(async () => undefined),
}));

vi.mock('pg', () => ({
  Pool: class MockPool {
    public async connect() {
      return { query: vi.fn(async () => undefined), release: vi.fn() };
    }
  },
}));

const session: DatabaseSessionRecord = {
  accessKeyId: 'key-1',
  credentialFilename: null,
  encryptionMode: 'aes-256-gcm',
  externalRef: null,
  model: 'gpt-5.5',
  sessionId: 'session-1',
  sourceRoute: '/v1/messages',
  startedAt: new Date('2026-07-01T00:00:00.000Z'),
  title: 'cipher-title',
  totalTokens: 12,
  turnCount: 1,
  updatedAt: new Date('2026-07-01T00:01:00.000Z'),
};

const turn: DatabaseSessionTurnRecord = {
  contentRaw: 'cipher-raw',
  contentText: 'cipher-text',
  contextJson: null,
  createdAt: new Date('2026-07-01T00:00:00.000Z'),
  encryptionMode: 'aes-256-gcm',
  model: 'gpt-5.5',
  reasoning: null,
  role: 'user',
  route: '/v1/messages',
  sessionId: 'session-1',
  toolCalls: null,
  turnId: 'session-1-turn-0',
  turnIndex: 0,
  usageJson: '{"total_tokens":12}',
};

describe('drizzle pg session adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pendingRows.current = [];
  });

  it('forwards session and turn operations through drizzle', async () => {
    const { DrizzlePgDatabaseStorageAdapter } =
      await import('@/lib/server/storage/backends/postgres');
    const adapter = new DrizzlePgDatabaseStorageAdapter({
      connectionString: 'postgres://example.test/codebuddy',
      schemaName: 'codebuddy_test',
    });

    await adapter.putSessionRecord(session);
    expect(insertValues).toHaveBeenCalledWith(session);

    pendingRows.current = [session];
    expect(await adapter.getSessionRecord('session-1')).toEqual(session);

    pendingRows.current = [];
    expect(await adapter.getSessionRecord('session-1')).toBeNull();

    pendingRows.current = [session];
    expect(
      await adapter.listSessionRecords({
        accessKeyId: 'key-1',
        cursor: { sessionId: 'session-1', updatedAt: new Date(0) },
        limit: 5,
      }),
    ).toEqual([session]);

    // A filter-free query still reaches drizzle.
    expect(await adapter.listSessionRecords({ limit: 5 })).toEqual([session]);

    pendingRows.current = [session];
    expect(
      await adapter.findLatestSessionByExternalRef(
        'key-1',
        'fallback:conv',
        new Date('2026-07-01T00:00:00.000Z'),
      ),
    ).toEqual(session);

    // A null access key filters on IS NULL instead of equality.
    pendingRows.current = [];
    expect(
      await adapter.findLatestSessionByExternalRef(
        null,
        'fallback:conv',
        new Date('2026-07-01T00:00:00.000Z'),
      ),
    ).toBeNull();

    await adapter.appendSessionTurns([turn]);
    expect(insertValues).toHaveBeenLastCalledWith([turn]);
    await adapter.appendSessionTurns([]);

    pendingRows.current = [turn];
    expect(await adapter.listSessionTurns('session-1')).toEqual([turn]);

    pendingRows.current = [{ turnId: 'stale-turn' }];

    await adapter.trimSessionTurns('session-1', 2);
    await adapter.trimSessionTurns('session-1', 0);

    pendingRows.current = [];
    await adapter.trimSessionTurns('session-1', 2);

    pendingRows.current = [{ sessionId: 'session-1' }];
    await adapter.trimSessionRecords(new Date('2026-06-01T00:00:00.000Z'));

    pendingRows.current = [];
    await adapter.trimSessionRecords(new Date('2026-06-01T00:00:00.000Z'));

    await adapter.deleteSessionRecord('session-1');
    await adapter.clearSessionRecords();

    // trimSessionTurns, trimSessionRecords, deleteSessionRecord, clearSessionRecords.
    expect(deleteTable).toHaveBeenCalledTimes(7);
    expect(deleteWhere).toHaveBeenCalledTimes(5);
  });
});
