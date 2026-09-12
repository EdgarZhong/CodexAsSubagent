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

const NOW = '2026-09-12T00:00:00.000Z';

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

test('recoverState turns an unreconciled execution into supervisor_crash completion with provenance', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-recovery-'));
  const store = SqliteStore.open(dir);
  const executions = new ExecutionStore(store);
  const completions = new CompletionStore(store);
  const router = new CompletionRouter({ executions, completions });
  executions.createExecution({
    threadId: 'thread-recover',
    turnId: 'turn-recover',
    host: 'kimi-code',
    workspace: '/workspace',
    sessionId: 'session-recover',
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
      clock: () => new Date(NOW),
    });
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].terminalStatus, 'failed');
    const completion = completions.listCompletions()[0];
    assert.equal(completion.payload.error.code, 'supervisor_crash');
    // synthetic failed 路径携带 Execution 的 (host, workspace, session) provenance。
    assert.equal(completion.host, 'kimi-code');
    assert.equal(completion.workspace, '/workspace');
    assert.equal(completion.sessionId, 'session-recover');
    assert.equal(executions.getExecutionByPhysicalThreadId('thread-recover'), null);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('recovery preserves current_session when a host scope has no active execution', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-recovery-preserve-'));
  const store = SqliteStore.open(dir);
  const executions = new ExecutionStore(store);
  const router = new CompletionRouter({ executions, completions: new CompletionStore(store) });
  store.sessionGateTransition({ host: 'kimi-code', workspace: '/workspace', sessionId: 'session-keep', now: NOW });
  // 对账完成后该 HostScope 无 active execution → current_session 保留（不清空）。
  try {
    await recoverState({
      executionStore: executions,
      completionRouter: router,
      historyAdapter: { async readRecentTurns() { return { turns: [] }; } },
      clock: () => new Date(NOW),
    });
    assert.equal(store.getCurrentSession({ host: 'kimi-code', workspace: '/workspace' }), 'session-keep');
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('recovery repairs current_session from the unique active execution of another instance', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-repair-'));
  const store = SqliteStore.open(dir);
  const executions = new ExecutionStore(store);
  const router = new CompletionRouter({ executions, completions: new CompletionStore(store) });
  // current_session 与唯一 active Execution 不一致（stale routing state）。
  store.sessionGateTransition({ host: 'kimi-code', workspace: '/workspace', sessionId: 'session-stale', now: NOW });
  executions.createExecution({
    threadId: 'thread-live',
    turnId: 'turn-live',
    host: 'kimi-code',
    workspace: '/workspace',
    sessionId: 'session-authoritative',
    ownerInstanceId: 'other-server',
  });
  try {
    await recoverState({
      executionStore: executions,
      completionRouter: router,
      historyAdapter: { async readRecentTurns() { return { turns: [] }; } },
      // 只对账 old-server 的 execution；other-server 的 active execution 保留，
      // current_session 以它为权威修复。
      ownerInstanceId: 'old-server',
      clock: () => new Date(NOW),
    });
    assert.equal(
      store.getCurrentSession({ host: 'kimi-code', workspace: '/workspace' }),
      'session-authoritative',
    );
    assert.notEqual(executions.getExecutionByPhysicalThreadId('thread-live'), null);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('recovery logs a session conflict without writing current_session, and never resets presence or holds', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-conflict-'));
  const store = SqliteStore.open(dir);
  const executions = new ExecutionStore(store);
  const router = new CompletionRouter({ executions, completions: new CompletionStore(store) });
  // 同一 Weak HostScope 出现两个不同 active Session：invariant violation。
  store.sessionGateTransition({ host: 'kimi-code', workspace: '/workspace', sessionId: 'session-old', now: NOW });
  executions.createExecution({
    threadId: 'thread-a',
    turnId: 'turn-a',
    host: 'kimi-code',
    workspace: '/workspace',
    sessionId: 'session-a',
    ownerInstanceId: 'other-server',
  });
  executions.createExecution({
    threadId: 'thread-b',
    turnId: 'turn-b',
    host: 'kimi-code',
    workspace: '/workspace',
    sessionId: 'session-b',
    ownerInstanceId: 'other-server',
  });
  // Presence 与 Hold 持久化：recovery 不得删除或重置。
  store.attachHostPresence({ host: 'kimi-code', workspace: '/workspace', instanceId: 'mcp-1', now: NOW, leaseMs: 60_000 });
  await store.acquireOrTakeoverThreadHold({
    threadId: 'thread-held-idle',
    workspace: '/workspace',
    holderHost: 'kimi-code',
    holdId: 'hold-keep',
    now: NOW,
    isHostAlive: () => false,
  });
  const warnings = [];
  const logger = { warn: (message, details) => warnings.push({ message, details }) };
  try {
    await recoverState({
      executionStore: executions,
      completionRouter: router,
      historyAdapter: { async readRecentTurns() { return { turns: [] }; } },
      ownerInstanceId: 'old-server',
      logger,
      clock: () => new Date(NOW),
    });
    // conflict 记录到 server.log（注入的 logger），且 current_session 不被写入。
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].message, 'recovery.session_conflict');
    assert.deepEqual(warnings[0].details.activeSessions.sort(), ['session-a', 'session-b']);
    assert.equal(
      store.getCurrentSession({ host: 'kimi-code', workspace: '/workspace' }),
      'session-old',
    );
    // presence/hold 完好。
    assert.equal(store.isHostAlive({ host: 'kimi-code', workspace: '/workspace', now: NOW }), true);
    const hold = store.getThreadHold('thread-held-idle');
    assert.equal(hold.holderHost, 'kimi-code');
    assert.equal(hold.holdId, 'hold-keep');
    // conflict 是派生状态：active Session 收敛到唯一后自动修复。
    store.db.prepare("DELETE FROM executions WHERE thread_id = 'thread-b'").run();
    const fixed = store.fixCurrentSessionFromExecutions({ host: 'kimi-code', workspace: '/workspace', now: NOW });
    assert.equal(fixed.fixed, true);
    assert.equal(store.getCurrentSession({ host: 'kimi-code', workspace: '/workspace' }), 'session-a');
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
