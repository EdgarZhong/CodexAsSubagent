import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import {
  attachKimiWebWorker,
  detachKimiWebWorker,
  resolveKimiCodeHome,
  workerKey,
  workerRegistryPath,
} from '../../src/cli/kimi-web.mjs';

test('Kimi Web attach is idempotent and detach verifies the worker command marker', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cas-kimi-web-registry-'));
  t.after(async () => { await rm(dataDir, { recursive: true, force: true }); });
  const identity = { kimiHome: '/tmp/kimi', sessionId: 'session-1', workspace: '/project' };
  let spawned = 0;
  const first = await attachKimiWebWorker({
    ...identity,
    dataDir,
    cliPath: '/repo/src/cli/main.mjs',
    discover: async () => ({ baseUrl: 'http://127.0.0.1:58627', token: 'secret' }),
    lookupPid: async () => '',
    spawnImpl: () => { spawned += 1; return { pid: 1234, unref() {} }; },
    now: () => new Date('2026-09-11T00:00:00.000Z'),
  });
  assert.equal(first.attached, true);
  assert.equal(spawned, 1);
  const registry = JSON.parse(await readFile(workerRegistryPath(dataDir), 'utf8'));
  const key = workerKey(identity);
  assert.equal(registry[key].pid, 1234);

  const second = await attachKimiWebWorker({
    ...identity,
    dataDir,
    cliPath: '/repo/src/cli/main.mjs',
    discover: async () => ({ baseUrl: 'http://127.0.0.1:58627', token: 'secret' }),
    lookupPid: async () => `node /repo/src/cli/main.mjs kimi-web --worker --worker-key=${key}`,
    spawnImpl: () => { spawned += 1; return { pid: 5678, unref() {} }; },
  });
  assert.equal(second.existing, true);
  assert.equal(spawned, 1);

  let killed = null;
  const detached = await detachKimiWebWorker({
    ...identity,
    dataDir,
    lookupPid: async () => `node /repo/src/cli/main.mjs kimi-web --worker --worker-key=${key}`,
    kill: (pid) => { killed = pid; },
  });
  assert.equal(detached.detached, true);
  assert.equal(killed, 1234);
});

test('Kimi home resolution honors explicit value, env, then default', () => {
  assert.equal(resolveKimiCodeHome({ kimiCodeHome: '/custom/home' }), '/custom/home');
  assert.equal(resolveKimiCodeHome({ env: { KIMI_CODE_HOME: '/env/home' } }), '/env/home');
  assert.match(resolveKimiCodeHome({ env: {} }), /\.kimi-code$/);
});
