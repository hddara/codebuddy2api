#!/usr/bin/env node
// Switch the production Swarm service to a published image tag.
//
// Usage:
//   node scripts/deploy-swarm.mjs 20261027.T01          # update and wait
//   node scripts/deploy-swarm.mjs --check 20261027.T01  # verify only
//
// Deployment used to be a human step: the machine that builds the image cannot
// reach the swarm manager. It can reach the project's Docker Swarm MCP endpoint
// instead, which is what this script drives. Credentials live in the gitignored
// `.mcp.json`; the endpoint is never hard-coded with a token here.

import fs from 'node:fs';
import path from 'node:path';

const SERVICE = 'codebuddy2api_app';
const POLL_INTERVAL_MS = 5_000;
const TIMEOUT_MS = 180_000;

const mcpConfigPath = path.resolve('.mcp.json');

const fail = (message) => {
  console.error(`error: ${message}`);
  process.exit(1);
};

if (!fs.existsSync(mcpConfigPath)) {
  fail(
    `${mcpConfigPath} not found. It holds the docker-swarm MCP endpoint and is gitignored.`,
  );
}

const server = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8')).mcpServers?.[
  'docker-swarm'
];

if (!server?.url || !server.headers?.Authorization) {
  fail(
    '.mcp.json has no docker-swarm entry with a url and Authorization header.',
  );
}

const rpc = async (payload) => {
  const response = await fetch(server.url, {
    body: JSON.stringify(payload),
    headers: {
      Accept: 'application/json, text/event-stream',
      Authorization: server.headers.Authorization,
      'Content-Type': 'application/json',
    },
    method: 'POST',
  });

  const raw = await response.text();

  if (!response.ok) {
    fail(`MCP HTTP ${response.status}: ${raw.slice(0, 300)}`);
  }

  // Streamable HTTP answers either as plain JSON or as a one-line SSE frame.
  const body =
    raw.startsWith('event:') || raw.startsWith('data:')
      ? (raw.split('\n').find((line) => line.startsWith('data: ')) ?? '').slice(
          6,
        )
      : raw;

  return JSON.parse(body);
};

const callTool = async (name, args) => {
  const result = await rpc({
    id: 2,
    jsonrpc: '2.0',
    method: 'tools/call',
    params: { arguments: args, name },
  });

  if (result.error) {
    fail(`${name}: ${JSON.stringify(result.error)}`);
  }

  const content = result.result?.content ?? [];
  const text = content.map((part) => part.text ?? '').join('\n');

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const readService = async () => {
  const services = await callTool('list_services', { stack: 'codebuddy2api' });

  return Array.isArray(services)
    ? services.find((entry) => entry.name === SERVICE)
    : undefined;
};

const waitForTag = async (tag) => {
  const deadline = Date.now() + TIMEOUT_MS;

  while (Date.now() < deadline) {
    const service = await readService();

    if (service && service.image.endsWith(`:${tag}`)) {
      if (service.updateState === 'completed') {
        return service;
      }

      if (service.updateState === 'paused') {
        fail('the service update paused; inspect it before retrying');
      }
    }

    await sleep(POLL_INTERVAL_MS);
  }

  fail(`timed out waiting for ${SERVICE} to run ${tag}`);
};

const main = async () => {
  const args = process.argv.slice(2);
  const checkOnly = args.includes('--check');
  const tag = args.find((arg) => !arg.startsWith('--'));

  if (!tag) {
    fail(
      'pass the image tag, e.g. `node scripts/deploy-swarm.mjs 20261027.T01`',
    );
  }

  await rpc({
    id: 1,
    jsonrpc: '2.0',
    method: 'initialize',
    params: {
      capabilities: {},
      clientInfo: { name: 'codebuddy2api-release', version: '1' },
      protocolVersion: '2025-06-18',
    },
  });

  const before = await readService();

  if (!before) {
    fail(`${SERVICE} not found in the codebuddy2api stack`);
  }

  console.log(`current: ${before.image}`);

  if (!checkOnly) {
    console.log(`updating ${SERVICE} -> ${tag}`);
    await callTool('update_service', {
      confirm: true,
      id: SERVICE,
      imageTag: tag,
    });
  }

  const after = await waitForTag(tag);

  console.log(`running: ${after.image} (updateState: ${after.updateState})`);
};

await main();
