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

const HOST = 'zcode';
const FOREIGN_HOST = 'kimi-code';
const SESSION = 'session-z';
const BASE_NOW = Date.parse('2026-09-12T00:00:00.000Z');

async function setup(t, { waitTimeoutMs = 40 } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'codex-as-subagent-v2-unit-'));
  // 与生产一致：bootstrap/Hook 侧先做 canonical resolution，current_sessions 以
  // canonical workspace 为 key（macOS 上 /var → /private/var）。
  const workspace = await WorkspaceGuard.resolve(await mkdtemp(join(tmpdir(), 'codex-as-subagent-v2-workspace-')));
  const calls = [];
  const threads = new Map();
  const turns = new Map();
  let nextThread = 1;
  let nextTurn = 1;
  let listener = null;
  let now = BASE_NOW;
  let startTurnBehavior = null;
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
      calls.push(['startTurn', input]);
      if (startTurnBehavior) return await startTurnBehavior(input);
      const turnId = `turn-${nextTurn++}`;
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
    clock: () => new Date(now),
  });
  t.after(async () => {
    runtime.close();
    store.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  });

  const establishSession = (sessionId = SESSION) => {
    store.sessionGateTransition({ host: HOST, workspace, sessionId, now: new Date(now).toISOString() });
  };
  establishSession();
  const ctx = { host: HOST, workspace };
  const emit = (event) => {
    assert.equal(typeof listener, 'function');
    listener(normalizeEvent(event));
  };
  const emitNormalized = (event) => {
    assert.equal(typeof listener, 'function');
    listener(event);
  };
  // 测试辅助：直接注册 fake adapter 中的外部 thread（绕过 spawn）。
  const registerThread = (threadId) => {
    threads.set(threadId, {
      id: threadId,
      cwd: workspace,
      title: threadId,
      status: 'idle',
      createdAt: '2026-09-11T00:00:00.000Z',
      updatedAt: '2026-09-11T00:00:00.000Z',
    });
  };
  // 测试辅助：host 域内 active execution 查找。
  const executionOf = (threadId, host = HOST) => executions.listExecutions({ host })
    .find((entry) => entry.threadId === threadId) ?? null;
  return {
    runtime, store, executions, completions, adapter, calls, threads, turns,
    workspace, ctx, emit, emitNormalized, registerThread, executionOf,
    establishSession,
    setNow: (value) => { now = value; },
    now: () => now,
    setStartTurnBehavior: (behavior) => { startTurnBehavior = behavior; },
  };
}

async function spawn(harness, prompt = 'do work') {
  return await harness.runtime.spawn(harness.ctx, { prompt });
}

function iso(value) {
  return new Date(value).toISOString();
}

function json(value) {
  return JSON.stringify(value);
}

test('RuntimeManager.spawn returns an immediate public ACK and persists model/effort with provenance', async (t) => {
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
  const execution = harness.executionOf('thread-1');
  assert.equal(execution.model, 'gpt-5.6-luna');
  assert.equal(execution.effort, 'xhigh');
  assert.equal(execution.host, HOST);
  assert.equal(execution.workspace, harness.workspace);
  assert.equal(execution.sessionId, SESSION);
  // spawn 取得 Thread Hold（§1.6）。
  const hold = harness.store.getThreadHold('thread-1');
  assert.equal(hold.holderHost, HOST);
  assert.equal(hold.workspace, harness.workspace);
  assert.deepEqual(harness.calls.map(([name]) => name), ['startThread', 'startTurn']);
  assert.doesNotMatch(json(ack), /turnId|deliveryId|workspace/);
});

test('runtime requests fail closed with session_not_established before any CAS state change', async (t) => {
  const harness = await setup(t);
  // 模拟 current_session 未建立：直接删除 routing state。
  harness.store.db.prepare('DELETE FROM current_sessions').run();
  await assert.rejects(
    harness.runtime.spawn(harness.ctx, { prompt: 'work' }),
    (error) => {
      assert.equal(error.code, 'session_not_established');
      assert.match(error.message, /PreToolUse Session Gate/);
      return true;
    },
  );
  await assert.rejects(
    harness.runtime.send(harness.ctx, { threadId: 'thread-x' }),
    (error) => error.code === 'session_not_established',
  );
  await assert.rejects(
    harness.runtime.models(harness.ctx),
    (error) => error.code === 'session_not_established',
  );
  await assert.rejects(
    harness.runtime.listThreads(harness.ctx),
    (error) => error.code === 'session_not_established',
  );
  // fail closed：没有创建任何 Codex thread、execution 或 hold。
  assert.deepEqual(harness.calls, []);
  assert.equal(harness.executions.listExecutions({ host: HOST }).length, 0);
  assert.equal(harness.store.getThreadHold('thread-x'), null);
});

test('spawn releases only its own newly acquired hold when startTurn fails, and the next spawn keeps its hold', async (t) => {
  const harness = await setup(t);
  harness.setStartTurnBehavior(async () => {
    throw new Error('turn refused');
  });
  await assert.rejects(spawn(harness), (error) => error.code === 'supervisor_unavailable');
  // 失败创建流程不得留下新有效 Host Hold（§1.6/§1.8）。
  assert.equal(harness.store.getThreadHold('thread-1'), null);
  assert.equal(harness.executions.listExecutions({ host: HOST }).length, 0);

  harness.setStartTurnBehavior(null);
  const ack = await spawn(harness);
  const hold = harness.store.getThreadHold(ack.threadId);
  assert.equal(hold.holderHost, HOST);
  assert.equal(hold.holdId, harness.store.getThreadHold(ack.threadId).holdId);
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

test('send B: an active execution of another host yields thread_held with holderHost', async (t) => {
  const harness = await setup(t);
  harness.registerThread('thread-foreign-busy');
  harness.store.createExecution({
    host: FOREIGN_HOST,
    workspace: harness.workspace,
    sessionId: 'session-k',
    threadId: 'thread-foreign-busy',
    turnId: 'turn-k1',
    ownerInstanceId: 'foreign',
    now: iso(harness.now()),
  });
  await assert.rejects(
    harness.runtime.send(harness.ctx, { threadId: 'thread-foreign-busy', prompt: 'hi' }),
    (error) => {
      assert.equal(error.code, 'thread_held');
      assert.equal(error.message, 'Thread is currently held by another host.');
      assert.deepEqual(error.data, { holderHost: FOREIGN_HOST });
      return true;
    },
  );
  assert.equal(harness.calls.filter(([name]) => name === 'resumeThread').length, 0);
  // 绝不能 takeover。
  assert.equal(harness.store.getThreadHold('thread-foreign-busy'), null);
});

test('send C: an idle thread without hold acquires one and records session provenance', async (t) => {
  const harness = await setup(t);
  harness.registerThread('thread-idle-c');
  const result = await harness.runtime.send(harness.ctx, { threadId: 'thread-idle-c', prompt: 'resume' });

  assert.equal(result.status, 'running');
  const hold = harness.store.getThreadHold('thread-idle-c');
  assert.equal(hold.holderHost, HOST);
  const execution = harness.executionOf('thread-idle-c');
  assert.equal(execution.host, HOST);
  assert.equal(execution.sessionId, SESSION);
  assert.equal(execution.workspace, harness.workspace);
});

test('send D: a pre-existing own hold is reused and never released on startTurn failure', async (t) => {
  const harness = await setup(t);
  const first = await spawn(harness);
  harness.emit({
    type: 'turn/completed',
    threadId: first.threadId,
    turnId: 'turn-1',
    turn: { id: 'turn-1', status: 'completed' },
  });
  await Promise.resolve();
  const before = harness.store.getThreadHold(first.threadId);
  assert.equal(before.holderHost, HOST);

  // 自有 Hold：startTurn 失败不释放既有 Hold（§1.8）。
  harness.setStartTurnBehavior(async () => {
    throw new Error('turn refused');
  });
  await assert.rejects(
    harness.runtime.send(harness.ctx, { threadId: first.threadId, prompt: 'again' }),
    (error) => error.code === 'supervisor_unavailable',
  );
  const after = harness.store.getThreadHold(first.threadId);
  assert.equal(after.holderHost, HOST);
  assert.equal(after.holdId, before.holdId);
});

function attachPresence(harness, { host, instanceId, leaseMs = 60_000 }) {
  harness.store.attachHostPresence({
    host,
    workspace: harness.workspace,
    instanceId,
    now: iso(harness.now()),
    leaseMs,
  });
}

async function acquireForeignHold(harness, threadId) {
  // 直接以外部 Host 身份取得 Hold（fresh acquire 不查询 presence）。
  const result = await harness.store.acquireOrTakeoverThreadHold({
    threadId,
    workspace: harness.workspace,
    holderHost: FOREIGN_HOST,
    holdId: `hold-${FOREIGN_HOST}-${threadId}`,
    now: iso(harness.now()),
    isHostAlive: () => false,
  });
  assert.equal(result.status, 'acquired');
  return result;
}

test('send E: a foreign hold with alive presence is rejected as thread_held', async (t) => {
  const harness = await setup(t);
  harness.registerThread('thread-held-e');
  await acquireForeignHold(harness, 'thread-held-e');
  attachPresence(harness, { host: FOREIGN_HOST, instanceId: 'kimi-mcp-1' });

  await assert.rejects(
    harness.runtime.send(harness.ctx, { threadId: 'thread-held-e', prompt: 'hi' }),
    (error) => {
      assert.equal(error.code, 'thread_held');
      assert.deepEqual(error.data, { holderHost: FOREIGN_HOST });
      return true;
    },
  );
  // Hold 未被夺取。
  const hold = harness.store.getThreadHold('thread-held-e');
  assert.equal(hold.holderHost, FOREIGN_HOST);
  assert.equal(hold.holdId, `hold-${FOREIGN_HOST}-thread-held-e`);
});

test('send F: a foreign hold with stale presence is atomically taken over', async (t) => {
  const harness = await setup(t);
  harness.registerThread('thread-stale-f');
  await acquireForeignHold(harness, 'thread-stale-f');
  // presence 先 alive，随后 lease 过期 → stale。
  attachPresence(harness, { host: FOREIGN_HOST, instanceId: 'kimi-mcp-1', leaseMs: 1_000 });
  harness.setNow(harness.now() + 2_000);

  const result = await harness.runtime.send(harness.ctx, { threadId: 'thread-stale-f', prompt: 'take over' });
  assert.equal(result.status, 'running');
  const hold = harness.store.getThreadHold('thread-stale-f');
  assert.equal(hold.holderHost, HOST);
  assert.notEqual(hold.holdId, `hold-${FOREIGN_HOST}-thread-stale-f`);
  const execution = harness.executionOf('thread-stale-f');
  assert.equal(execution.host, HOST);
  assert.equal(execution.sessionId, SESSION);
});

test('send F: a failed startTurn after takeover releases only the newly taken hold', async (t) => {
  const harness = await setup(t);
  harness.registerThread('thread-stale-fail');
  await acquireForeignHold(harness, 'thread-stale-fail');
  attachPresence(harness, { host: FOREIGN_HOST, instanceId: 'kimi-mcp-1', leaseMs: 1_000 });
  harness.setNow(harness.now() + 2_000);

  harness.setStartTurnBehavior(async () => {
    throw new Error('turn refused');
  });
  await assert.rejects(
    harness.runtime.send(harness.ctx, { threadId: 'thread-stale-fail', prompt: 'take over' }),
    (error) => error.code === 'supervisor_unavailable',
  );
  // takeover 取得的新 hold_id 被精确释放，Hold 行清空。
  assert.equal(harness.store.getThreadHold('thread-stale-fail'), null);
});

test('wait reports thread_held while another host owns the active execution', async (t) => {
  const harness = await setup(t);
  harness.registerThread('thread-foreign-wait');
  harness.store.createExecution({
    host: FOREIGN_HOST,
    workspace: harness.workspace,
    sessionId: 'session-k',
    threadId: 'thread-foreign-wait',
    turnId: 'turn-k1',
    ownerInstanceId: 'foreign',
    now: iso(harness.now()),
  });
  await assert.rejects(
    harness.runtime.wait(harness.ctx, 'thread-foreign-wait'),
    (error) => {
      assert.equal(error.code, 'thread_held');
      assert.deepEqual(error.data, { holderHost: FOREIGN_HOST });
      return true;
    },
  );
});

test('direct wait only claims completions of the current session', async (t) => {
  const harness = await setup(t);
  const ack = await spawn(harness);
  harness.emit({
    type: 'turn/completed',
    threadId: ack.threadId,
    turnId: 'turn-1',
    turn: { id: 'turn-1', status: 'completed', finalAssistantMessage: 'for session z' },
  });
  await Promise.resolve();
  // Session B 接管（A 的 active execution 已 terminal）。
  harness.establishSession('session-b');
  await assert.rejects(
    harness.runtime.wait(harness.ctx, ack.threadId),
    (error) => error.code === 'no_active_turn',
  );
  // Session A 的 Hook/direct wait 归属不变：切回 A 后可以领取。
  harness.establishSession(SESSION);
  const result = await harness.runtime.wait(harness.ctx, ack.threadId);
  assert.equal(result.toJSON().finalAssistantMessage, 'for session z');
});

test('steer and interrupt never take over another host execution and keep no_active_turn', async (t) => {
  const harness = await setup(t);
  harness.registerThread('thread-foreign-steer');
  harness.store.createExecution({
    host: FOREIGN_HOST,
    workspace: harness.workspace,
    sessionId: 'session-k',
    threadId: 'thread-foreign-steer',
    turnId: 'turn-k1',
    ownerInstanceId: 'foreign',
    now: iso(harness.now()),
  });
  for (const operation of ['steer', 'interrupt']) {
    await assert.rejects(
      operation === 'steer'
        ? harness.runtime.steer(harness.ctx, { threadId: 'thread-foreign-steer', prompt: 'hi' })
        : harness.runtime.interrupt(harness.ctx, 'thread-foreign-steer'),
      (error) => {
        assert.equal(error.code, 'thread_held');
        assert.deepEqual(error.data, { holderHost: FOREIGN_HOST });
        return true;
      },
    );
  }
  harness.registerThread('thread-no-turn');
  await assert.rejects(
    harness.runtime.steer(harness.ctx, { threadId: 'thread-no-turn', prompt: 'hi' }),
    (error) => error.code === 'no_active_turn',
  );
  await assert.rejects(
    harness.runtime.interrupt(harness.ctx, 'thread-no-turn'),
    (error) => error.code === 'no_active_turn',
  );
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
  assert.ok(harness.executionOf(ack.threadId));
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
  const completion = harness.completions.listCompletions({ host: HOST })[0];
  assert.equal(completion.deliveryState, 'claimed_direct');
  assert.equal(completion.host, HOST);
  assert.equal(completion.sessionId, SESSION);
  assert.equal(await harness.runtime.ackDelivery(result, HOST), true);
  assert.equal(harness.completions.getCompletion(completion.completionId).deliveryState, 'delivered');
});

test('wait reserves before terminal, wakes from durable completion, and does not interrupt on timeout', async (t) => {
  const harness = await setup(t, { waitTimeoutMs: 35 });
  const ack = await spawn(harness);
  const waiting = harness.runtime.wait(harness.ctx, ack.threadId);
  await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(harness.executionOf(ack.threadId).reservationKind, 'direct');

  harness.emit({
    type: 'turn/interrupted',
    threadId: ack.threadId,
    turnId: 'turn-1',
    turn: { id: 'turn-1', status: 'interrupted', lastAssistantMessage: 'stopped' },
  });
  const result = await waiting;
  assert.equal(result.toJSON().status, 'interrupted');
  assert.equal(harness.calls.filter(([name]) => name === 'interruptTurn').length, 0);
  assert.equal(harness.completions.listCompletions({ host: HOST })[0].deliveryState, 'claimed_direct');
  await harness.runtime.ackDelivery(result, HOST);
  assert.equal(harness.completions.listCompletions({ host: HOST })[0].deliveryState, 'delivered');

  const second = await harness.runtime.send(harness.ctx, { threadId: ack.threadId, prompt: 'again' });
  const timedOut = await harness.runtime.wait(harness.ctx, second.threadId);
  assert.equal(timedOut.timedOut, true);
  assert.equal(timedOut.status, 'running');
  assert.equal(harness.executionOf(second.threadId).reservationId, null);
  assert.equal(harness.calls.filter(([name]) => name === 'interruptTurn').length, 0);
});

test('status and read_thread report thread_held for valid foreign holds and allow stale ones', async (t) => {
  const harness = await setup(t);
  harness.registerThread('thread-read-held');
  await acquireForeignHold(harness, 'thread-read-held');
  attachPresence(harness, { host: FOREIGN_HOST, instanceId: 'kimi-mcp-1' });

  for (const read of ['status', 'readThread']) {
    await assert.rejects(
      read === 'status'
        ? harness.runtime.status(harness.ctx, 'thread-read-held')
        : harness.runtime.readThread(harness.ctx, 'thread-read-held'),
      (error) => {
        assert.equal(error.code, 'thread_held');
        assert.deepEqual(error.data, { holderHost: FOREIGN_HOST });
        return true;
      },
    );
  }

  // Hold stale 且 idle → 放行（§1.10）。
  attachPresence(harness, { host: FOREIGN_HOST, instanceId: 'kimi-mcp-1', leaseMs: 1_000 });
  harness.setNow(harness.now() + 2_000);
  const snapshot = await harness.runtime.status(harness.ctx, 'thread-read-held');
  assert.equal(snapshot.threadId, 'thread-read-held');
  const read = await harness.runtime.readThread(harness.ctx, 'thread-read-held');
  assert.equal(read.threadId, 'thread-read-held');
});

test('status shows foreign active executions as thread_held', async (t) => {
  const harness = await setup(t);
  harness.registerThread('thread-foreign-status');
  harness.store.createExecution({
    host: FOREIGN_HOST,
    workspace: harness.workspace,
    sessionId: 'session-k',
    threadId: 'thread-foreign-status',
    turnId: 'turn-k1',
    ownerInstanceId: 'foreign',
    now: iso(harness.now()),
  });
  await assert.rejects(
    harness.runtime.status(harness.ctx, 'thread-foreign-status'),
    (error) => {
      assert.equal(error.code, 'thread_held');
      assert.deepEqual(error.data, { holderHost: FOREIGN_HOST });
      return true;
    },
  );
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

test('listThreads hides threads validly held by other hosts and keeps own/stale/free ones', async (t) => {
  const harness = await setup(t);
  const own = await spawn(harness);
  harness.registerThread('thread-free');
  harness.registerThread('thread-foreign-execution');
  harness.registerThread('thread-foreign-held');
  harness.registerThread('thread-foreign-stale');

  harness.store.createExecution({
    host: FOREIGN_HOST,
    workspace: harness.workspace,
    sessionId: 'session-k',
    threadId: 'thread-foreign-execution',
    turnId: 'turn-k1',
    ownerInstanceId: 'foreign',
    now: iso(harness.now()),
  });
  await acquireForeignHold(harness, 'thread-foreign-held');
  attachPresence(harness, { host: FOREIGN_HOST, instanceId: 'kimi-mcp-1' });
  // stale hold 用第三个 Host：presence 按 (host, workspace) 判定，同一 Host 只要
  // 有任意存活 instance 即 alive，无法在同一快照里同时呈现 alive 与 stale。
  const staleHold = await harness.store.acquireOrTakeoverThreadHold({
    threadId: 'thread-foreign-stale',
    workspace: harness.workspace,
    holderHost: 'claude-code',
    holdId: 'hold-claude-stale',
    now: iso(harness.now()),
    isHostAlive: () => false,
  });
  assert.equal(staleHold.status, 'acquired');
  attachPresence(harness, { host: 'claude-code', instanceId: 'claude-mcp-1', leaseMs: 1_000 });
  harness.setNow(harness.now() + 2_000);

  const listed = await harness.runtime.listThreads(harness.ctx);
  const listedIds = listed.threads.map((entry) => entry.threadId);
  assert.equal(listedIds.includes(own.threadId), true);
  assert.equal(listedIds.includes('thread-free'), true);
  assert.equal(listedIds.includes('thread-foreign-stale'), true);
  assert.equal(listedIds.includes('thread-foreign-execution'), false);
  assert.equal(listedIds.includes('thread-foreign-held'), false);
  assert.doesNotMatch(json(listed), /cwd|turnId|session/);
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
