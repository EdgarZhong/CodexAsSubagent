import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { SqliteStore } from '../../src/adapters/sqlite/sqlite-store.mjs';
import { CompletionStore } from '../../src/core/completion-store.mjs';
import { CompletionRouter } from '../../src/core/completion-router.mjs';
import { ExecutionStore } from '../../src/core/execution-store.mjs';
import { RuntimeManager } from '../../src/core/runtime-manager.mjs';
import { LifecycleManager } from '../../src/server/lifecycle-manager.mjs';
import { RuntimeServer } from '../../src/server/server.mjs';
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

test('RuntimeServer arms idle shutdown from runtime state changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-idle-'));
  const socketPath = join(dir, 'server.sock');
  let active = 1;
  let emitStateChange = null;
  let closedResolve;
  const closed = new Promise((resolve) => { closedResolve = resolve; });
  const runtime = {
    executionStore: { listExecutions: () => (active > 0 ? [{}] : []) },
    completionStore: { listCompletions: () => [] },
    close() { return Promise.resolve(); },
    subscribeStateChanges(listener) {
      emitStateChange = listener;
      return () => { emitStateChange = null; };
    },
  };
  const server = new RuntimeServer({ runtime, idleShutdownMs: 5, onClosed: () => closedResolve() });
  try {
    await server.listen(socketPath);
    // listen 会先 arm 一次；活跃 execution 存在时不得退出。
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(server.closed, false);

    // 模拟异步 terminal 落地后 runtime 主动通知：此时才允许 idle 退出。
    active = 0;
    assert.equal(typeof emitStateChange, 'function');
    emitStateChange();
    await closed;
    assert.equal(server.closed, true);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('RuntimeManager.close terminates the supervisor adapter exactly once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-runtime-close-'));
  const store = SqliteStore.open(dir);
  const executions = new ExecutionStore(store);
  const completions = new CompletionStore(store);
  let adapterClosed = 0;
  const runtime = new RuntimeManager({
    adapter: {
      async startThread() { return { thread: { id: 'thread-stub' } }; },
      async close() { adapterClosed += 1; },
      subscribeRuntimeEvents() { return () => {}; },
    },
    executionStore: executions,
    completionStore: completions,
    completionRouter: new CompletionRouter({ executions, completions }),
    historyAdapter: { async readRecentTurns() { return { turns: [] }; } },
  });
  try {
    await runtime.close();
    await runtime.close();
    assert.equal(adapterClosed, 1);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
