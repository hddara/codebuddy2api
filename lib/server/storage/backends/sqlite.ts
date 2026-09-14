import Database from 'better-sqlite3';
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
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import path from 'node:path';

import {
  debugLogs,
  documents,
  sessionTurns,
  sessions,
  usageEvents,
} from './sqlite-schema';
import type {
  DatabaseDocumentRecord,
  DatabaseSessionRecord,
  DatabaseSessionTurnRecord,
  DatabaseStorageAdapter,
  ListSessionRecordsOptions,
  StorageEvent,
} from './types';

interface SqliteDatabaseStorageAdapterOptions {
  path: string;
}

export class DrizzleSqliteDatabaseStorageAdapter implements DatabaseStorageAdapter {
  private readonly db: ReturnType<typeof drizzle>;

  private readonly sqlite: InstanceType<typeof Database>;

  public constructor(options: SqliteDatabaseStorageAdapterOptions) {
    this.sqlite = new Database(options.path);
    this.db = drizzle(this.sqlite);
  }

  public async ensureSchema(): Promise<void> {
    migrate(this.db, {
      migrationsFolder: path.resolve('lib/server/storage/migrations/sqlite'),
    });

    await Promise.all([
      this.db.select({ key: documents.documentKey }).from(documents).limit(1),
      this.db.select({ key: usageEvents.eventId }).from(usageEvents).limit(1),
      this.db.select({ key: debugLogs.eventId }).from(debugLogs).limit(1),
      this.db.select({ key: sessions.sessionId }).from(sessions).limit(1),
      this.db.select({ key: sessionTurns.turnId }).from(sessionTurns).limit(1),
    ]);
  }

  public async appendUsageEvents(entries: StorageEvent[]): Promise<void> {
    if (!entries.length) return;

    await this.db
      .insert(usageEvents)
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
      .from(usageEvents)
      .where(gte(usageEvents.occurredAt, since))
      .orderBy(asc(usageEvents.occurredAt), asc(usageEvents.eventId));

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
    await this.db.delete(usageEvents);
  }

  public async trimUsageEvents(before: Date): Promise<void> {
    await this.db.delete(usageEvents).where(lt(usageEvents.occurredAt, before));
  }

  public async appendDebugLogs(entries: StorageEvent[]): Promise<void> {
    if (!entries.length) return;

    await this.db
      .insert(debugLogs)
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
          createdAt: new Date(entry.timestamp),
          eventId: entry.id,
        })),
      )
      .onConflictDoNothing();
  }

  public async listDebugLogs(limit: number): Promise<StorageEvent[]> {
    const rows = await this.db
      .select()
      .from(debugLogs)
      .orderBy(desc(debugLogs.createdAt), desc(debugLogs.eventId))
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
    await this.db.delete(debugLogs);
  }

  public async trimDebugLogs(maxEntries: number): Promise<void> {
    const rows = await this.db
      .select({ eventId: debugLogs.eventId })
      .from(debugLogs)
      .orderBy(desc(debugLogs.createdAt), desc(debugLogs.eventId));
    const staleRows = rows.slice(maxEntries);

    if (!staleRows.length) return;

    await this.db.delete(debugLogs).where(
      inArray(
        debugLogs.eventId,
        staleRows.map((row) => row.eventId),
      ),
    );
  }

  public async getDocument(
    namespace: string,
    key: string,
  ): Promise<DatabaseDocumentRecord | null> {
    const rows = await this.db
      .select({
        encryptedPayload: documents.encryptedPayload,
        encryptionMode: documents.encryptionMode,
        key: documents.documentKey,
        payload: documents.payload,
      })
      .from(documents)
      .where(
        and(eq(documents.namespace, namespace), eq(documents.documentKey, key)),
      )
      .limit(1);

    return rows[0] ?? null;
  }

  public async listDocuments(
    namespace: string,
  ): Promise<DatabaseDocumentRecord[]> {
    return this.db
      .select({
        encryptedPayload: documents.encryptedPayload,
        encryptionMode: documents.encryptionMode,
        key: documents.documentKey,
        payload: documents.payload,
      })
      .from(documents)
      .where(eq(documents.namespace, namespace))
      .orderBy(asc(documents.documentKey));
  }

  public async putDocument(input: {
    encryptedPayload: string | null;
    encryptionMode: string | null;
    key: string;
    namespace: string;
    payload: unknown;
  }): Promise<void> {
    await this.db
      .insert(documents)
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
        target: [documents.namespace, documents.documentKey],
      });
  }

  public async deleteDocument(namespace: string, key: string): Promise<void> {
    await this.db
      .delete(documents)
      .where(
        and(eq(documents.namespace, namespace), eq(documents.documentKey, key)),
      );
  }

  public async putSessionRecord(record: DatabaseSessionRecord): Promise<void> {
    await this.db
      .insert(sessions)
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
        target: sessions.sessionId,
      });
  }

  public async getSessionRecord(
    sessionId: string,
  ): Promise<DatabaseSessionRecord | null> {
    const rows = await this.db
      .select()
      .from(sessions)
      .where(eq(sessions.sessionId, sessionId))
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
      .from(sessions)
      .where(
        and(
          accessKeyId === null
            ? isNull(sessions.accessKeyId)
            : eq(sessions.accessKeyId, accessKeyId),
          eq(sessions.externalRef, externalRef),
          gte(sessions.updatedAt, updatedAfter),
        ),
      )
      .orderBy(desc(sessions.updatedAt), desc(sessions.sessionId))
      .limit(1);

    return rows[0] ?? null;
  }

  public async listSessionRecords(
    options: ListSessionRecordsOptions,
  ): Promise<DatabaseSessionRecord[]> {
    const filters: SQL[] = [];

    if (options.accessKeyId) {
      filters.push(eq(sessions.accessKeyId, options.accessKeyId));
    }

    if (options.cursor) {
      const cursorFilter = or(
        lt(sessions.updatedAt, options.cursor.updatedAt),
        and(
          eq(sessions.updatedAt, options.cursor.updatedAt),
          lt(sessions.sessionId, options.cursor.sessionId),
        ),
      );

      if (cursorFilter) {
        filters.push(cursorFilter);
      }
    }

    return this.db
      .select()
      .from(sessions)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(desc(sessions.updatedAt), desc(sessions.sessionId))
      .limit(options.limit);
  }

  public async appendSessionTurns(
    records: DatabaseSessionTurnRecord[],
  ): Promise<void> {
    if (!records.length) return;

    await this.db.insert(sessionTurns).values(records).onConflictDoNothing();
  }

  public async listSessionTurns(
    sessionId: string,
  ): Promise<DatabaseSessionTurnRecord[]> {
    return this.db
      .select()
      .from(sessionTurns)
      .where(eq(sessionTurns.sessionId, sessionId))
      .orderBy(asc(sessionTurns.turnIndex));
  }

  public async trimSessionTurns(
    sessionId: string,
    maxTurns: number,
  ): Promise<void> {
    if (maxTurns <= 0) return;

    // SQLite rejects OFFSET without LIMIT, so page in memory like trimDebugLogs.
    const rows = await this.db
      .select({ turnId: sessionTurns.turnId })
      .from(sessionTurns)
      .where(eq(sessionTurns.sessionId, sessionId))
      .orderBy(desc(sessionTurns.turnIndex), desc(sessionTurns.turnId));
    const staleRows = rows.slice(maxTurns);

    if (!staleRows.length) return;

    await this.db.delete(sessionTurns).where(
      inArray(
        sessionTurns.turnId,
        staleRows.map((row) => row.turnId),
      ),
    );
  }

  public async deleteSessionRecord(sessionId: string): Promise<void> {
    await this.db
      .delete(sessionTurns)
      .where(eq(sessionTurns.sessionId, sessionId));
    await this.db.delete(sessions).where(eq(sessions.sessionId, sessionId));
  }

  public async clearSessionRecords(): Promise<void> {
    await this.db.delete(sessionTurns);
    await this.db.delete(sessions);
  }

  public async trimSessionRecords(before: Date): Promise<void> {
    const staleRows = await this.db
      .select({ sessionId: sessions.sessionId })
      .from(sessions)
      .where(lt(sessions.updatedAt, before));

    if (!staleRows.length) return;

    const staleIds = staleRows.map((row) => row.sessionId);

    await this.db
      .delete(sessionTurns)
      .where(inArray(sessionTurns.sessionId, staleIds));
    await this.db.delete(sessions).where(inArray(sessions.sessionId, staleIds));
  }
}
