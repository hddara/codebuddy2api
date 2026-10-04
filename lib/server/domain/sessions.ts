import { getStorageBackendMeta } from '../storage';
import { listUsageEventsSince, type UsageEventRecord } from './usage';

/**
 * A conversation observed at the gateway, grouped by the upstream
 * `x-conversation-id` header the IDE sends on every chat/responses request.
 *
 * The gateway has always stored that id on each usage event
 * (`usage_events.conversation_id`); this module only folds those raw events into
 * a per-conversation view so the console can answer "which sessions are active
 * right now, and what did they cost?".
 */
export interface SessionSummary {
  accessKeyId: string | null;
  accessKeyName: string | null;
  callCount: number;
  /** Conversation id exactly as the client sent it. */
  conversationId: string;
  credentialFilenames: string[];
  inputTokens: number;
  /** Last event timestamp, ISO 8601. */
  lastActiveAt: string;
  /** First event timestamp, ISO 8601. */
  firstSeenAt: string;
  models: string[];
  outputTokens: number;
  /** Distinct routes the conversation used (`/v1/chat/completions`, ...). */
  routes: string[];
  totalTokens: number;
}

export interface SessionListResponse {
  /** Sessions sorted by `lastActiveAt` descending. */
  sessions: SessionSummary[];
  totals: {
    sessions: number;
    calls: number;
    totalTokens: number;
  };
  /** Echoed window so the UI can render "in the last N minutes". */
  windowMinutes: number;
  /** Events without a conversation id cannot be grouped and are reported here. */
  ungroupedEvents: number;
}

export const DEFAULT_SESSION_WINDOW_MINUTES = 24 * 60;
const MAX_SESSION_WINDOW_MINUTES = 30 * 24 * 60;
const MAX_SESSIONS_RETURNED = 200;

const addUnique = (list: string[], value: string | null): void => {
  if (value && !list.includes(value)) {
    list.push(value);
  }
};

/**
 * Folds usage events into per-conversation summaries.
 *
 * Kept pure so the grouping rules stay unit-testable without touching storage.
 */
export const summarizeSessions = (
  events: UsageEventRecord[],
  { windowMinutes }: { windowMinutes: number },
): SessionListResponse => {
  const cutoffMs = Date.now() - windowMinutes * 60 * 1000;
  const byConversation = new Map<string, SessionSummary>();
  let ungroupedEvents = 0;

  for (const event of events) {
    const conversationId = event.conversationId;

    if (!conversationId) {
      ungroupedEvents += 1;
      continue;
    }

    const eventMs = Date.parse(event.timestamp);

    if (!Number.isFinite(eventMs) || eventMs < cutoffMs) {
      continue;
    }

    const existing = byConversation.get(conversationId);

    if (!existing) {
      byConversation.set(conversationId, {
        accessKeyId: event.accessKeyId,
        accessKeyName: event.accessKeyName,
        callCount: event.callCount,
        conversationId,
        credentialFilenames: event.credentialFilename
          ? [event.credentialFilename]
          : [],
        firstSeenAt: event.timestamp,
        inputTokens: event.inputTokens,
        lastActiveAt: event.timestamp,
        models: [event.model],
        outputTokens: event.outputTokens,
        routes: [event.route],
        totalTokens: event.totalTokens,
      });
      continue;
    }

    existing.callCount += event.callCount;
    existing.inputTokens += event.inputTokens;
    existing.outputTokens += event.outputTokens;
    existing.totalTokens += event.totalTokens;
    addUnique(existing.credentialFilenames, event.credentialFilename);
    addUnique(existing.models, event.model);
    addUnique(existing.routes, event.route);

    if (eventMs < Date.parse(existing.firstSeenAt)) {
      existing.firstSeenAt = event.timestamp;
    }

    if (eventMs > Date.parse(existing.lastActiveAt)) {
      existing.lastActiveAt = event.timestamp;
    }
  }

  const sessions = [...byConversation.values()]
    .sort(
      (left, right) =>
        Date.parse(right.lastActiveAt) - Date.parse(left.lastActiveAt),
    )
    .slice(0, MAX_SESSIONS_RETURNED);

  return {
    sessions,
    totals: {
      calls: sessions.reduce((sum, item) => sum + item.callCount, 0),
      sessions: sessions.length,
      totalTokens: sessions.reduce((sum, item) => sum + item.totalTokens, 0),
    },
    ungroupedEvents,
    windowMinutes,
  };
};

export const normalizeSessionWindowMinutes = (value: unknown): number => {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : Number.NaN;

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_SESSION_WINDOW_MINUTES;
  }

  return Math.min(Math.floor(parsed), MAX_SESSION_WINDOW_MINUTES);
};

export const getSessionSummaries = async ({
  windowMinutes = DEFAULT_SESSION_WINDOW_MINUTES,
}: { windowMinutes?: number } = {}): Promise<SessionListResponse> => {
  const normalizedWindow = normalizeSessionWindowMinutes(windowMinutes);

  // Event storage only exists for database backends; the file backend keeps no
  // usage history to group, so report an empty window instead of failing.
  if (getStorageBackendMeta().backend === 'file') {
    return {
      sessions: [],
      totals: { calls: 0, sessions: 0, totalTokens: 0 },
      ungroupedEvents: 0,
      windowMinutes: normalizedWindow,
    };
  }

  const since = new Date(Date.now() - normalizedWindow * 60 * 1000);
  const events = await listUsageEventsSince(since);

  return summarizeSessions(events, { windowMinutes: normalizedWindow });
};
