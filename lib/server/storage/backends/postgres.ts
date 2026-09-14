import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  or,
  type SQL,
} from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import path from 'node:path';

import { createPostgresStorageSchema } from './postgres-schema';
import type {
  DatabaseDocumentRecord,
  DatabaseSessionRecord,
  DatabaseSessionTurnRecord,
  DatabaseStorageAdapter,
  ListSessionRecordsOptions,
  StorageEvent,
} from './types';

export type {
  DatabaseDocumentRecord,
  DatabaseSessionRecord,
  DatabaseSessionTurnRecord,
  DatabaseStorageAdapter,
  ListSessionRecordsOptions,
  StorageEvent,
};

const MIGRATION_LOCK_ID = 1_873_289_124;

interface PgDatabaseStorageAdapterOptions {
  connectionString: string;
  schemaName: string;
}

export class DrizzlePgDatabaseStorageAdapter implements DatabaseStorageAdapter {
  private readonly db: ReturnType<typeof drizzle>;

  private readonly documents: ReturnType<
    typeof createPostgresStorageSchema
  >['documents'];

  private readonly debugLogs: ReturnType<
    typeof createPostgresStorageSchema
  >['debugLogs'];

  private readonly pool: InstanceType<typeof Pool>;

  private readonly sessionTurns: ReturnType<
    typeof createPostgresStorageSchema
  >['sessionTurns'];

  private readonly sessions: ReturnType<
    typeof createPostgresStorageSchema
  >['sessions'];

  private readonly usageEvents: ReturnType<
    typeof createPostgresStorageSchema
  >['usageEvents'];

  public constructor(options: PgDatabaseStorageAdapterOptions) {
    this.pool = new Pool({
      connectionString: options.connectionString,
    });
    this.db = drizzle(this.pool);
    const schema = createPostgresStorageSchema(options.schemaName);
    this.documents = schema.documents;
    this.debugLogs = schema.debugLogs;
    this.sessionTurns = schema.sessionTurns;
    this.sessions = schema.sessions;
    this.usageEvents = schema.usageEvents;
  }

  public async ensureSchema(): Promise<void> {
    const client = await this.pool.connect();
    let migrationLockAcquired = false;

    try {
      await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
      migrationLockAcquired = true;
      await migrate(this.db, {
        migrationsFolder: path.resolve(
          'lib/server/storage/migrations/postgres',
        ),
      });
    } finally {
      if (migrationLockAcquired) {
        await client.query('SELECT pg_advisory_unlock($1)', [
          MIGRATION_LOCK_ID,
        ]);
      }
      client.release();
    }

    await Promise.all([
      this.db
        .select({ key: this.documents.documentKey })
        .from(this.documents)
        .limit(1),
      this.db
        .select({ key: this.usageEvents.eventId })
        .from(this.usageEvents)
        .limit(1),
      this.db
        .select({ key: this.debugLogs.eventId })
        .from(this.debugLogs)
        .limit(1),
      this.db
        .select({ key: this.sessions.sessionId })
        .from(this.sessions)
        .limit(1),
      this.db
        .select({ key: this.sessionTurns.turnId })
        .from(this.sessionTurns)
        .limit(1),
    ]);
  }

  public async appendUsageEvents(entries: StorageEvent[]): Promise<void> {
    if (!entries.length) return;
    await this.db
      .insert(this.usageEvents)
      .values(
        entries.map((entry) => ({
          ...(entry.payload as {
            accessKeyId: string | null;
            accessKeyName: string | null;
            cacheCreationTokens: number;
            cacheReadTokens: number;
            callCount: number;
            credentialFilename: string | null;
            inputTokens: number;
            model: string;
            outputTokens: number;
            route: string;
            totalTokens: number;
          }),
          eventId: entry.id,
          occurredAt: new Date(entry.timestamp),
        })),
      )
      .onConflictDoNothing();
  }

  public async listUsageEvents(since: Date): Promise<StorageEvent[]> {
    const rows = await this.db
      .select()
      .from(this.usageEvents)
      .where(gte(this.usageEvents.occurredAt, since))
      .orderBy(asc(this.usageEvents.occurredAt), asc(this.usageEvents.eventId));
    return rows.map((row) => ({
      id: row.eventId,
      payload: {
        accessKeyId: row.accessKeyId,
        accessKeyName: row.accessKeyName,
        cacheCreationTokens: row.cacheCreationTokens,
        cacheReadTokens: row.cacheReadTokens,
        callCount: row.callCount,
        credentialFilename: row.credentialFilename,
        inputTokens: row.inputTokens,
        model: row.model,
        outputTokens: row.outputTokens,
        route: row.route,
        timestamp: row.occurredAt.toISOString(),
        totalTokens: row.totalTokens,
      },
      timestamp: row.occurredAt.toISOString(),
    }));
  }

  public async clearUsageEvents(): Promise<void> {
    await this.db.delete(this.usageEvents);
  }

  public async trimUsageEvents(before: Date): Promise<void> {
    await this.db
      .delete(this.usageEvents)
      .where(lt(this.usageEvents.occurredAt, before));
  }

  public async appendDebugLogs(entries: StorageEvent[]): Promise<void> {
    if (!entries.length) return;
    await this.db
      .insert(this.debugLogs)
      .values(
        entries.map((entry) => ({
          ...(entry.payload as {
            credentialFilename: string | null;
            elapsedMs: number;
            error: string | null;
            model: string | null;
            requestBody: unknown;
            requestKey: string | null;
            route: string;
            transformedResponse: unknown;
            upstreamRequest: unknown;
            upstreamResponse: unknown;
            usage: unknown;
          }),
          eventId: entry.id,
          createdAt: new Date(entry.timestamp),
        })),
      )
      .onConflictDoNothing();
  }

  public async listDebugLogs(limit: number): Promise<StorageEvent[]> {
    const rows = await this.db
      .select()
      .from(this.debugLogs)
      .orderBy(desc(this.debugLogs.createdAt), desc(this.debugLogs.eventId))
      .limit(limit);
    return rows.map((row) => ({
      id: row.eventId,
      payload: {
        credentialFilename: row.credentialFilename,
        createdAt: row.createdAt.toISOString(),
        elapsedMs: row.elapsedMs,
        error: row.error,
        id: row.eventId,
        model: row.model,
        requestBody: row.requestBody,
        requestKey: row.requestKey,
        route: row.route,
        transformedResponse: row.transformedResponse,
        upstreamRequest: row.upstreamRequest,
        upstreamResponse: row.upstreamResponse,
        usage: row.usage,
      },
      timestamp: row.createdAt.toISOString(),
    }));
  }

  public async clearDebugLogs(): Promise<void> {
    await this.db.delete(this.debugLogs);
  }

  public async trimDebugLogs(maxEntries: number): Promise<void> {
    const rows = await this.db
      .select({ eventId: this.debugLogs.eventId })
      .from(this.debugLogs)
      .orderBy(desc(this.debugLogs.createdAt), desc(this.debugLogs.eventId))
      .offset(maxEntries);
    if (!rows.length) return;
    await this.db.delete(this.debugLogs).where(
      inArray(
        this.debugLogs.eventId,
        rows.map((row) => row.eventId),
      ),
    );
  }

  public async getDocument(
    namespace: string,
    key: string,
  ): Promise<DatabaseDocumentRecord | null> {
    const rows = await this.db
      .select({
        encryptedPayload: this.documents.encryptedPayload,
        encryptionMode: this.documents.encryptionMode,
        key: this.documents.documentKey,
        payload: this.documents.payload,
      })
      .from(this.documents)
      .where(
        and(
          eq(this.documents.namespace, namespace),
          eq(this.documents.documentKey, key),
        ),
      )
      .limit(1);

    const row = rows[0];

    if (!row) {
      return null;
    }

    return row;
  }

  public async listDocuments(
    namespace: string,
  ): Promise<DatabaseDocumentRecord[]> {
    const rows = await this.db
      .select({
        encryptedPayload: this.documents.encryptedPayload,
        encryptionMode: this.documents.encryptionMode,
        key: this.documents.documentKey,
        payload: this.documents.payload,
      })
      .from(this.documents)
      .where(eq(this.documents.namespace, namespace))
      .orderBy(asc(this.documents.documentKey));

    return rows;
  }

  public async putDocument(input: {
    encryptedPayload: string | null;
    encryptionMode: string | null;
    key: string;
    namespace: string;
    payload: unknown;
  }): Promise<void> {
    await this.db
      .insert(this.documents)
      .values({
        documentKey: input.key,
        encryptedPayload: input.encryptedPayload,
        encryptionMode: input.encryptionMode,
        namespace: input.namespace,
        payload: input.payload,
      })
      .onConflictDoUpdate({
        set: {
          encryptedPayload: input.encryptedPayload,
          encryptionMode: input.encryptionMode,
          payload: input.payload,
          updatedAt: new Date(),
        },
        target: [this.documents.namespace, this.documents.documentKey],
      });
  }

  public async deleteDocument(namespace: string, key: string): Promise<void> {
    await this.db
      .delete(this.documents)
      .where(
        and(
          eq(this.documents.namespace, namespace),
          eq(this.documents.documentKey, key),
        ),
      );
  }

  public async putSessionRecord(record: DatabaseSessionRecord): Promise<void> {
    await this.db
      .insert(this.sessions)
      .values(record)
      .onConflictDoUpdate({
        set: {
          accessKeyId: record.accessKeyId,
          credentialFilename: record.credentialFilename,
          encryptionMode: record.encryptionMode,
          externalRef: record.externalRef,
          model: record.model,
          sourceRoute: record.sourceRoute,
          title: record.title,
          totalTokens: record.totalTokens,
          turnCount: record.turnCount,
          updatedAt: record.updatedAt,
        },
        target: this.sessions.sessionId,
      });
  }

  public async getSessionRecord(
    sessionId: string,
  ): Promise<DatabaseSessionRecord | null> {
    const rows = await this.db
      .select()
      .from(this.sessions)
      .where(eq(this.sessions.sessionId, sessionId))
      .limit(1);

    return rows[0] ?? null;
  }

  public async findLatestSessionByExternalRef(
    accessKeyId: string | null,
    externalRef: string,
    updatedAfter: Date,
  ): Promise<DatabaseSessionRecord | null> {
    const rows = await this.db
      .select()
      .from(this.sessions)
      .where(
        and(
          accessKeyId === null
            ? isNull(this.sessions.accessKeyId)
            : eq(this.sessions.accessKeyId, accessKeyId),
          eq(this.sessions.externalRef, externalRef),
          gte(this.sessions.updatedAt, updatedAfter),
        ),
      )
      .orderBy(desc(this.sessions.updatedAt), desc(this.sessions.sessionId))
      .limit(1);

    return rows[0] ?? null;
  }

  public async listSessionRecords(
    options: ListSessionRecordsOptions,
  ): Promise<DatabaseSessionRecord[]> {
    const filters: SQL[] = [];

    if (options.accessKeyId) {
      filters.push(eq(this.sessions.accessKeyId, options.accessKeyId));
    }

    if (options.cursor) {
      const cursorFilter = or(
        lt(this.sessions.updatedAt, options.cursor.updatedAt),
        and(
          eq(this.sessions.updatedAt, options.cursor.updatedAt),
          lt(this.sessions.sessionId, options.cursor.sessionId),
        ),
      );

      if (cursorFilter) {
        filters.push(cursorFilter);
      }
    }

    return this.db
      .select()
      .from(this.sessions)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(desc(this.sessions.updatedAt), desc(this.sessions.sessionId))
      .limit(options.limit);
  }

  public async appendSessionTurns(
    records: DatabaseSessionTurnRecord[],
  ): Promise<void> {
    if (!records.length) return;

    await this.db
      .insert(this.sessionTurns)
      .values(records)
      .onConflictDoNothing();
  }

  public async listSessionTurns(
    sessionId: string,
  ): Promise<DatabaseSessionTurnRecord[]> {
    return this.db
      .select()
      .from(this.sessionTurns)
      .where(eq(this.sessionTurns.sessionId, sessionId))
      .orderBy(asc(this.sessionTurns.turnIndex));
  }

  public async trimSessionTurns(
    sessionId: string,
    maxTurns: number,
  ): Promise<void> {
    if (maxTurns <= 0) return;

    const staleRows = await this.db
      .select({ turnId: this.sessionTurns.turnId })
      .from(this.sessionTurns)
      .where(eq(this.sessionTurns.sessionId, sessionId))
      .orderBy(
        desc(this.sessionTurns.turnIndex),
        desc(this.sessionTurns.turnId),
      )
      .offset(maxTurns);

    if (!staleRows.length) return;

    await this.db.delete(this.sessionTurns).where(
      inArray(
        this.sessionTurns.turnId,
        staleRows.map((row) => row.turnId),
      ),
    );
  }

  public async deleteSessionRecord(sessionId: string): Promise<void> {
    await this.db
      .delete(this.sessionTurns)
      .where(eq(this.sessionTurns.sessionId, sessionId));
    await this.db
      .delete(this.sessions)
      .where(eq(this.sessions.sessionId, sessionId));
  }

  public async clearSessionRecords(): Promise<void> {
    await this.db.delete(this.sessionTurns);
    await this.db.delete(this.sessions);
  }

  public async trimSessionRecords(before: Date): Promise<void> {
    const staleRows = await this.db
      .select({ sessionId: this.sessions.sessionId })
      .from(this.sessions)
      .where(lt(this.sessions.updatedAt, before));

    if (!staleRows.length) return;

    const staleIds = staleRows.map((row) => row.sessionId);

    await this.db
      .delete(this.sessionTurns)
      .where(inArray(this.sessionTurns.sessionId, staleIds));
    await this.db
      .delete(this.sessions)
      .where(inArray(this.sessions.sessionId, staleIds));
  }
}
