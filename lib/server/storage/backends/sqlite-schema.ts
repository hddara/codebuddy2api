import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const documents = sqliteTable(
  'documents',
  {
    namespace: text('namespace').notNull(),
    documentKey: text('document_key').notNull(),
    payload: text('payload', { mode: 'json' }).$type<unknown>(),
    encryptedPayload: text('encrypted_payload'),
    encryptionMode: text('encryption_mode'),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.namespace, table.documentKey],
      name: 'documents_namespace_document_key_pk',
    }),
  ],
);

export const usageEvents = sqliteTable(
  'usage_events',
  {
    eventId: text('event_id').primaryKey(),
    occurredAt: integer('occurred_at', { mode: 'timestamp_ms' }).notNull(),
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
  (table) => [
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

export const debugLogs = sqliteTable(
  'debug_logs',
  {
    eventId: text('event_id').primaryKey(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    credentialFilename: text('credential_filename'),
    elapsedMs: integer('elapsed_ms'),
    error: text('error'),
    model: text('model'),
    requestKey: text('request_key'),
    route: text('route').notNull(),
    requestBody: text('request_body', { mode: 'json' }).$type<unknown>(),
    transformedResponse: text('transformed_response', {
      mode: 'json',
    }).$type<unknown>(),
    upstreamRequest: text('upstream_request', {
      mode: 'json',
    }).$type<unknown>(),
    upstreamResponse: text('upstream_response', {
      mode: 'json',
    }).$type<unknown>(),
    usage: text('usage', { mode: 'json' }).$type<unknown>(),
  },
  (table) => [
    index('debug_logs_created_at_idx').on(table.createdAt, table.eventId),
  ],
);

/**
 * One row per conversation. Session logging only runs on database backends, so
 * these tables have no file-backend counterpart.
 *
 * `title` carries a truncated copy of the first user message, which is prompt
 * content: it is encrypted column-wise like `session_turns`, with
 * `encryption_mode` recording how this row was written.
 */
export const sessions = sqliteTable(
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
    startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    encryptionMode: text('encryption_mode'),
  },
  (table) => [
    index('sessions_updated_at_idx').on(table.updatedAt, table.sessionId),
    index('sessions_access_key_updated_idx').on(
      table.accessKeyId,
      table.updatedAt,
      table.sessionId,
    ),
  ],
);

/**
 * One row per turn. The content columns hold either AES-256-GCM ciphertext or a
 * plain JSON string, selected by `encryption_mode`; both are opaque to SQL, so
 * they are declared as plain text rather than json columns.
 */
export const sessionTurns = sqliteTable(
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
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    encryptionMode: text('encryption_mode'),
  },
  (table) => [
    uniqueIndex('session_turns_session_idx').on(
      table.sessionId,
      table.turnIndex,
    ),
  ],
);
