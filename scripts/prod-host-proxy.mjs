/**
 * Host-fixing reverse proxy for on-device testing through a tunnel.
 *
 * Why this exists: the production gateway sits behind `openresty`, which routes
 * by `Host`. A tunnel (ngrok `http https://code.apimesh.cn`) rewrites the Host to
 * its own domain, so openresty has no matching server block and answers 404 —
 * the request never reaches the app. ngrok 3.x exposes no `--host-header` flag,
 * so instead of fighting the tunnel this proxy listens locally and always sends
 * the upstream Host that production expects.
 *
 * Usage:
 *   node scripts/prod-host-proxy.mjs            # listens on 8001
 *   PORT=9101 node scripts/prod-host-proxy.mjs
 *   UPSTREAM=http://127.0.0.1:8001 node scripts/prod-host-proxy.mjs   # local gateway
 *
 * Then point the tunnel at this port:
 *   ngrok http 8001
 *
 * Note it forwards both directions faithfully, including `text/event-stream`
 * (no buffering) and the `Cookie` header the admin API authenticates with.
 */

import http from 'node:http';
import https from 'node:https';

const PORT = Number(process.env.PORT ?? 8001);

/** Upstream host and the Host header to present to it. */
const UPSTREAM = process.env.UPSTREAM ?? 'https://code.apimesh.cn';
const UPSTREAM_HOST = process.env.UPSTREAM_HOST ?? 'code.apimesh.cn';

const target = new URL(UPSTREAM);
const isTls = target.protocol === 'https:';
const client = isTls ? https : http;

/** Headers that describe *this* hop and must not be forwarded verbatim. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * Set `DUMP_HEADERS=1` to log the auth-relevant request headers.
 *
 * On-device debugging has no other vantage point: the App runtime decides for
 * itself whether a `Cookie` header survives, and this is the only place that can
 * observe what actually left the phone. Values are truncated to a length so a
 * live session token never lands in a log file.
 */
const DUMP_HEADERS = process.env.DUMP_HEADERS === '1';

const server = http.createServer((req, res) => {
  if (DUMP_HEADERS) {
    const interesting = ['authorization', 'cookie', 'x-client-platform', 'host'];
    const seen = interesting
      .filter((name) => req.headers[name])
      .map((name) => `${name}=${String(req.headers[name]).slice(0, 24)}(len ${String(req.headers[name]).length})`);

    process.stdout.write(`${req.method} ${req.url} :: ${seen.join(' | ') || '(no auth headers)'}\n`);
  }

  const headers = {};

  for (const [name, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue;
    headers[name] = value;
  }

  // The whole point: tell openresty which site we mean.
  headers.host = isTls ? UPSTREAM_HOST : `${target.hostname}:${target.port}`;

  const upstreamRequest = client.request(
    {
      hostname: target.hostname,
      method: req.method,
      path: req.url,
      port: target.port || (isTls ? 443 : 80),
      headers,
    },
    (upstreamResponse) => {
      const responseHeaders = {};

      for (const [name, value] of Object.entries(upstreamResponse.headers)) {
        if (HOP_BY_HOP.has(name.toLowerCase())) continue;
        responseHeaders[name] = value;
      }

      res.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);

      // `pipe` keeps SSE flowing chunk by chunk instead of buffering the reply.
      upstreamResponse.pipe(res);
    },
  );

  upstreamRequest.on('error', (error) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    }

    res.end(`upstream error: ${error.message}`);
  });

  req.pipe(upstreamRequest);
});

server.listen(PORT, () => {
  process.stdout.write(
    `host-fixing proxy on :${PORT} -> ${UPSTREAM} (Host: ${UPSTREAM_HOST})\n`,
  );
});
