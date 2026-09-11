import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { SqliteStore } from '../../src/adapters/sqlite/sqlite-store.mjs';
import { CompletionStore } from '../../src/core/completion-store.mjs';
import { CompletionRouter } from '../../src/core/completion-router.mjs';
import { ExecutionStore } from '../../src/core/execution-store.mjs';
import { LifecycleManager } from '../../src/server/lifecycle-manager.mjs';
import { recoverState } from '../../src/server/recovery.mjs';

test('LifecycleManager ignores pending completions but blocks while execution is active', async () => {
  let active = 1;
  let unacked = 0;
  let shutdowns = 0;
  const lifecycle = new LifecycleManager({
    idleShutdownMs: 5,
    getActiveExecutionCount: () => active,
    getUnackedDirectCount: () => unacked,
    onShutdown: async () => { shutdowns += 1; },
  });
  lifecycle.noteRequestStart();
  lifecycle.noteRequestEnd();
  assert.equal(lifecycle.maybeShutdown(), false);
  active = 0;
  assert.equal(lifecycle.maybeShutdown(), true);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(shutdowns, 1);
  unacked = 1;
  assert.equal(lifecycle.maybeShutdown(), false);
  lifecycle.close();
});

test('recoverState turns an unreconciled execution into supervisor_crash completion', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-recovery-'));
  const store = SqliteStore.open(dir);
  const executions = new ExecutionStore(store);
  const completions = new CompletionStore(store);
  const router = new CompletionRouter({ executions, completions });
  executions.createExecution({
    threadId: 'thread-recover',
    turnId: 'turn-recover',
    workspace: '/workspace',
    ownerInstanceId: 'old-server',
    model: 'gpt-5.6-luna',
    effort: 'xhigh',
  });
  try {
    const recovered = await recoverState({
      executionStore: executions,
      completionRouter: router,
      historyAdapter: { async readRecentTurns() { return { turns: [] }; } },
      ownerInstanceId: 'old-server',
    });
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].terminalStatus, 'failed');
    assert.equal(completions.listCompletions()[0].payload.error.code, 'supervisor_crash');
    assert.equal(executions.getExecution('thread-recover'), null);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
