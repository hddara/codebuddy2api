import {
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  type PgTableExtraConfigValue,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const createPostgresStorageSchema = (schemaName: string) => {
  const schema = pgSchema(schemaName);

  const documents = schema.table(
    'documents',
    {
      namespace: text('namespace').notNull(),
      documentKey: text('document_key').notNull(),
      payload: jsonb('payload'),
      encryptedPayload: text('encrypted_payload'),
      encryptionMode: text('encryption_mode'),
      updatedAt: timestamp('updated_at', { withTimezone: true })
        .defaultNow()
        .notNull(),
    },
    (table): PgTableExtraConfigValue[] => [
      primaryKey({
        columns: [table.namespace, table.documentKey],
        name: 'documents_namespace_document_key_pk',
      }),
    ],
  );

  const usageEvents = schema.table(
    'usage_events',
    {
      eventId: text('event_id').primaryKey(),
      occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
      accessKeyId: text('access_key_id'),
      accessKeyName: text('access_key_name'),
      cacheCreationTokens: integer('cache_creation_tokens').notNull(),
      cacheReadTokens: integer('cache_read_tokens').notNull(),
      callCount: integer('call_count').notNull(),
      credentialFilename: text('credential_filename'),
      inputTokens: integer('input_tokens').notNull(),
      model: text('model').notNull(),
      outputTokens: integer('output_tokens').notNull(),
      route: text('route').notNull(),
      totalTokens: integer('total_tokens').notNull(),
    },
    (table): PgTableExtraConfigValue[] => [
      index('usage_events_occurred_at_idx').on(table.occurredAt, table.eventId),
      index('usage_events_credential_occurred_at_idx').on(
        table.credentialFilename,
        table.occurredAt,
        table.eventId,
      ),
      index('usage_events_access_key_occurred_at_idx').on(
        table.accessKeyId,
        table.occurredAt,
        table.eventId,
      ),
    ],
  );

  const debugLogs = schema.table(
    'debug_logs',
    {
      eventId: text('event_id').primaryKey(),
      createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
      credentialFilename: text('credential_filename'),
      elapsedMs: integer('elapsed_ms'),
      error: text('error'),
      model: text('model'),
      requestKey: text('request_key'),
      route: text('route').notNull(),
      requestBody: jsonb('request_body'),
      transformedResponse: jsonb('transformed_response'),
      upstreamRequest: jsonb('upstream_request'),
      upstreamResponse: jsonb('upstream_response'),
      usage: jsonb('usage'),
    },
    (table): PgTableExtraConfigValue[] => [
      index('debug_logs_created_at_idx').on(
        table.createdAt.desc(),
        table.eventId.desc(),
      ),
    ],
  );

  /**
   * One row per conversation. `title` carries prompt content, so it is
   * encrypted column-wise with `encryption_mode` describing how the row was
   * written.
   */
  const sessions = schema.table(
    'sessions',
    {
      sessionId: text('session_id').primaryKey(),
      title: text('title'),
      sourceRoute: text('source_route').notNull(),
      accessKeyId: text('access_key_id'),
      credentialFilename: text('credential_filename'),
      model: text('model'),
      externalRef: text('external_ref'),
      turnCount: integer('turn_count').default(0).notNull(),
      totalTokens: integer('total_tokens').default(0).notNull(),
      startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
      updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
      encryptionMode: text('encryption_mode'),
    },
    (table): PgTableExtraConfigValue[] => [
      index('sessions_updated_at_idx').on(table.updatedAt, table.sessionId),
      index('sessions_access_key_updated_idx').on(
        table.accessKeyId,
        table.updatedAt,
        table.sessionId,
      ),
    ],
  );

  /**
   * One row per turn. The content columns hold ciphertext or a plain JSON
   * string, so they are text rather than jsonb.
   */
  const sessionTurns = schema.table(
    'session_turns',
    {
      turnId: text('turn_id').primaryKey(),
      sessionId: text('session_id').notNull(),
      turnIndex: integer('turn_index').notNull(),
      role: text('role').notNull(),
      contentText: text('content_text'),
      contentRaw: text('content_raw'),
      toolCalls: text('tool_calls'),
      reasoning: text('reasoning'),
      contextJson: text('context_json'),
      usageJson: text('usage_json'),
      model: text('model'),
      route: text('route').notNull(),
      createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
      encryptionMode: text('encryption_mode'),
    },
    (table): PgTableExtraConfigValue[] => [
      uniqueIndex('session_turns_session_idx').on(
        table.sessionId,
        table.turnIndex,
      ),
    ],
  );

  return { debugLogs, documents, schema, sessionTurns, sessions, usageEvents };
};

export const {
  debugLogs: postgresDebugLogs,
  documents: postgresDocuments,
  sessionTurns: postgresSessionTurns,
  sessions: postgresSessions,
  usageEvents: postgresUsageEvents,
} = createPostgresStorageSchema('codebuddy2api');
