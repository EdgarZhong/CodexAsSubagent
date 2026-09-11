import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { acquireStartupLock, ensureServer } from '../../src/server/startup-lock.mjs';

test('startup lock allows one winner and releases atomically', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-startup-lock-'));
  const lockPath = join(dir, 'server.lock');
  try {
    const first = await acquireStartupLock(lockPath, {
      socketPath: join(dir, 'server.sock'),
      instanceId: 'first',
      isProcessAlive: async () => true,
      probe: async () => true,
    });
    const second = await acquireStartupLock(lockPath, {
      socketPath: join(dir, 'server.sock'),
      instanceId: 'second',
      isProcessAlive: async () => true,
      probe: async () => true,
    });
    assert.equal(first.acquired, true);
    assert.equal(second.acquired, false);
    await first.release();
    const third = await acquireStartupLock(lockPath, { instanceId: 'third' });
    assert.equal(third.acquired, true);
    await third.release();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ensureServer replaces a stale lock and waits for socket health', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-startup-stale-'));
  const lockPath = join(dir, 'server.lock');
  const socketPath = join(dir, 'server.sock');
  try {
    const started = [];
    const result = await ensureServer({
      socketPath,
      lockPath,
      probe: async () => started.length > 0,
      isProcessAlive: async () => false,
      startServer: async () => { started.push(true); },
      timeoutMs: 100,
      pollMs: 1,
    });
    assert.equal(result.started, true);
    assert.equal(started.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
