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

async function setup(t, { waitTimeoutMs = 40 } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'codex-as-subagent-task4-unit-'));
  const workspace = await mkdtemp(join(tmpdir(), 'codex-as-subagent-task4-workspace-'));
  const calls = [];
  const threads = new Map();
  const turns = new Map();
  let nextThread = 1;
  let nextTurn = 1;
  let listener = null;
  const adapter = createFakeSupervisorAdapter({
    async startThread(input) {
      const threadId = `thread-${nextThread++}`;
      threads.set(threadId, {
        id: threadId,
        cwd: input.workspace,
        title: `Thread ${threadId}`,
        status: 'running',
        createdAt: '2026-09-11T00:00:00.000Z',
        updatedAt: '2026-09-11T00:00:00.000Z',
      });
      calls.push(['startThread', input]);
      return { thread: threads.get(threadId) };
    },
    async resumeThread(input) {
      calls.push(['resumeThread', input]);
      const thread = threads.get(input.threadId);
      return thread ? { thread } : null;
    },
    async startTurn(input) {
      const turnId = `turn-${nextTurn++}`;
      calls.push(['startTurn', input]);
      turns.set(turnId, { id: turnId, threadId: input.threadId, prompt: input.prompt });
      const thread = threads.get(input.threadId);
      if (thread) {
        thread.status = 'running';
        thread.updatedAt = '2026-09-11T00:00:01.000Z';
      }
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
      calls.push(['listThreads', input]);
      return {
        threads: [...threads.values()].filter((thread) => thread.cwd === input.workspace),
        nextCursor: null,
      };
    },
    async readThreadMetadata(threadId) {
      calls.push(['readThreadMetadata', threadId]);
      return threads.get(threadId) ?? null;
    },
    async readRecentTurns(threadId, options = {}) {
      calls.push(['readRecentTurns', threadId, options]);
      return { turns: [...turns.values()]
        .filter((turn) => turn.threadId === threadId)
        .map((turn) => turn.history ?? { id: turn.id, status: 'completed' }) };
    },
    async listModels() {
      return [{ id: 'gpt-5.6-luna', supportedReasoningEfforts: ['xhigh', 'high'] }];
    },
    async readEffectiveConfig() {
      return { model: 'gpt-5.6-luna', model_reasoning_effort: 'xhigh' };
    },
    subscribeRuntimeEvents(callback) {
      listener = callback;
      return () => {
        if (listener === callback) listener = null;
      };
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
      models: [{ id: 'gpt-5.6-luna', supportedReasoningEfforts: ['xhigh', 'high'] }],
      effectiveConfig: { model: 'gpt-5.6-luna', model_reasoning_effort: 'xhigh' },
    }),
    executionStore: executions,
    completionStore: completions,
    completionRouter: new CompletionRouter({ executions, completions }),
    historyAdapter: createHistoryAdapter(adapter),
    waitTimeoutMs,
    clock: () => new Date(),
  });
  t.after(async () => {
    runtime.close();
    store.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  });

  const ctx = { workspace };
  const emit = (event) => {
    assert.equal(typeof listener, 'function');
    listener(normalizeEvent(event));
  };
  const emitNormalized = (event) => {
    assert.equal(typeof listener, 'function');
    listener(event);
  };
  return { runtime, store, executions, completions, adapter, calls, threads, turns, workspace, ctx, emit, emitNormalized };
}

async function spawn(harness, prompt = 'do work') {
  return await harness.runtime.spawn(harness.ctx, { prompt });
}

function json(value) {
  return JSON.stringify(value);
}

test('RuntimeManager.spawn returns an immediate public ACK and persists model/effort', async (t) => {
  const harness = await setup(t);
  const ack = await spawn(harness);

  assert.deepEqual(ack, {
    threadId: 'thread-1',
    status: 'running',
    model: 'gpt-5.6-luna',
    effort: 'xhigh',
    startedAt: ack.startedAt,
  });
  assert.equal('turnId' in ack, false);
  assert.equal('deliveryId' in ack, false);
  assert.match(ack.startedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(harness.executions.getExecution('thread-1').model, 'gpt-5.6-luna');
  assert.deepEqual(harness.executions.getExecution('thread-1').effort, 'xhigh');
  assert.deepEqual(harness.calls.map(([name]) => name), ['startThread', 'startTurn']);
  assert.doesNotMatch(json(ack), /turnId|deliveryId|workspace/);
});

test('send resumes an idle thread with persisted model/effort and rejects a busy thread', async (t) => {
  const harness = await setup(t);
  const first = await spawn(harness);

  await assert.rejects(
    harness.runtime.send(harness.ctx, { threadId: first.threadId, prompt: 'parallel work' }),
    (error) => error.code === 'thread_busy',
  );
  assert.equal(harness.calls.filter(([name]) => name === 'resumeThread').length, 0);

  harness.emit({
    type: 'turn/completed',
    threadId: first.threadId,
    turnId: 'turn-1',
    turn: { id: 'turn-1', status: 'completed', finalAssistantMessage: 'done' },
  });
  await Promise.resolve();
  const second = await harness.runtime.send(harness.ctx, { threadId: first.threadId, prompt: 'continue' });

  assert.equal(second.threadId, first.threadId);
  assert.equal(second.status, 'running');
  assert.equal(second.model, 'gpt-5.6-luna');
  assert.equal(second.effort, 'xhigh');
  assert.equal('turnId' in second, false);
  assert.equal(harness.calls.filter(([name]) => name === 'resumeThread').length, 1);
  assert.equal(harness.calls.filter(([name]) => name === 'startTurn').length, 2);
});

test('steer requires an active turn and never exposes the internal turn id', async (t) => {
  const harness = await setup(t);
  const ack = await spawn(harness);

  assert.deepEqual(await harness.runtime.steer(harness.ctx, {
    threadId: ack.threadId,
    prompt: 'focus on the failing test',
  }), { threadId: ack.threadId, accepted: true, status: 'running' });
  const steerCall = harness.calls.find(([name]) => name === 'steerTurn');
  assert.equal(steerCall[1].expectedTurnId, 'turn-1');
  assert.doesNotMatch(json(steerCall[1]), /workspace/);

  harness.emit({
    type: 'turn/completed',
    threadId: ack.threadId,
    turnId: 'turn-1',
    turn: { id: 'turn-1', status: 'completed' },
  });
  await Promise.resolve();
  await assert.rejects(
    harness.runtime.steer(harness.ctx, { threadId: ack.threadId, prompt: 'too late' }),
    (error) => error.code === 'no_active_turn',
  );
});

test('interrupt is an ACK only and does not synthesize a terminal result', async (t) => {
  const harness = await setup(t);
  const ack = await spawn(harness);
  const interrupt = await harness.runtime.interrupt(harness.ctx, ack.threadId);

  assert.equal(interrupt.threadId, ack.threadId);
  assert.equal(interrupt.interruptRequested, true);
  assert.match(interrupt.requestedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal('turnId' in interrupt, false);
  assert.equal(harness.completions.listCompletions().length, 0);
  assert.ok(harness.executions.getExecution(ack.threadId));
  assert.equal(harness.calls.find(([name]) => name === 'interruptTurn')[1].turnId, 'turn-1');
});

test('terminal before wait is claimed through CompletionRouter and ACKed explicitly', async (t) => {
  const harness = await setup(t);
  const ack = await spawn(harness);
  harness.emit({
    type: 'turn/completed',
    threadId: ack.threadId,
    turnId: 'turn-1',
    turn: {
      id: 'turn-1',
      status: 'completed',
      finalAssistantMessage: 'finished',
      fileChanges: [{ path: 'src/a.mjs', kind: 'modified' }],
    },
  });
  await Promise.resolve();

  const result = await harness.runtime.wait(harness.ctx, ack.threadId);
  assert.equal(result.constructor.name, 'TerminalResult');
  assert.deepEqual(result.toJSON(), {
    threadId: ack.threadId,
    status: 'completed',
    finalAssistantMessage: 'finished',
    changes: {
      files: [{ path: 'src/a.mjs', kind: 'modified' }],
      filesChanged: 1,
      filesTruncated: false,
    },
    error: null,
  });
  assert.doesNotMatch(json(result), /turnId|deliveryId/);
  const completion = harness.completions.listCompletions()[0];
  assert.equal(completion.deliveryState, 'claimed_direct');
  assert.equal(await harness.runtime.ackDelivery(result), true);
  assert.equal(harness.completions.getCompletion(completion.completionId).deliveryState, 'delivered');
});

test('wait reserves before terminal, wakes from durable completion, and does not interrupt on timeout', async (t) => {
  const harness = await setup(t, { waitTimeoutMs: 35 });
  const ack = await spawn(harness);
  const waiting = harness.runtime.wait(harness.ctx, ack.threadId);
  await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(harness.executions.getExecution(ack.threadId).reservationKind, 'direct');

  harness.emit({
    type: 'turn/interrupted',
    threadId: ack.threadId,
    turnId: 'turn-1',
    turn: { id: 'turn-1', status: 'interrupted', lastAssistantMessage: 'stopped' },
  });
  const result = await waiting;
  assert.equal(result.toJSON().status, 'interrupted');
  assert.equal(harness.calls.filter(([name]) => name === 'interruptTurn').length, 0);
  assert.equal(harness.completions.listCompletions()[0].deliveryState, 'claimed_direct');
  await harness.runtime.ackDelivery(result);
  assert.equal(harness.completions.listCompletions()[0].deliveryState, 'delivered');

  const second = await harness.runtime.send(harness.ctx, { threadId: ack.threadId, prompt: 'again' });
  const timedOut = await harness.runtime.wait(harness.ctx, second.threadId);
  assert.equal(timedOut.timedOut, true);
  assert.equal(timedOut.status, 'running');
  assert.equal(harness.executions.getExecution(second.threadId).reservationId, null);
  assert.equal(harness.calls.filter(([name]) => name === 'interruptTurn').length, 0);
});

test('status updates liveness previews with the 200/600 caps and filesChanged', async (t) => {
  const harness = await setup(t);
  const ack = await spawn(harness);
  harness.emitNormalized({
    type: 'assistant.delta',
    threadId: ack.threadId,
    internalTurnId: 'turn-1',
    assistantMessage: 'x'.repeat(800),
  });
  harness.emitNormalized({
    type: 'item.completed',
    threadId: ack.threadId,
    internalTurnId: 'turn-1',
    latestAction: 'y'.repeat(300),
    changes: { files: [{ path: 'a' }, { path: 'b' }], filesChanged: 2, filesTruncated: false },
  });

  const snapshot = await harness.runtime.status(harness.ctx, ack.threadId);
  assert.equal(snapshot.status, 'running');
  assert.equal(snapshot.latestAssistantPreview.length, 600);
  assert.equal(snapshot.latestAction.length, 200);
  assert.equal(snapshot.filesChanged, 2);
  assert.equal(Number.isInteger(snapshot.idleForSec), true);
  assert.doesNotMatch(json(snapshot), /turnId|internalTurnId|eventCursor/);
});

test('listThreads filters current workspace and readThread returns compact history', async (t) => {
  const harness = await setup(t);
  const first = await spawn(harness);
  const thread = harness.threads.get(first.threadId);
  const turn = harness.turns.get('turn-1');
  turn.history = {
    id: 'turn-1',
    status: 'completed',
    finalAssistantMessage: 'history answer',
    fileChanges: [{ path: 'src/current.mjs', kind: 'added' }],
    internalSecret: 'must not leak',
  };
  const other = 'thread-other';
  harness.threads.set(other, {
    id: other,
    cwd: '/definitely-not-the-current-workspace',
    title: 'other',
    status: 'completed',
  });
  thread.status = 'completed';
  thread.updatedAt = '2026-09-11T00:00:02.000Z';

  const listed = await harness.runtime.listThreads(harness.ctx);
  assert.equal(listed.total, 1);
  assert.equal(listed.truncated, false);
  assert.deepEqual(listed.threads.map((entry) => entry.threadId), [first.threadId]);
  assert.doesNotMatch(json(listed), /cwd|turnId|internalSecret/);

  const read = await harness.runtime.readThread(harness.ctx, first.threadId);
  assert.equal(read.threadId, first.threadId);
  assert.deepEqual(read.assistantMessages, ['history answer']);
  assert.equal(read.changes.filesChanged, 1);
  assert.deepEqual(read.changes.files, [{ path: 'src/current.mjs', kind: 'added' }]);
  assert.doesNotMatch(json(read), /turnId|internalSecret/);
});

test('models returns a stable public catalog and synthetic default-model errors', async (t) => {
  const harness = await setup(t);
  assert.deepEqual(await harness.runtime.models(harness.ctx), {
    default: { model: 'gpt-5.6-luna', effort: 'xhigh' },
    models: [{ id: 'gpt-5.6-luna', supportedEfforts: ['xhigh', 'high'] }],
  });

  const unavailable = new RuntimeManager({
    adapter: harness.adapter,
    workspaceGuard: new WorkspaceGuard(),
    modelService: new ModelService({ models: [], effectiveConfig: {} }),
    executionStore: harness.executions,
    completionStore: harness.completions,
    completionRouter: new CompletionRouter({ executions: harness.executions, completions: harness.completions }),
    historyAdapter: createHistoryAdapter(harness.adapter),
  });
  t.after(() => unavailable.close());
  await assert.rejects(unavailable.models(harness.ctx), (error) => error.code === 'default_model_unavailable');
});
