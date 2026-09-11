import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { SqliteStore } from '../../src/adapters/sqlite/sqlite-store.mjs';
import { runKimiWebWorker, KIMI_WEB_MODEL } from '../../src/hook/kimi-web.mjs';

async function setup(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'cas-kimi-web-integration-'));
  const workspace = await mkdtemp(join(tmpdir(), 'cas-kimi-workspace-'));
  const store = SqliteStore.open(dataDir);
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  });
  return { store, workspace };
}

function seed(store, workspace, threadId = 'thread-1') {
  store.createExecution({ threadId, turnId: 'turn-1', workspace, ownerInstanceId: 'owner-1' });
  return store.insertCompletionFirst({
    threadId,
    turnId: 'turn-1',
    workspace,
    completionId: 'completion-1',
    terminalResult: {
      threadId,
      turnId: 'turn-1',
      status: 'completed',
      finalAssistantMessage: 'Kimi Web integration complete',
      changes: { files: [] },
    },
  });
}

test('Kimi Web worker delivers a durable completion and ACKs it after acceptance', async (t) => {
  const { store, workspace } = await setup(t);
  seed(store, workspace);
  const submitted = [];
  const result = await runKimiWebWorker({
    server: { baseUrl: 'http://127.0.0.1:58627', token: 'secret', sessionId: 'session-1', workspace },
    sessionId: 'session-1',
    workspace,
    store,
    resolveWorkspace: async (value) => value,
    client: {
      async submitCompletion(input) { submitted.push(input); return { accepted: true, model: KIMI_WEB_MODEL }; },
    },
  });
  assert.equal(result.delivered, 1);
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].model, KIMI_WEB_MODEL);
  assert.equal(store.listCompletions({ workspace })[0].deliveryState, 'delivered');
});

test('Kimi Web network failure keeps the completion leased instead of ACKing', async (t) => {
  const { store, workspace } = await setup(t);
  seed(store, workspace);
  const result = await runKimiWebWorker({
    server: { baseUrl: 'http://127.0.0.1:58627', token: 'secret', sessionId: 'session-1', workspace },
    sessionId: 'session-1',
    workspace,
    store,
    resolveWorkspace: async (value) => value,
    client: { async submitCompletion() { throw new Error('server disappeared'); } },
  });
  assert.equal(result.delivered, 0);
  assert.match(result.error.message, /server disappeared/);
  assert.equal(store.listCompletions({ workspace })[0].deliveryState, 'claimed_hook');
  store.requeueExpiredLeases({ now: new Date(Date.now() + 31_000) });
  assert.equal(store.listCompletions({ workspace })[0].deliveryState, 'pending');
});
