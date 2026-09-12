import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import net from 'node:net';
import test from 'node:test';

import { RuntimeServer } from '../../src/server/server.mjs';
import { StdioBootstrap } from '../../src/mcp/stdio-bootstrap.mjs';

function request(socketPath, body) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      data += chunk;
      const line = data.split('\n')[0];
      if (!line) return;
      socket.end();
      try { resolve(JSON.parse(line)); } catch (error) { reject(error); }
    });
    socket.once('error', reject);
    socket.once('connect', () => socket.write(`${JSON.stringify(body)}\n`));
  });
}

test('RuntimeServer routes correlated requests over newline-delimited Unix socket', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-server-'));
  const socketPath = join(dir, 'server.sock');
  const calls = [];
  const runtime = {
    executionStore: { listExecutions: () => [] },
    completionStore: { listCompletions: () => [] },
    close() {},
    async sessionContext(context) {
      return { host: context.host, workspace: context.workspace, sessionId: 'session-A' };
    },
    async spawn(ctx, params) { calls.push(['spawn', ctx, params]); return { threadId: 't-1', status: 'running' }; },
    claimIdFor() { return null; },
    ackClaim() { return false; },
    releaseClaim() { return false; },
  };
  const server = new RuntimeServer({ runtime, idleShutdownMs: 100_000 });
  try {
    await server.listen(socketPath);
    const response = await request(socketPath, {
      id: 7,
      method: 'runtime.spawn',
      params: { prompt: 'hello' },
      context: { host: 'kimi-code', workspace: '/workspace/current' },
    });
    assert.deepEqual(response, { id: 7, result: { threadId: 't-1', status: 'running' } });
    assert.deepEqual(calls, [[
      'spawn',
      { host: 'kimi-code', workspace: '/workspace/current', sessionId: 'session-A' },
      { prompt: 'hello' },
    ]]);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('StdioBootstrap removes hidden delivery id and ACKs only after stdout write', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-bootstrap-'));
  const socketPath = join(dir, 'server.sock');
  const acked = [];
  const nacked = [];
  const runtime = {
    executionStore: { listExecutions: () => [] },
    completionStore: { listCompletions: () => [] },
    close() {},
    async sessionContext(context) {
      return { host: context.host, workspace: context.workspace, sessionId: 'session-A' };
    },
    async wait() { return { threadId: 't-1', status: 'completed' }; },
    claimIdFor(value) { return value?.status === 'completed' ? 'delivery-1' : null; },
    ackClaim(id, host) { acked.push([id, host]); return true; },
    releaseClaim(id, host) { nacked.push([id, host]); return true; },
  };
  const server = new RuntimeServer({ runtime, idleShutdownMs: 100_000 });
  const output = new PassThrough();
  let outputText = '';
  output.on('data', (chunk) => { outputText += chunk.toString(); });
  try {
    await server.listen(socketPath);
    const bootstrap = new StdioBootstrap({
      socketPath,
      lockPath: join(dir, 'server.lock'),
      cwd: process.cwd(),
      stdout: output,
      ensure: async () => {},
    });
    const context = { host: 'zcode', workspace: process.cwd() };
    const response = await bootstrap.handleRequest({ id: 1, method: 'runtime.wait', params: { threadId: 't-1' } }, context);
    assert.deepEqual(response, { id: 1, result: { threadId: 't-1', status: 'completed' } });
    assert.deepEqual(JSON.parse(outputText.trim()), response);
    assert.deepEqual(acked, [['delivery-1', 'zcode']]);
    assert.deepEqual(nacked, []);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
