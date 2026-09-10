import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { Worker } from 'node:worker_threads';

import { SqliteStore } from '../../src/adapters/sqlite/sqlite-store.mjs';
import { CompletionStore } from '../../src/core/completion-store.mjs';
import { ExecutionStore } from '../../src/core/execution-store.mjs';
import { TerminalResult } from '../../src/core/terminal-result.mjs';

async function openStore(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'codex-as-subagent-task3-'));
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

test('SqliteStore creates the durable schema and required SQLite pragmas', async (t) => {
  const { store } = await openStore(t);

  assert.equal(store.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(store.db.prepare('PRAGMA synchronous').get().synchronous, 2);
  assert.equal(store.db.prepare('PRAGMA busy_timeout').get().timeout, 5000);
  assert.equal(store.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);

  const tables = store.db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  ).all().map((row) => row.name);
  assert.deepEqual(tables, ['completions', 'executions', 'meta']);

  const completionColumns = store.db.prepare('PRAGMA table_info(completions)').all().map((row) => row.name);
  assert.deepEqual(completionColumns, [
    'completion_id',
    'thread_id',
    'turn_id',
    'workspace',
    'terminal_status',
    'payload_json',
    'delivery_state',
    'delivery_id',
    'delivery_started_at',
    'delivered_at',
    'created_at',
  ]);

  const indexes = store.db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'completions_pending_workspace_idx'",
  ).all();
  assert.equal(indexes.length, 1);
});

test('terminal completion commits before delivery and duplicate thread/turn is idempotent', async (t) => {
  const { store } = await openStore(t);
  const executions = new ExecutionStore(store);
  const completions = new CompletionStore(store);
  const workspace = await mkdtemp(join(tmpdir(), 'codex-as-subagent-workspace-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(join(workspace, 'pre-existing-dirty-file.mjs'), 'already here\n');

  executions.createExecution({
    threadId: 'thread-pending',
    turnId: 'turn-pending',
    workspace,
    ownerInstanceId: 'instance-1',
    now: '2026-09-11T00:00:00.000Z',
  });

  const first = completions.insertCompletionFirst(terminal(
    'thread-pending',
    'turn-pending',
    workspace,
    { repositoryDiff: { files: ['pre-existing-dirty-file.mjs'] } },
  ));
  assert.equal(first.inserted, true);
  assert.equal(first.deliveryState, 'pending');
  assert.equal(first.payload.changes.files[0].path, 'turn-file.mjs');
  assert.doesNotMatch(JSON.stringify(first.payload), /pre-existing-dirty-file/);
  assert.equal(executions.getExecution('thread-pending'), null);

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
});

test('direct reservation uses compare-and-set, ACK is required, and expired leases requeue', async (t) => {
  const { store } = await openStore(t);
  const executions = new ExecutionStore(store);
  const completions = new CompletionStore(store);
  const workspace = '/workspace/direct';

  executions.createExecution({
    threadId: 'thread-direct',
    turnId: 'turn-direct',
    workspace,
    ownerInstanceId: 'instance-1',
    now: '2026-09-11T00:00:00.000Z',
  });
  const first = executions.reserveDirect({
    threadId: 'thread-direct',
    reservationId: 'direct-reservation',
    now: '2026-09-11T00:00:01.000Z',
  });
  const second = executions.reserveDirect({
    threadId: 'thread-direct',
    reservationId: 'another-reservation',
    now: '2026-09-11T00:00:02.000Z',
  });
  assert.equal(first.reserved, true);
  assert.equal(first.reservationId, 'direct-reservation');
  assert.equal(second.reserved, false);

  const completion = completions.insertCompletionFirst(terminal(
    'thread-direct',
    'turn-direct',
    workspace,
    { completionId: 'direct-completion' },
  ));
  assert.equal(completion.deliveryState, 'claimed_direct');
  assert.equal(completion.deliveryId, 'direct-reservation');
  assert.equal(completions.ackDelivery({ deliveryId: 'wrong-id' }), null);
  assert.equal(completions.getCompletion('direct-completion').deliveryState, 'claimed_direct');
  assert.equal(completions.ackDelivery({
    deliveryId: 'direct-reservation',
    now: '2026-09-11T00:00:03.000Z',
  }).deliveryState, 'delivered');

  executions.createExecution({
    threadId: 'thread-hook-lease',
    turnId: 'turn-hook-lease',
    workspace,
    ownerInstanceId: 'instance-1',
    now: '2026-09-11T00:00:00.000Z',
  });
  const pending = completions.insertCompletionFirst(terminal(
    'thread-hook-lease',
    'turn-hook-lease',
    workspace,
    { completionId: 'hook-lease-completion' },
  ));
  assert.equal(pending.deliveryState, 'pending');
  const [claimed] = completions.claimPendingHook({
    workspace,
    now: '2026-09-11T00:00:10.000Z',
  });
  assert.equal(claimed.deliveryState, 'claimed_hook');
  assert.equal(completions.requeueExpiredLeases({
    now: '2026-09-11T00:00:41.000Z',
  }), 1);
  assert.equal(completions.getCompletion('hook-lease-completion').deliveryState, 'pending');

  const pendingDirect = completions.insertCompletionFirst(terminal(
    'thread-pending-direct',
    'turn-pending-direct',
    workspace,
    { completionId: 'pending-direct-completion' },
  ));
  assert.equal(pendingDirect.deliveryState, 'pending');
  const directClaim = executions.reserveDirect({
    threadId: 'thread-pending-direct',
    workspace,
    reservationId: 'pending-direct-reservation',
  });
  assert.equal(directClaim.source, 'completion');
  assert.equal(completions.getCompletion('pending-direct-completion').deliveryState, 'claimed_direct');
  assert.equal(executions.releaseReservation({ reservationId: 'pending-direct-reservation' }).released, true);
  assert.equal(completions.getCompletion('pending-direct-completion').deliveryState, 'pending');

  executions.createExecution({
    threadId: 'thread-direct-lease',
    turnId: 'turn-direct-lease',
    workspace,
    ownerInstanceId: 'instance-1',
    now: '2026-09-11T00:00:00.000Z',
  });
  executions.reserveDirect({
    threadId: 'thread-direct-lease',
    reservationId: 'direct-lease-reservation',
    now: '2026-09-11T00:00:00.000Z',
  });
  const directLease = completions.insertCompletionFirst(terminal(
    'thread-direct-lease',
    'turn-direct-lease',
    workspace,
    {
      completionId: 'direct-lease-completion',
      now: '2026-09-11T00:00:00.000Z',
    },
  ));
  assert.equal(directLease.deliveryState, 'claimed_direct');
  assert.equal(completions.requeueExpiredLeases({
    now: '2026-09-11T00:00:29.999Z',
  }), 0);
  assert.equal(completions.getCompletion('direct-lease-completion').deliveryState, 'claimed_direct');
  assert.equal(completions.requeueExpiredLeases({
    now: '2026-09-11T00:00:30.000Z',
  }), 1);
  assert.equal(completions.getCompletion('direct-lease-completion').deliveryState, 'pending');
});

test('two racing Hook Workers can claim a pending completion only once', async (t) => {
  const { dataDir, store } = await openStore(t);
  const executions = new ExecutionStore(store);
  const completions = new CompletionStore(store);
  const workspace = '/workspace/hook-race';
  executions.createExecution({
    threadId: 'thread-race',
    turnId: 'turn-race',
    workspace,
    ownerInstanceId: 'instance-1',
  });
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
        workspace: workerData.workspace,
        deliveryId: workerData.deliveryId,
      });
      parentPort.postMessage({
        type: 'result',
        count: claimed.length,
        deliveryId: claimed[0]?.deliveryId ?? null,
      });
      store.close();
    })().catch((error) => parentPort.postMessage({ type: 'error', message: error.message }));
  `;
  const workers = ['hook-a', 'hook-b'].map((deliveryId) => new Worker(workerSource, {
    eval: true,
    workerData: { barrier, dataDir, deliveryId, sqliteModule, workspace },
  }));
  t.after(() => Promise.all(workers.map((worker) => worker.terminate())));

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

  await Promise.all(workers.map((worker) => nextMessage(worker)));
  const results = workers.map((worker) => nextMessage(worker));
  Atomics.store(new Int32Array(barrier), 0, 1);
  Atomics.notify(new Int32Array(barrier), 0, workers.length);
  const [first, second] = await Promise.all(results);
  assert.equal(first.count + second.count, 1);
  assert.equal([first.deliveryId, second.deliveryId].filter(Boolean).length, 1);
  const claimed = completions.getCompletion('thread-race-turn-race-completion');
  assert.equal(claimed.deliveryState, 'claimed_hook');
  assert.equal(claimed.deliveryId, first.deliveryId ?? second.deliveryId);
});

test('SqliteStore rejects payload identity and status conflicts', async (t) => {
  const { store } = await openStore(t);
  const completions = new CompletionStore(store);
  const canonical = new TerminalResult({
    threadId: 'payload-thread',
    status: 'completed',
    finalAssistantMessage: 'safe',
    changes: { files: [] },
  });

  assert.throws(
    () => completions.insertCompletionFirst({
      threadId: 'row-thread',
      turnId: 'row-turn',
      workspace: '/workspace/identity',
      terminalResult: canonical,
    }),
    /threadId/,
  );
  assert.throws(
    () => completions.insertCompletionFirst({
      threadId: 'row-thread',
      turnId: 'row-turn',
      workspace: '/workspace/identity',
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
      threadId: 'row-thread',
      turnId: 'row-turn',
      workspace: '/workspace/identity',
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
