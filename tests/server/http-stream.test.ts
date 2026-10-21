import { describe, expect, it } from 'vitest';

import {
  readCappedResponseText,
  waitForStreamDemand,
} from '@/lib/server/shared/http';

const encoder = new TextEncoder();

const buildController = (desiredSize: number | null) =>
  ({ desiredSize }) as unknown as ReadableStreamDefaultController<Uint8Array>;

const streamOf = (chunks: string[]): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
      controller.close();
    },
  });

describe('waitForStreamDemand', () => {
  it('returns immediately when the consumer has room', async () => {
    await expect(
      waitForStreamDemand(buildController(1)),
    ).resolves.toBeUndefined();
  });

  it('returns when the stream is cancelled while the queue is full', async () => {
    let checks = 0;

    await expect(
      waitForStreamDemand(buildController(0), () => {
        checks += 1;

        // Cancelled on the second poll, so the loop has to observe it to exit.
        return checks > 1;
      }),
    ).resolves.toBeUndefined();

    expect(checks).toBeGreaterThan(1);
  });
});

describe('readCappedResponseText', () => {
  it('returns the whole body when it fits', async () => {
    const response = new Response(streamOf(['data: a\n\n', 'data: b\n\n']));

    await expect(readCappedResponseText(response, 1024)).resolves.toBe(
      'data: a\n\ndata: b\n\n',
    );
  });

  it('returns an empty string when there is no body', async () => {
    const response = new Response(null, { status: 204 });

    await expect(readCappedResponseText(response, 1024)).resolves.toBe('');
  });

  it('rejects a body that exceeds the cap instead of buffering it', async () => {
    const response = new Response(streamOf(['x'.repeat(64), 'y'.repeat(64)]));

    await expect(readCappedResponseText(response, 32)).rejects.toThrow(
      /exceeds the maximum size/,
    );
  });
});
