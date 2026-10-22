/**
 * Shrinks a conversation the upstream would otherwise refuse for size.
 *
 * The gateway caps a request body at 8 MiB (`lib/server/shared/http.ts`), and a
 * long agent session reaches that ceiling long before it reaches the model's
 * context window: every turn resends the whole history plus a full set of tool
 * definitions, and JSON escaping multiplies the text again. The cap is there to
 * protect the heap, so it cannot simply be raised.
 *
 * Two independent levers live here:
 *
 *  1. `pruneToolDefinitions` drops `tools` when `tool_choice` already forbids
 *     calling them. This is lossless: the model could not have invoked a tool,
 *     so the definitions were pure transport weight.
 *
 *  2. `compressMessages` bounds the history to a character budget, keeping the
 *     newest turns verbatim and replacing the older ones with a short summary
 *     stub.
 *
 * Both are opt-in and off by default. They change what is sent upstream, which
 * is the operator's call, not a default this gateway should make — the same
 * reasoning that governs `harness-identity.ts`.
 *
 * Invariants that must never be broken, because each one turns a size problem
 * into a hard upstream 400:
 *  - an `assistant` message carrying `tool_calls` is kept whenever any of its
 *    `tool` results is kept, and vice versa;
 *  - the last user turn is never dropped, since it is the actual question;
 *  - a message is only ever replaced by a stub of the same role, so the
 *    alternation the upstream expects is preserved;
 *  - anything unexpected returns the input untouched.
 */

/** Shape this module reads; mirrors `OpenAIMessage` in `codebuddy.ts`. */
export interface CompressibleMessage {
  content?: unknown;
  role?: string;
  tool_call_id?: string;
  tool_calls?: unknown[];
}

/** What `compressMessages` did, for the caller's log line. */
export interface MessageCompressionResult<T> {
  /** Messages kept verbatim at the tail of the conversation. */
  keptCount: number;
  /** Messages replaced by a stub. */
  replacedCount: number;
  /** Text characters before and after, so the win is measurable. */
  charsAfter: number;
  charsBefore: number;
  /** True when nothing changed and the original array may be reused. */
  unchanged: boolean;
  messages: T[];
}

const DEFAULT_HISTORY_BUDGET_CHARS = 400_000;

/**
 * Only tool results are truncated in place. A result is machine output — build
 * logs, file dumps, command transcripts — where the head carries the useful
 * part and the tail often carries the verdict, so both ends survive and the
 * middle is elided. An ordinary message is never rewritten: silently editing
 * what a human or the model said changes the meaning of the conversation.
 */
const TOOL_RESULT_HEAD_CHARS = 2_000;
const TOOL_RESULT_TAIL_CHARS = 500;

const readBooleanEnv = (name: string): boolean =>
  ['1', 'true', 'yes', 'on'].includes(
    (process.env[name] ?? '').trim().toLowerCase(),
  );

const readPositiveIntEnv = (name: string, fallback: number): number => {
  const raw = (process.env[name] ?? '').trim();

  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * Reads the opt-in switch.
 *
 * A plain environment read, matching `isHarnessIdentityRewriteEnabled`: this
 * decides what reaches the upstream, so it has to be visible in the deployment
 * definition and revocable by editing that definition alone.
 */
export const isHistoryCompressionEnabled = (): boolean =>
  readBooleanEnv('CODEBUDDY_COMPRESS_HISTORY');

/**
 * Character budget for the conversation history.
 *
 * Characters, not bytes, because that is what the request carries: the byte
 * count after JSON escaping is what the 8 MiB cap measures, and a char budget
 * leaves headroom for the tool schema and the escaping overhead on top.
 */
export const getHistoryBudgetChars = (): number =>
  readPositiveIntEnv(
    'CODEBUDDY_HISTORY_BUDGET_CHARS',
    DEFAULT_HISTORY_BUDGET_CHARS,
  );

/** True when the caller has told the upstream not to call any tool. */
const forbidsToolUse = (toolChoice: unknown): boolean => {
  if (toolChoice === 'none') {
    return true;
  }

  // Some clients model the same thing as `{ type: 'none' }`.
  if (toolChoice && typeof toolChoice === 'object') {
    return (toolChoice as { type?: unknown }).type === 'none';
  }

  return false;
};

/**
 * Drops tool definitions that `tool_choice` makes unreachable.
 *
 * Returns `undefined` when the definitions are still live, so the caller can
 * spread the result without a conditional.
 */
export const pruneToolDefinitions = (
  tools: unknown[] | undefined,
  toolChoice: unknown,
): unknown[] | undefined => {
  if (!Array.isArray(tools) || !tools.length) {
    return tools;
  }

  return forbidsToolUse(toolChoice) ? undefined : tools;
};

/** Reads the text of one message, whether content is a string or blocks. */
const readMessageChars = (message: CompressibleMessage): number => {
  const { content } = message;

  if (typeof content === 'string') {
    return content.length;
  }

  if (!Array.isArray(content)) {
    return 0;
  }

  return content.reduce((total, part) => {
    if (!part || typeof part !== 'object') {
      return total;
    }

    const text = (part as { text?: unknown }).text;

    return total + (typeof text === 'string' ? text.length : 0);
  }, 0);
};

/**
 * Elides the middle of a long tool result, keeping both ends.
 *
 * The head is where a command states what it is about to do and a file starts;
 * the tail is where an error summary or exit status lands. Only text parts are
 * touched, and only the first oversized one, so a message keeps its structure.
 */
const truncateToolResult = (
  message: CompressibleMessage,
): CompressibleMessage => {
  const { content } = message;

  if (typeof content !== 'string') {
    if (!Array.isArray(content)) {
      return message;
    }

    let touched = false;

    const next = content.map((part) => {
      if (touched || !part || typeof part !== 'object') {
        return part;
      }

      const text = (part as { text?: unknown }).text;

      if (typeof text !== 'string' || text.length <= TOOL_RESULT_HEAD_CHARS) {
        return part;
      }

      touched = true;

      return { ...part, text: elide(text) };
    });

    return touched ? { ...message, content: next } : message;
  }

  if (content.length <= TOOL_RESULT_HEAD_CHARS) {
    return message;
  }

  return { ...message, content: elide(content) };
};

const elide = (text: string): string => {
  const tail = text.slice(-TOOL_RESULT_TAIL_CHARS);
  const omitted = text.length - TOOL_RESULT_HEAD_CHARS - TOOL_RESULT_TAIL_CHARS;

  return (
    text.slice(0, TOOL_RESULT_HEAD_CHARS) +
    `\n\n…[${omitted} characters omitted]…\n\n` +
    tail
  );
};

/**
 * Replaces one message with a same-role stub.
 *
 * The role is preserved deliberately: dropping a message outright would change
 * the user/assistant alternation the upstream validates. A message whose
 * content arrived as blocks keeps that shape — some clients only parse one
 * form, and the stub carries no meaning beyond "something was here".
 */
const createStub = (message: CompressibleMessage): CompressibleMessage => {
  const note =
    message.role === 'tool'
      ? '[earlier tool result omitted to fit the request size budget]'
      : '[earlier conversation omitted to fit the request size budget]';

  // A tool result cannot become prose — it answers a `tool_call_id` — so its
  // stub keeps the id and only shortens the payload.
  return {
    ...message,
    content: Array.isArray(message.content)
      ? [{ text: note, type: 'text' }]
      : note,
  };
};

/** Indexes of the messages that cannot be removed without breaking the call. */
const findPinnedIndexes = (
  messages: CompressibleMessage[],
): { lastUserIndex: number; pinned: Set<number> } => {
  const pinned = new Set<number>();

  let lastUserIndex = -1;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      lastUserIndex = index;
      break;
    }
  }

  if (lastUserIndex >= 0) {
    // The final user turn is the question being asked; it stays verbatim even
    // if it alone exceeds the budget.
    pinned.add(lastUserIndex);
  }

  // An assistant `tool_calls` turn and its `tool` results form one unit. Keep
  // each unit or drop each unit — never half of it.
  let index = messages.length - 1;

  while (index >= 0) {
    if (messages[index]?.role !== 'tool') {
      index -= 1;
      continue;
    }

    const group: number[] = [];
    let cursor = index;

    while (cursor >= 0 && messages[cursor]?.role === 'tool') {
      group.push(cursor);
      cursor -= 1;
    }

    const callerIndex =
      cursor >= 0 && messages[cursor]?.role === 'assistant' ? cursor : -1;

    // A tool result with no caller is already malformed; leave it alone rather
    // than "fixing" it into something the upstream accepts differently.
    if (callerIndex < 0) {
      index = cursor;
      continue;
    }

    group.push(callerIndex);
    group.forEach((groupIndex) => pinned.add(groupIndex));
    index = cursor - 1;
  }

  return { lastUserIndex, pinned };
};

/**
 * Bounds the conversation to `budgetChars`, keeping the newest turns verbatim.
 *
 * Walks backwards so the tail — the live context — is measured first, then
 * stubs whatever falls outside the budget. Messages pinned by
 * `findPinnedIndexes` are never stubbed, and a stubbed assistant turn takes its
 * tool results with it so the pairing survives.
 */
export const compressMessages = <T extends CompressibleMessage>(
  messages: T[],
  options: { budgetChars?: number } = {},
): MessageCompressionResult<T> => {
  const budgetChars = options.budgetChars ?? getHistoryBudgetChars();
  const charsBefore = messages.reduce(
    (total, message) => total + readMessageChars(message),
    0,
  );

  if (charsBefore <= budgetChars) {
    return {
      keptCount: messages.length,
      replacedCount: 0,
      charsAfter: charsBefore,
      charsBefore,
      unchanged: true,
      messages,
    };
  }

  const { pinned } = findPinnedIndexes(messages);
  const next: CompressibleMessage[] = messages.slice();

  // Tool results are elided in place first: it recovers the most size for the
  // least semantic damage, and often brings the conversation back under budget
  // without touching the transcript at all.
  let running = 0;

  for (let index = 0; index < next.length; index += 1) {
    const message = next[index];

    if (!message || message.role !== 'tool') {
      continue;
    }

    const before = readMessageChars(message);
    const truncated = truncateToolResult(message);
    const after = readMessageChars(truncated);

    if (after < before) {
      next[index] = { ...truncated } as CompressibleMessage;
      running += before - after;
    }
  }

  if (running === 0 && charsBefore > budgetChars) {
    // Nothing shrinkable in the tool results; fall through to stubbing.
    running = 0;
  }

  const target = budgetChars;
  let charsAfterElision = charsBefore - running;

  if (charsAfterElision <= target) {
    return {
      keptCount: messages.length,
      replacedCount: 0,
      charsAfter: charsAfterElision,
      charsBefore,
      unchanged: running === 0,
      messages: running === 0 ? messages : (next as T[]),
    };
  }

  // Still over: stub the oldest messages one at a time until the budget fits.
  let replacedCount = 0;

  for (let index = 0; index < next.length; index += 1) {
    if (charsAfterElision <= target) {
      break;
    }

    const message = next[index];

    if (!message || pinned.has(index)) {
      continue;
    }

    const before = readMessageChars(message);

    if (before === 0) {
      continue;
    }

    next[index] = createStub(message) as CompressibleMessage;
    charsAfterElision -= before;
    replacedCount += 1;
  }

  const charsAfter = next.reduce(
    (total, message) => total + readMessageChars(message),
    0,
  );

  return {
    keptCount: messages.length - replacedCount,
    replacedCount,
    charsAfter,
    charsBefore,
    unchanged: replacedCount === 0 && running === 0,
    messages: next as T[],
  };
};
