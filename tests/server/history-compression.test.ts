import {
  capToolDefinitions,
  collectReferencedToolNames,
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
    // Large enough that stubbing clears MIN_STUB_RECLAIM_BYTES: replacing a
    // 5 KB turn to save 4.9 KB changes the request shape for nothing, so the
    // compressor deliberately leaves it alone.
    const messages = [
      message('system', 'S'.repeat(5_000)),
      message('user', 'U'.repeat(40_000)),
      message('assistant', 'A'.repeat(40_000)),
      message('user', 'the actual question'),
    ];

    const result = compressMessages(messages, { budgetBytes: 2_000 });

    expect(result.replacedCount).toBeGreaterThan(0);
    expect(result.bytesAfter).toBeLessThan(result.bytesBefore);
    expect(result.messages.at(-1)).toEqual(messages.at(-1));
  });

  it('never stubs the system prompt, even when nothing else can be shrunk', () => {
    // Stubbing the system prompt was the production bug behind upstream code
    // 11128: the call arrived with no instructions and the channel check read
    // it as a non-official client.
    const messages = [
      message('system', 'S'.repeat(60_000)),
      message('user', 'the question'),
      message('user', 'latest'),
    ];

    const result = compressMessages(messages, { budgetBytes: 10 });

    expect(result.messages[0]?.content).toBe('S'.repeat(60_000));
    expect(result.messages[1]?.content).toBe('the question');
  });

  it('protects developer messages the same way as system ones', () => {
    const messages = [
      message('developer', 'D'.repeat(60_000)),
      message('user', 'latest'),
    ];

    const result = compressMessages(messages, { budgetBytes: 10 });

    expect(result.messages[0]?.content).toBe('D'.repeat(60_000));
  });

  it('stubs a small turn rather than leaving the body over budget', () => {
    // There used to be a 32 KiB floor on what a stub had to reclaim, and it
    // disabled the stage outright in production: stages 2 and 3 already cut
    // every tool result to two kilobytes, so no group ever cleared the floor and
    // a 6,354-message session came out 4 MB wide with `replacedCount: 2`.
    // Keeping the floor means keeping bodies over budget, so the floor is gone.
    const messages = [
      message('user', 'U'.repeat(4_000)),
      message('user', 'latest'),
    ];

    const result = compressMessages(messages, { budgetBytes: 100 });

    expect(result.replacedCount).toBe(1);
    expect(result.unchanged).toBe(false);
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
      message('user', 'U'.repeat(40_000)),
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
      message('user', 'U'.repeat(40_000)),
      message('user', 'latest'),
    ];

    const result = compressMessages(messages, { budgetBytes: 50 });

    expect(result.messages[0]?.content).toContain('omitted');
    expect(result.messages.at(-1)).toEqual(messages.at(-1));
  });

  it('stubs a long run of tool groups instead of stopping short', () => {
    // The production shape: thousands of small tool groups. Every group is
    // worth only a few kilobytes after elision, which the old 32 KiB floor
    // refused — so the request stayed megabytes wide and the upstream answered
    // `code: 11128`. Stubbing is the only stage left that can shrink it.
    const messages = [message('system', 'instructions'), message('user', 'go')];

    for (let index = 0; index < 400; index += 1) {
      messages.push({
        content: 'thinking',
        role: 'assistant',
        tool_calls: [
          {
            function: { arguments: '{"path":"a.ts"}', name: 'read_file' },
            id: `call-${index}`,
            type: 'function',
          },
        ],
      });
      messages.push({
        content: 'x'.repeat(30_000),
        role: 'tool',
        tool_call_id: `call-${index}`,
      });
    }

    messages.push(message('user', 'latest'));

    const result = compressMessages(messages, { budgetBytes: 512 * 1024 });

    expect(result.replacedCount).toBeGreaterThan(0);
    expect(result.bytesAfter).toBeLessThan(512 * 1024);
    expect(result.messages[0]).toEqual(message('system', 'instructions'));
    expect(result.messages.at(-1)).toEqual(message('user', 'latest'));
  });

  it('shrinks a conversation even when the budget is zero', () => {
    // `applySizeControls` used to compute the budget as `target - overhead` and
    // clamp it at zero. With 131 tool definitions the overhead exceeds the whole
    // target, so the budget was zero and the history was never touched. A zero
    // budget means "nothing fits", not "do not try".
    const messages = [
      message('user', 'E'.repeat(20_000)),
      message('user', 'latest'),
    ];

    const result = compressMessages(messages, { budgetBytes: 0 });

    expect(result.bytesAfter).toBeLessThan(result.bytesBefore);
    expect(result.replacedCount).toBe(1);
    expect(result.messages.at(-1)).toEqual(message('user', 'latest'));
  });
});

describe('capToolDefinitions', () => {
  const tool = (name: string, padding: number) => ({
    function: {
      description: 'd'.repeat(padding),
      name,
      parameters: { properties: {}, type: 'object' },
    },
    type: 'function',
  });

  it('leaves a tool set that already fits alone', () => {
    const tools = [tool('a', 10), tool('b', 10)];

    expect(capToolDefinitions(tools, 1024 * 1024, new Set())).toBe(tools);
  });

  it('keeps the tools the conversation already called', () => {
    // Production sent 140 definitions on every turn, 1.3-1.7 MB against a 1 MiB
    // target: the history could be compressed to nothing and the body still did
    // not fit. The definitions worth keeping are the ones in use.
    const tools = [
      tool('unused', 4000),
      tool('used', 4000),
      tool('other', 4000),
    ];

    const capped = capToolDefinitions(tools, 4200, new Set(['used']));

    expect(capped).toHaveLength(1);
    expect((capped?.[0] as { function: { name: string } }).function.name).toBe(
      'used',
    );
  });

  it('keeps the caller order so a definition list does not churn', () => {
    const tools = [tool('a', 2000), tool('b', 2000), tool('c', 2000)];

    const capped = capToolDefinitions(tools, 4400, new Set(['c', 'a']));

    expect(
      capped?.map(
        (entry) => (entry as { function: { name: string } }).function.name,
      ),
    ).toEqual(['a', 'c']);
  });

  it('always keeps at least one definition', () => {
    const tools = [tool('huge', 50_000), tool('small', 10)];

    const capped = capToolDefinitions(tools, 100, new Set());

    expect(capped).toHaveLength(1);
  });
});

describe('collectReferencedToolNames', () => {
  it('collects the names an assistant turn called', () => {
    const names = collectReferencedToolNames([
      {
        role: 'assistant',
        tool_calls: [
          {
            function: { arguments: '{}', name: 'read_file' },
            type: 'function',
          },
          {
            function: { arguments: '{}', name: 'write_file' },
            type: 'function',
          },
        ],
      },
      message('user', 'hi'),
    ]);

    expect([...names].sort()).toEqual(['read_file', 'write_file']);
  });
});

describe('pruneToolDefinitions with a forced choice', () => {
  it('keeps only the tool a function tool_choice names', () => {
    const tools = [
      { function: { name: 'a' }, type: 'function' },
      { function: { name: 'b' }, type: 'function' },
    ];

    const pruned = pruneToolDefinitions(tools, {
      function: { name: 'b' },
      type: 'function',
    });

    expect(pruned).toHaveLength(1);
    expect((pruned?.[0] as { function: { name: string } }).function.name).toBe(
      'b',
    );
  });

  it('keeps everything when the choice constrains nothing', () => {
    const tools = [
      { function: { name: 'a' }, type: 'function' },
      { function: { name: 'b' }, type: 'function' },
    ];

    expect(pruneToolDefinitions(tools, 'auto')).toBe(tools);
    expect(pruneToolDefinitions(tools, 'required')).toBe(tools);
  });
});
