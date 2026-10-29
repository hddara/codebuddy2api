#!/usr/bin/env node
// Call a project MCP server from the shell, without registering it in a client.
//
// Usage:
//   node scripts/mcp-call.mjs list
//   node scripts/mcp-call.mjs <server> tools
//   node scripts/mcp-call.mjs <server> call <tool> ['{"arg":"value"}']
//   node scripts/mcp-call.mjs <server> call <tool> --args-file args.json
//
// Options:
//   --config <path>   read another MCP config (default: ./.mcp.json)
//   --raw             print the raw JSON-RPC result instead of text content
//
// The project keeps its MCP endpoints in the gitignored `.mcp.json`, which is
// the file the CodeBuddy client reads. DeepSeek Harness does not read it: its
// servers live in `~/.dsh/profiles/desktop/cordis.patch.yml`, and anything put
// in `~/.dsh/cordis.patch.yml` applies to every workspace of that profile. So a
// project-scoped server is not registered anywhere — it is called from here,
// with the same config the project already has, and only while this repository
// is the working directory.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const DEFAULT_CONFIG = '.mcp.json';
const REQUEST_TIMEOUT_MS = 60_000;

const fail = (message) => {
  console.error(`error: ${message}`);
  process.exit(1);
};

const parseArgs = (argv) => {
  const options = { config: DEFAULT_CONFIG, raw: false };
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];

    if (value === '--config') {
      options.config = argv[index + 1];
      index += 1;
      continue;
    }

    if (value === '--raw') {
      options.raw = true;
      continue;
    }

    if (value === '--args-file') {
      options.argsFile = argv[index + 1];
      index += 1;
      continue;
    }

    positional.push(value);
  }

  return { options, positional };
};

const loadServers = (configPath) => {
  const absolute = path.resolve(configPath);

  if (!fs.existsSync(absolute)) {
    fail(
      `${absolute} not found. The project MCP config is gitignored; copy .mcp.json from the maintainer or restore it from the deployment notes.`,
    );
  }

  return JSON.parse(fs.readFileSync(absolute, 'utf8')).mcpServers ?? {};
};

/** Reads a JSON-RPC reply that may arrive as plain JSON or as an SSE frame. */
const unwrap = (raw) => {
  const trimmed = raw.trim();

  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return JSON.parse(trimmed);
  }

  const line = trimmed.split('\n').find((entry) => entry.startsWith('data: '));

  return line ? JSON.parse(line.slice(6)) : null;
};

const createHttpTransport = (server) => {
  let sessionId = server.headers?.['Mcp-Session-Id'] ?? null;

  return {
    async request(payload) {
      const headers = {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        ...server.headers,
      };

      if (sessionId) {
        headers['Mcp-Session-Id'] = sessionId;
      }

      const response = await fetch(server.url, {
        body: JSON.stringify(payload),
        headers,
        method: 'POST',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      sessionId = response.headers.get('mcp-session-id') ?? sessionId;

      const raw = await response.text();

      if (!response.ok) {
        fail(`MCP HTTP ${response.status}: ${raw.slice(0, 300)}`);
      }

      return unwrap(raw);
    },
    close() {},
  };
};

const createStdioTransport = (server) => {
  const child = spawn(server.command, server.args ?? [], {
    cwd: server.cwd || process.cwd(),
    env: { ...process.env, ...server.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  let buffer = '';

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;

    let newline = buffer.indexOf('\n');

    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);

      if (line) {
        const message = unwrap(line);

        if (message?.id && pending.has(message.id)) {
          pending.get(message.id)(message);
          pending.delete(message.id);
        }
      }

      newline = buffer.indexOf('\n');
    }
  });

  const stderr = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => stderr.push(chunk));

  child.on('exit', (code) => {
    for (const resolve of pending.values()) {
      resolve({
        error: {
          message: `server exited (${code}): ${stderr.join('').slice(0, 300)}`,
        },
      });
    }
    pending.clear();
  });

  return {
    async request(payload) {
      if (!payload.id) {
        child.stdin.write(`${JSON.stringify(payload)}\n`);

        return null;
      }

      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(payload.id);
          resolve({
            error: { message: `timed out after ${REQUEST_TIMEOUT_MS}ms` },
          });
        }, REQUEST_TIMEOUT_MS);

        pending.set(payload.id, (message) => {
          clearTimeout(timer);
          resolve(message);
        });
        child.stdin.write(`${JSON.stringify(payload)}\n`);
      });
    },
    close() {
      child.kill();
    },
  };
};

const createTransport = (server) => {
  if (server.url) {
    return createHttpTransport(server);
  }

  if (server.command) {
    return createStdioTransport(server);
  }

  fail(
    `server entry has neither a url nor a command: ${JSON.stringify(server)}`,
  );
};

const handshake = async (transport) => {
  await transport.request({
    id: 1,
    jsonrpc: '2.0',
    method: 'initialize',
    params: {
      capabilities: {},
      clientInfo: { name: 'codebuddy2api-mcp-call', version: '1.0.0' },
      protocolVersion: '2024-11-05',
    },
  });

  // Notification: no id, no reply. Stateless endpoints ignore it; stateful ones
  // answer 400 to a tools call that skips it.
  await transport.request({
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  });
};

const printText = (result) => {
  const content = result?.content ?? [];

  if (!Array.isArray(content) || !content.length) {
    console.log(JSON.stringify(result, null, 2));

    return;
  }

  for (const part of content) {
    if (part.type === 'text' && typeof part.text === 'string') {
      try {
        console.log(JSON.stringify(JSON.parse(part.text), null, 2));
      } catch {
        console.log(part.text);
      }
      continue;
    }

    console.log(JSON.stringify(part, null, 2));
  }
};

const readArgs = (options, inline) => {
  if (options.argsFile) {
    return JSON.parse(fs.readFileSync(path.resolve(options.argsFile), 'utf8'));
  }

  if (inline) {
    try {
      return JSON.parse(inline);
    } catch (error) {
      fail(`arguments are not valid JSON: ${error.message}`);
    }
  }

  return {};
};

const main = async () => {
  const { options, positional } = parseArgs(process.argv.slice(2));
  const servers = loadServers(options.config);
  const [command, ...rest] = positional;

  if (!command || command === 'list') {
    for (const [name, server] of Object.entries(servers)) {
      console.log(
        `${name.padEnd(16)} ${server.disabled ? 'disabled  ' : 'available '} ${
          server.url ?? `${server.command} ${(server.args ?? []).join(' ')}`
        }`,
      );
    }

    return;
  }

  const server = servers[command];

  if (!server) {
    fail(
      `unknown server "${command}". Known: ${Object.keys(servers).join(', ')}`,
    );
  }

  if (server.disabled) {
    fail(`server "${command}" is disabled in ${options.config}`);
  }

  const [action, tool, inlineArgs] = rest;
  const transport = createTransport(server);

  try {
    await handshake(transport);

    if (action === 'tools') {
      const reply = await transport.request({
        id: 2,
        jsonrpc: '2.0',
        method: 'tools/list',
        params: {},
      });

      if (reply?.error) {
        fail(`tools/list: ${JSON.stringify(reply.error)}`);
      }

      for (const entry of reply?.result?.tools ?? []) {
        console.log(
          `${entry.name}\n  ${(entry.description ?? '').split('\n')[0]}`,
        );
      }

      return;
    }

    if (action !== 'call' || !tool) {
      fail(
        'usage: node scripts/mcp-call.mjs <server> tools | call <tool> [json]',
      );
    }

    const reply = await transport.request({
      id: 2,
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { arguments: readArgs(options, inlineArgs), name: tool },
    });

    if (reply?.error) {
      fail(`${tool}: ${JSON.stringify(reply.error)}`);
    }

    if (options.raw) {
      console.log(JSON.stringify(reply?.result, null, 2));
    } else {
      printText(reply?.result);
    }

    if (reply?.result?.isError) {
      process.exitCode = 1;
    }
  } finally {
    transport.close();
  }
};

await main();
