import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/server/storage', () => ({
  readStorageJson: vi.fn(),
}));

const { readStorageJson } = await import('@/lib/server/storage');
const {
  DEFAULT_MAX_CONCURRENT_REQUESTS,
  MAX_CONCURRENT_ENV,
  acquireRequestSlot,
  attachSlotToResponse,
  buildConcurrencyRejection,
  getConcurrencyRejectionMessage,
  getConcurrencyState,
  getMaxConcurrentRequests,
  resetConcurrencyGateForTests,
  withAdmission,
} = await import('@/lib/server/shared/concurrency-gate');
const { resetLogLevelCache } = await import('@/lib/server/shared/log');

const drain = async (response: Response): Promise<string> => response.text();

describe('concurrency gate', () => {
  beforeEach(() => {
    resetConcurrencyGateForTests();
    delete process.env[MAX_CONCURRENT_ENV];
    resetLogLevelCache();
    vi.mocked(readStorageJson).mockResolvedValue({
      CODEBUDDY_LOG_LEVEL: 'DEBUG',
    });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    resetConcurrencyGateForTests();
    delete process.env[MAX_CONCURRENT_ENV];
    vi.restoreAllMocks();
    resetLogLevelCache();
  });

  it('defaults to a small limit and honours the environment override', () => {
    expect(getMaxConcurrentRequests()).toBe(DEFAULT_MAX_CONCURRENT_REQUESTS);

    process.env[MAX_CONCURRENT_ENV] = '2';
    expect(getMaxConcurrentRequests()).toBe(2);

    // An operator debugging something else must be able to switch the gate off
    // without a new image.
    process.env[MAX_CONCURRENT_ENV] = '0';
    expect(getMaxConcurrentRequests()).toBeNull();

    process.env[MAX_CONCURRENT_ENV] = '-1';
    expect(getMaxConcurrentRequests()).toBeNull();

    process.env[MAX_CONCURRENT_ENV] = 'lots';
    expect(getMaxConcurrentRequests()).toBe(DEFAULT_MAX_CONCURRENT_REQUESTS);

    process.env[MAX_CONCURRENT_ENV] = '  ';
    expect(getMaxConcurrentRequests()).toBe(DEFAULT_MAX_CONCURRENT_REQUESTS);
  });

  it('reports the counters it tracks', () => {
    process.env[MAX_CONCURRENT_ENV] = '1';
    const slot = acquireRequestSlot();

    expect(getConcurrencyState()).toEqual({
      active: 1,
      admitted: 1,
      limit: 1,
      peak: 1,
      rejected: 0,
    });

    slot?.release();
    expect(getConcurrencyState().active).toBe(0);
  });

  it('refuses the request that would exceed the limit', async () => {
    process.env[MAX_CONCURRENT_ENV] = '1';
    const slot = acquireRequestSlot();

    expect(acquireRequestSlot()).toBeNull();
    expect(getConcurrencyState().rejected).toBe(1);
    await vi.waitFor(() =>
      expect(console.warn).toHaveBeenCalledWith(
        '[CodeBuddy2API][WARN] Request rejected: concurrency limit reached',
        expect.objectContaining({ active: 1, limit: 1, rejected: 1 }),
      ),
    );

    slot?.release();
    expect(acquireRequestSlot()).not.toBeNull();
  });

  it('admits again once a slot is released, and ignores a double release', () => {
    process.env[MAX_CONCURRENT_ENV] = '1';
    const slot = acquireRequestSlot();

    slot?.release();
    slot?.release();

    expect(getConcurrencyState().active).toBe(0);
    expect(acquireRequestSlot()).not.toBeNull();
  });

  it('lets everything through when the gate is switched off', () => {
    process.env[MAX_CONCURRENT_ENV] = '0';

    const slots = Array.from({ length: 20 }, () => acquireRequestSlot());

    expect(slots.every(Boolean)).toBe(true);
    expect(getConcurrencyState().limit).toBeNull();
    expect(getConcurrencyState().active).toBe(20);
  });

  it('releases a body-less response immediately', () => {
    const slot = acquireRequestSlot();

    attachSlotToResponse(new Response(null, { status: 204 }), slot!);

    expect(getConcurrencyState().active).toBe(0);
  });

  it('holds the slot until the body finishes, then releases it', async () => {
    const slot = acquireRequestSlot();
    const wrapped = attachSlotToResponse(
      new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      }),
      slot!,
    );

    expect(getConcurrencyState().active).toBe(1);

    const payload = await drain(wrapped);

    expect(payload).toBe('{"ok":true}');
    expect(wrapped.status).toBe(200);
    expect(getConcurrencyState().active).toBe(0);
  });

  it('releases the slot when the client cancels the stream', async () => {
    const slot = acquireRequestSlot();
    const wrapped = attachSlotToResponse(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('first'));
          },
        }),
      ),
      slot!,
    );

    await wrapped.body?.cancel();

    expect(getConcurrencyState().active).toBe(0);
  });

  it('releases the slot when the body errors mid-stream', async () => {
    const slot = acquireRequestSlot();
    const wrapped = attachSlotToResponse(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new Error('upstream vanished'));
          },
        }),
      ),
      slot!,
    );

    await expect(drain(wrapped)).rejects.toThrow();

    expect(getConcurrencyState().active).toBe(0);
  });

  it('runs the handler inside a slot and frees it afterwards', async () => {
    const result = await withAdmission(async () =>
      Response.json({ active: getConcurrencyState().active }),
    );

    expect(await result.json()).toEqual({ active: 1 });
    expect(getConcurrencyState().active).toBe(0);
  });

  it('answers 503 with a retry hint instead of running the handler', async () => {
    process.env[MAX_CONCURRENT_ENV] = '1';
    const slot = acquireRequestSlot();
    const handler = vi.fn(async () => Response.json({ ran: true }));

    const response = await withAdmission(handler);

    expect(handler).not.toHaveBeenCalled();
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('2');
    expect(await response.json()).toEqual({
      error: {
        code: 'server_busy',
        message: getConcurrencyRejectionMessage(),
        type: 'overloaded_error',
      },
    });

    slot?.release();
  });

  it('lets a caller supply its own rejection envelope', async () => {
    process.env[MAX_CONCURRENT_ENV] = '1';
    const slot = acquireRequestSlot();

    const response = await withAdmission(
      async () => Response.json({ ran: true }),
      () => Response.json({ type: 'error' }, { status: 529 }),
    );

    expect(response.status).toBe(529);
    expect(await response.json()).toEqual({ type: 'error' });

    slot?.release();
  });

  it('frees the slot when the handler throws', async () => {
    await expect(
      withAdmission(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(getConcurrencyState().active).toBe(0);
  });

  it('escalates a slot held far too long', async () => {
    const now = 1_000_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const slot = acquireRequestSlot();

    clock.mockReturnValue(now + 130_000);
    slot?.release();

    await vi.waitFor(() =>
      expect(console.warn).toHaveBeenCalledWith(
        '[CodeBuddy2API][WARN] Request slot released',
        expect.objectContaining({
          durationMs: 130_000,
          slowRequestThresholdMs: 120_000,
        }),
      ),
    );
  });

  it('force-releases a slot that is never disposed of', async () => {
    vi.useFakeTimers();

    try {
      process.env[MAX_CONCURRENT_ENV] = '1';
      acquireRequestSlot();

      // An aborted connection whose reader is dropped without a cancel arriving
      // would otherwise hold this slot forever, and four such leaks would wedge
      // the gate permanently.
      expect(acquireRequestSlot()).toBeNull();

      await vi.advanceTimersByTimeAsync(30 * 60_000);

      expect(getConcurrencyState().active).toBe(0);
      expect(acquireRequestSlot()).not.toBeNull();
      await vi.waitFor(() =>
        expect(console.warn).toHaveBeenCalledWith(
          '[CodeBuddy2API][WARN] Request slot leaked, releasing it',
          expect.objectContaining({ leaseMs: 30 * 60_000 }),
        ),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the lease timer when the slot is released normally', async () => {
    vi.useFakeTimers();

    try {
      const slot = acquireRequestSlot();
      slot?.release();

      await vi.advanceTimersByTimeAsync(30 * 60_000);

      // The lease must not release a *different* request's slot later on.
      expect(getConcurrencyState().active).toBe(0);
      expect(console.warn).not.toHaveBeenCalledWith(
        '[CodeBuddy2API][WARN] Request slot leaked, releasing it',
        expect.anything(),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('describes the limit in the rejection message', () => {
    process.env[MAX_CONCURRENT_ENV] = '3';

    expect(getConcurrencyRejectionMessage()).toContain('limit 3');
  });

  it('builds the same rejection the default path uses', async () => {
    const response = buildConcurrencyRejection();

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: 'server_busy' },
    });
  });
});
