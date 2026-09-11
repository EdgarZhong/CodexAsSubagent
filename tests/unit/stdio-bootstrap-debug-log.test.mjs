import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { StdioBootstrap } from '../../src/mcp/stdio-bootstrap.mjs';

async function withDataDir(t, run) {
  const dir = await mkdtemp(join(tmpdir(), 'cas-mcp-debug-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  await run(dir);
}

function makeBootstrap(dataDir) {
  return new StdioBootstrap({
    socketPath: '/tmp/cas-does-not-exist.sock',
    lockPath: '/tmp/cas-does-not-exist.lock',
    dataDir,
    ensure: async () => {},
    connect: async () => { throw new Error('connect must not be used'); },
  });
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'kimi-code', version: '0.42.0' },
  },
};

test('initialize is logged when the mcp-debug flag file exists', async (t) => {
  await withDataDir(t, async (dir) => {
    await writeFile(join(dir, 'mcp-debug'), '', 'utf8');
    const bootstrap = makeBootstrap(dir);
    const response = await bootstrap.handleMcpRequest(INITIALIZE, { workspace: '/tmp/ws' });
    assert.equal(response.result.serverInfo.name, 'codex-as-subagent');
    const lines = (await readFile(join(dir, 'mcp-debug.log'), 'utf8')).trim().split('\n');
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.request.method, 'initialize');
    assert.deepEqual(entry.request.params.clientInfo, { name: 'kimi-code', version: '0.42.0' });
    assert.equal(typeof entry.cwd, 'string');
    assert.equal(typeof entry.at, 'string');
  });
});

test('initialize is not logged without the flag file', async (t) => {
  await withDataDir(t, async (dir) => {
    const bootstrap = makeBootstrap(dir);
    await bootstrap.handleMcpRequest(INITIALIZE, { workspace: '/tmp/ws' });
    await assert.rejects(stat(join(dir, 'mcp-debug.log')), { code: 'ENOENT' });
  });
});

test('debug logging is skipped when dataDir is null', async () => {
  const bootstrap = makeBootstrap(null);
  const response = await bootstrap.handleMcpRequest(INITIALIZE, { workspace: '/tmp/ws' });
  assert.equal(response.result.serverInfo.name, 'codex-as-subagent');
});
