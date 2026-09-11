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

async function setup(t, { waitTimeoutMs = 45 } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'codex-as-subagent-task4-integration-'));
  const workspace = await mkdtemp(join(tmpdir(), 'codex-as-subagent-task4-integration-workspace-'));
  const calls = [];
  const threads = new Map();
  const turns = new Map();
  let sequence = 1;
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
      const turnId = `${input.threadId}-turn-${turns.size + 1}`;
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
  });
  t.after(async () => {
    runtime.close();
    store.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  });
  const ctx = { workspace };
  const emit = (event) => listener(normalizeEvent(event));
  return { runtime, store, executions, completions, adapter, calls, threads, turns, workspace, ctx, emit };
}

test('waitMany all snapshots active threads and excludes a later spawn', async (t) => {
  const harness = await setup(t);
  const first = await harness.runtime.spawn(harness.ctx, { prompt: 'first' });
  const waiting = harness.runtime.waitMany(harness.ctx, 'all');
  const later = await harness.runtime.spawn(harness.ctx, { prompt: 'later' });

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
  assert.doesNotMatch(JSON.stringify(result), /turnId|deliveryId|workspace/);
  assert.ok(harness.executions.getExecution(later.threadId));
  assert.equal(harness.completions.listCompletions()[0].deliveryState, 'claimed_direct');
  await harness.runtime.ackDelivery(result);
  assert.equal(harness.completions.listCompletions()[0].deliveryState, 'delivered');
});

test('waitMany keeps all completed rows claimed_direct until batch ACK and releases only unfinished reservations', async (t) => {
  const harness = await setup(t, { waitTimeoutMs: 35 });
  const a = await harness.runtime.spawn(harness.ctx, { prompt: 'a' });
  const b = await harness.runtime.spawn(harness.ctx, { prompt: 'b' });
  const c = await harness.runtime.spawn(harness.ctx, { prompt: 'c' });
  const waiting = harness.runtime.waitMany(harness.ctx, [a.threadId, b.threadId, c.threadId]);
  await new Promise((resolve) => setTimeout(resolve, 2));

  for (const [threadId, turnId, status] of [
    [a.threadId, harness.executions.getExecution(a.threadId).turnId, 'completed'],
    [b.threadId, harness.executions.getExecution(b.threadId).turnId, 'failed'],
  ]) {
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
  const rows = harness.completions.listCompletions();
  assert.deepEqual(rows.map((row) => row.deliveryState), ['claimed_direct', 'claimed_direct']);
  assert.equal(harness.executions.getExecution(c.threadId).reservationId, null);
  const deliveryIds = new Set(rows.map((row) => row.deliveryId));
  assert.equal(deliveryIds.size, 1);
  await harness.runtime.ackDelivery(result);
  assert.deepEqual(harness.completions.listCompletions().map((row) => row.deliveryState), ['delivered', 'delivered']);
});

test('waitMany validates the whole explicit set and fails closed on workspace mismatch', async (t) => {
  const harness = await setup(t);
  const otherWorkspace = await mkdtemp(join(tmpdir(), 'codex-as-subagent-task4-other-workspace-'));
  t.after(() => rm(otherWorkspace, { recursive: true, force: true }));
  harness.threads.set('foreign-thread', {
    id: 'foreign-thread',
    cwd: otherWorkspace,
    status: 'running',
  });
  await assert.rejects(
    harness.runtime.waitMany(harness.ctx, ['foreign-thread']),
    (error) => error.code === 'thread_workspace_mismatch',
  );
  assert.equal(harness.executions.listExecutions().length, 0);
});
