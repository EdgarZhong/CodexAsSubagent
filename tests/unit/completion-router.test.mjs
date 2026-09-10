import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { SqliteStore } from '../../src/adapters/sqlite/sqlite-store.mjs';
import { CompletionRouter } from '../../src/core/completion-router.mjs';
import { CompletionStore } from '../../src/core/completion-store.mjs';
import { ExecutionStore } from '../../src/core/execution-store.mjs';
import { TerminalResult } from '../../src/core/terminal-result.mjs';
import { normalizeEvent } from '../../src/adapters/supervisor/protocol-normalizer.mjs';

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

  const result = router.onTerminal(normalizeEvent({
    method: 'turn/completed',
    threadId: 'thread-normalized',
    turnId: 'turn-normalized',
    params: {
      turn: {
        id: 'turn-normalized',
        status: 'completed',
        assistantMessage: 'normalized complete',
        changes: {
          files: [{ path: 'normalized-turn.mjs', kind: 'modified' }],
        },
      },
    },
  }));
  assert.equal(result.deliveryState, 'pending');
  assert.deepEqual(result.payload.changes, {
    files: [{ path: 'normalized-turn.mjs', kind: 'modified' }],
    filesChanged: 1,
    filesTruncated: false,
  });
});

test('CompletionRouter accepts an already-built verified recovery TerminalResult', async (t) => {
  const { store, completions, router } = await setup(t);
  const terminalResult = new TerminalResult({
    threadId: 'thread-canonical',
    status: 'completed',
    finalAssistantMessage: 'canonical complete',
    changes: {
      files: ['canonical-turn.mjs'],
      filesChanged: 1,
      filesTruncated: false,
    },
  });
  const result = router.onTerminal({
    type: 'recovery.terminal',
    provenance: 'recovery',
    verifiedTerminal: true,
    threadId: 'thread-canonical',
    turnId: 'turn-canonical',
    workspace: '/workspace/router-canonical',
    terminalResult,
  });
  assert.equal(result.deliveryState, 'pending');
  assert.equal(result.payload.finalAssistantMessage, 'canonical complete');
  assert.deepEqual(result.payload.changes.files, ['canonical-turn.mjs']);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM completions').get().count, 1);
  assert.equal(completions.getCompletion(result.completionId).terminalStatus, 'completed');
});

test('CompletionRouter only accepts verified terminal types and matching identities', async (t) => {
  const { store, executions, router } = await setup(t);
  const workspace = '/workspace/router-negative';
  executions.createExecution({
    threadId: 'thread-negative',
    turnId: 'turn-negative',
    workspace,
    ownerInstanceId: 'router-instance',
  });

  for (const event of [
    {
      type: 'error',
      status: 'failed',
      threadId: 'thread-negative',
      turnId: 'turn-negative',
    },
    {
      type: 'item.completed',
      status: 'completed',
      threadId: 'thread-negative',
      turnId: 'turn-negative',
    },
  ]) {
    assert.equal(router.onTerminal(event), null);
  }
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM completions').get().count, 0);
  assert.notEqual(executions.getExecution('thread-negative'), null);

  assert.equal(router.onTerminal({
    type: 'turn.completed',
    status: 'failed',
    threadId: 'thread-negative',
    turnId: 'turn-negative',
  }), null);
  assert.equal(router.onTerminal({
    type: 'turn.completed',
    threadId: 'orphan-thread',
    turnId: 'orphan-turn',
  }), null);
  const canonicalResult = new TerminalResult({
    threadId: 'thread-negative',
    status: 'completed',
    finalAssistantMessage: 'must not bypass event type',
    changes: { files: [] },
  });
  assert.equal(router.onTerminal({
    type: 'item.completed',
    provenance: 'canonical',
    verifiedTerminal: true,
    threadId: 'thread-negative',
    turnId: 'turn-negative',
    terminalResult: canonicalResult,
  }), null);
  assert.equal(router.onTerminal({
    type: 'recovery.terminal',
    provenance: 'recovery',
    threadId: 'thread-negative',
    turnId: 'turn-negative',
    terminalResult: canonicalResult,
  }), null);
  assert.equal(router.onTerminal({
    type: 'item.completed',
    provenance: 'recovery',
    verifiedTerminal: true,
    threadId: 'thread-negative',
    turnId: 'turn-negative',
    terminalResult: canonicalResult,
  }), null);
  assert.equal(router.onTerminal({
    type: 'turn.completed',
    threadId: 'thread-negative',
    turnId: 'stale-turn',
  }), null);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM completions').get().count, 0);
  assert.notEqual(executions.getExecution('thread-negative'), null);

  const mismatchedResult = new TerminalResult({
    threadId: 'other-thread',
    status: 'completed',
    finalAssistantMessage: 'wrong identity',
    changes: { files: [] },
  });
  assert.equal(router.onTerminal({
    type: 'turn.completed',
    threadId: 'thread-negative',
    turnId: 'turn-negative',
    terminalResult: mismatchedResult,
  }), null);
  assert.equal(router.onTerminal({
    type: 'turn.completed',
    threadId: 'thread-negative',
    turnId: 'turn-negative',
    terminalResult: new TerminalResult({
      threadId: 'thread-negative',
      status: 'failed',
      lastAssistantMessage: 'wrong status',
      changes: { files: [] },
    }),
  }), null);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM completions').get().count, 0);
});

test('CompletionRouter preserves truncated normalized change metadata', async (t) => {
  const { executions, router } = await setup(t);
  const workspace = '/workspace/router-truncated';
  executions.createExecution({
    threadId: 'thread-truncated',
    turnId: 'turn-truncated',
    workspace,
    ownerInstanceId: 'router-instance',
  });
  const files = Array.from({ length: 20 }, (_, index) => `turn-file-${index}.mjs`);
  const normalized = normalizeEvent({
    method: 'turn/completed',
    threadId: 'thread-truncated',
    turnId: 'turn-truncated',
    turn: {
      id: 'turn-truncated',
      status: 'completed',
      assistantMessage: 'truncated safely',
      fileChanges: files.slice(0, 1),
    },
  });
  normalized.changes = {
    files,
    filesChanged: 25,
    filesTruncated: true,
  };
  const result = router.onTerminal(normalized);
  assert.equal(result.payload.changes.files.length, 20);
  assert.equal(result.payload.changes.filesChanged, 25);
  assert.equal(result.payload.changes.filesTruncated, true);
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
