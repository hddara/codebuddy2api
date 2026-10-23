/**
 * Detects tool-call markup that leaked into assistant prose.
 *
 * The upstream model sometimes emits its tool-call syntax as plain text instead
 * of populating `tool_calls`. DeepSeek spells it with DSML, whose tags are
 * delimited by the `<|` and `|>` tokens the tokenizer reserves:
 *
 *     <|DSML|invoke name="read_file">
 *       <|DSML|parameter name="path">src/index.ts</|DSML|parameter>
 *     </|DSML|invoke>
 *
 * Nothing goes wrong on this side — the bytes are forwarded verbatim — but the
 * caller receives a turn that looks like an answer and silently does nothing.
 * The failure is invisible in every metric the gateway keeps: the status is
 * 200, the finish_reason is `stop`, and the byte count is ordinary.
 *
 * Two consequences drive the design here:
 *
 *  1. A caller needs to be told. `findToolCallLeak` finds the marker so a log
 *     line can name it, which is the difference between "the model replied
 *     nothing useful" and "the model lost its tool call".
 *
 *  2. The marker is easy to mangle. A client that strips `<|`/`|>` leaves
 *     `</ || DSML || invoke>`, so the pattern has to survive the delimiters
 *     being emptied, spaced or turned into pipes — matching only the pristine
 *     form would miss exactly the cases users report.
 *
 * Detection is read-only. This module never rewrites a response: the model's
 * text is what it is, and quietly editing it would hide the problem instead of
 * surfacing it.
 */

/** Markers that only appear when tool-call syntax escaped into prose. */
const LEAK_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  // Pristine DSML, as the model emits it.
  { label: 'dsml', pattern: /<\|\s*DSML\s*\|/i },
  // Every byte between `<` and the tag name is a delimiter a client may have
  // blanked. `</ || DSML || invoke>` keeps only spaces and pipes, while a
  // stricter sanitiser could leave `<  DSML  invoke >`; matching the whole run
  // of punctuation and whitespace covers each rendering without loosening the
  // rule enough to match ordinary prose.
  { label: 'dsml-mangled', pattern: /<[\s/|]+DSML/i },
  // The tag name itself, in case the opening `<` was consumed as HTML.
  {
    label: 'dsml-tag',
    pattern: /<\s*\/?\s*\|?\s*DSML\s*\|?\s*(invoke|calls|parameter)/i,
  },
];

export interface ToolCallLeak {
  /** Which marker matched, for the log line. */
  marker: string;
  /** Offset of the match, so a sample can be cut around it. */
  offset: number;
  /** A short excerpt centred on the marker, safe to log. */
  sample: string;
}

const SAMPLE_RADIUS = 80;

/**
 * Returns the first piece of leaked tool-call markup in `text`, or `null`.
 *
 * Only assistant prose is worth scanning: a user can legitimately paste this
 * syntax while debugging, and a tool result can contain it as data.
 */
export const findToolCallLeak = (text: unknown): ToolCallLeak | null => {
  if (typeof text !== 'string' || !text) {
    return null;
  }

  let best: ToolCallLeak | null = null;

  for (const { label, pattern } of LEAK_PATTERNS) {
    const match = pattern.exec(text);

    if (!match) {
      continue;
    }

    if (best && match.index >= best.offset) {
      continue;
    }

    best = {
      marker: label,
      offset: match.index,
      sample: text.slice(
        Math.max(0, match.index - SAMPLE_RADIUS),
        match.index + SAMPLE_RADIUS,
      ),
    };
  }

  return best;
};

/** Reads the text of a message whose content may be a string or blocks. */
const readContentText = (content: unknown): string => {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((part) => {
      if (!part || typeof part !== 'object') {
        return '';
      }

      const text = (part as { text?: unknown }).text;

      return typeof text === 'string' ? text : '';
    })
    .join('\n');
};

/**
 * Scans one assistant turn for leaked tool-call markup.
 *
 * A turn that actually populated `tool_calls` is skipped: some models duplicate
 * their reasoning about a call into content, and that is not a failure. The
 * interesting case is a call-shaped turn with no `tool_calls` at all.
 */
export const inspectAssistantTurn = (message: {
  content?: unknown;
  role?: string;
  tool_calls?: unknown[];
}): ToolCallLeak | null => {
  if (message.role !== 'assistant') {
    return null;
  }

  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    return null;
  }

  return findToolCallLeak(readContentText(message.content));
};
