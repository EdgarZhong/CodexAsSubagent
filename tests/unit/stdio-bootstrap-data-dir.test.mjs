import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { StdioBootstrap, defaultStartServer } from '../../src/mcp/stdio-bootstrap.mjs';
import { ensureServer } from '../../src/server/startup-lock.mjs';

const STUB = `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.CODEX_AS_SUBAGENT_TEST_OUT, JSON.stringify(process.argv.slice(2)));
`;

async function readJson(path, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      return JSON.parse(await readFile(path, 'utf8'));
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } while (Date.now() < deadline);
  throw new Error(`stub output not written: ${path}`);
}

async function withStubCapture(t, run) {
  const dir = await mkdtemp(join(tmpdir(), 'codex-start-server-'));
  const out = join(dir, 'argv.json');
  const stub = join(dir, 'stub.mjs');
  await writeFile(stub, STUB, 'utf8');
  const previousCli = process.env.CODEX_AS_SUBAGENT_CLI;
  const previousOut = process.env.CODEX_AS_SUBAGENT_TEST_OUT;
  process.env.CODEX_AS_SUBAGENT_CLI = stub;
  process.env.CODEX_AS_SUBAGENT_TEST_OUT = out;
  t.after(async () => {
    if (previousCli === undefined) delete process.env.CODEX_AS_SUBAGENT_CLI;
    else process.env.CODEX_AS_SUBAGENT_CLI = previousCli;
    if (previousOut === undefined) delete process.env.CODEX_AS_SUBAGENT_TEST_OUT;
    else process.env.CODEX_AS_SUBAGENT_TEST_OUT = previousOut;
    await rm(dir, { recursive: true, force: true });
  });
  await run({ dir, out });
}

test('defaultStartServer passes an explicit --data-dir to the detached serve process', async (t) => {
  await withStubCapture(t, async ({ dir, out }) => {
    defaultStartServer({
      socketPath: join(dir, 'server.sock'),
      lockPath: join(dir, 'server.lock'),
      dataDir: dir,
    });
    const argv = await readJson(out);
    assert.equal(argv[0], 'serve');
    assert.equal(argv[argv.indexOf('--data-dir') + 1], dir);
    assert.equal(argv[argv.indexOf('--socket') + 1], join(dir, 'server.sock'));
    assert.equal(argv[argv.indexOf('--lock') + 1], join(dir, 'server.lock'));
  });
});

test('defaultStartServer derives --data-dir from the socket directory when none is provided', async (t) => {
  await withStubCapture(t, async ({ dir, out }) => {
    defaultStartServer({
      socketPath: join(dir, 'server.sock'),
      lockPath: join(dir, 'server.lock'),
    });
    const argv = await readJson(out);
    assert.equal(argv[argv.indexOf('--data-dir') + 1], dir);
  });
});

test('StdioBootstrap forwards dataDir to ensureServer', async () => {
  const seen = [];
  const bootstrap = new StdioBootstrap({
    socketPath: '/tmp/cas-does-not-exist.sock',
    lockPath: '/tmp/cas-does-not-exist.lock',
    dataDir: '/tmp/cas-data',
    ensure: async (options) => { seen.push(options); },
    connect: async () => { throw new Error('connect must not be used'); },
  });
  await assert.rejects(bootstrap.forward({ id: 1, method: 'runtime.models' }, {}));
  assert.equal(seen[0].dataDir, '/tmp/cas-data');
  assert.equal(seen[0].socketPath, '/tmp/cas-does-not-exist.sock');
});

test('ensureServer forwards dataDir to startServer', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-ensure-server-'));
  const captured = [];
  try {
    await ensureServer({
      socketPath: join(dir, 'server.sock'),
      lockPath: join(dir, 'server.lock'),
      dataDir: dir,
      probe: async () => captured.length > 0,
      isProcessAlive: async () => false,
      startServer: async (options) => { captured.push(options); },
      timeoutMs: 100,
      pollMs: 1,
    });
    assert.equal(captured.length, 1);
    assert.equal(captured[0].dataDir, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
