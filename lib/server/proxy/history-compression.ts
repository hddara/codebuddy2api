/**
 * Shrinks a conversation the upstream would otherwise refuse for size.
 *
 * The gateway aims to dispatch a request body of at most
 * `CODEBUDDY_REQUEST_TARGET_BYTES` (`lib/server/shared/http.ts`), and a long
 * agent session reaches that ceiling long before it reaches the model's context
 * window: every turn resends the whole history plus a full set of tool
 * definitions, and JSON escaping multiplies the text again.
 *
 * Everything here measures **bytes**, not characters, because bytes are what
 * the cap and the socket both measure. A character budget undercounts CJK text
 * and, worse, silently disagreed with the byte cap by roughly 20x: a 400k-char
 * budget is ~5% of an 8 MiB body.
 *
 * Two independent levers live here:
 *
 *  1. `pruneToolDefinitions` drops `tools` when `tool_choice` already forbids
 *     calling them. This is lossless: the model could not have invoked a tool,
 *     so the definitions were pure transport weight.
 *
 *  2. `compressMessages` bounds the history to a byte budget, keeping the
 *     newest turns verbatim and eliding older ones.
 *
 * Compression is on by default. It cannot be optional: the reject cap and the
 * dispatch target are both enforced before the upstream call, so a body that
 * never gets compressed is not "sent as-is", it is refused with a 413. The
 * switch exists to turn it *off* for debugging, not to turn it on.
 * `pruneToolDefinitions` remains bundled with it — it is part of the same
 * decision about what the upstream needs to see.
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
  /** Serialised size before and after, so the win is measurable in the unit
   * that actually matters: the bytes the cap and the socket both count. */
  bytesAfter: number;
  bytesBefore: number;
  /** Images replaced by a placeholder note, and tool results elided. */
  imagesDropped: number;
  toolResultsElided: number;
  /** True when nothing changed and the original array may be reused. */
  unchanged: boolean;
  messages: T[];
}

/**
 * Only tool results are truncated in place. A result is machine output — build
 * logs, file dumps, command transcripts — where the head carries the useful
 * part and the tail often carries the verdict, so both ends survive and the
 * middle is elided. An ordinary message is never rewritten: silently editing
 * what a human or the model said changes the meaning of the conversation.
 */
const TOOL_RESULT_HEAD_CHARS = 2_000;
const TOOL_RESULT_TAIL_CHARS = 500;

/**
 * Placeholder left where a historical image used to be.
 *
 * The note keeps the block's type as `text` so the upstream still sees a
 * well-formed content array. Only the image is rewritten; any prose the turn
 * carried stays readable, which matters because the surrounding text is often
 * what makes the image meaningful ("this screenshot shows the failure").
 */
const OMITTED_IMAGE_TEXT = '[image omitted to fit the request size budget]';

/**
 * Serialised size of a value in bytes, as the wire will carry it.
 *
 * `Buffer.byteLength` rather than `.length`: a UTF-8 code point takes up to
 * three bytes and the cap being defended is a byte cap, so counting characters
 * understates the body for any non-ASCII conversation — CJK text worst of all.
 */
const byteSizeOf = (value: string): number => Buffer.byteLength(value, 'utf8');

/**
 * Bytes a data URL occupies.
 *
 * An image arrives as a base64 data URL, which is roughly 1.33x the binary
 * size, and every turn resends the whole history — so one screenshot taken at
 * turn five is still paying its full cost at turn two hundred. That is the
 * single largest contributor to a session drifting past the body cap.
 */
const readImageBytes = (part: unknown): number => {
  if (!part || typeof part !== 'object') {
    return 0;
  }

  const url = (part as { image_url?: unknown }).image_url;

  if (typeof url === 'string') {
    return Buffer.byteLength(url, 'utf8');
  }

  if (url && typeof url === 'object') {
    const nested = (url as { url?: unknown }).url;

    return typeof nested === 'string' ? Buffer.byteLength(nested, 'utf8') : 0;
  }

  return 0;
};

const readBooleanEnv = (name: string, fallback = false): boolean => {
  const raw = (process.env[name] ?? '').trim().toLowerCase();

  if (!raw) {
    return fallback;
  }

  if (['0', 'false', 'no', 'off'].includes(raw)) {
    return false;
  }

  return ['1', 'true', 'yes', 'on'].includes(raw);
};

/**
 * Reads the compression switch, on unless explicitly turned off.
 *
 * Default-on is not a preference, it is forced by the order of the pipeline:
 * the reject cap is applied when the body is read, long before this runs, so a
 * body that is not compressed is not "sent as-is" — it is refused. Measured
 * against production, leaving this off is what made every large session end in
 * a 413.
 *
 * A plain environment read, matching `isHarnessIdentityRewriteEnabled`: this
 * decides what reaches the upstream, so it has to be visible in the deployment
 * definition and revocable by editing that definition alone.
 */
export const isHistoryCompressionEnabled = (): boolean =>
  readBooleanEnv('CODEBUDDY_COMPRESS_HISTORY', true);

/**
 * Bytes the conversation occupies in the body that will be serialised.
 *
 * Exported so the caller can subtract it from the whole-body size and work out
 * how much of the budget the tool definitions, the system prompt and the other
 * fields are already spending. Without that split a target expressed in body
 * bytes cannot be turned into a message budget at all.
 */
export const measureMessagesBytes = (
  messages: readonly CompressibleMessage[],
): number =>
  messages.reduce((total, message) => total + readMessageBytes(message), 0);

/**
 * Bytes the images inside the conversation occupy.
 *
 * Split out from `measureMessagesBytes` because the two answer different
 * questions. The total says whether a request will fit; this says *why* it does
 * not, and image bytes are the answer often enough to be worth naming. A
 * session carrying four screenshots is almost entirely image, and no amount of
 * eliding tool results will bring it under a target sized for text.
 */
export const measureImageBytes = (
  messages: readonly CompressibleMessage[],
): number => {
  let total = 0;

  for (const message of messages) {
    const { content } = message;

    if (!Array.isArray(content)) {
      continue;
    }

    for (const part of content) {
      total += readImageBytes(part);
    }
  }

  return total;
};

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

/**
 * Bytes one message is responsible for.
 *
 * Three things this counts that a walk over `content` alone misses:
 *
 *  - **tool call arguments.** An assistant turn that wrote a file carries the
 *    whole file in `tool_calls[].function.arguments`. Measured on a real
 *    session this was 100% invisible to the old counter: 300 KB of arguments
 *    registered as 2 characters, so a conversation built entirely out of file
 *    writes could sit at the body cap while reporting almost nothing.
 *  - **images**, at their base64 length.
 *  - **UTF-8 width**, so non-ASCII text is not understated by the factor of
 *    three that the cap sees.
 *
 * Measured field by field rather than by stringifying the whole message: the
 * content string can be megabytes, and paying a second copy of it just to
 * measure would recreate the memory spike this module exists to prevent.
 */
const readMessageBytes = (message: CompressibleMessage): number => {
  let total = readContentBytes(message);

  const { tool_calls: toolCalls } = message;

  if (Array.isArray(toolCalls)) {
    for (const call of toolCalls) {
      if (!call || typeof call !== 'object') {
        continue;
      }

      const fn = (call as { function?: unknown }).function;

      if (!fn || typeof fn !== 'object') {
        continue;
      }

      const { arguments: rawArgs, name } = fn as {
        arguments?: unknown;
        name?: unknown;
      };

      if (typeof rawArgs === 'string') {
        total += byteSizeOf(rawArgs);
      }

      if (typeof name === 'string') {
        total += byteSizeOf(name);
      }
    }
  }

  // Role and tool_call_id are deliberately not counted. They are a few dozen
  // bytes of envelope already attributed to the whole-body overhead by the
  // caller, and counting them here would let a stub that is longer than an
  // empty original appear to have grown the conversation.
  return total;
};

/** Bytes inside `content`, whether it is a plain string or a block array. */
const readContentBytes = (message: CompressibleMessage): number => {
  const { content } = message;

  if (typeof content === 'string') {
    return byteSizeOf(content);
  }

  if (!Array.isArray(content)) {
    return 0;
  }

  let total = 0;

  for (const part of content) {
    if (!part || typeof part !== 'object') {
      continue;
    }

    const text = (part as { text?: unknown }).text;

    if (typeof text === 'string') {
      total += byteSizeOf(text);
    }

    // An image is measured too: it is usually the largest thing in the
    // message, so a budget that ignored it could never see the overflow.
    total += readImageBytes(part);
  }

  return total;
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

/**
 * Replaces every image in a message with a one-line note.
 *
 * The note keeps the block's type as `text` so the upstream still sees a
 * well-formed content array. Only the image is rewritten; any prose the turn
 * carried stays readable, which matters because the surrounding text is often
 * what makes the image meaningful ("this screenshot shows the failure").
 */
const dropImages = (message: CompressibleMessage): CompressibleMessage => {
  const { content } = message;

  if (!Array.isArray(content)) {
    return message;
  }

  let touched = false;

  const next = content.map((part) => {
    if (readImageBytes(part) === 0) {
      return part;
    }

    touched = true;

    return { text: OMITTED_IMAGE_TEXT, type: 'text' };
  });

  return touched ? { ...message, content: next } : message;
};

/**
 * Elides the arguments of every tool call in an assistant turn.
 *
 * This is the counterpart to `truncateToolResult`, and it exists because
 * arguments were the blind spot that made the whole budget unreliable: a turn
 * that writes a file carries the entire file inside
 * `tool_calls[].function.arguments`. Measured on a real session, 100 turns of
 * 80 KB writes produced a 7.8 MB body while the request's own size counter
 * reported 1,390 characters — the conversation was at the cap and nothing in
 * the log said so.
 *
 * Only the `arguments` string is shortened. The call `id`, the `name` and the
 * `type` are untouched, so the pairing with the matching `tool` result stays
 * exactly as the upstream validated it — this is why arguments are elided here
 * rather than removed by `createStub`.
 */
const truncateToolCallArguments = (
  message: CompressibleMessage,
): CompressibleMessage => {
  const { tool_calls: toolCalls } = message;

  if (!Array.isArray(toolCalls) || !toolCalls.length) {
    return message;
  }

  let touched = false;

  const next = toolCalls.map((call) => {
    if (touched || !call || typeof call !== 'object') {
      return call;
    }

    const callRecord = call as { function?: unknown };
    const fn = callRecord.function;

    if (!fn || typeof fn !== 'object') {
      return call;
    }

    const fnRecord = fn as { arguments?: unknown; name?: unknown };

    if (typeof fnRecord.arguments !== 'string') {
      return call;
    }

    if (fnRecord.arguments.length <= TOOL_RESULT_HEAD_CHARS) {
      return call;
    }

    touched = true;

    return {
      ...callRecord,
      function: { ...fnRecord, arguments: elide(fnRecord.arguments) },
    };
  });

  return touched ? { ...message, tool_calls: next } : message;
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
/**
 * Groups the messages that have to move together, and the one that cannot move.
 *
 * Two different kinds of "do not touch" are at play, and conflating them is
 * what made this feature inert:
 *
 *  - **The last user turn** must not be rewritten at all. It is the question.
 *  - **An `assistant` turn with `tool_calls` and its `tool` results** must not
 *    be *stubbed* independently, because the upstream validates the pairing. But
 *    they can still be *elided* — shortening arguments or result text leaves
 *    both halves present and correctly paired.
 *
 * The earlier version put every tool group in a single `pinned` set that both
 * the eliding and the stubbing stages respected. Since a long agent session is
 * almost entirely tool groups, that protected the whole transcript: production
 * logged `replacedCount: 0` on 475-message requests that were 300 KB over
 * budget, with nothing but image drops having any effect.
 */
const findPinnedIndexes = (
  messages: CompressibleMessage[],
): { lastUserIndex: number; groupOf: Map<number, number[]> } => {
  const groupOf = new Map<number, number[]>();
  let lastUserIndex = -1;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      lastUserIndex = index;
      break;
    }
  }

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
    if (callerIndex >= 0) {
      group.push(callerIndex);
      group.forEach((member) => groupOf.set(member, group));
    }

    index = cursor === index ? index - 1 : cursor;
  }

  return { lastUserIndex, groupOf };
};

/**
 * Bounds the conversation to `budgetBytes`, keeping the newest turns verbatim.
 *
 * Four stages, ordered by how little meaning each one destroys. Every stage is
 * skipped once the running total is under budget, so a conversation that only
 * needs the cheapest fix never pays for the expensive ones:
 *
 *  1. historical images → a placeholder note (`imagesDropped`);
 *  2. `tool` results → head + tail with the middle elided;
 *  3. `tool_calls[].function.arguments` → the same treatment, which is what
 *     makes a write-heavy session shrink at all;
 *  4. whole messages → a one-line stub, oldest first.
 *
 * Stages 1–3 rewrite *inside* a message and so preserve every pairing; only
 * stage 4 removes structure, and it does so per group from
 * `findPinnedIndexes` so an `assistant` call and its results disappear
 * together.
 */
export const compressMessages = <T extends CompressibleMessage>(
  messages: T[],
  options: { budgetBytes: number },
): MessageCompressionResult<T> => {
  const budgetBytes = options.budgetBytes;
  const bytesBefore = messages.reduce(
    (total, message) => total + readMessageBytes(message),
    0,
  );

  if (bytesBefore <= budgetBytes) {
    return {
      bytesAfter: bytesBefore,
      bytesBefore,
      imagesDropped: 0,
      keptCount: messages.length,
      messages,
      replacedCount: 0,
      toolResultsElided: 0,
      unchanged: true,
    };
  }

  const { groupOf, lastUserIndex } = findPinnedIndexes(messages);
  const next: CompressibleMessage[] = messages.slice();

  let imagesDropped = 0;
  let toolResultsElided = 0;
  let running = 0;
  let bytesAfterElision = bytesBefore;

  /**
   * Applies one rewrite and books the win, so the loop exits as soon as the
   * conversation fits instead of always paying full price.
   */
  const applyRewrite = (
    index: number,
    rewrite: (message: CompressibleMessage) => CompressibleMessage,
  ): boolean => {
    const message = next[index];

    if (!message) {
      return false;
    }

    const before = readMessageBytes(message);
    const rewritten = rewrite(message);
    const after = readMessageBytes(rewritten);

    if (after >= before) {
      return false;
    }

    next[index] = rewritten;
    running += before - after;
    bytesAfterElision -= before - after;

    return true;
  };

  // Stage 1 — images. A single base64 screenshot can outweigh an entire
  // transcript, so the historical ones are the cheapest large win, and unlike
  // eliding text it loses nothing the model cannot ask to see again. The last
  // user turn is exempt: its image may be the question itself.
  for (let index = 0; index < next.length; index += 1) {
    if (bytesAfterElision <= budgetBytes) {
      break;
    }

    if (index === lastUserIndex) {
      continue;
    }

    if (applyRewrite(index, dropImages)) {
      imagesDropped += 1;
    }
  }

  // Stage 2 — tool results. Machine output whose head says what it did and
  // whose tail holds the verdict; the middle is what nobody reads.
  for (let index = 0; index < next.length; index += 1) {
    if (bytesAfterElision <= budgetBytes) {
      break;
    }

    if (next[index]?.role !== 'tool') {
      continue;
    }

    if (applyRewrite(index, truncateToolResult)) {
      toolResultsElided += 1;
    }
  }

  // Stage 3 — tool call arguments. This is the stage that makes a session
  // that writes files shrink: the old code never touched arguments, which is
  // why production logged `replacedCount: 0` on requests that were still
  // hundreds of kilobytes over budget.
  for (let index = 0; index < next.length; index += 1) {
    if (bytesAfterElision <= budgetBytes) {
      break;
    }

    if (applyRewrite(index, truncateToolCallArguments)) {
      toolResultsElided += 1;
    }
  }

  if (bytesAfterElision <= budgetBytes) {
    return {
      bytesAfter: bytesAfterElision,
      bytesBefore,
      imagesDropped,
      keptCount: messages.length,
      messages: running === 0 ? messages : (next as T[]),
      replacedCount: 0,
      toolResultsElided,
      unchanged: running === 0,
    };
  }

  // Stage 4 — still over: stub whole messages, oldest first, until it fits.
  // A message is stubbed either on its own or as its whole tool group, never
  // as half of one: an `assistant` turn carrying `tool_calls` with its results
  // missing is a hard 400 from the upstream.
  let replacedCount = 0;
  const stubbed = new Set<number>();

  for (let index = 0; index < next.length; index += 1) {
    if (bytesAfterElision <= budgetBytes) {
      break;
    }

    if (stubbed.has(index) || index === lastUserIndex) {
      continue;
    }

    const group = groupOf.get(index) ?? [index];

    // Skip a group that holds the last user turn or a message already stubbed.
    if (
      group.some((member) => member === lastUserIndex || stubbed.has(member))
    ) {
      continue;
    }

    let reclaimed = 0;

    for (const member of group) {
      const target = next[member];

      if (!target) {
        continue;
      }

      const before = readMessageBytes(target);

      if (before === 0) {
        continue;
      }

      next[member] = createStub(target) as CompressibleMessage;
      stubbed.add(member);
      reclaimed += before;
    }

    if (reclaimed === 0) {
      continue;
    }

    bytesAfterElision -= reclaimed;
    replacedCount += group.length;
  }

  const bytesAfter = next.reduce(
    (total, message) => total + readMessageBytes(message),
    0,
  );

  return {
    bytesAfter,
    bytesBefore,
    imagesDropped,
    keptCount: messages.length - replacedCount,
    messages: next as T[],
    replacedCount,
    toolResultsElided,
    unchanged: replacedCount === 0 && running === 0,
  };
};
