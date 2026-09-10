import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { SqliteStore } from '../../src/adapters/sqlite/sqlite-store.mjs';
import { CompletionRouter } from '../../src/core/completion-router.mjs';
import { CompletionStore } from '../../src/core/completion-store.mjs';
import { ExecutionStore } from '../../src/core/execution-store.mjs';

async function setup(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'codex-as-subagent-router-'));
  const store = SqliteStore.open(dataDir);
  const executions = new ExecutionStore(store);
  const completions = new CompletionStore(store);
  const router = new CompletionRouter({ executions, completions });
  t.after(() => {
    store.close();
    return rm(dataDir, { recursive: true, force: true });
  });
  return { store, executions, completions, router };
}

test('CompletionRouter persists terminal result first and ignores non-terminal events', async (t) => {
  const { store, executions, completions, router } = await setup(t);
  const workspace = '/workspace/router';
  executions.createExecution({
    threadId: 'thread-router',
    turnId: 'turn-router',
    workspace,
    ownerInstanceId: 'router-instance',
  });

  assert.equal(router.onTerminal({
    type: 'assistant.delta',
    threadId: 'thread-router',
    turnId: 'turn-router',
    workspace,
    assistantMessage: 'still working',
  }), null);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM completions').get().count, 0);

  const result = router.onTerminal({
    type: 'turn.completed',
    status: 'completed',
    threadId: 'thread-router',
    turnId: 'turn-router',
    workspace,
    finalAssistantMessage: 'finished',
    turn: {
      id: 'turn-router',
      status: 'completed',
      fileChanges: [{ path: 'current-turn.mjs', kind: 'added' }],
    },
  });
  assert.equal(result.deliveryState, 'pending');
  assert.equal(result.payload.finalAssistantMessage, 'finished');
  assert.equal(result.payload.changes.files[0].path, 'current-turn.mjs');
  assert.equal(executions.getExecution('thread-router'), null);
  assert.equal(completions.getCompletion(result.completionId).deliveryState, 'pending');
});

test('CompletionRouter accepts normalized terminal events and preserves their safe turn changes', async (t) => {
  const { executions, completions, router } = await setup(t);
  const workspace = '/workspace/router-normalized';
  executions.createExecution({
    threadId: 'thread-normalized',
    turnId: 'turn-normalized',
    workspace,
    ownerInstanceId: 'router-instance',
  });

  const result = router.onTerminal({
    type: 'turn.completed',
    threadId: 'thread-normalized',
    assistantMessage: 'normalized complete',
    changes: {
      files: [{ path: 'normalized-turn.mjs', kind: 'modified' }],
      filesChanged: 1,
      filesTruncated: false,
    },
  });
  assert.equal(result.deliveryState, 'pending');
  assert.deepEqual(result.payload.changes, {
    files: [{ path: 'normalized-turn.mjs', kind: 'modified' }],
    filesChanged: 1,
    filesTruncated: false,
  });
});

test('CompletionRouter accepts an already-built canonical TerminalResult', async (t) => {
  const { store, completions, router } = await setup(t);
  const result = router.onTerminal({
    turnId: 'turn-canonical',
    workspace: '/workspace/router-canonical',
    terminalResult: {
      threadId: 'thread-canonical',
      status: 'completed',
      finalAssistantMessage: 'canonical complete',
      changes: {
        files: ['canonical-turn.mjs'],
        filesChanged: 1,
        filesTruncated: false,
      },
      error: null,
    },
  });
  assert.equal(result.deliveryState, 'pending');
  assert.equal(result.payload.finalAssistantMessage, 'canonical complete');
  assert.deepEqual(result.payload.changes.files, ['canonical-turn.mjs']);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM completions').get().count, 1);
  assert.equal(completions.getCompletion(result.completionId).terminalStatus, 'completed');
});

test('CompletionRouter routes a reserved direct terminal result without holding a delivery lock', async (t) => {
  const { executions, completions, router } = await setup(t);
  const workspace = '/workspace/router-direct';
  executions.createExecution({
    threadId: 'thread-router-direct',
    turnId: 'turn-router-direct',
    workspace,
    ownerInstanceId: 'router-instance',
  });
  const reservation = executions.reserveDirect({
    threadId: 'thread-router-direct',
    reservationId: 'router-direct-delivery',
  });
  assert.equal(reservation.reserved, true);

  const result = router.onTerminal({
    type: 'turn.failed',
    status: 'failed',
    threadId: 'thread-router-direct',
    turnId: 'turn-router-direct',
    workspace,
    lastAssistantMessage: 'failed safely',
    error: { code: 'upstream_error', message: 'bounded failure' },
    turn: { id: 'turn-router-direct', status: 'failed' },
  });
  assert.equal(result.deliveryState, 'claimed_direct');
  assert.equal(result.deliveryId, 'router-direct-delivery');
  assert.equal(completions.ackDelivery({ deliveryId: result.deliveryId }).deliveryState, 'delivered');
});
