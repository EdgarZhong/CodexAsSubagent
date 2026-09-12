import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';

import { SqliteStore } from '../../src/adapters/sqlite/sqlite-store.mjs';
import { CompletionStore } from '../../src/core/completion-store.mjs';
import { ExecutionStore } from '../../src/core/execution-store.mjs';
import { TerminalResult } from '../../src/core/terminal-result.mjs';

const T0 = '2026-09-12T00:00:00.000Z';

function plusSeconds(iso, seconds) {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString();
}

async function openStore(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'codex-as-subagent-v2-store-'));
  const store = SqliteStore.open(dataDir);
  t.after(() => {
    store.close();
    return rm(dataDir, { recursive: true, force: true });
  });
  return { dataDir, store };
}

function terminal(threadId, turnId, workspace, overrides = {}) {
  return {
    completionId: `${threadId}-${turnId}-completion`,
    threadId,
    turnId,
    workspace,
    status: 'completed',
    finalAssistantMessage: 'turn complete',
    turn: {
      id: turnId,
      status: 'completed',
      fileChanges: [{ path: 'turn-file.mjs', kind: 'modified' }],
    },
    ...overrides,
  };
}

function executionInput(overrides = {}) {
  return {
    host: 'kimi-code',
    workspace: '/workspace/main',
    sessionId: 'session-a',
    now: T0,
    ...overrides,
  };
}

function insertProvenancedCompletion(store, {
  host = 'kimi-code',
  workspace = '/workspace/main',
  sessionId = 'session-a',
  threadId,
  turnId,
  ...overrides
}) {
  return store.insertCompletionFirst({
    host,
    workspace,
    sessionId,
    ...terminal(threadId, turnId, workspace, overrides),
  });
}

function nextMessage(worker) {
  return new Promise((resolve, reject) => {
    const onMessage = (message) => {
      cleanup();
      if (message.type === 'error') reject(new Error(message.message));
      else resolve(message);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`race worker exited before result: ${code}`));
    };
    const cleanup = () => {
      worker.off('message', onMessage);
      worker.off('error', onError);
      worker.off('exit', onExit);
    };
    worker.once('message', onMessage);
    worker.once('error', onError);
    worker.once('exit', onExit);
  });
}

test('SqliteStore creates the V2 schema with host/session scoping and required pragmas', async (t) => {
  const { store } = await openStore(t);

  assert.equal(store.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(store.db.prepare('PRAGMA synchronous').get().synchronous, 2);
  assert.equal(store.db.prepare('PRAGMA busy_timeout').get().timeout, 5000);
  assert.equal(store.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);

  const tables = store.db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  ).all().map((row) => row.name);
  assert.deepEqual(tables, [
    'completions',
    'current_sessions',
    'executions',
    'host_presence',
    'meta',
    'thread_holds',
  ]);

  const executionColumns = store.db.prepare('PRAGMA table_info(executions)').all().map((row) => row.name);
  assert.deepEqual(executionColumns, [
    'thread_id',
    'turn_id',
    'host',
    'workspace',
    'session_id',
    'owner_instance_id',
    'model',
    'effort',
    'started_at',
    'last_activity_at',
    'reservation_id',
    'reservation_kind',
    'reservation_created_at',
  ]);

  const completionColumns = store.db.prepare('PRAGMA table_info(completions)').all().map((row) => row.name);
  assert.deepEqual(completionColumns, [
    'completion_id',
    'thread_id',
    'turn_id',
    'host',
    'workspace',
    'session_id',
    'terminal_status',
    'payload_json',
    'delivery_state',
    'claim_id',
    'claimed_at',
    'delivered_at',
    'created_at',
  ]);

  const holdColumns = store.db.prepare('PRAGMA table_info(thread_holds)').all().map((row) => row.name);
  assert.deepEqual(holdColumns, [
    'thread_id',
    'workspace',
    'holder_host',
    'hold_id',
    'acquired_at',
    'updated_at',
  ]);

  const indexNames = new Set(
    store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((row) => row.name),
  );
  for (const required of [
    'executions_scope_idx',
    'completions_pending_scope_idx',
    'thread_holds_holder_idx',
    'host_presence_expiry_idx',
  ]) {
    assert.equal(indexNames.has(required), true, `missing index ${required}`);
  }
  assert.equal(indexNames.has('completions_pending_workspace_idx'), false);

  assert.equal(
    store.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value,
    '2',
  );
});

test('legacy V1 databases are destructively rebuilt into the V2 schema on open', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'codex-as-subagent-v1-legacy-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));

  const legacy = new DatabaseSync(join(dataDir, 'state.sqlite'));
  legacy.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE executions (
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      workspace TEXT NOT NULL,
      owner_instance_id TEXT NOT NULL,
      model TEXT,
      effort TEXT,
      started_at TEXT NOT NULL,
      last_activity_at TEXT NOT NULL,
      reservation_id TEXT,
      reservation_kind TEXT,
      reservation_created_at TEXT,
      PRIMARY KEY (thread_id, turn_id)
    );
    CREATE TABLE completions (
      completion_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      workspace TEXT NOT NULL,
      terminal_status TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      delivery_state TEXT NOT NULL,
      claim_id TEXT,
      claimed_at TEXT,
      delivered_at TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (thread_id, turn_id)
    );
    CREATE INDEX completions_pending_workspace_idx
      ON completions(workspace, delivery_state, created_at);
    INSERT INTO meta(key, value) VALUES ('schema_version', '1');
    INSERT INTO executions(thread_id, turn_id, workspace, owner_instance_id, started_at, last_activity_at)
      VALUES ('legacy-thread', 'legacy-turn', '/legacy', 'legacy-instance', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO completions(
      completion_id, thread_id, turn_id, workspace, terminal_status,
      payload_json, delivery_state, created_at
    ) VALUES (
      'legacy-completion', 'legacy-thread', 'legacy-turn', '/legacy', 'completed',
      '{}', 'delivered', '2026-01-01T00:00:00.000Z'
    );
  `);
  legacy.close();

  const store = SqliteStore.open(dataDir);
  t.after(() => store.close());

  assert.equal(
    store.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value,
    '2',
  );
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM executions').get().count, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM completions').get().count, 0);

  const executionColumns = store.db.prepare('PRAGMA table_info(executions)').all().map((row) => row.name);
  assert.equal(executionColumns.includes('host'), true);
  assert.equal(executionColumns.includes('session_id'), true);

  const indexNames = new Set(
    store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((row) => row.name),
  );
  assert.equal(indexNames.has('completions_pending_workspace_idx'), false);
  assert.equal(indexNames.has('completions_pending_scope_idx'), true);

  // 重建后的 V2 schema 完全可用。
  store.createExecution(executionInput({ threadId: 'fresh-thread', turnId: 'fresh-turn' }));
  assert.equal(store.getExecutionByPhysicalThreadId('fresh-thread').threadId, 'fresh-thread');

  // meta 存在但缺 schema_version 同样触发废弃重建。
  const dirNoVersion = await mkdtemp(join(tmpdir(), 'codex-as-subagent-v1-noversion-'));
  t.after(() => rm(dirNoVersion, { recursive: true, force: true }));
  const noVersion = new DatabaseSync(join(dirNoVersion, 'state.sqlite'));
  noVersion.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
  noVersion.close();
  const rebuilt = SqliteStore.open(dirNoVersion);
  t.after(() => rebuilt.close());
  assert.equal(
    rebuilt.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value,
    '2',
  );
});

test('terminal completion inherits host/session provenance from its execution and is idempotent', async (t) => {
  const { store } = await openStore(t);
  const executions = new ExecutionStore(store);
  const completions = new CompletionStore(store);
  const workspace = await mkdtemp(join(tmpdir(), 'codex-as-subagent-workspace-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(join(workspace, 'pre-existing-dirty-file.mjs'), 'already here\n');

  executions.createExecution(executionInput({
    workspace,
    threadId: 'thread-pending',
    turnId: 'turn-pending',
    ownerInstanceId: 'instance-1',
  }));

  const first = completions.insertCompletionFirst(terminal(
    'thread-pending',
    'turn-pending',
    workspace,
    { repositoryDiff: { files: ['pre-existing-dirty-file.mjs'] } },
  ));
  assert.equal(first.inserted, true);
  assert.equal(first.host, 'kimi-code');
  assert.equal(first.workspace, workspace);
  assert.equal(first.sessionId, 'session-a');
  assert.equal(first.deliveryState, 'pending');
  assert.equal(first.payload.changes.files[0].path, 'turn-file.mjs');
  assert.doesNotMatch(JSON.stringify(first.payload), /pre-existing-dirty-file/);
  assert.equal(store.getExecutionByPhysicalThreadId('thread-pending'), null);

  const duplicate = completions.insertCompletionFirst(terminal(
    'thread-pending',
    'turn-pending',
    workspace,
    { finalAssistantMessage: 'a different duplicate' },
  ));
  assert.equal(duplicate.inserted, false);
  assert.equal(duplicate.completionId, first.completionId);
  assert.equal(duplicate.payload.finalAssistantMessage, 'turn complete');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM completions').get().count, 1);

  // 与 execution 归属冲突的显式 provenance 必须被拒绝。
  executions.createExecution(executionInput({
    workspace,
    threadId: 'thread-mismatch',
    turnId: 'turn-mismatch',
  }));
  assert.throws(
    () => completions.insertCompletionFirst({
      ...terminal('thread-mismatch', 'turn-mismatch', workspace),
      host: 'zcode',
    }),
    /host/,
  );
  assert.throws(
    () => completions.insertCompletionFirst({
      ...terminal('thread-mismatch', 'turn-mismatch', workspace),
      sessionId: 'session-b',
    }),
    /session/,
  );
  assert.throws(
    () => completions.insertCompletionFirst({
      ...terminal('thread-mismatch', 'turn-mismatch', workspace),
      workspace: '/workspace/other',
    }),
    /workspace/,
  );
  assert.equal(store.getExecutionByPhysicalThreadId('thread-mismatch').turnId, 'turn-mismatch');
});

test('trusted recovery path requires explicit provenance when no execution exists', async (t) => {
  const { store } = await openStore(t);
  const completions = new CompletionStore(store);

  const recovered = completions.insertCompletionFirst({
    host: 'kimi-code',
    workspace: '/workspace/recovery',
    sessionId: 'session-r',
    ...terminal('recovery-thread', 'recovery-turn', '/workspace/recovery'),
  });
  assert.equal(recovered.inserted, true);
  assert.equal(recovered.host, 'kimi-code');
  assert.equal(recovered.sessionId, 'session-r');

  assert.throws(
    () => completions.insertCompletionFirst(terminal('no-provenance', 'turn', '/workspace/recovery')),
    /host/,
  );

  // Trusted supervisor event path：按物理 thread id 取最新 execution，与 host 无关。
  store.createExecution(executionInput({
    host: 'zcode',
    sessionId: 'session-z',
    threadId: 'physical-thread',
    turnId: 'turn-1',
    now: plusSeconds(T0, 10),
  }));
  store.createExecution(executionInput({
    host: 'zcode',
    sessionId: 'session-z',
    threadId: 'physical-thread',
    turnId: 'turn-2',
    now: plusSeconds(T0, 20),
  }));
  assert.equal(store.getExecutionByPhysicalThreadId('physical-thread').turnId, 'turn-2');
  assert.equal(store.getExecutionByPhysicalThreadId('physical-thread', 'turn-1').turnId, 'turn-1');
});

test('SqliteStore rejects payload identity and status conflicts', async (t) => {
  const { store } = await openStore(t);
  const completions = new CompletionStore(store);
  const provenance = { host: 'kimi-code', workspace: '/workspace/identity', sessionId: 'session-a' };
  const canonical = new TerminalResult({
    threadId: 'payload-thread',
    status: 'completed',
    finalAssistantMessage: 'safe',
    changes: { files: [] },
  });

  assert.throws(
    () => completions.insertCompletionFirst({
      ...provenance,
      threadId: 'row-thread',
      turnId: 'row-turn',
      terminalResult: canonical,
    }),
    /threadId/,
  );
  assert.throws(
    () => completions.insertCompletionFirst({
      ...provenance,
      threadId: 'row-thread',
      turnId: 'row-turn',
      terminalResult: {
        threadId: 'row-thread',
        turnId: 'other-turn',
        status: 'completed',
        finalAssistantMessage: 'wrong turn identity',
        changes: { files: [] },
      },
    }),
    /turnId/,
  );
  assert.throws(
    () => completions.insertCompletionFirst({
      ...provenance,
      threadId: 'row-thread',
      turnId: 'row-turn',
      status: 'failed',
      terminalResult: new TerminalResult({
        threadId: 'row-thread',
        status: 'completed',
        finalAssistantMessage: 'safe',
        changes: { files: [] },
      }),
    }),
    /status/,
  );
});

test('direct reservation is host/session scoped, ACK requires host, and expired leases requeue globally', async (t) => {
  const { store } = await openStore(t);
  const executions = new ExecutionStore(store);
  const completions = new CompletionStore(store);
  const workspace = '/workspace/direct';

  executions.createExecution(executionInput({
    workspace,
    threadId: 'thread-direct',
    turnId: 'turn-direct',
    ownerInstanceId: 'instance-1',
  }));

  const wrongHost = executions.reserveWaiter({
    host: 'zcode',
    workspace,
    sessionId: 'session-a',
    threadId: 'thread-direct',
    reservationId: 'wrong-host-reservation',
    now: T0,
  });
  assert.equal(wrongHost.reserved, false);
  assert.equal(wrongHost.reason, 'host_mismatch');
  assert.equal(wrongHost.holderHost, 'kimi-code');

  const wrongSession = executions.reserveWaiter({
    host: 'kimi-code',
    workspace,
    sessionId: 'session-b',
    threadId: 'thread-direct',
    reservationId: 'wrong-session-reservation',
    now: T0,
  });
  assert.equal(wrongSession.reserved, false);
  assert.equal(wrongSession.reason, 'session_mismatch');
  assert.equal(wrongSession.holderSessionId, 'session-a');

  const first = executions.reserveWaiter({
    host: 'kimi-code',
    workspace,
    sessionId: 'session-a',
    threadId: 'thread-direct',
    reservationId: 'direct-reservation',
    now: plusSeconds(T0, 1),
  });
  const second = executions.reserveWaiter({
    host: 'kimi-code',
    workspace,
    sessionId: 'session-a',
    threadId: 'thread-direct',
    reservationId: 'another-reservation',
    now: plusSeconds(T0, 2),
  });
  assert.equal(first.reserved, true);
  assert.equal(first.reservationId, 'direct-reservation');
  assert.equal(second.reserved, false);
  assert.equal(second.reason, 'already_reserved');

  const completion = completions.insertCompletionFirst(terminal(
    'thread-direct',
    'turn-direct',
    workspace,
    { completionId: 'direct-completion' },
  ));
  assert.equal(completion.deliveryState, 'claimed_waiter');
  assert.equal(completion.claimId, 'direct-reservation');

  // ACK 必须匹配 host：错误 host + 正确 claimId 不生效；缺失 host 直接 fail closed。
  assert.equal(completions.ackDelivery({ host: 'zcode', claimId: 'direct-reservation', now: T0 }), null);
  assert.equal(completions.getCompletion('direct-completion').deliveryState, 'claimed_waiter');
  assert.throws(
    () => completions.ackDelivery({ claimId: 'direct-reservation', now: T0 }),
    /host/,
  );
  assert.equal(completions.getCompletion('direct-completion').deliveryState, 'claimed_waiter');
  assert.equal(
    completions.ackDelivery({
      host: 'kimi-code',
      claimId: 'direct-reservation',
      now: plusSeconds(T0, 3),
    }).deliveryState,
    'delivered',
  );

  // Hook claim 走完整谓词，lease 过期全局 requeue。
  executions.createExecution(executionInput({
    workspace,
    threadId: 'thread-hook-lease',
    turnId: 'turn-hook-lease',
    ownerInstanceId: 'instance-1',
  }));
  const pending = completions.insertCompletionFirst(terminal(
    'thread-hook-lease',
    'turn-hook-lease',
    workspace,
    { completionId: 'hook-lease-completion' },
  ));
  assert.equal(pending.deliveryState, 'pending');
  const [claimed] = completions.claimPendingHook({
    host: 'kimi-code',
    workspace,
    sessionId: 'session-a',
    now: plusSeconds(T0, 10),
  });
  assert.equal(claimed.deliveryState, 'claimed_hook');
  assert.equal(completions.recoverExpiredClaims({ now: plusSeconds(T0, 41) }), 1);
  assert.equal(completions.getCompletion('hook-lease-completion').deliveryState, 'pending');

  // Pending completion 抢占按 host+workspace+session 完整谓词。
  executions.createExecution(executionInput({
    workspace,
    threadId: 'thread-pending-direct',
    turnId: 'turn-pending-direct',
    ownerInstanceId: 'instance-1',
  }));
  const pendingDirect = completions.insertCompletionFirst(terminal(
    'thread-pending-direct',
    'turn-pending-direct',
    workspace,
    { completionId: 'pending-direct-completion' },
  ));
  assert.equal(pendingDirect.deliveryState, 'pending');
  const excluded = executions.reserveWaiter({
    host: 'kimi-code',
    workspace,
    sessionId: 'session-b',
    threadId: 'thread-pending-direct',
    reservationId: 'pending-direct-reservation',
    now: T0,
  });
  assert.equal(excluded.reserved, false);
  assert.equal(excluded.reason, 'not_found');
  const directClaim = executions.reserveWaiter({
    host: 'kimi-code',
    workspace,
    sessionId: 'session-a',
    threadId: 'thread-pending-direct',
    reservationId: 'pending-direct-reservation',
    now: T0,
  });
  assert.equal(directClaim.source, 'completion');
  assert.equal(completions.getCompletion('pending-direct-completion').deliveryState, 'claimed_waiter');
  assert.equal(
    executions.releaseReservation({ host: 'kimi-code', reservationId: 'pending-direct-reservation' }).released,
    true,
  );
  assert.equal(completions.getCompletion('pending-direct-completion').deliveryState, 'pending');

  // Direct lease 过期边界。
  executions.createExecution(executionInput({
    workspace,
    threadId: 'thread-direct-lease',
    turnId: 'turn-direct-lease',
    ownerInstanceId: 'instance-1',
  }));
  executions.reserveWaiter({
    host: 'kimi-code',
    workspace,
    sessionId: 'session-a',
    threadId: 'thread-direct-lease',
    reservationId: 'direct-lease-reservation',
    now: T0,
  });
  const directLease = completions.insertCompletionFirst(terminal(
    'thread-direct-lease',
    'turn-direct-lease',
    workspace,
    { completionId: 'direct-lease-completion', now: T0 },
  ));
  assert.equal(directLease.deliveryState, 'claimed_waiter');
  assert.equal(completions.recoverExpiredClaims({ now: plusSeconds(T0, 29.999) }), 0);
  assert.equal(completions.getCompletion('direct-lease-completion').deliveryState, 'claimed_waiter');
  assert.equal(completions.recoverExpiredClaims({ now: plusSeconds(T0, 30) }), 1);
  assert.equal(completions.getCompletion('direct-lease-completion').deliveryState, 'pending');
});

test('hook claims and nack are isolated across hosts and sessions', async (t) => {
  const { store } = await openStore(t);
  const completions = new CompletionStore(store);

  insertProvenancedCompletion(store, { threadId: 'thread-h1', turnId: 'turn-h1' });
  insertProvenancedCompletion(store, {
    host: 'zcode',
    sessionId: 'session-a',
    threadId: 'thread-h2',
    turnId: 'turn-h2',
  });
  insertProvenancedCompletion(store, { sessionId: 'session-b', threadId: 'thread-h3', turnId: 'turn-h3' });

  const kimiClaims = completions.claimPendingHook({
    host: 'kimi-code',
    workspace: '/workspace/main',
    sessionId: 'session-a',
    claimId: 'hook-1',
    now: T0,
  });
  assert.deepEqual(kimiClaims.map((row) => row.completionId), ['thread-h1-turn-h1-completion']);

  const zcodeClaims = completions.claimPendingHook({
    host: 'zcode',
    workspace: '/workspace/main',
    sessionId: 'session-a',
    claimId: 'hook-2',
    now: T0,
  });
  assert.deepEqual(zcodeClaims.map((row) => row.completionId), ['thread-h2-turn-h2-completion']);

  const sessionBClaims = completions.claimPendingHook({
    host: 'kimi-code',
    workspace: '/workspace/main',
    sessionId: 'session-b',
    claimId: 'hook-3',
    now: T0,
  });
  assert.deepEqual(sessionBClaims.map((row) => row.completionId), ['thread-h3-turn-h3-completion']);

  assert.equal(completions.listCompletions({ host: 'kimi-code' }).length, 2);
  assert.equal(completions.listCompletions({ host: 'kimi-code', sessionId: 'session-a' }).length, 1);
  assert.equal(completions.listCompletions({ host: 'zcode' }).length, 1);

  // NACK 同样必须匹配 host。
  assert.equal(completions.nackDelivery({ host: 'zcode', claimId: 'hook-1' }), null);
  assert.equal(completions.getCompletion('thread-h1-turn-h1-completion').deliveryState, 'claimed_hook');
  const nacked = completions.nackDelivery({ host: 'kimi-code', claimId: 'hook-1' });
  assert.equal(nacked.nacked, true);
  assert.equal(nacked.deliveryState, 'pending');
  assert.equal(nacked.claimId, null);
  assert.equal(completions.getCompletion('thread-h1-turn-h1-completion').deliveryState, 'pending');
});

test('two racing Hook Workers can claim a pending completion only once', async (t) => {
  const { dataDir, store } = await openStore(t);
  const executions = new ExecutionStore(store);
  const completions = new CompletionStore(store);
  const workspace = '/workspace/hook-race';
  executions.createExecution(executionInput({
    workspace,
    threadId: 'thread-race',
    turnId: 'turn-race',
    ownerInstanceId: 'instance-1',
  }));
  completions.insertCompletionFirst(terminal('thread-race', 'turn-race', workspace));

  const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const sqliteModule = new URL('../../src/adapters/sqlite/sqlite-store.mjs', import.meta.url).href;
  const workerSource = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { SqliteStore } = await import(workerData.sqliteModule);
      const store = SqliteStore.open(workerData.dataDir);
      parentPort.postMessage({ type: 'ready' });
      Atomics.wait(new Int32Array(workerData.barrier), 0, 0);
      const claimed = store.claimPendingHook({
        host: workerData.host,
        workspace: workerData.workspace,
        sessionId: workerData.sessionId,
        claimId: workerData.claimId,
      });
      parentPort.postMessage({
        type: 'result',
        count: claimed.length,
        claimId: claimed[0]?.claimId ?? null,
      });
      store.close();
    })().catch((error) => parentPort.postMessage({ type: 'error', message: error.message }));
  `;
  const workers = ['hook-a', 'hook-b'].map((claimId) => new Worker(workerSource, {
    eval: true,
    workerData: {
      barrier,
      dataDir,
      claimId,
      host: 'kimi-code',
      sessionId: 'session-a',
      sqliteModule,
      workspace,
    },
  }));
  t.after(() => Promise.all(workers.map((worker) => worker.terminate())));

  await Promise.all(workers.map((worker) => nextMessage(worker)));
  const results = workers.map((worker) => nextMessage(worker));
  Atomics.store(new Int32Array(barrier), 0, 1);
  Atomics.notify(new Int32Array(barrier), 0, workers.length);
  const [first, second] = await Promise.all(results);
  assert.equal(first.count + second.count, 1);
  assert.equal([first.claimId, second.claimId].filter(Boolean).length, 1);
  const claimed = completions.getCompletion('thread-race-turn-race-completion');
  assert.equal(claimed.deliveryState, 'claimed_hook');
  assert.equal(claimed.claimId, first.claimId ?? second.claimId);
});

test('session gate follows the four-branch state machine with atomic establishment', async (t) => {
  const { store } = await openStore(t);
  const host = 'kimi-code';
  const workspace = '/workspace/gate';

  assert.equal(store.getCurrentSession({ host, workspace }), null);

  // 集合 0 + current null → 原子建立。
  const established = store.sessionGateTransition({ host, workspace, sessionId: 'session-a', now: T0 });
  assert.equal(established.decision, 'allow');
  assert.equal(established.reason, 'session_established');
  assert.equal(store.getCurrentSession({ host, workspace }), 'session-a');

  // 集合 0 + current 已是本 session → 重确认放行。
  const reconfirmed = store.sessionGateTransition({
    host,
    workspace,
    sessionId: 'session-a',
    now: plusSeconds(T0, 1),
  });
  assert.equal(reconfirmed.decision, 'allow');
  assert.equal(reconfirmed.reason, 'session_reconfirmed');

  // session-a 有 active execution → 放行；他人 → veto。
  store.createExecution(executionInput({ workspace, threadId: 'thread-g1', turnId: 'turn-g1' }));
  const authorized = store.sessionGateTransition({
    host,
    workspace,
    sessionId: 'session-a',
    now: plusSeconds(T0, 2),
  });
  assert.equal(authorized.decision, 'allow');
  assert.equal(authorized.reason, 'session_authorized');

  const vetoed = store.sessionGateTransition({
    host,
    workspace,
    sessionId: 'session-b',
    now: plusSeconds(T0, 3),
  });
  assert.equal(vetoed.decision, 'veto');
  assert.equal(vetoed.reason, 'other_session_active');
  assert.equal(vetoed.conflict, undefined);
  assert.equal(store.getCurrentSession({ host, workspace }), 'session-a');

  // a terminal 后懒切换：session-b 过 gate 成功接管。
  insertProvenancedCompletion(store, { workspace, threadId: 'thread-g1', turnId: 'turn-g1' });
  const handoff = store.sessionGateTransition({
    host,
    workspace,
    sessionId: 'session-b',
    now: plusSeconds(T0, 4),
  });
  assert.equal(handoff.decision, 'allow');
  assert.equal(handoff.reason, 'session_handoff');
  assert.equal(store.getCurrentSession({ host, workspace }), 'session-b');

  // 并发原子切换（同进程顺序模拟，事务语义验证）：空 HostScope 上两个 session 竞争，
  // 先过 gate 并立即产生 active execution 的 session 独占本轮 establishment，
  // 后到者被 veto——一个 HostScope 内不会同时出现两个活跃 session。
  const raceWorkspace = '/workspace/gate-race';
  const firstArrival = store.sessionGateTransition({
    host,
    workspace: raceWorkspace,
    sessionId: 'session-a',
    now: T0,
  });
  assert.equal(firstArrival.decision, 'allow');
  store.createExecution(executionInput({
    workspace: raceWorkspace,
    threadId: 'thread-race-gate',
    turnId: 'turn-race-gate',
  }));
  const secondArrival = store.sessionGateTransition({
    host,
    workspace: raceWorkspace,
    sessionId: 'session-b',
    now: T0,
  });
  assert.equal(secondArrival.decision, 'veto');
  assert.equal(secondArrival.reason, 'other_session_active');
  assert.equal(store.getCurrentSession({ host, workspace: raceWorkspace }), 'session-a');

  // Host Namespace 隔离：同 workspace 下 zcode 的 current_session 独立。
  assert.equal(store.getCurrentSession({ host: 'zcode', workspace }), null);
  const zcodeGate = store.sessionGateTransition({
    host: 'zcode',
    workspace,
    sessionId: 'session-z',
    now: T0,
  });
  assert.equal(zcodeGate.decision, 'allow');
  assert.equal(zcodeGate.reason, 'session_established');
  assert.equal(store.getCurrentSession({ host: 'kimi-code', workspace }), 'session-b');
});

test('multiple active sessions veto with conflict and recovery derives from active executions', async (t) => {
  const { store } = await openStore(t);
  const host = 'kimi-code';
  const workspace = '/workspace/conflict';

  store.createExecution(executionInput({
    workspace,
    threadId: 'thread-m1',
    turnId: 'turn-m1',
    sessionId: 'session-a',
  }));
  store.createExecution(executionInput({
    workspace,
    threadId: 'thread-m2',
    turnId: 'turn-m2',
    sessionId: 'session-b',
  }));

  const activeSet = store.activeSessionSet({ host, workspace });
  assert.deepEqual([...activeSet].sort(), ['session-a', 'session-b']);

  // 多 active session：即便包含本 session 也 fail closed。
  const selfGate = store.sessionGateTransition({ host, workspace, sessionId: 'session-a', now: T0 });
  assert.equal(selfGate.decision, 'veto');
  assert.equal(selfGate.conflict, true);
  const otherGate = store.sessionGateTransition({ host, workspace, sessionId: 'session-c', now: T0 });
  assert.equal(otherGate.decision, 'veto');
  assert.equal(otherGate.conflict, true);

  const conflictFix = store.fixCurrentSessionFromExecutions({ host, workspace, now: T0 });
  assert.equal(conflictFix.fixed, false);
  assert.equal(conflictFix.conflict, true);
  assert.equal(store.getCurrentSession({ host, workspace }), null);

  // 收敛到唯一 active session：以 active Execution 为权威修复。
  insertProvenancedCompletion(store, {
    workspace,
    threadId: 'thread-m2',
    turnId: 'turn-m2',
    sessionId: 'session-b',
  });
  const repaired = store.fixCurrentSessionFromExecutions({ host, workspace, now: plusSeconds(T0, 1) });
  assert.equal(repaired.fixed, true);
  assert.equal(repaired.reason, 'repaired');
  assert.equal(repaired.session, 'session-a');
  assert.equal(store.getCurrentSession({ host, workspace }), 'session-a');

  const authorized = store.sessionGateTransition({ host, workspace, sessionId: 'session-a', now: T0 });
  assert.equal(authorized.decision, 'allow');
  const blocked = store.sessionGateTransition({ host, workspace, sessionId: 'session-b', now: T0 });
  assert.equal(blocked.decision, 'veto');
  assert.equal(blocked.reason, 'other_session_active');

  // 全部 terminal：0 active → 保留 stale current_session 不动。
  insertProvenancedCompletion(store, {
    workspace,
    threadId: 'thread-m1',
    turnId: 'turn-m1',
    sessionId: 'session-a',
  });
  const idle = store.fixCurrentSessionFromExecutions({ host, workspace, now: plusSeconds(T0, 2) });
  assert.equal(idle.fixed, false);
  assert.equal(idle.reason, 'no_active_execution');
  assert.equal(idle.currentSession, 'session-a');
  assert.equal(store.getCurrentSession({ host, workspace }), 'session-a');

  // stale current 不构成占用：下一次合法 gate 懒切换。
  const takeover = store.sessionGateTransition({ host, workspace, sessionId: 'session-b', now: T0 });
  assert.equal(takeover.decision, 'allow');
  assert.equal(takeover.reason, 'session_handoff');
});

test('presence lifecycle supports attach, heartbeat renewal, expiry, and detach', async (t) => {
  const { store } = await openStore(t);
  const host = 'kimi-code';
  const workspace = '/workspace/presence';

  const attached = store.attachHostPresence({
    host,
    workspace,
    instanceId: 'instance-1',
    now: T0,
    leaseMs: 1000,
  });
  assert.equal(attached.expiresAt, plusSeconds(T0, 1));
  assert.equal(store.isHostAlive({ host, workspace, now: plusSeconds(T0, 0.5) }), true);

  // heartbeat 续期：跨过原租约到期点后仍 alive。
  const heartbeat = store.heartbeatHostPresence({
    host,
    workspace,
    instanceId: 'instance-1',
    now: plusSeconds(T0, 0.8),
    leaseMs: 1000,
  });
  assert.equal(heartbeat.refreshed, true);
  assert.equal(heartbeat.expiresAt, plusSeconds(T0, 1.8));
  assert.equal(store.isHostAlive({ host, workspace, now: plusSeconds(T0, 1.2) }), true);

  // 过期即不 alive，且过期行被 lazy delete。
  // instance-1 租约到 T0+1.8s；instance-2 在 T0+1.0s 续期到 T0+2.0s。
  store.attachHostPresence({
    host,
    workspace,
    instanceId: 'instance-2',
    now: plusSeconds(T0, 1),
    leaseMs: 1000,
  });
  assert.equal(store.isHostAlive({ host, workspace, now: plusSeconds(T0, 1.9) }), true);
  const remainingAfterLazyDelete = store.db.prepare(
    'SELECT instance_id FROM host_presence WHERE host = ? AND workspace = ? ORDER BY instance_id',
  ).all(host, workspace).map((row) => row.instance_id);
  assert.deepEqual(remainingAfterLazyDelete, ['instance-2']);
  assert.equal(store.isHostAlive({ host, workspace, now: plusSeconds(T0, 2.001) }), false);
  const remaining = store.db.prepare(
    'SELECT COUNT(*) AS count FROM host_presence WHERE host = ? AND workspace = ?',
  ).get(host, workspace);
  assert.equal(remaining.count, 0);

  // detach 后不 alive；detach 之后的 heartbeat 不复活 presence。
  store.attachHostPresence({
    host,
    workspace,
    instanceId: 'instance-3',
    now: T0,
    leaseMs: 60_000,
  });
  const detached = store.detachHostPresence({ host, workspace, instanceId: 'instance-3' });
  assert.equal(detached.detached, true);
  assert.equal(store.isHostAlive({ host, workspace, now: plusSeconds(T0, 0.1) }), false);
  const staleHeartbeat = store.heartbeatHostPresence({
    host,
    workspace,
    instanceId: 'instance-3',
    now: plusSeconds(T0, 0.2),
    leaseMs: 60_000,
  });
  assert.equal(staleHeartbeat.refreshed, false);
  assert.equal(store.isHostAlive({ host, workspace, now: plusSeconds(T0, 0.3) }), false);
});

test('thread holds support acquire, self re-entry, alive rejection, stale takeover, and execution repair', async (t) => {
  const { store } = await openStore(t);
  const workspace = '/workspace/holds';

  const noHold = { host: 'never' };
  const aliveHosts = new Set();
  const isHostAlive = async ({ host }) => aliveHosts.has(host);
  const seenAliveQueries = [];
  const recordingIsHostAlive = async (input) => {
    seenAliveQueries.push(input);
    return isHostAlive(input);
  };

  // 情况 C：无 Hold → acquire。
  const acquired = await store.acquireOrTakeoverThreadHold({
    threadId: 'thread-1',
    workspace,
    holderHost: 'kimi-code',
    holdId: 'hold-1',
    now: T0,
    isHostAlive,
  });
  assert.equal(acquired.status, 'acquired');
  assert.equal(acquired.mode, 'acquire');
  assert.equal(acquired.holdId, 'hold-1');
  assert.equal(store.getThreadHold('thread-1').holderHost, 'kimi-code');
  assert.equal(store.getThreadHold('thread-1').holdId, 'hold-1');

  // 情况 D：Hold 已属于自己 → 直接继续，不重新生成。
  const held = await store.acquireOrTakeoverThreadHold({
    threadId: 'thread-1',
    workspace,
    holderHost: 'kimi-code',
    holdId: 'hold-ignored',
    now: plusSeconds(T0, 1),
    isHostAlive,
  });
  assert.equal(held.status, 'held');
  assert.equal(held.holdId, 'hold-1');
  assert.equal(store.getThreadHold('thread-1').holdId, 'hold-1');

  // 情况 E：他人 Hold 且 presence alive → 拒绝。
  aliveHosts.add('kimi-code');
  const rejected = await store.acquireOrTakeoverThreadHold({
    threadId: 'thread-1',
    workspace,
    holderHost: 'zcode',
    holdId: 'hold-2',
    now: plusSeconds(T0, 2),
    isHostAlive,
  });
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.reason, 'existing_holder');
  assert.equal(rejected.holderHost, 'kimi-code');
  aliveHosts.delete('kimi-code');

  // 情况 F：他人 Hold 但 stale → 原子 lazy takeover。
  const takeover = await store.acquireOrTakeoverThreadHold({
    threadId: 'thread-1',
    workspace,
    holderHost: 'zcode',
    holdId: 'hold-2',
    now: plusSeconds(T0, 3),
    isHostAlive: recordingIsHostAlive,
  });
  assert.equal(takeover.status, 'acquired');
  assert.equal(takeover.mode, 'takeover');
  assert.equal(takeover.previousHolder, 'kimi-code');
  assert.equal(store.getThreadHold('thread-1').holderHost, 'zcode');
  assert.equal(seenAliveQueries.at(-1).host, 'kimi-code');
  assert.equal(seenAliveQueries.at(-1).workspace, workspace);

  // active Execution 是权威：他人 active execution → 拒绝并给出 holderHost。
  store.createExecution(executionInput({
    workspace,
    threadId: 'thread-1',
    turnId: 'turn-1',
    host: 'kimi-code',
    sessionId: 'session-a',
  }));
  const executionRejected = await store.acquireOrTakeoverThreadHold({
    threadId: 'thread-1',
    workspace,
    holderHost: 'zcode',
    holdId: 'hold-3',
    now: plusSeconds(T0, 4),
    isHostAlive,
  });
  assert.equal(executionRejected.status, 'rejected');
  assert.equal(executionRejected.reason, 'active_execution');
  assert.equal(executionRejected.holderHost, 'kimi-code');

  // active Execution 属于自己：Hold 与 execution.host 不一致 → 当次事务自动修复。
  const repaired = await store.acquireOrTakeoverThreadHold({
    threadId: 'thread-1',
    workspace,
    holderHost: 'kimi-code',
    holdId: 'hold-3',
    now: plusSeconds(T0, 5),
    isHostAlive,
  });
  assert.equal(repaired.status, 'acquired');
  assert.equal(repaired.mode, 'repair');
  assert.equal(repaired.holdId, 'hold-3');
  assert.equal(store.getThreadHold('thread-1').holderHost, 'kimi-code');
  assert.equal(store.getThreadHold('thread-1').holdId, 'hold-3');

  // 无 Hold 但有属于自己 active execution → 修复路径创建 Hold。
  const repairedFromNothing = await store.acquireOrTakeoverThreadHold({
    threadId: 'thread-2',
    workspace,
    holderHost: 'kimi-code',
    holdId: 'hold-4',
    now: T0,
    isHostAlive,
  }).then(async (first) => {
    // thread-2 先无 execution：走 acquire。
    assert.equal(first.status, 'acquired');
    store.createExecution(executionInput({ workspace, threadId: 'thread-3', turnId: 'turn-3' }));
    return store.acquireOrTakeoverThreadHold({
      threadId: 'thread-3',
      workspace,
      holderHost: 'kimi-code',
      holdId: 'hold-5',
      now: T0,
      isHostAlive,
    });
  });
  assert.equal(repairedFromNothing.status, 'acquired');
  assert.equal(repairedFromNothing.mode, 'repair');
  assert.equal(store.getThreadHold('thread-3').holdId, 'hold-5');

  // 同一 Thread 出现不同 Host 的冲突 active execution → fail closed。
  store.createExecution(executionInput({
    workspace,
    threadId: 'thread-4',
    turnId: 'turn-4a',
    host: 'kimi-code',
  }));
  store.createExecution(executionInput({
    workspace,
    threadId: 'thread-4',
    turnId: 'turn-4b',
    host: 'zcode',
  }));
  const conflicted = await store.acquireOrTakeoverThreadHold({
    threadId: 'thread-4',
    workspace,
    holderHost: 'kimi-code',
    holdId: 'hold-6',
    now: T0,
    isHostAlive,
  });
  assert.equal(conflicted.status, 'rejected');
  assert.equal(conflicted.reason, 'conflicting_executions');
  assert.deepEqual([...conflicted.hosts].sort(), ['kimi-code', 'zcode']);
  assert.equal(noHold.host, 'never');
});

test('concurrent stale-hold takeover lets exactly one host win', async (t) => {
  const { dataDir, store } = await openStore(t);
  const workspace = '/workspace/hold-race';

  // 旧 Host 持有 Hold 但没有任何 presence（stale）。
  const legacy = await store.acquireOrTakeoverThreadHold({
    threadId: 'race-thread',
    workspace,
    holderHost: 'legacy-host',
    holdId: 'hold-legacy',
    now: T0,
    isHostAlive: async () => false,
  });
  assert.equal(legacy.status, 'acquired');

  const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const sqliteModule = new URL('../../src/adapters/sqlite/sqlite-store.mjs', import.meta.url).href;
  const workerSource = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { SqliteStore } = await import(workerData.sqliteModule);
      const store = SqliteStore.open(workerData.dataDir);
      store.attachHostPresence({
        host: workerData.host,
        workspace: workerData.workspace,
        instanceId: workerData.instanceId,
        now: workerData.now,
        leaseMs: 60000,
      });
      parentPort.postMessage({ type: 'ready' });
      Atomics.wait(new Int32Array(workerData.barrier), 0, 0);
      const result = await store.acquireOrTakeoverThreadHold({
        threadId: workerData.threadId,
        workspace: workerData.workspace,
        holderHost: workerData.host,
        holdId: workerData.holdId,
        now: workerData.now,
        isHostAlive: ({ host, workspace }) => store.isHostAlive({
          host,
          workspace,
          now: workerData.now,
        }),
      });
      parentPort.postMessage({
        type: 'result',
        status: result.status,
        mode: result.mode ?? null,
        reason: result.reason ?? null,
        holdId: result.holdId ?? null,
      });
      store.close();
    })().catch((error) => parentPort.postMessage({ type: 'error', message: error.message }));
  `;
  const workerSpecs = [
    { host: 'kimi-code', instanceId: 'instance-b', holdId: 'hold-b' },
    { host: 'zcode', instanceId: 'instance-c', holdId: 'hold-c' },
  ];
  const workers = workerSpecs.map((spec) => new Worker(workerSource, {
    eval: true,
    workerData: {
      barrier,
      dataDir,
      host: spec.host,
      instanceId: spec.instanceId,
      holdId: spec.holdId,
      now: T0,
      sqliteModule,
      threadId: 'race-thread',
      workspace,
    },
  }));
  t.after(() => Promise.all(workers.map((worker) => worker.terminate())));

  await Promise.all(workers.map((worker) => nextMessage(worker)));
  const resultsPromise = workers.map((worker) => nextMessage(worker));
  Atomics.store(new Int32Array(barrier), 0, 1);
  Atomics.notify(new Int32Array(barrier), 0, workers.length);
  const results = await Promise.all(resultsPromise);

  const winners = results.filter((result) => result.status === 'acquired');
  const losers = results.filter((result) => result.status === 'rejected');
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
  assert.equal(winners[0].mode, 'takeover');
  assert.equal(losers[0].reason, 'existing_holder');

  const winnerSpec = workerSpecs[results.indexOf(winners[0])];
  const finalHold = store.getThreadHold('race-thread');
  assert.equal(finalHold.holderHost, winnerSpec.host);
  assert.equal(finalHold.holdId, winners[0].holdId);
  assert.notEqual(finalHold.holdId, 'hold-legacy');
});

test('releaseThreadHold releases precisely by hold_id and never clobbers a replaced hold', async (t) => {
  const { store } = await openStore(t);
  const workspace = '/workspace/release';
  const isHostAlive = async () => false;

  const acquired = await store.acquireOrTakeoverThreadHold({
    threadId: 'thread-1',
    workspace,
    holderHost: 'kimi-code',
    holdId: 'hold-1',
    now: T0,
    isHostAlive,
  });
  assert.equal(acquired.status, 'acquired');

  // hold_id 不匹配时精确释放不生效。
  const wrongRelease = store.releaseThreadHold('thread-1', 'hold-wrong');
  assert.equal(wrongRelease.released, false);
  assert.equal(store.getThreadHold('thread-1').holdId, 'hold-1');

  // 并发替换场景：active execution 触发 repair，产生新 hold_id。
  store.createExecution(executionInput({ workspace, threadId: 'thread-1', turnId: 'turn-1' }));
  const repaired = await store.acquireOrTakeoverThreadHold({
    threadId: 'thread-1',
    workspace,
    holderHost: 'kimi-code',
    holdId: 'hold-2',
    now: plusSeconds(T0, 1),
    isHostAlive,
  });
  assert.equal(repaired.status, 'acquired');
  assert.equal(repaired.mode, 'repair');

  // startTurn 失败场景：只释放本次取得的 hold_id，不影响已被替换的新 Hold。
  const staleRelease = store.releaseThreadHold('thread-1', 'hold-1');
  assert.equal(staleRelease.released, false);
  assert.equal(store.getThreadHold('thread-1').holdId, 'hold-2');

  const currentRelease = store.releaseThreadHold('thread-1', 'hold-2');
  assert.equal(currentRelease.released, true);
  assert.equal(store.getThreadHold('thread-1'), null);

  // 正常 startTurn 失败流程：acquire 后按本次 hold_id 精确释放。
  const secondAcquire = await store.acquireOrTakeoverThreadHold({
    threadId: 'thread-2',
    workspace,
    holderHost: 'kimi-code',
    holdId: 'hold-10',
    now: T0,
    isHostAlive,
  });
  assert.equal(secondAcquire.status, 'acquired');
  assert.equal(store.releaseThreadHold('thread-2', 'hold-10').released, true);
  assert.equal(store.getThreadHold('thread-2'), null);
});

test('late ACK/NACK from a stale claimant never clobbers a newer claim (hook and waiter paths)', async (t) => {
  const { store } = await openStore(t);
  const executions = new ExecutionStore(store);
  const completions = new CompletionStore(store);
  const workspace = '/workspace/claim-isolation';

  // Hook 路径：claim A → nack 回 pending → claim B → A 的迟到 ACK/NACK 均无效。
  const pending = insertProvenancedCompletion(store, { threadId: 'thread-iso', turnId: 'turn-iso', workspace });
  assert.equal(pending.deliveryState, 'pending');
  const [claimA] = completions.claimPendingHook({
    host: 'kimi-code',
    workspace,
    sessionId: 'session-a',
    claimId: 'claim-A',
    now: plusSeconds(T0, 1),
  });
  assert.equal(claimA.deliveryState, 'claimed_hook');
  assert.equal(claimA.claimId, 'claim-A');
  assert.equal(
    completions.nackDelivery({ host: 'kimi-code', claimId: 'claim-A', now: plusSeconds(T0, 2) }).nacked,
    true,
  );
  assert.equal(completions.getCompletion('thread-iso-turn-iso-completion').deliveryState, 'pending');

  const [claimB] = completions.claimPendingHook({
    host: 'kimi-code',
    workspace,
    sessionId: 'session-a',
    claimId: 'claim-B',
    now: plusSeconds(T0, 3),
  });
  assert.equal(claimB.claimId, 'claim-B');
  assert.equal(completions.ackDelivery({ host: 'kimi-code', claimId: 'claim-A', now: plusSeconds(T0, 4) }), null);
  assert.equal(completions.nackDelivery({ host: 'kimi-code', claimId: 'claim-A', now: plusSeconds(T0, 4) }), null);
  const afterLateA = completions.getCompletion('thread-iso-turn-iso-completion');
  assert.equal(afterLateA.deliveryState, 'claimed_hook');
  assert.equal(afterLateA.claimId, 'claim-B');
  assert.equal(
    completions.ackDelivery({ host: 'kimi-code', claimId: 'claim-B', now: plusSeconds(T0, 5) }).deliveryState,
    'delivered',
  );

  // Waiter 路径：waiter claim A（出生态）→ release 回 pending → hook claim B →
  // A 的迟到 ACK 不得影响 B 的 claim。
  executions.createExecution(executionInput({
    workspace,
    threadId: 'thread-iso-w',
    turnId: 'turn-iso-w',
    ownerInstanceId: 'instance-1',
  }));
  const reserved = executions.reserveWaiter({
    host: 'kimi-code',
    workspace,
    sessionId: 'session-a',
    threadId: 'thread-iso-w',
    reservationId: 'waiter-A',
    now: plusSeconds(T0, 6),
  });
  assert.equal(reserved.reserved, true);
  const born = completions.insertCompletionFirst(terminal(
    'thread-iso-w',
    'turn-iso-w',
    workspace,
    { completionId: 'iso-w-completion', now: plusSeconds(T0, 6) },
  ));
  assert.equal(born.deliveryState, 'claimed_waiter');
  assert.equal(born.claimId, 'waiter-A');
  assert.equal(
    executions.releaseReservation({ host: 'kimi-code', threadId: 'thread-iso-w', reservationId: 'waiter-A' }).released,
    true,
  );
  assert.equal(completions.getCompletion('iso-w-completion').deliveryState, 'pending');
  const [hookClaim] = completions.claimPendingHook({
    host: 'kimi-code',
    workspace,
    sessionId: 'session-a',
    claimId: 'hook-B',
    now: plusSeconds(T0, 7),
  });
  assert.equal(hookClaim.claimId, 'hook-B');
  assert.equal(completions.ackDelivery({ host: 'kimi-code', claimId: 'waiter-A', now: plusSeconds(T0, 8) }), null);
  const afterLateWaiter = completions.getCompletion('iso-w-completion');
  assert.equal(afterLateWaiter.deliveryState, 'claimed_hook');
  assert.equal(afterLateWaiter.claimId, 'hook-B');
});

test('claim-layer recovery requeues expired claims before consumer CAS claims', async (t) => {
  const { store } = await openStore(t);
  const executions = new ExecutionStore(store);
  const completions = new CompletionStore(store);
  const workspace = '/workspace/claim-recovery';

  // (a) 过期 claimed_hook 在迟到 waiter 认领前被回收（thread 有界）。
  const staleHook = insertProvenancedCompletion(store, {
    threadId: 'thread-rec-h',
    turnId: 'turn-rec-h',
    workspace,
    now: plusSeconds(T0, 1),
  });
  completions.claimPendingHook({
    host: 'kimi-code',
    workspace,
    sessionId: 'session-a',
    claimId: 'dead-hook',
    now: plusSeconds(T0, 2),
  });
  assert.equal(completions.getCompletion(staleHook.completionId).deliveryState, 'claimed_hook');

  // 未过期的 claim 不得被回收：claim 时间在 lease 窗口内 → waiter 认领失败。
  const notExpired = executions.reserveWaiter({
    host: 'kimi-code',
    workspace,
    sessionId: 'session-a',
    threadId: 'thread-rec-h',
    reservationId: 'not-expired-waiter',
    now: plusSeconds(T0, 4),
    leaseMs: 5_000,
  });
  assert.equal(notExpired.reserved, false);
  assert.equal(notExpired.reason, 'not_found');

  const lateWaiter = executions.reserveWaiter({
    host: 'kimi-code',
    workspace,
    sessionId: 'session-a',
    threadId: 'thread-rec-h',
    reservationId: 'late-waiter',
    now: plusSeconds(T0, 10),
    leaseMs: 5_000,
  });
  assert.equal(lateWaiter.reserved, true);
  assert.equal(lateWaiter.source, 'completion');
  assert.equal(lateWaiter.completion.deliveryState, 'claimed_waiter');
  assert.equal(lateWaiter.completion.claimId, 'late-waiter');

  // (b) 过期 claimed_waiter 在 Hook 认领前被回收（session 有界）。
  executions.createExecution(executionInput({
    workspace,
    threadId: 'thread-rec-w',
    turnId: 'turn-rec-w',
    ownerInstanceId: 'instance-1',
  }));
  executions.reserveWaiter({
    host: 'kimi-code',
    workspace,
    sessionId: 'session-a',
    threadId: 'thread-rec-w',
    reservationId: 'dead-waiter',
    now: plusSeconds(T0, 20),
  });
  const bornWaiter = completions.insertCompletionFirst(terminal(
    'thread-rec-w',
    'turn-rec-w',
    workspace,
    { completionId: 'rec-w-completion', now: plusSeconds(T0, 21) },
  ));
  assert.equal(bornWaiter.deliveryState, 'claimed_waiter');
  // 弃置的 late-waiter claim（claimed_at=T0+10）此刻同样过期，一并被回收认领；
  // 断言按 created_at 排序的整批结果。
  const claimedBatch = completions.claimPendingHook({
    host: 'kimi-code',
    workspace,
    sessionId: 'session-a',
    claimId: 'fresh-hook',
    now: plusSeconds(T0, 40),
    leaseMs: 5_000,
  });
  assert.deepEqual(
    claimedBatch.map((row) => row.completionId),
    ['thread-rec-h-turn-rec-h-completion', 'rec-w-completion'],
  );
  assert.ok(claimedBatch.every((row) => row.deliveryState === 'claimed_hook' && row.claimId === 'fresh-hook'));
});

test('session-bounded claim recovery never touches other sessions or hosts', async (t) => {
  const { store } = await openStore(t);
  const completions = new CompletionStore(store);
  const otherSession = insertProvenancedCompletion(store, {
    threadId: 'thread-other',
    turnId: 'turn-other',
    sessionId: 'session-b',
    now: plusSeconds(T0, 1),
  });
  completions.claimPendingHook({
    host: 'kimi-code',
    workspace: '/workspace/main',
    sessionId: 'session-b',
    claimId: 'other-claim',
    now: plusSeconds(T0, 2),
  });
  const otherHost = insertProvenancedCompletion(store, {
    threadId: 'thread-host-b',
    turnId: 'turn-host-b',
    host: 'zcode',
    sessionId: 'session-b',
    now: plusSeconds(T0, 3),
  });
  completions.claimPendingHook({
    host: 'zcode',
    workspace: '/workspace/main',
    sessionId: 'session-b',
    claimId: 'zcode-claim',
    now: plusSeconds(T0, 4),
  });

  const recovered = completions.recoverExpiredClaims({
    host: 'kimi-code',
    workspace: '/workspace/main',
    sessionId: 'session-a',
    now: plusSeconds(T0, 60),
    leaseMs: 5_000,
  });
  assert.equal(recovered, 0);
  assert.equal(completions.getCompletion(otherSession.completionId).deliveryState, 'claimed_hook');
  assert.equal(completions.getCompletion(otherHost.completionId).deliveryState, 'claimed_hook');

  const recoveredB = completions.recoverExpiredClaims({
    host: 'kimi-code',
    workspace: '/workspace/main',
    sessionId: 'session-b',
    now: plusSeconds(T0, 61),
    leaseMs: 5_000,
  });
  assert.equal(recoveredB, 1);
  assert.equal(completions.getCompletion(otherSession.completionId).deliveryState, 'pending');
  assert.equal(completions.getCompletion(otherHost.completionId).deliveryState, 'claimed_hook');
});
