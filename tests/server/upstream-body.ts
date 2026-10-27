import { gunzipSync } from 'node:zlib';

/**
 * The text an upstream call actually carried.
 *
 * Larger bodies leave the gateway gzipped, the way the official client sends
 * them, so a test that reads `init.body` directly sees bytes instead of JSON.
 * This decodes either shape so assertions keep describing the payload rather
 * than the transport.
 */
export const readUpstreamBody = (init: RequestInit | undefined): string => {
  const body = init?.body;

  if (typeof body === 'string') {
    return body;
  }

  const buffer = Buffer.from(body as Uint8Array);
  const encoding = new Headers(init?.headers).get('content-encoding');

  return encoding === 'gzip'
    ? gunzipSync(buffer).toString('utf8')
    : buffer.toString('utf8');
};
