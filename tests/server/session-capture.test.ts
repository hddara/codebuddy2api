import fs from 'node:fs';
import path from 'node:path';

const tempRootDir = path.join(process.cwd(), '.tmp-test-session-capture');
const sqlitePath = path.join(tempRootDir, 'storage.sqlite');
const ENCRYPTION_KEY = 'session-capture-test-key';

const cleanupTempState = (): void => {
  fs.rmSync(tempRootDir, { force: true, recursive: true, maxRetries: 5 });
};

const load = async () => {
  vi.resetModules();
  const storage = await import('@/lib/server/storage');
  const capture = await import('@/lib/server/domain/session-capture');

  // The runtime lives on globalThis, so it survives `resetModules()` and would
  // otherwise hand this module generation a backend built by the previous one.
  storage.resetStorageRuntime();

  return { capture, storage };
};

const chatBody = () => ({
  messages: [{ content: 'Hello there', role: 'user' }],
  model: 'gpt-5.5',
});

describe('session capture', () => {
  beforeEach(() => {
    cleanupTempState();
    vi.resetModules();
    process.env.CODEBUDDY_STORAGE_BACKEND = 'sqlite';
    process.env.CODEBUDDY_STORAGE_SQLITE_PATH = sqlitePath;
    process.env.CODEBUDDY_STORAGE_ENCRYPTION_KEY = ENCRYPTION_KEY;
    delete process.env.CODEBUDDY_SESSION_LOG_ENABLED;
  });

  afterEach(() => {
    cleanupTempState();
    delete process.env.CODEBUDDY_STORAGE_BACKEND;
    delete process.env.CODEBUDDY_STORAGE_SQLITE_PATH;
    delete process.env.CODEBUDDY_STORAGE_ENCRYPTION_KEY;
    delete process.env.CODEBUDDY_SESSION_LOG_ENABLED;
  });

  it('records a request and its response as two turns', async () => {
    const { capture, storage } = await load();
    const sessionCapture = await capture.beginSessionCapture({
      accessKeyId: 'key-1',
      body: chatBody(),
      credentialFilename: null,
      headers: new Headers(),
      route: '/v1/chat/completions',
    });

    expect(sessionCapture).not.toBeNull();

    const response = Response.json({
      choices: [{ message: { content: 'Hi!', role: 'assistant' } }],
      usage: { total_tokens: 7 },
    });

    // The capture must hand the very same response back to the caller.
    expect(capture.finalizeSessionCapture(sessionCapture, response)).toBe(
      response,
    );

    const sessionId = sessionCapture!.identity.sessionId;
    await vi.waitFor(async () => {
      expect(await storage.getStorageSession(sessionId)).not.toBeNull();
    });

    const stored = await storage.getStorageSession(sessionId);

    expect(
      stored?.turns.map((turn) => [
        turn.role,
        turn.turnIndex,
        turn.contentText,
      ]),
    ).toEqual([
      ['user', 0, 'Hello there'],
      ['assistant', 1, 'Hi!'],
    ]);
    expect(stored?.session.turnCount).toBe(2);
    expect(stored?.session.totalTokens).toBe(7);
    expect(stored?.session.externalRef).toBe(
      sessionCapture!.identity.externalRef,
    );
  });

  it('continues the same session on the next turn', async () => {
    const { capture, storage } = await load();

    for (const _round of [0, 1]) {
      const sessionCapture = await capture.beginSessionCapture({
        accessKeyId: 'key-1',
        body: chatBody(),
        credentialFilename: null,
        headers: new Headers(),
        route: '/v1/chat/completions',
      });
      const response = Response.json({
        choices: [{ message: { content: 'Hi!', role: 'assistant' } }],
      });

      capture.finalizeSessionCapture(sessionCapture, response);
      await vi.waitFor(async () => {
        const stored = await storage.getStorageSession(
          sessionCapture!.identity.sessionId,
        );

        expect(stored?.turns.length).toBe((_round + 1) * 2);
      });
    }

    const stored = await storage.listStorageSessions();

    expect(stored.sessions).toHaveLength(1);
    expect(stored.sessions[0]?.turnCount).toBe(4);
    const turns = await storage.getStorageSession(
      stored.sessions[0]!.sessionId,
    );

    expect(turns?.turns.map((turn) => turn.turnIndex)).toEqual([0, 1, 2, 3]);
  });

  it('does nothing when session logging is disabled', async () => {
    process.env.CODEBUDDY_SESSION_LOG_ENABLED = 'false';
    const { capture } = await load();

    expect(
      await capture.beginSessionCapture({
        accessKeyId: 'key-1',
        body: chatBody(),
        credentialFilename: null,
        headers: new Headers(),
        route: '/v1/chat/completions',
      }),
    ).toBeNull();

    const response = Response.json({ ok: true });

    expect(capture.finalizeSessionCapture(null, response)).toBe(response);
  });

  it('does nothing on the file backend', async () => {
    process.env.CODEBUDDY_STORAGE_BACKEND = 'file';
    delete process.env.CODEBUDDY_STORAGE_ENCRYPTION_KEY;
    const { capture } = await load();

    expect(
      await capture.beginSessionCapture({
        accessKeyId: 'key-1',
        body: chatBody(),
        credentialFilename: null,
        headers: new Headers(),
        route: '/v1/chat/completions',
      }),
    ).toBeNull();
  });

  it('keeps serving the response when recording fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { capture } = await load();
    const sessionCapture = await capture.beginSessionCapture({
      accessKeyId: 'key-1',
      body: chatBody(),
      credentialFilename: null,
      headers: new Headers(),
      route: '/v1/chat/completions',
    });

    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error('stream exploded'));
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );

    expect(capture.finalizeSessionCapture(sessionCapture, response)).toBe(
      response,
    );
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalled();
    });
    warn.mockRestore();
  });

  it('swallows a storage failure while starting the capture', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    // A file where the data directory should be: opening sqlite must fail.
    fs.mkdirSync(tempRootDir, { recursive: true });
    fs.writeFileSync(path.join(tempRootDir, 'blocked'), 'not a directory');
    process.env.CODEBUDDY_STORAGE_SQLITE_PATH = path.join(
      tempRootDir,
      'blocked',
      'storage.sqlite',
    );
    const { capture } = await load();

    expect(
      await capture.beginSessionCapture({
        accessKeyId: 'key-1',
        body: chatBody(),
        credentialFilename: null,
        headers: new Headers(),
        route: '/v1/chat/completions',
      }),
    ).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('extractAssistantText', () => {
  const loadCapture = async () => {
    vi.resetModules();

    return import('@/lib/server/domain/session-capture');
  };

  it('reads Chat Completions, Anthropic and Responses bodies', async () => {
    const { extractAssistantText } = await loadCapture();

    expect(
      extractAssistantText({
        choices: [{ message: { content: 'from chat' } }],
      }),
    ).toBe('from chat');
    expect(
      extractAssistantText({
        content: [{ text: 'from anthropic', type: 'text' }],
      }),
    ).toBe('from anthropic');
    expect(extractAssistantText({ output_text: 'from responses' })).toBe(
      'from responses',
    );
    expect(
      extractAssistantText({
        output: [{ content: [{ text: 'from output' }], type: 'message' }],
      }),
    ).toBe('from output');
  });

  it('splices streamed deltas back together', async () => {
    const { extractAssistantText } = await loadCapture();

    expect(
      extractAssistantText(
        [
          'data: {"choices":[{"delta":{"content":"Hel"}}]}',
          '',
          'data: {"choices":[{"delta":{"content":"lo"}}]}',
          '',
          'data: [DONE]',
          '',
        ].join('\n'),
      ),
    ).toBe('Hello');
    expect(
      extractAssistantText(
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Yo"}}',
      ),
    ).toBe('Yo');
  });

  it('returns null for shapes it cannot read', async () => {
    const { extractAssistantText } = await loadCapture();

    expect(extractAssistantText({})).toBeNull();
    expect(extractAssistantText('not json at all')).toBeNull();
    expect(extractAssistantText(null)).toBeNull();
    expect(extractAssistantText(42)).toBeNull();
    expect(extractAssistantText({ choices: [{ message: {} }] })).toBeNull();
  });
});
