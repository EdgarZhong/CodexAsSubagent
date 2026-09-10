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

test('CompletionRouter rejects conflicting evidence before any durable mutation', async (t) => {
  const { store, executions, router } = await setup(t);
  const cases = [];
  for (const other of ['failed', 'running', 'unknown', undefined]) {
    const status = { type: 'completed', status: other };
    cases.push([`event.status/${other}`, { status }]);
    for (const key of ['item', 'diff']) {
      cases.push([`params.${key}/${other}`, { params: { [key]: { turn: { status } } } }]);
    }
    cases.push([`hidden.status/${other}`, {
      verifiedTerminalStatus: true,
      internalStatusSources: [{ source: 'test.status', status }],
    }]);
    for (const key of ['turn', 'turnRecord', 'currentTurn']) {
      cases.push([`result.${key}/${other}`, { result: { status: 'completed', [key]: { status } } }]);
    }
    if (other !== 'running') cases.push([`execution.status/${other}`, {}, { status: { type: 'running', status: other } }]);
  }
  for (const key of ['turn', 'turnRecord', 'currentTurn']) {
    cases.push([`event.${key}.type`, { [key]: { type: 'failed', status: 'completed' } }]);
    cases.push([`event.${key}.id`, { [key]: { id: 'other-turn' } }]);
    cases.push([`result.${key}.thread`, { result: { status: 'completed', [key]: { thread: { id: 'other-thread' } } } }]);
    cases.push([`execution.${key}.id`, {}, { [key]: { id: 'other-turn' } }]);
    cases.push([`execution.${key}.thread`, {}, { [key]: { thread: { id: 'other-thread' } } }]);
  }
  cases.push(
    ['conflicting method', { method: 'turn/failed' }],
    ['conflicting params method', { params: { method: 'item/completed' } }],
    ['undefined hidden status', { internalStatusSources: undefined }],
    ['execution.active disagreement', {}, { status: 'running', currentTurn: { status: 'queued' } }],
    ['hidden result identity', { result: { status: 'completed', verifiedTurnIdentity: true,
      internalTurnIdentitySources: [{ source: 'result.turn.id', value: 'other-turn' }] } }],
    ['hidden execution identity', {}, { verifiedThreadIdentity: true,
      internalThreadIdentitySources: [{ source: 'execution.thread.id', value: 'other-thread' }] }],
    ['hidden result status', { result: { status: 'completed', verifiedTerminalStatus: true,
      internalStatusSources: [{ source: 'result.status', status: 'failed' }] } }],
    ['deep params thread', { params: { diff: { turn: { thread: { id: 'other-thread' } } } } }],
    ['failed diff completed', { type: 'turn.failed', status: 'failed', params: { diff: { turn: { status: 'completed' } } } }],
    ['hidden event thread', { verifiedThreadIdentity: true,
      internalThreadIdentitySources: [{ source: 'event.thread.id', value: 'other-thread' }] }],
    ['hidden event turn', { verifiedTurnIdentity: true,
      internalTurnIdentitySources: [{ source: 'event.turn.id', value: 'other-turn' }] }],
    ['hidden execution status', {}, { verifiedTerminalStatus: true,
      internalStatusSources: [{ source: 'execution.status', status: { type: 'running', status: 'failed' } }] }],
    ['two supplied results', { result: { status: 'completed' }, terminalResult: {
      threadId: 'other-thread', status: 'completed', changes: { files: [] },
    } }],
  );
  const getExecution = router.executions.getExecution.bind(router.executions);
  let executionExtras = {};
  router.executions.getExecution = (...args) => {
    const execution = getExecution(...args);
    return execution ? { ...execution, ...executionExtras } : null;
  };
  const failures = [];
  for (const [index, [name, extras, activeExtras = {}]] of cases.entries()) {
    const threadId = `thread-evidence-${index}`;
    const turnId = `turn-evidence-${index}`;
    executionExtras = activeExtras;
    executions.createExecution({ threadId, turnId,
      workspace: '/workspace/evidence', ownerInstanceId: 'router-instance' });
    const before = getExecution(threadId);
    const event = { type: 'turn.completed', status: 'completed', threadId, internalTurnId: turnId, ...extras };
    if (event.result) event.result = { threadId, turnId, changes: { files: [] }, ...event.result };
    if (router.onTerminal(event) !== null
      || JSON.stringify(getExecution(threadId)) !== JSON.stringify(before)
      || store.db.prepare('SELECT COUNT(*) AS count FROM completions WHERE thread_id = ?').get(threadId).count !== 0) {
      failures.push(name);
    }
  }
  assert.deepEqual(failures, []);
});

test('CompletionRouter validates TerminalResult instance evidence before toJSON projection', async (t) => {
  const { executions, store, router } = await setup(t);
  const failures = [];
  for (const [index, extras] of [
    { turn: { thread: { id: 'other-thread' } } },
    { turnRecord: { id: 'other-turn' } },
    { currentTurn: { status: { type: 'completed', status: 'failed' } } },
  ].entries()) {
    const threadId = `thread-instance-${index}`;
    const turnId = `turn-instance-${index}`;
    executions.createExecution({ threadId, turnId, workspace: '/workspace/instance', ownerInstanceId: 'router-instance' });
    const terminalResult = Object.assign(new TerminalResult({ threadId, status: 'completed' }), extras);
    if (router.onTerminal({ type: 'turn.completed', threadId, turnId, terminalResult }) !== null
      || executions.getExecution(threadId) === null) failures.push(index);
  }
  assert.deepEqual(failures, []);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM completions').get().count, 0);
});

test('CompletionRouter requires retained turn identity and accepts consistent terminal evidence', async (t) => {
  const { executions, store, router } = await setup(t);
  const getExecution = router.executions.getExecution.bind(router.executions);
  router.executions.getExecution = (...args) => {
    const execution = getExecution(...args);
    return execution ? { ...execution, status: { type: 'running', status: 'running' },
      currentTurn: { id: execution.turnId, thread: { id: execution.threadId }, status: 'running' } } : null;
  };
  for (const status of ['completed', 'failed', 'interrupted']) {
    const threadId = `thread-consistent-${status}`;
    const turnId = `turn-consistent-${status}`;
    executions.createExecution({ threadId, turnId, workspace: '/workspace/consistent', ownerInstanceId: 'router-instance' });
    const raw = { method: `turn/${status}`, threadId, turnId, params: {
      item: { type: 'agentMessage', turn: { id: turnId, status: { type: status, status } } },
      diff: { turn: { id: turnId, thread: { id: threadId }, status } },
      currentTurn: { id: turnId, status },
    } };
    const normalized = normalizeEvent(raw);
    const before = getExecution(threadId);
    // Public serialization loses the private turn evidence, even with a supplied result.
    assert.equal(router.onTerminal({ ...JSON.parse(JSON.stringify(normalized)),
      result: { threadId, turnId, status, changes: { files: [] } } }), null);
    assert.deepEqual(getExecution(threadId), before);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM completions WHERE thread_id = ?').get(threadId).count, 0);
    const completion = router.onTerminal(normalized);
    assert.equal(completion.payload.status, status);
    assert.equal(getExecution(threadId), null);
    assert.doesNotMatch(JSON.stringify(completion.payload), /turnId|params|internal|verified/);
  }
});

test('CompletionRouter gates orphan canonical and recovery results on type and verification', async (t) => {
  const { store, router } = await setup(t);
  for (const provenance of ['canonical', 'recovery']) {
    const threadId = `thread-orphan-${provenance}`;
    const turnId = `turn-orphan-${provenance}`;
    const terminalResult = new TerminalResult({ threadId, status: 'completed' });
    const event = { provenance, verifiedTerminal: true, threadId, turnId,
      workspace: '/workspace/orphan', terminalResult,
      type: provenance === 'canonical' ? 'turn.completed' : 'recovery.terminal' };
    for (const extras of [
      { verifiedTerminal: false }, { type: 'error' }, { type: 'item.completed' },
      { currentTurn: { status: { type: 'completed', status: 'failed' } } },
      { turnRecord: { id: 'other-turn' } },
    ]) assert.equal(router.onTerminal({ ...event, ...extras }), null);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM completions WHERE thread_id = ?').get(threadId).count, 0);
    assert.equal(router.onTerminal(event).payload.status, 'completed');
  }
});

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

test('CompletionRouter accepts valid failed and interrupted terminal events', async (t) => {
  const { executions, completions, router } = await setup(t);
  const workspace = '/workspace/router-terminal-statuses';
  for (const [threadId, turnId, type, status] of [
    ['thread-failed', 'turn-failed', 'turn.failed', 'failed'],
    ['thread-interrupted', 'turn-interrupted', 'turn.interrupted', 'interrupted'],
  ]) {
    executions.createExecution({
      threadId,
      turnId,
      workspace,
      ownerInstanceId: 'router-instance',
    });
    const result = router.onTerminal({
      type,
      status,
      threadId,
      turnId,
      turn: { id: turnId, status },
    });
    assert.equal(result.payload.status, status);
    assert.equal(completions.getCompletion(result.completionId).terminalStatus, status);
    assert.equal(executions.getExecution(threadId), null);
  }
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

test('CompletionRouter rejects nested status and identity conflicts', async (t) => {
  const { store, executions, router } = await setup(t);
  const threadId = 'thread-nested-conflicts';
  const turnId = 'turn-nested-conflicts';
  executions.createExecution({
    threadId,
    turnId,
    workspace: '/workspace/router-nested-conflicts',
    ownerInstanceId: 'router-instance',
  });

  const normalizedStatusConflict = normalizeEvent({
    method: 'turn/completed',
    threadId,
    turnId,
    turn: { id: turnId, status: 'failed' },
  });
  assert.equal(normalizedStatusConflict.status, undefined);
  assert.equal(normalizedStatusConflict.verifiedTerminalStatus, false);
  assert.equal(router.onTerminal(normalizedStatusConflict), null);

  for (const event of [
    {
      type: 'turn.completed',
      status: 'completed',
      threadId,
      turnId,
      turn: { id: turnId, status: 'failed' },
    },
    {
      type: 'turn.failed',
      status: 'failed',
      threadId,
      turnId,
      turn: { id: turnId, status: 'completed' },
    },
    {
      type: 'turn.completed',
      status: 'completed',
      threadId,
      turnId,
      turn: { id: turnId, status: 'running' },
    },
    {
      type: 'turn.completed',
      status: 'completed',
      threadId,
      turnId,
      turn: { id: turnId, thread: { id: 'other-thread' }, status: 'completed' },
    },
    {
      type: 'turn.completed',
      status: 'completed',
      threadId,
      internalTurnId: turnId,
      turnRecord: { id: 'other-turn', status: 'completed' },
    },
    {
      type: 'turn.completed',
      status: 'completed',
      threadId,
      turnId,
      params: {
        item: { turn: { id: turnId, status: 'failed' } },
      },
    },
    {
      type: 'turn.completed',
      status: 'completed',
      threadId,
      turnId,
      params: {
        diff: { turn: { id: turnId, status: 'running' } },
      },
    },
    {
      type: 'turn.completed',
      status: 'completed',
      threadId,
      turnId,
      params: {
        diff: {
          turn: {
            id: turnId,
            thread: { id: 'other-thread' },
            status: 'completed',
          },
        },
      },
    },
    {
      type: 'turn.completed',
      status: 'completed',
      threadId,
      turnId,
      params: {
        item: {
          turn: {
            id: turnId,
            status: 'completed',
            currentTurn: { id: 'other-turn', status: 'completed' },
          },
        },
      },
    },
  ]) {
    assert.equal(router.onTerminal(event), null);
  }
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM completions').get().count, 0);
  assert.notEqual(executions.getExecution(threadId), null);
});

test('CompletionRouter rejects nested supplied-result status and identity conflicts', async (t) => {
  const { store, executions, router } = await setup(t);
  const workspace = '/workspace/router-result-evidence';
  const cases = [
    {
      threadId: 'thread-result-turn-status',
      turnId: 'turn-result-turn-status',
      key: 'terminalResult',
      payload: {
        status: 'completed',
        turn: { status: 'failed' },
      },
    },
    {
      threadId: 'thread-result-record-status',
      turnId: 'turn-result-record-status',
      key: 'result',
      payload: {
        status: 'completed',
        turnRecord: { status: 'running' },
      },
    },
    {
      threadId: 'thread-result-current-status',
      turnId: 'turn-result-current-status',
      key: 'terminalResult',
      payload: {
        status: 'completed',
        currentTurn: { status: 'unknown' },
      },
    },
    {
      threadId: 'thread-result-deep-identity',
      turnId: 'turn-result-deep-identity',
      key: 'terminalResult',
      payload: {
        status: 'completed',
        turn: {
          currentTurn: { id: 'other-turn', status: 'completed' },
        },
      },
    },
  ];

  for (const entry of cases) {
    executions.createExecution({
      threadId: entry.threadId,
      turnId: entry.turnId,
      workspace,
      ownerInstanceId: 'router-instance',
    });
    const payload = {
      threadId: entry.threadId,
      turnId: entry.turnId,
      changes: { files: [] },
      ...entry.payload,
    };
    assert.equal(router.onTerminal({
      type: 'turn.completed',
      status: 'completed',
      threadId: entry.threadId,
      turnId: entry.turnId,
      [entry.key]: payload,
    }), null);
  }

  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM completions').get().count, 0);
  assert.ok(cases.every(({ threadId }) => executions.getExecution(threadId) !== null));
});

test('CompletionRouter rejects conflicting nested active-execution evidence', async (t) => {
  const { store, executions, router } = await setup(t);
  const workspace = '/workspace/router-execution-evidence';
  const cases = [
    {
      threadId: 'thread-execution-current-id',
      turnId: 'turn-execution-current-id',
      evidence: {
        currentTurn: { id: 'other-turn', status: 'running' },
      },
    },
    {
      threadId: 'thread-execution-thread-id',
      turnId: 'turn-execution-thread-id',
      evidence: {
        turn: {
          id: 'turn-execution-thread-id',
          thread: { id: 'other-thread' },
          status: 'running',
        },
      },
    },
    {
      threadId: 'thread-execution-terminal-status',
      turnId: 'turn-execution-terminal-status',
      evidence: {
        currentTurn: { id: 'turn-execution-terminal-status', status: 'failed' },
      },
    },
    {
      threadId: 'thread-execution-deep-status',
      turnId: 'turn-execution-deep-status',
      evidence: {
        turn: {
          id: 'turn-execution-deep-status',
          status: 'running',
          currentTurn: { id: 'turn-execution-deep-status', status: 'unknown' },
        },
      },
    },
  ];
  for (const entry of cases) {
    executions.createExecution({
      threadId: entry.threadId,
      turnId: entry.turnId,
      workspace,
      ownerInstanceId: 'router-instance',
    });
  }

  const getExecution = router.executions.getExecution.bind(router.executions);
  const evidenceByThread = new Map(cases.map((entry) => [entry.threadId, entry.evidence]));
  router.executions.getExecution = (threadOrOptions, turnId) => {
    const execution = getExecution(threadOrOptions, turnId);
    return execution
      ? { ...execution, ...evidenceByThread.get(execution.threadId) }
      : null;
  };

  for (const entry of cases) {
    assert.equal(router.onTerminal({
      type: 'turn.completed',
      status: 'completed',
      threadId: entry.threadId,
      turnId: entry.turnId,
    }), null);
  }

  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM completions').get().count, 0);
  assert.ok(cases.every(({ threadId }) => executions.getExecution(threadId) !== null));
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
