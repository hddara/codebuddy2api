import {
  deleteStorageJson,
  getStorageBackendMeta,
  listStorageJson,
  readStorageJson,
  writeStorageJson,
} from '../storage';

/**
 * Human-readable names for conversations.
 *
 * Why this exists: a conversation is only ever identified by the 32-character
 * `x-conversation-id` the IDE sends, so every list of them reads as
 * `31703ad7f0d0…` — technically unique and practically unrecognisable. This
 * module stores one short label per conversation so a reader can tell at a
 * glance which one they want.
 *
 * Two sources, and the distinction matters:
 *
 *  - `truncate` — the question cut to a phrase. Written **first**, so a title
 *    exists the moment a conversation starts. It costs nothing and never fails.
 *  - `ai` — a summarised title, written when the model answers. Replaces
 *    `truncate` (and an earlier `ai`), but never a `manual` one.
 *  - `manual` — the user renamed it. Terminal: nothing overwrites it.
 *
 * The ordering is the point. Waiting for the model would leave the list blank
 * for as long as the call takes (and forever if it fails), so the cheap label
 * lands first and is refined afterwards.
 */

const NAMESPACE = 'session-titles';

/** Titles are a label, not content: keep them short enough to fit one line. */
export const MAX_TITLE_CHARS = 40;

/** How much of the question the fallback label keeps. */
const FALLBACK_TITLE_CHARS = 24;

/** Input to the summariser, so a pasted essay does not become a huge prompt. */
const MAX_SUMMARY_INPUT_CHARS = 500;

export type SessionTitleSource = 'ai' | 'manual' | 'truncate';

export interface SessionTitleRecord {
  conversationId: string;
  createdAt: string;
  source: SessionTitleSource;
  title: string;
  updatedAt: string;
}

export interface SessionTitleStore {
  [conversationId: string]: SessionTitleRecord;
}

interface SessionTitleRuntime {
  /** In-flight generations, so concurrent turns do not each call the model. */
  __codebuddy2apiTitleGenerating__?: Set<string>;
}

const globalState = globalThis as typeof globalThis & SessionTitleRuntime;

const getGenerating = (): Set<string> => {
  globalState.__codebuddy2apiTitleGenerating__ ??= new Set();

  return globalState.__codebuddy2apiTitleGenerating__;
};

/**
 * True when the active backend can list documents in this namespace.
 *
 * Mirrors the transcripts module: the file backend refuses to enumerate any
 * namespace other than `credentials`, so titles degrade to "not stored" there
 * rather than throwing on every request.
 */
const canStoreTitles = (): boolean =>
  getStorageBackendMeta().backend !== 'file';

const collapseWhitespace = (value: string): string =>
  value.replace(/\s+/g, ' ').trim();

/**
 * Strips the wrappers a model adds around a short answer.
 *
 * Asked for a title, models return `"登录问题"`, `标题：登录问题` or a whole
 * sentence. The prompt discourages all three; this makes the result usable when
 * it happens anyway, because a title carrying quotes looks like a defect.
 */
const cleanTitle = (value: string): string => {
  let text = collapseWhitespace(value);

  // A leading label such as `标题：` / `Title:`.
  text = text.replace(/^(?:标题|题目|title)\s*[:：]\s*/i, '');

  // A matching pair of quotes or brackets around the whole answer.
  const pairs: Array<[string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ['“', '”'],
    ['「', '」'],
    ['《', '》'],
    ['【', '】'],
    ['(', ')'],
    ['（', '）'],
  ];

  // Punctuation is stripped before the wrapper, not after.
  //
  // Models are prone to `“标题”。` — the sentence period sits *outside* the
  // quotes, so checking for a closing quote first never matches and the title
  // keeps both. Removing trailing punctuation first exposes the quote pair, and
  // the pair removal then runs on the trimmed text. It repeats because a model
  // can also produce `“标题。”`: stripping the period leaves `“标题”`, which the
  // same pass then unwraps.
  for (let pass = 0; pass < 3; pass += 1) {
    const before = text;

    text = text.replace(/[。.、,，;；!！?？]+$/, '').trim();

    for (const [open, close] of pairs) {
      if (text.startsWith(open) && text.endsWith(close) && text.length > 2) {
        text = text.slice(open.length, -close.length).trim();
        break;
      }
    }

    if (text === before) {
      break;
    }
  }

  return text.slice(0, MAX_TITLE_CHARS);
};

/**
 * Public form of the cleanup, for callers that produce a title outside this
 * module (the model summary) and need to normalise it before storing.
 */
export const cleanTitleForStorage = cleanTitle;

/**
 * The label used before (or instead of) a model summary.
 *
 * Takes the first line only: questions are often "what I want" followed by a
 * pasted stack trace, and the first line is the part that identifies it.
 */
export const buildFallbackTitle = (question: string): string => {
  const firstLine = collapseWhitespace(question.split('\n')[0] ?? '');

  if (!firstLine) {
    return '';
  }

  return firstLine.length > FALLBACK_TITLE_CHARS
    ? `${firstLine.slice(0, FALLBACK_TITLE_CHARS)}…`
    : firstLine;
};

/** The prompt sent to the summariser; exported so tests can assert on it. */
export const buildTitlePrompt = (question: string): string => {
  const trimmed = collapseWhitespace(question).slice(
    0,
    MAX_SUMMARY_INPUT_CHARS,
  );

  return [
    '用不超过 12 个字的短语概括下面这段用户提问的主题，作为会话标题。',
    '只输出标题本身：不要引号、不要标点、不要解释、不要加「标题」二字。',
    '',
    trimmed,
  ].join('\n');
};

const readStore = async (): Promise<SessionTitleStore> => {
  if (!canStoreTitles()) {
    return {};
  }

  return (await readStorageJson<SessionTitleStore>(NAMESPACE, 'store')) ?? {};
};

const writeStore = async (store: SessionTitleStore): Promise<void> => {
  await writeStorageJson(NAMESPACE, 'store', store);
};

/** One conversation's title, or null when it has none yet. */
export const getSessionTitle = async (
  conversationId: string,
): Promise<SessionTitleRecord | null> => {
  if (!conversationId) {
    return null;
  }

  const store = await readStore();

  return store[conversationId] ?? null;
};

/** Every stored title, keyed by conversation id. */
export const listSessionTitles = async (): Promise<SessionTitleStore> =>
  readStore();

/**
 * Writes a title, respecting who owns it.
 *
 * Returns the record now in force, which is **not** always the one passed in:
 * a `manual` title is terminal, so an attempt to overwrite it reports the
 * existing record instead. Callers that only care about the outcome can use the
 * return value and ignore the rest.
 */
export const setSessionTitle = async ({
  conversationId,
  source,
  title,
}: {
  conversationId: string;
  source: SessionTitleSource;
  title: string;
}): Promise<SessionTitleRecord | null> => {
  if (!conversationId || !canStoreTitles()) {
    return null;
  }

  const cleaned = cleanTitle(title);

  if (!cleaned) {
    return null;
  }

  const store = await readStore();
  const existing = store[conversationId];

  // A rename wins over everything, including a later model summary.
  if (existing?.source === 'manual' && source !== 'manual') {
    return existing;
  }

  // Re-running the same generation (a retry, a second turn) must not move
  // `createdAt` or rewrite the document for no reason.
  if (existing && existing.source === source && existing.title === cleaned) {
    return existing;
  }

  const now = new Date().toISOString();
  const record: SessionTitleRecord = {
    conversationId,
    createdAt: existing?.createdAt ?? now,
    source,
    title: cleaned,
    updatedAt: now,
  };

  store[conversationId] = record;
  await writeStore(store);

  return record;
};

/**
 * Records the cheap label, but only when the conversation has no title at all.
 *
 * Deliberately non-destructive: once an `ai` or `manual` title exists, a later
 * turn's fallback must not downgrade it back to a truncated question.
 */
export const ensureFallbackTitle = async ({
  conversationId,
  question,
}: {
  conversationId: string;
  question: string;
}): Promise<SessionTitleRecord | null> => {
  if (!conversationId || !canStoreTitles()) {
    return null;
  }

  const store = await readStore();

  if (store[conversationId]) {
    return store[conversationId] ?? null;
  }

  const fallback = buildFallbackTitle(question);

  if (!fallback) {
    return null;
  }

  const now = new Date().toISOString();
  const record: SessionTitleRecord = {
    conversationId,
    createdAt: now,
    source: 'truncate',
    title: fallback,
    updatedAt: now,
  };

  store[conversationId] = record;
  await writeStore(store);

  return record;
};

/** User rename. Always wins, and marks the record so nothing overwrites it. */
export const renameSession = async ({
  conversationId,
  title,
}: {
  conversationId: string;
  title: string;
}): Promise<SessionTitleRecord | null> =>
  setSessionTitle({ conversationId, source: 'manual', title });

/** True when a model summary should be attempted for this record. */
export const needsAiTitle = (
  record: SessionTitleRecord | null | undefined,
): boolean => !record || record.source === 'truncate';

/**
 * Marks a conversation as "generation in flight".
 *
 * Several turns of one conversation can complete at nearly the same time, and
 * each would otherwise ask the model for the same title.
 */
export const beginTitleGeneration = (conversationId: string): boolean => {
  const generating = getGenerating();

  if (generating.has(conversationId)) {
    return false;
  }

  generating.add(conversationId);

  return true;
};

export const endTitleGeneration = (conversationId: string): void => {
  getGenerating().delete(conversationId);
};

export const clearSessionTitles = async (): Promise<number> => {
  if (!canStoreTitles()) {
    return 0;
  }

  const store = await readStore();
  const count = Object.keys(store).length;

  await deleteStorageJson(NAMESPACE, 'store');

  return count;
};

/** Test/teardown helper. */
export const resetSessionTitleRuntime = (): void => {
  delete globalState.__codebuddy2apiTitleGenerating__;
};

/**
 * Keeps `listStorageJson` referenced: the store is a single document today, but
 * a per-conversation layout would need enumeration and the import is already
 * here to make that switch local.
 */
export const listSessionTitleDocuments = async (): Promise<
  SessionTitleRecord[]
> => {
  if (!canStoreTitles()) {
    return [];
  }

  const documents = await listStorageJson<SessionTitleRecord>(NAMESPACE);

  return documents
    .map((document) => document.value)
    .filter(
      (value): value is SessionTitleRecord =>
        Boolean(value) &&
        typeof value === 'object' &&
        'conversationId' in value,
    );
};
