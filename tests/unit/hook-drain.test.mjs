import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { drainPending } from '../../src/hook/drain.mjs';
import { availableHosts, renderCompletions } from '../../src/hook/render-completions.mjs';

function row(completionId = 'completion-1') {
  return {
    completionId,
    payload: {
      threadId: 'thread-1',
      status: 'completed',
      finalAssistantMessage: 'subagent finished',
      changes: { files: ['src/app.mjs'] },
    },
  };
}

test('drainPending claims before rendering and ACKs only after output succeeds', async () => {
  const events = [];
  const store = {
    requeueExpiredLeases() { events.push('requeue'); return 0; },
    claimPendingHook(input) {
      events.push(['claim', input.workspace]);
      return [row()];
    },
    ackDelivery(input) {
      events.push(['ack', input.deliveryId]);
      return { acknowledged: true };
    },
  };
  const output = {
    write(text) {
      events.push(['write', text]);
      return true;
    },
  };
  const result = await drainPending({
    workspace: '/alias/workspace',
    host: 'plain',
    store,
    deliveryId: 'hook-delivery-1',
    workspaceGuard: { resolve: async (value) => { events.push(['resolve', value]); return '/canonical/workspace'; } },
    renderer(completions) {
      events.push(['render', completions[0].completionId]);
      return 'rendered completion';
    },
    output,
  });
  assert.equal(result.acknowledged, true);
  assert.deepEqual(events, [
    ['resolve', '/alias/workspace'],
    'requeue',
    ['claim', '/canonical/workspace'],
    ['render', 'completion-1'],
    ['write', 'rendered completion\n'],
    ['ack', 'hook-delivery-1'],
  ]);
});

test('a render crash leaves the claimed lease for expiry-based recovery', async () => {
  let state = 'pending';
  const store = {
    requeueExpiredLeases() {
      if (state === 'claimed_hook') state = 'pending';
      return 1;
    },
    claimPendingHook() {
      if (state !== 'pending') return [];
      state = 'claimed_hook';
      return [row('crash-recovery')];
    },
    ackDelivery() {
      assert.fail('a failed render must not ACK');
    },
  };
  await assert.rejects(
    drainPending({ workspace: '/workspace', store, workspaceGuard: { resolve: async () => '/workspace' }, renderer() { throw new Error('render crashed'); } }),
    /render crashed/,
  );
  assert.equal(state, 'claimed_hook');
  store.requeueExpiredLeases();
  assert.equal(state, 'pending');
});

test('host wrappers remain isolated and stable completion ids remain visible', () => {
  const completions = [row('duplicate-id'), row('duplicate-id')];
  const outputs = availableHosts().map((host) => renderCompletions(completions, host));
  assert.equal(new Set(outputs).size, availableHosts().length);
  assert.match(outputs[0], /duplicate-id/);
  assert.match(outputs[0], /subagent finished/);
});

test('drainPending can write through a backpressure-aware stream', async () => {
  const output = new PassThrough();
  const chunks = [];
  output.on('data', (chunk) => chunks.push(chunk.toString()));
  const store = {
    claimPendingHook() { return [row('stream-completion')]; },
    ackDelivery() { return { acknowledged: true }; },
  };
  const result = await drainPending({ workspace: '/workspace', store, workspaceGuard: { resolve: async () => '/workspace' }, output });
  assert.equal(result.acknowledged, true);
  assert.match(chunks.join(''), /stream-completion/);
});
