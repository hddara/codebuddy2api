import {
  compressMessages,
  isHistoryCompressionEnabled,
  pruneToolDefinitions,
  type CompressibleMessage,
} from '@/lib/server/proxy/history-compression';

const message = (
  role: string,
  content: unknown,
  extra: Partial<CompressibleMessage> = {},
): CompressibleMessage => ({
  content,
  role,
  ...extra,
});

describe('history compression switches', () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
  });

  it('is on by default', () => {
    delete process.env.CODEBUDDY_COMPRESS_HISTORY;

    // Compression cannot be opt-in: the reject cap fires before an
    // uncompressed body could ever be dispatched, so "off" means every
    // oversized request is refused rather than sent.
    expect(isHistoryCompressionEnabled()).toBe(true);
  });

  it('can be switched off for debugging', () => {
    for (const value of ['0', 'false', 'no', 'off']) {
      process.env.CODEBUDDY_COMPRESS_HISTORY = value;

      expect(isHistoryCompressionEnabled()).toBe(false);
    }
  });

  it('accepts the documented truthy spellings', () => {
    for (const value of ['1', 'true', 'YES', 'On']) {
      process.env.CODEBUDDY_COMPRESS_HISTORY = value;

      expect(isHistoryCompressionEnabled()).toBe(true);
    }
  });

  it('ignores a switch value that is not on the list', () => {
    process.env.CODEBUDDY_COMPRESS_HISTORY = 'maybe';

    expect(isHistoryCompressionEnabled()).toBe(false);
  });
});

describe('pruneToolDefinitions', () => {
  const tools = [{ function: { name: 'read' }, type: 'function' }];

  it('drops the definitions when tool_choice forbids every tool', () => {
    expect(pruneToolDefinitions(tools, 'none')).toBeUndefined();
    expect(pruneToolDefinitions(tools, { type: 'none' })).toBeUndefined();
  });

  it('keeps the definitions while a tool can still be called', () => {
    for (const choice of [undefined, 'auto', 'required', { type: 'auto' }]) {
      expect(pruneToolDefinitions(tools, choice)).toEqual(tools);
    }
  });

  it('passes an absent or empty tool list straight through', () => {
    expect(pruneToolDefinitions(undefined, 'none')).toBeUndefined();
    expect(pruneToolDefinitions([], 'none')).toEqual([]);
  });
});

describe('compressMessages', () => {
  it('returns the input untouched when it already fits', () => {
    const messages = [message('user', 'hello'), message('assistant', 'hi')];
    const result = compressMessages(messages, { budgetBytes: 1_000 });

    expect(result.unchanged).toBe(true);
    expect(result.messages).toBe(messages);
    expect(result.bytesAfter).toBe(result.bytesBefore);
  });

  it('elides the middle of a long tool result before stubbing anything', () => {
    const long = 'A'.repeat(10_000);
    const messages = [
      message('tool', long, { tool_call_id: 'call-1' }),
      message('user', 'what happened?'),
    ];

    const result = compressMessages(messages, { budgetBytes: 5_000 });

    expect(result.replacedCount).toBe(0);
    expect(result.bytesAfter).toBeLessThan(result.bytesBefore);

    const shortened = result.messages[0]?.content as string;

    // Both ends survive: the head states what ran, the tail carries the verdict.
    expect(shortened.startsWith('A'.repeat(2_000))).toBe(true);
    expect(shortened.endsWith('A'.repeat(500))).toBe(true);
    expect(shortened).toContain('characters omitted');
  });

  it('stubs old turns and keeps the newest ones verbatim', () => {
    const messages = [
      message('system', 'S'.repeat(5_000)),
      message('user', 'U'.repeat(5_000)),
      message('assistant', 'A'.repeat(5_000)),
      message('user', 'the actual question'),
    ];

    const result = compressMessages(messages, { budgetBytes: 2_000 });

    expect(result.replacedCount).toBeGreaterThan(0);
    expect(result.bytesAfter).toBeLessThan(result.bytesBefore);
    expect(result.messages.at(-1)).toEqual(messages.at(-1));
  });

  it('never removes the last user turn even when it alone exceeds the budget', () => {
    const question = message('user', 'Q'.repeat(20_000));
    const messages = [message('user', 'old'), question];

    const result = compressMessages(messages, { budgetBytes: 100 });

    expect(result.messages.at(-1)).toEqual(question);
    expect(result.bytesAfter).toBeGreaterThanOrEqual(20_000);
  });

  it('keeps an assistant tool_calls turn together with its tool results', () => {
    const messages = [
      message('user', 'old question'),
      message('assistant', '', { tool_calls: [{ id: 'call-1' }] }),
      message('tool', 'T'.repeat(3_000), { tool_call_id: 'call-1' }),
      message('assistant', 'answer'),
      message('user', 'follow up'),
    ];

    const result = compressMessages(messages, { budgetBytes: 2_500 });

    const roles = result.messages.map((item) => item.role);
    const callerIndex = roles.indexOf('assistant');

    // The caller and its result are stubbed or kept as one unit, so the
    // tool_calls/tool-result pairing the upstream validates stays intact.
    const caller = result.messages[callerIndex];

    expect(caller?.tool_calls).toBeDefined();

    const toolIndex = roles.indexOf('tool');

    if (toolIndex >= 0) {
      expect(result.messages[toolIndex]?.tool_call_id).toBe('call-1');
    }
  });

  it('preserves the role of every message it rewrites', () => {
    const messages = [
      message('system', 'S'.repeat(3_000)),
      message('user', 'U'.repeat(3_000)),
      message('assistant', 'A'.repeat(3_000)),
      message('user', 'question'),
    ];

    const result = compressMessages(messages, { budgetBytes: 500 });

    expect(result.messages.map((item) => item.role)).toEqual(
      messages.map((item) => item.role),
    );
  });

  it('handles content given as text blocks', () => {
    const blocks = [{ text: 'B'.repeat(10_000), type: 'text' }];
    const messages = [
      message('tool', blocks, { tool_call_id: 'call-1' }),
      message('user', 'question'),
    ];

    const result = compressMessages(messages, { budgetBytes: 1_000 });

    expect(result.bytesAfter).toBeLessThan(result.bytesBefore);
    expect(Array.isArray(result.messages[0]?.content)).toBe(true);
  });

  it('leaves an orphaned tool result alone rather than pairing it', () => {
    const messages = [
      message('tool', 'T'.repeat(4_000), { tool_call_id: 'call-x' }),
      message('user', 'question'),
    ];

    const result = compressMessages(messages, { budgetBytes: 100 });

    // Already malformed going in; compression must not invent a caller for it.
    expect(result.messages.filter((item) => item.role === 'tool')).toHaveLength(
      1,
    );
  });

  describe('images', () => {
    const imagePart = (data: string) => ({
      image_url: { url: data },
      type: 'image_url',
    });

    it('replaces a historical image with a text note', () => {
      const messages = [
        message('user', [
          { text: 'what is wrong here?', type: 'text' },
          imagePart(`data:image/png;base64,${'A'.repeat(40_000)}`),
        ]),
        message('assistant', 'I will look.'),
        message('user', 'any update?'),
      ];

      const result = compressMessages(messages, { budgetBytes: 1_000 });

      expect(result.bytesAfter).toBeLessThan(result.bytesBefore);
      const blocks = result.messages[0]?.content as Array<{
        text?: string;
        type?: string;
      }>;
      expect(blocks.some((part) => part.type === 'image_url')).toBe(false);
      // The prose beside the image survives; it is what gives it meaning.
      expect(blocks[0]?.text).toBe('what is wrong here?');
    });

    it('keeps the image attached to the last user turn', () => {
      const messages = [
        message('user', 'first'),
        message('user', [
          { text: 'look at this', type: 'text' },
          imagePart(`data:image/png;base64,${'A'.repeat(40_000)}`),
        ]),
      ];

      const result = compressMessages(messages, { budgetBytes: 10 });

      const blocks = result.messages[1]?.content as Array<{ type?: string }>;
      // The current turn's image may be the question itself.
      expect(blocks.some((part) => part.type === 'image_url')).toBe(true);
    });

    it('counts an image towards the size it measures', () => {
      const withImage = [
        message('user', [
          { text: 'see', type: 'text' },
          imagePart(`data:image/png;base64,${'A'.repeat(9_000)}`),
        ]),
        message('assistant', 'ok'),
      ];
      const withoutImage = [
        message('user', [{ text: 'see', type: 'text' }]),
        message('assistant', 'ok'),
      ];

      const a = compressMessages(withImage, { budgetBytes: 100_000 });
      const b = compressMessages(withoutImage, { budgetBytes: 100_000 });

      // A budget that ignored the base64 could never see the overflow coming.
      // 9,000 payload bytes plus the 22-byte `data:image/png;base64,` prefix.
      expect(a.bytesBefore - b.bytesBefore).toBe(9_022);
    });

    it('reads a flat image_url string as well as the nested form', () => {
      const messages = [
        message('user', [
          {
            image_url: `data:image/png;base64,${'A'.repeat(9_000)}`,
            type: 'input_image',
          },
        ]),
        message('user', 'next'),
      ];

      const result = compressMessages(messages, { budgetBytes: 500 });

      expect(result.bytesAfter).toBeLessThan(result.bytesBefore);
      const blocks = result.messages[0]?.content as Array<{ type?: string }>;
      expect(blocks[0]?.type).toBe('text');
    });
  });

  describe('tool call arguments', () => {
    const writeCall = (payload: string) => ({
      function: { arguments: payload, name: 'write_file' },
      id: 'call-1',
      type: 'function',
    });

    it('counts arguments towards the size it measures', () => {
      const withArgs = [
        message('assistant', 'writing', {
          tool_calls: [writeCall('A'.repeat(9_000))],
        }),
        message('user', 'go on'),
      ];
      const withoutArgs = [
        message('assistant', 'writing', { tool_calls: [writeCall('')] }),
        message('user', 'go on'),
      ];

      const a = compressMessages(withArgs, { budgetBytes: 1_000_000 });
      const b = compressMessages(withoutArgs, { budgetBytes: 1_000_000 });

      // A session built entirely out of file writes reported almost nothing
      // before this was counted, which is how a 7.8 MB body claimed to be 1.4k
      // characters and sailed past every budget. Exactly the payload: 'A' is
      // one byte and needs no JSON escaping.
      expect(a.bytesBefore - b.bytesBefore).toBe(9_000);
    });

    it('elides long arguments and keeps the call id and name', () => {
      const messages = [
        message('assistant', '', {
          tool_calls: [writeCall('A'.repeat(10_000))],
        }),
        message('tool', 'ok', { tool_call_id: 'call-1' }),
        message('user', 'carry on'),
      ];

      const result = compressMessages(messages, { budgetBytes: 3_000 });

      expect(result.bytesAfter).toBeLessThan(result.bytesBefore);
      expect(result.toolResultsElided).toBeGreaterThan(0);

      const call = (
        result.messages[0]?.tool_calls as Array<{
          function?: { arguments?: string; name?: string };
          id?: string;
        }>
      )[0];

      // The id and name are what the upstream pairs the call with; only the
      // payload is shortened.
      expect(call?.id).toBe('call-1');
      expect(call?.function?.name).toBe('write_file');
      expect(call?.function?.arguments).toContain('characters omitted');
    });

    it('leaves arguments alone when they are already small', () => {
      const messages = [
        message('assistant', 'hi', { tool_calls: [writeCall('{"path":"a"}')] }),
        message('user', 'next'),
      ];

      const result = compressMessages(messages, { budgetBytes: 100_000 });

      expect(result.unchanged).toBe(true);
      expect(result.messages).toBe(messages);
    });
  });

  it('reports the byte totals it measured', () => {
    const messages = [
      message('system', 'S'.repeat(2_000)),
      message('user', 'question'),
    ];

    const result = compressMessages(messages, { budgetBytes: 100 });

    expect(result.bytesBefore).toBeGreaterThan(2_000);
    expect(result.bytesAfter).toBeLessThan(result.bytesBefore);
    expect(result.keptCount).toBe(messages.length - result.replacedCount);
  });

  it('copes with a conversation of empty or non-text messages', () => {
    const messages = [
      message('user', undefined),
      message('assistant', null),
      message('user', ''),
    ];

    const result = compressMessages(messages, { budgetBytes: 1 });

    expect(result.bytesBefore).toBe(0);
    expect(result.replacedCount).toBe(0);
    expect(result.unchanged).toBe(true);
  });

  it('stubs the oldest message first when nothing is truncatable', () => {
    const messages = [
      message('user', 'U'.repeat(1_000)),
      message('user', 'latest'),
    ];

    const result = compressMessages(messages, { budgetBytes: 50 });

    expect(result.messages[0]?.content).toContain('omitted');
    expect(result.messages.at(-1)).toEqual(messages.at(-1));
  });
});
