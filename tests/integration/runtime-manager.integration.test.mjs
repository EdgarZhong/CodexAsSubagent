import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { createFakeSupervisorAdapter } from '../../src/adapters/supervisor/app-server-adapter.mjs';
import { createHistoryAdapter } from '../../src/adapters/supervisor/history-adapter.mjs';
import { SqliteStore } from '../../src/adapters/sqlite/sqlite-store.mjs';
import { CompletionRouter } from '../../src/core/completion-router.mjs';
import { CompletionStore } from '../../src/core/completion-store.mjs';
import { ExecutionStore } from '../../src/core/execution-store.mjs';
import { ModelService } from '../../src/core/model-service.mjs';
import { RuntimeManager } from '../../src/core/runtime-manager.mjs';
import { WorkspaceGuard } from '../../src/core/workspace-guard.mjs';
import { normalizeEvent } from '../../src/adapters/supervisor/protocol-normalizer.mjs';

const BASE_NOW = Date.parse('2026-09-12T00:00:00.000Z');

async function setup(t, { waitTimeoutMs = 45 } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'codex-as-subagent-v2-integration-'));
  // 与生产一致：ctx.workspace 使用 canonical path（bootstrap 解析后的形态）。
  const workspace = await WorkspaceGuard.resolve(
    await mkdtemp(join(tmpdir(), 'codex-as-subagent-v2-integration-workspace-')),
  );
  const calls = [];
  const threads = new Map();
  const turns = new Map();
  let sequence = 1;
  let turnSequence = 1;
  let listener;
  const adapter = createFakeSupervisorAdapter({
    async startThread(input) {
      const threadId = `integration-thread-${sequence++}`;
      const thread = { id: threadId, cwd: input.workspace, title: threadId, status: 'running' };
      threads.set(threadId, thread);
      calls.push(['startThread', input]);
      return { thread };
    },
    async resumeThread(input) {
      calls.push(['resumeThread', input]);
      return { thread: threads.get(input.threadId) };
    },
    async startTurn(input) {
      const turnId = `${input.threadId}-turn-${turnSequence++}`;
      calls.push(['startTurn', input]);
      turns.set(turnId, { id: turnId, threadId: input.threadId });
      return { threadId: input.threadId, turnId, turn: { id: turnId, status: 'inProgress' } };
    },
    async steerTurn(input) {
      calls.push(['steerTurn', input]);
      return { threadId: input.threadId, turnId: input.expectedTurnId };
    },
    async interruptTurn(input) {
      calls.push(['interruptTurn', input]);
      return { threadId: input.threadId, interrupted: true };
    },
    async listThreads(input) {
      return { threads: [...threads.values()].filter((thread) => thread.cwd === input.workspace), nextCursor: null };
    },
    async readThreadMetadata(threadId) {
      return threads.get(threadId) ?? null;
    },
    async readRecentTurns(threadId) {
      return { turns: [...turns.values()].filter((turn) => turn.threadId === threadId) };
    },
    async listModels() {
      return [{ id: 'gpt-5.6-luna', supportedReasoningEfforts: ['xhigh'] }];
    },
    async readEffectiveConfig() {
      return { model: 'gpt-5.6-luna', model_reasoning_effort: 'xhigh' };
    },
    subscribeRuntimeEvents(callback) {
      listener = callback;
      return () => { if (listener === callback) listener = null; };
    },
  });
  const store = SqliteStore.open(dataDir);
  const executions = new ExecutionStore(store);
  const completions = new CompletionStore(store);
  const runtime = new RuntimeManager({
    adapter,
    workspaceGuard: new WorkspaceGuard(),
    modelService: new ModelService({
      adapter,
      models: [{ id: 'gpt-5.6-luna', supportedReasoningEfforts: ['xhigh'] }],
      effectiveConfig: { model: 'gpt-5.6-luna', model_reasoning_effort: 'xhigh' },
    }),
    executionStore: executions,
    completionStore: completions,
    completionRouter: new CompletionRouter({ executions, completions }),
    historyAdapter: createHistoryAdapter(adapter),
    waitTimeoutMs,
    clock: () => new Date(BASE_NOW),
  });
  t.after(async () => {
    runtime.close();
    store.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  });
  // ctx.host/workspace 由 bootstrap 提供（T3）；SessionContext 经 runtime 解析。
  const contextFor = (host) => ({ host, workspace });
  const establishSession = (host, sessionId) => {
    store.sessionGateTransition({ host, workspace, sessionId, now: new Date(BASE_NOW).toISOString() });
  };
  establishSession('kimi-code', 'kimi-session');
  establishSession('zcode', 'zcode-session');
  const emit = (event) => listener(normalizeEvent(event));
  const executionOf = (threadId, host) => executions.listExecutions({ host })
    .find((entry) => entry.threadId === threadId) ?? null;
  return {
    runtime, store, executions, completions, adapter, calls, threads, turns,
    workspace, contextFor, establishSession, emit, executionOf,
  };
}

test('waitMany all snapshots active threads and excludes a later spawn', async (t) => {
  const harness = await setup(t);
  const ctx = harness.contextFor('kimi-code');
  const first = await harness.runtime.spawn(ctx, { prompt: 'first' });
  const waiting = harness.runtime.waitMany(ctx, 'all');
  const later = await harness.runtime.spawn(ctx, { prompt: 'later' });

  harness.emit({
    type: 'turn/completed',
    threadId: first.threadId,
    turnId: `${first.threadId}-turn-1`,
    turn: { id: `${first.threadId}-turn-1`, status: 'completed', finalAssistantMessage: 'first done' },
  });
  const result = await waiting;
  assert.deepEqual(result.completed.map((entry) => entry.toJSON().threadId), [first.threadId]);
  assert.deepEqual(result.pending, []);
  assert.equal(result.timedOut, false);
  assert.doesNotMatch(JSON.stringify(result), /turnId|claimId|workspace/);
  assert.ok(harness.executionOf(later.threadId, 'kimi-code'));
  assert.equal(harness.completions.listCompletions({ host: 'kimi-code' })[0].deliveryState, 'claimed_waiter');
  await harness.runtime.ackClaim(harness.runtime.claimIdFor(result), 'kimi-code');
  assert.equal(harness.completions.listCompletions({ host: 'kimi-code' })[0].deliveryState, 'delivered');
});

test('waitMany keeps all completed rows claimed_waiter until batch ACK and releases only unfinished reservations', async (t) => {
  const harness = await setup(t, { waitTimeoutMs: 35 });
  const ctx = harness.contextFor('kimi-code');
  const a = await harness.runtime.spawn(ctx, { prompt: 'a' });
  const b = await harness.runtime.spawn(ctx, { prompt: 'b' });
  const c = await harness.runtime.spawn(ctx, { prompt: 'c' });
  const waiting = harness.runtime.waitMany(ctx, [a.threadId, b.threadId, c.threadId]);
  await new Promise((resolve) => setTimeout(resolve, 2));

  for (const [threadId, status] of [
    [a.threadId, 'completed'],
    [b.threadId, 'failed'],
  ]) {
    const turnId = harness.executionOf(threadId, 'kimi-code').turnId;
    harness.emit({
      type: status === 'completed' ? 'turn/completed' : 'turn/failed',
      threadId,
      turnId,
      turn: { id: turnId, status, finalAssistantMessage: `${threadId} done` },
    });
  }
  const result = await waiting;
  assert.deepEqual(result.completed.map((entry) => entry.toJSON().threadId), [a.threadId, b.threadId]);
  assert.deepEqual(result.pending.map((entry) => entry.threadId), [c.threadId]);
  assert.equal(result.timedOut, true);
  const rows = harness.completions.listCompletions({ host: 'kimi-code' });
  assert.deepEqual(rows.map((row) => row.deliveryState), ['claimed_waiter', 'claimed_waiter']);
  assert.equal(harness.executionOf(c.threadId, 'kimi-code').reservationId, null);
  const claimIds = new Set(rows.map((row) => row.claimId));
  assert.equal(claimIds.size, 1);
  await harness.runtime.ackClaim(harness.runtime.claimIdFor(result), 'kimi-code');
  assert.deepEqual(
    harness.completions.listCompletions({ host: 'kimi-code' }).map((row) => row.deliveryState),
    ['delivered', 'delivered'],
  );
});

test('waitMany validates the whole explicit set and fails closed on workspace mismatch', async (t) => {
  const harness = await setup(t);
  const ctx = harness.contextFor('kimi-code');
  const otherWorkspace = await mkdtemp(join(tmpdir(), 'codex-as-subagent-v2-other-workspace-'));
  t.after(() => rm(otherWorkspace, { recursive: true, force: true }));
  harness.threads.set('foreign-thread', {
    id: 'foreign-thread',
    cwd: otherWorkspace,
    status: 'running',
  });
  await assert.rejects(
    harness.runtime.waitMany(ctx, ['foreign-thread']),
    (error) => error.code === 'thread_workspace_mismatch',
  );
  assert.equal(harness.executions.listExecutions({ host: 'kimi-code' }).length, 0);
});

test('same workspace dual hosts are isolated: hold, visibility and wait provenance', async (t) => {
  const harness = await setup(t);
  const kimi = harness.contextFor('kimi-code');
  const zcode = harness.contextFor('zcode');

  // kimi spawn：execution/hold 归属 kimi-code + kimi session。
  const spawned = await harness.runtime.spawn(kimi, { prompt: 'kimi work' });
  const execution = harness.executionOf(spawned.threadId, 'kimi-code');
  assert.equal(execution.host, 'kimi-code');
  assert.equal(execution.sessionId, 'kimi-session');
  assert.equal(harness.store.getThreadHold(spawned.threadId).holderHost, 'kimi-code');

  // zcode 观察：send/steer/interrupt/wait/status 全部 thread_held，hold 不被夺取。
  for (const attempt of [
    () => harness.runtime.send(zcode, { threadId: spawned.threadId, prompt: 'steal' }),
    () => harness.runtime.steer(zcode, { threadId: spawned.threadId, prompt: 'steer' }),
    () => harness.runtime.interrupt(zcode, spawned.threadId),
    () => harness.runtime.wait(zcode, spawned.threadId),
    () => harness.runtime.status(zcode, spawned.threadId),
    () => harness.runtime.readThread(zcode, spawned.threadId),
  ]) {
    await assert.rejects(attempt, (error) => {
      assert.equal(error.code, 'thread_held');
      assert.deepEqual(error.data, { holderHost: 'kimi-code' });
      return true;
    });
  }

  // zcode listThreads 不可见 kimi 正在持有的 thread；kimi 自己可见。
  const zcodeList = await harness.runtime.listThreads(zcode);
  assert.equal(zcodeList.threads.some((entry) => entry.threadId === spawned.threadId), false);
  const kimiList = await harness.runtime.listThreads(kimi);
  assert.equal(kimiList.threads.some((entry) => entry.threadId === spawned.threadId), true);

  // waitMany 'all' 只包含 caller 自己的 execution。
  const zcodeWaitAll = await harness.runtime.waitMany(zcode, 'all');
  assert.deepEqual(zcodeWaitAll, { completed: [], pending: [], timedOut: false });

  // kimi 的 turn terminal 后，pending completion 的 session 归属固化。
  harness.emit({
    type: 'turn/completed',
    threadId: spawned.threadId,
    turnId: execution.turnId,
    turn: { id: execution.turnId, status: 'completed', finalAssistantMessage: 'kimi answer' },
  });
  await Promise.resolve();
  const pendingCompletion = harness.completions.listCompletions({
    host: 'kimi-code', sessionId: 'kimi-session',
  })[0];
  assert.equal(pendingCompletion.payload.finalAssistantMessage, 'kimi answer');

  // kimi hold 仍在（idle thread 依然由 kimi 持有），但 kimi presence 从未注册，
  // zcode send 走 stale takeover：新 execution 归 zcode + zcode session。
  const takeover = await harness.runtime.send(zcode, { threadId: spawned.threadId, prompt: 'zcode turn' });
  assert.equal(takeover.threadId, spawned.threadId);
  const zcodeExecution = harness.executionOf(spawned.threadId, 'zcode');
  assert.equal(zcodeExecution.sessionId, 'zcode-session');
  assert.equal(harness.store.getThreadHold(spawned.threadId).holderHost, 'zcode');

  // zcode 先对自己刚启动的 turn reserve direct wait；随后 terminal 只会返回
  // zcode 自己的 completion，kimi 留下的 pending 归 kimi（Direct Wait session 谓词）。
  const zcodeWaiting = harness.runtime.wait(zcode, spawned.threadId);
  await new Promise((resolve) => setTimeout(resolve, 2));
  harness.emit({
    type: 'turn/completed',
    threadId: spawned.threadId,
    turnId: zcodeExecution.turnId,
    turn: { id: zcodeExecution.turnId, status: 'completed', finalAssistantMessage: 'zcode answer' },
  });
  const zcodeWait = await zcodeWaiting;
  assert.equal(zcodeWait.toJSON().finalAssistantMessage, 'zcode answer');
  // kimi 的 pending completion 未被 zcode 的 direct wait 消费。
  const stillPending = harness.completions.listCompletions({
    host: 'kimi-code', sessionId: 'kimi-session', deliveryState: 'pending',
  });
  assert.equal(stillPending.length, 1);
  assert.equal(stillPending[0].payload.finalAssistantMessage, 'kimi answer');
});

test('same host dual sessions are isolated by the weak-host session state machine', async (t) => {
  const harness = await setup(t);
  const host = 'kimi-code';
  const ctx = harness.contextFor(host);

  // Session A spawn 并 terminal，留下 session A 的 pending completion。
  const spawned = await harness.runtime.spawn(ctx, { prompt: 'session a work' });
  const execution = harness.executionOf(spawned.threadId, host);
  harness.emit({
    type: 'turn/completed',
    threadId: spawned.threadId,
    turnId: execution.turnId,
    turn: { id: execution.turnId, status: 'completed', finalAssistantMessage: 'for a' },
  });
  await Promise.resolve();

  // Session B 接管 current_session（A 已无 active execution）。
  harness.establishSession(host, 'session-b');
  // B send 同一 idle thread：Execution 固化为 session B。
  await harness.runtime.send(ctx, { threadId: spawned.threadId, prompt: 'session b work' });
  const nextExecution = harness.executionOf(spawned.threadId, host);
  assert.equal(nextExecution.sessionId, 'session-b');

  // 同一 (host, workspace) 有 active execution 时，其他 Session 被 Session Gate veto。
  const veto = harness.store.sessionGateTransition({ host, workspace: harness.workspace, sessionId: 'session-c', now: new Date(BASE_NOW).toISOString() });
  assert.equal(veto.decision, 'veto');

  // B terminal 后，B 的 direct wait 只 claim B 的 completion；A 的 pending 保留给 A。
  harness.emit({
    type: 'turn/completed',
    threadId: spawned.threadId,
    turnId: nextExecution.turnId,
    turn: { id: nextExecution.turnId, status: 'completed', finalAssistantMessage: 'for b' },
  });
  await Promise.resolve();
  const waitB = await harness.runtime.wait(ctx, spawned.threadId);
  assert.equal(waitB.toJSON().finalAssistantMessage, 'for b');
  assert.equal(
    harness.completions.listCompletions({ host, sessionId: 'session-b', deliveryState: 'pending' }).length,
    0,
  );
});
