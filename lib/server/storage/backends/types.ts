export interface DatabaseDocumentRecord {
  encryptedPayload: string | null;
  encryptionMode: string | null;
  key: string;
  payload: unknown;
}

export interface StorageEvent {
  id: string;
  payload: unknown;
  timestamp: string;
}

export interface SessionListCursor {
  sessionId: string;
  updatedAt: Date;
}

export interface ListSessionRecordsOptions {
  /** Restricts the list to one application. Falsy values list every session. */
  accessKeyId?: string | null;
  /** Keyset cursor pointing at the last row of the previous page. */
  cursor?: SessionListCursor | null;
  limit: number;
}

/**
 * Raw `sessions` row. Timestamps are `Date` because both dialects map their
 * timestamp columns through drizzle; the storage facade converts them to epoch
 * milliseconds.
 */
export interface DatabaseSessionRecord {
  accessKeyId: string | null;
  credentialFilename: string | null;
  /** Describes how `title` was written: null when there is no title. */
  encryptionMode: string | null;
  externalRef: string | null;
  model: string | null;
  sessionId: string;
  sourceRoute: string;
  startedAt: Date;
  title: string | null;
  totalTokens: number;
  turnCount: number;
  updatedAt: Date;
}

/**
 * Raw `session_turns` row. The content columns already hold whatever the
 * storage facade produced (ciphertext or a plain JSON string); the adapter
 * never inspects them.
 */
export interface DatabaseSessionTurnRecord {
  contentRaw: string | null;
  contentText: string | null;
  contextJson: string | null;
  createdAt: Date;
  /** Describes how the content columns of this row were written. */
  encryptionMode: string | null;
  model: string | null;
  reasoning: string | null;
  role: string;
  route: string;
  sessionId: string;
  toolCalls: string | null;
  turnId: string;
  turnIndex: number;
  usageJson: string | null;
}

export interface DatabaseStorageAdapter {
  appendDebugLogs(entries: StorageEvent[]): Promise<void>;
  appendSessionTurns(records: DatabaseSessionTurnRecord[]): Promise<void>;
  appendUsageEvents(entries: StorageEvent[]): Promise<void>;
  clearDebugLogs(): Promise<void>;
  clearSessionRecords(): Promise<void>;
  clearUsageEvents(): Promise<void>;
  deleteDocument(namespace: string, key: string): Promise<void>;
  /** Removes the session row together with every turn that belongs to it. */
  deleteSessionRecord(sessionId: string): Promise<void>;
  ensureSchema(): Promise<void>;
  /**
   * Newest session with the given `external_ref`, scoped to one access key and
   * to rows touched after `updatedAfter`. Drives the sliding-window half of
   * conversation resolution, where a conversation continues only while it stays
   * active.
   */
  findLatestSessionByExternalRef(
    accessKeyId: string | null,
    externalRef: string,
    updatedAfter: Date,
  ): Promise<DatabaseSessionRecord | null>;
  getDocument(
    namespace: string,
    key: string,
  ): Promise<DatabaseDocumentRecord | null>;
  getSessionRecord(sessionId: string): Promise<DatabaseSessionRecord | null>;
  listDocuments(namespace: string): Promise<DatabaseDocumentRecord[]>;
  listDebugLogs(limit: number): Promise<StorageEvent[]>;
  /** Newest first, keyed by `(updated_at, session_id)`. */
  listSessionRecords(
    options: ListSessionRecordsOptions,
  ): Promise<DatabaseSessionRecord[]>;
  /** Oldest first, ordered by `turn_index`. */
  listSessionTurns(sessionId: string): Promise<DatabaseSessionTurnRecord[]>;
  listUsageEvents(since: Date): Promise<StorageEvent[]>;
  putDocument(input: {
    encryptedPayload: string | null;
    encryptionMode: string | null;
    key: string;
    namespace: string;
    payload: unknown;
  }): Promise<void>;
  putSessionRecord(record: DatabaseSessionRecord): Promise<void>;
  trimDebugLogs(maxEntries: number): Promise<void>;
  /** Drops sessions whose `updated_at` is older than the cutoff. */
  trimSessionRecords(before: Date): Promise<void>;
  /** Keeps at most `maxTurns` turns of one session, newest first. */
  trimSessionTurns(sessionId: string, maxTurns: number): Promise<void>;
  trimUsageEvents(before: Date): Promise<void>;
}
