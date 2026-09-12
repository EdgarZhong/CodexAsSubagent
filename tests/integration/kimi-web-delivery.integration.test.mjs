import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { SqliteStore, DEFAULT_DELIVERY_LEASE_MS } from '../../src/adapters/sqlite/sqlite-store.mjs';
import { CompletionRouter } from '../../src/core/completion-router.mjs';
import { CompletionStore } from '../../src/core/completion-store.mjs';
import { ExecutionStore } from '../../src/core/execution-store.mjs';
import { createWebDelivery } from '../../src/core/web-delivery.mjs';
import { ERROR_CODES } from '../../src/shared/errors.mjs';

const SESSION = 'session-integration';
const THREAD = 'thread-integration';
const TURN = 'turn-integration';

function response(body, status = 200) {
  return { status, ok: status >= 200 && status < 300, async json() { return body; } };
}

function fakeLogger() {
  const entries = [];
  const record = (level) => (message, details) => entries.push({ level, message, details });
  return { entries, error: record('error'), warn: record('warn'), info: record('info'), debug: record('debug') };
}

// 完整链路 fixture：SQLite V2 store + CompletionRouter + 事件驱动 web delivery，
// Kimi Server HTTP 用 fake fetch 承接（走真实 KimiWebClient envelope 路径）。
// instances 传空数组表示 0 个 active Server（不写 registry 与 token）。
async function setup(t, { instances, fetchImpl } = {}) {
  const effectiveInstances = instances ?? [{ server_id: 'server-a', base_url: 'http://127.0.0.1:58627' }];
  const dataDir = await mkdtemp(join(tmpdir(), 'cas-kimi-web-data-'));
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'cas-kimi-workspace-')));
  const home = await mkdtemp(join(tmpdir(), 'cas-kimi-home-'));
  if (effectiveInstances.length > 0) {
    await mkdir(join(home, 'server', 'instances'), { recursive: true });
    for (const [index, instance] of effectiveInstances.entries()) {
      await writeFile(join(home, 'server', 'instances', `server-${index}.json`), JSON.stringify(instance));
    }
    await writeFile(join(home, 'server.token'), 'secret-token\n');
  }
  const store = SqliteStore.open(dataDir);
  const executions = new ExecutionStore(store);
  const completions = new CompletionStore(store);
  const logger = fakeLogger();

  const requests = [];
  const requestSnapshots = [];
  const defaultFetch = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith(':steer')) return response({ code: 0, data: {} });
    if (pathname.endsWith('/prompts')) {
      return options.method === 'POST'
        ? response({ code: 0, data: { prompt_id: 'cas-integration' } })
        : response({ code: 0, data: { active: null, queued: [] } });
    }
    return response({ code: 0, data: { id: SESSION, metadata: { cwd: workspace } } });
  };
  const effectiveFetch = fetchImpl ?? defaultFetch;
  const observedFetch = async (url, options = {}) => {
    // 每个外部请求发生时同步快照 Mailbox：验证 durable COMMIT 先于外部副作用。
    const rows = completions.listCompletions({ host: 'kimi-code' });
    requestSnapshots.push(rows.map((row) => ({ deliveryState: row.deliveryState, deliveryId: row.deliveryId })));
    requests.push({ url, method: options.method ?? 'GET' });
    return effectiveFetch(url, options);
  };

  const realDelivery = createWebDelivery({
    store: completions,
    kimiCodeHome: home,
    fetchImpl: observedFetch,
    logger,
  });
  // fire-and-forget spy：收集 router 触发的同一个 promise，测试可 await 而不改变语义。
  const attempts = [];
  const webDelivery = {
    attemptWebDelivery(input) {
      const promise = realDelivery.attemptWebDelivery(input);
      attempts.push(promise);
      return promise;
    },
  };
  const router = new CompletionRouter({ executions, completions, webDelivery, logger });

  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });
  return { store, executions, completions, router, logger, attempts, requests, requestSnapshots, workspace };
}

function seedExecution(executions, workspace, threadId = THREAD) {
  executions.createExecution({
    threadId,
    turnId: TURN,
    host: 'kimi-code',
    workspace,
    sessionId: SESSION,
    ownerInstanceId: 'integration-owner',
  });
}

function terminal(router, threadId = THREAD) {
  return router.onTerminal({
    type: 'turn.completed',
    status: 'completed',
    threadId,
    turnId: TURN,
    finalAssistantMessage: 'Kimi Web integration complete',
    turn: { id: TURN, status: 'completed' },
  });
}

test('terminal COMMIT then event-driven web delivery claims, pushes and ACKs', async (t) => {
  const { completions, router, attempts, requests, requestSnapshots, executions, workspace } = await setup(t);
  seedExecution(executions, workspace);

  const completion = terminal(router);
  assert.equal(completion.inserted, true);
  assert.equal(completion.host, 'kimi-code');
  assert.equal(completion.sessionId, SESSION);
  assert.equal(completion.deliveryState, 'pending');

  const result = await attempts[0];
  assert.equal(result.status, 'delivered');
  assert.ok(result.deliveryId.startsWith('web-'));

  // 外部副作用顺序：GET session 校验 → GET prompt queue → POST prompt。
  assert.deepEqual(requests.map((request) => request.method), ['GET', 'GET', 'POST']);
  assert.ok(requests[0].url.endsWith(`/api/v1/sessions/${SESSION}`));
  assert.ok(requests[2].url.endsWith(`/api/v1/sessions/${SESSION}/prompts`));

  // COMMIT 先于外部副作用：第一个 HTTP 请求时 Mailbox 已有该 completion，
  // 且已原子 claim 为 claimed_hook（web- 前缀 deliveryId）。
  assert.equal(requestSnapshots[0].length, 1);
  assert.equal(requestSnapshots[0][0].deliveryState, 'claimed_hook');
  assert.ok(requestSnapshots[0][0].deliveryId.startsWith('web-'));

  const row = completions.listCompletions({ host: 'kimi-code' })[0];
  assert.equal(row.deliveryState, 'delivered');
  assert.equal(row.deliveryId, result.deliveryId);
  assert.ok(row.payload.finalAssistantMessage.includes('Kimi Web integration complete'));
});

test('web delivery failure NACKs the completion back to pending in the Mailbox', async (t) => {
  const { completions, router, attempts, requests, executions, workspace } = await setup(t, {
    fetchImpl: async () => { throw new Error('server disappeared'); },
  });
  seedExecution(executions, workspace);

  const completion = terminal(router);
  assert.equal(completion.deliveryState, 'pending');

  const result = await attempts[0];
  assert.equal(result.status, 'nacked');
  assert.equal(result.reason, 'session_lookup_failed');

  // 构造外部副作用失败：completion 不丢失，仍完整保留在 Mailbox 并回到 pending。
  const rows = completions.listCompletions({ host: 'kimi-code' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].completionId, completion.completionId);
  assert.equal(rows[0].deliveryState, 'pending');
  assert.equal(rows[0].deliveryId, null);
  assert.equal(requests.length, 1);
});

test('a direct wait reservation (claimed_direct) never triggers web delivery', async (t) => {
  const { completions, router, attempts, requests, executions, workspace } = await setup(t);
  seedExecution(executions, workspace);
  executions.reserveDirect({
    host: 'kimi-code',
    workspace,
    sessionId: SESSION,
    threadId: THREAD,
    deliveryId: 'reservation-direct-1',
  });

  const completion = terminal(router);
  assert.equal(completion.deliveryState, 'claimed_direct');

  // onTerminal 已返回但 web delivery 未被触发：无尝试、无外部请求、状态不变。
  await new Promise((resolveTick) => setImmediate(resolveTick));
  assert.equal(attempts.length, 0);
  assert.equal(requests.length, 0);
  const row = completions.listCompletions({ host: 'kimi-code' })[0];
  assert.equal(row.deliveryState, 'claimed_direct');
});

test('with zero active servers the completion stays pending without any side effect', async (t) => {
  const { completions, router, attempts, requests, logger, executions, workspace } = await setup(t, { instances: [] });
  seedExecution(executions, workspace);

  const completion = terminal(router);
  assert.equal(completion.deliveryState, 'pending');

  const result = await attempts[0];
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'server_unavailable');
  assert.equal(requests.length, 0);
  assert.ok(logger.entries.some((entry) => entry.level === 'debug' && entry.message === 'web_delivery.server_unavailable'));
  assert.equal(completions.listCompletions({ host: 'kimi-code' })[0].deliveryState, 'pending');
});

test('with multiple active servers delivery fails closed as multiple_active_host_servers', async (t) => {
  const { completions, router, attempts, requests, logger, executions, workspace } = await setup(t, {
    instances: [
      { server_id: 'server-a', base_url: 'http://127.0.0.1:58627' },
      { server_id: 'server-b', base_url: 'http://127.0.0.1:58628' },
    ],
  });
  seedExecution(executions, workspace);

  terminal(router);
  const result = await attempts[0];
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, ERROR_CODES.MULTIPLE_ACTIVE_HOST_SERVERS);
  assert.equal(requests.length, 0);
  assert.ok(logger.entries.some((entry) => entry.level === 'warn'
    && entry.message === 'web_delivery.multiple_active_host_servers'));
  assert.equal(completions.listCompletions({ host: 'kimi-code' })[0].deliveryState, 'pending');
});

test('an orphan claim from a crashed process recovers through lease expiry and redelivery', async (t) => {
  const { store, completions, executions, workspace } = await setup(t);
  seedExecution(executions, workspace);
  const inserted = completions.insertCompletionFirst({
    threadId: THREAD,
    turnId: TURN,
    status: 'completed',
    host: 'kimi-code',
    workspace,
    sessionId: SESSION,
    terminalResult: {
      threadId: THREAD,
      turnId: TURN,
      status: 'completed',
      finalAssistantMessage: 'Kimi Web lease recovery',
      changes: { files: [] },
    },
  });
  assert.equal(inserted.deliveryState, 'pending');

  // 模拟崩溃前的 orphan claim（claimed_hook 残留）。
  completions.claimPendingHook({
    host: 'kimi-code',
    workspace,
    sessionId: SESSION,
    limit: 1,
    deliveryId: 'web-orphan',
  });
  assert.equal(completions.getCompletion(inserted.completionId).deliveryState, 'claimed_hook');

  // lease（默认 30s）过期后 requeue 回 pending，随后事件驱动重投成功。
  const requeued = store.requeueExpiredLeases({ now: new Date(Date.now() + DEFAULT_DELIVERY_LEASE_MS + 1_000) });
  assert.equal(requeued, 1);
  assert.equal(completions.getCompletion(inserted.completionId).deliveryState, 'pending');
});
