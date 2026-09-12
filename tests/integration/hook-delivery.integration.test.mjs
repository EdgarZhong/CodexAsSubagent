import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { SqliteStore } from '../../src/adapters/sqlite/sqlite-store.mjs';
import { CompletionStore } from '../../src/core/completion-store.mjs';
import { TerminalResult } from '../../src/core/terminal-result.mjs';
import { drainPending } from '../../src/hook/drain.mjs';
import { renderCompletions } from '../../src/hook/render-completions.mjs';

const HOST = 'zcode';
const SESSION = 'session-zcode-1';

async function setup(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'codex-hook-delivery-'));
  const workspacePath = await mkdtemp(join(tmpdir(), 'codex-hook-workspace-'));
  const otherWorkspacePath = await mkdtemp(join(tmpdir(), 'codex-hook-other-workspace-'));
  const workspace = await realpath(workspacePath);
  const otherWorkspace = await realpath(otherWorkspacePath);
  const store = SqliteStore.open(dataDir);
  const completions = new CompletionStore(store);
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(workspacePath, { recursive: true, force: true });
    await rm(otherWorkspacePath, { recursive: true, force: true });
  });
  return { store, completions, workspace, otherWorkspace };
}

function insert(completions, { workspace, threadId, turnId, completionId, message = 'done' }) {
  // 无 Execution 的 trusted 路径必须显式携带 provenance（host/workspace/session）。
  return completions.insertCompletionFirst({
    host: HOST,
    workspace,
    sessionId: SESSION,
    threadId,
    turnId,
    completionId,
    terminalResult: new TerminalResult({
      threadId,
      status: 'completed',
      finalAssistantMessage: message,
      changes: { files: [`${threadId}.mjs`] },
    }),
  });
}

test('Hook drains only current-workspace pending completions and ACKs after claim', async (t) => {
  const harness = await setup(t);
  insert(harness.completions, {
    workspace: harness.workspace,
    threadId: 'thread-current',
    turnId: 'turn-current',
    completionId: 'completion-current',
  });
  insert(harness.completions, {
    workspace: harness.otherWorkspace,
    threadId: 'thread-foreign',
    turnId: 'turn-foreign',
    completionId: 'completion-foreign',
  });
  let stateAtWrite;
  const output = {
    write(text) {
      stateAtWrite = harness.completions.getCompletion('completion-current').deliveryState;
      assert.match(text, /thread-current/);
      return true;
    },
  };
  const result = await drainPending({
    workspace: harness.workspace,
    host: HOST,
    sessionId: SESSION,
    store: harness.completions,
    output,
  });
  assert.equal(stateAtWrite, 'claimed_hook');
  assert.equal(result.acknowledged, true);
  assert.equal(harness.completions.getCompletion('completion-current').deliveryState, 'delivered');
  assert.equal(harness.completions.getCompletion('completion-foreign').deliveryState, 'pending');
  assert.match(result.text, /thread-current/);
  const parsed = JSON.parse(result.text);
  assert.match(parsed.additionalContext, /thread-current/);
  assert.equal(parsed.decision, undefined, 'non-Stop drain must not request continuation');
});

test('completions of another session are invisible to the drain even in the same workspace', async (t) => {
  const harness = await setup(t);
  insert(harness.completions, {
    workspace: harness.workspace,
    threadId: 'thread-other-session',
    turnId: 'turn-other-session',
    completionId: 'completion-other-session',
  });
  const result = await drainPending({
    workspace: harness.workspace,
    host: HOST,
    sessionId: 'session-B',
    store: harness.completions,
  });
  assert.equal(result.count, 0);
  assert.equal(harness.completions.getCompletion('completion-other-session').deliveryState, 'pending');
});

test('expired claimed Hook lease is requeued and delivered on a later drain', async (t) => {
  const harness = await setup(t);
  insert(harness.completions, {
    workspace: harness.workspace,
    threadId: 'thread-expired',
    turnId: 'turn-expired',
    completionId: 'completion-expired',
  });
  const firstClaim = harness.completions.claimPendingHook({
    host: HOST,
    workspace: harness.workspace,
    sessionId: SESSION,
    claimId: 'crashed-hook',
    now: '2026-09-11T00:00:00.000Z',
  });
  assert.equal(firstClaim.length, 1);
  assert.equal(harness.completions.getCompletion('completion-expired').deliveryState, 'claimed_hook');
  const result = await drainPending({
    workspace: harness.workspace,
    host: HOST,
    sessionId: SESSION,
    store: harness.completions,
    now: '2026-09-11T00:00:31.000Z',
  });
  assert.equal(result.acknowledged, true);
  assert.equal(harness.completions.getCompletion('completion-expired').deliveryState, 'delivered');
});

test('duplicate completion ids remain visible to the renderer without deduplication', async (t) => {
  const harness = await setup(t);
  insert(harness.completions, {
    workspace: harness.workspace,
    threadId: 'thread-a',
    turnId: 'turn-a',
    completionId: 'same-visible-id-a',
  });
  insert(harness.completions, {
    workspace: harness.workspace,
    threadId: 'thread-b',
    turnId: 'turn-b',
    completionId: 'same-visible-id-b',
  });
  const result = await drainPending({
    workspace: harness.workspace,
    host: HOST,
    sessionId: SESSION,
    store: harness.completions,
  });
  assert.deepEqual(result.completions.map((entry) => entry.completionId), ['same-visible-id-a', 'same-visible-id-b']);
  assert.match(renderCompletions(result.completions), /same-visible-id-a/);
  assert.match(renderCompletions(result.completions), /same-visible-id-b/);
});
