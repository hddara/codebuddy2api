# Pinned, not floating: `oven/bun:1-slim` follows whichever release is newest,
# so the runtime the gateway runs on changed without any commit saying so. The
# memory accounting and GC of the JavaScriptCore build decide when a large
# streamed reply is collected, which makes this part of the runtime contract.
#
# Do not go below 1.4.3: Bun 1.3.14 crashes with a NAPI FATAL ERROR (SIGILL)
# while loading better-sqlite3's prebuilt N-API binding, which takes down the
# whole process on startup when the storage backend is `sqlite`.
ARG BUN_VERSION=1.4.3

FROM oven/bun:${BUN_VERSION}-slim AS deps

WORKDIR /app

RUN apt-get update && \
    apt-get install --no-install-recommends --yes python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
# `--ignore-scripts` skips dependency install hooks, which is what pulled in a
# from-source node-gyp build of better-sqlite3 against a download of the Node
# headers — a tarball that fails to extract here and takes the whole image down
# with it. better-sqlite3 ships prebuilt bindings for this platform, and the
# gateway runs on the `pg` storage backend, so nothing needs compiling.
RUN bun install --frozen-lockfile --ignore-scripts

FROM oven/bun:${BUN_VERSION}-slim AS builder

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN bun run build

FROM oven/bun:${BUN_VERSION}-slim AS runner

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8001 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1

COPY --from=builder --chown=bun:bun /app/.next/standalone ./
COPY --from=builder --chown=bun:bun /app/.next/static ./.next/static
COPY --from=builder --chown=bun:bun /app/public ./public

RUN mkdir -p /app/.codebuddy_data /app/.codebuddy_creds && \
    chown -R bun:bun /app

USER bun

EXPOSE 8001

CMD ["bun", "server.js"]
