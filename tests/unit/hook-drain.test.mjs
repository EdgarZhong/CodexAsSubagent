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
      events.push(['claim', input.workspace, input.host, input.sessionId]);
      return [row()];
    },
    ackDelivery(input) {
      events.push(['ack', input.deliveryId, input.host]);
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
    // DeliveryContext：workspace 必须已是 canonical 形态（canonicalize 由 CLI 层完成）。
    workspace: '/canonical/workspace',
    host: 'plain',
    sessionId: 'session-1',
    store,
    deliveryId: 'hook-delivery-1',
    renderer(completions) {
      events.push(['render', completions[0].completionId]);
      return 'rendered completion';
    },
    output,
  });
  assert.equal(result.acknowledged, true);
  assert.deepEqual(events, [
    'requeue',
    ['claim', '/canonical/workspace', 'plain', 'session-1'],
    ['render', 'completion-1'],
    ['write', 'rendered completion\n'],
    ['ack', 'hook-delivery-1', 'plain'],
  ]);
});

test('drainPending rejects workspace-only drains (host and session are mandatory)', async () => {
  const store = { claimPendingHook() { return []; }, ackDelivery() { return { acknowledged: true }; } };
  await assert.rejects(
    drainPending({ workspace: '/workspace', store }),
    /requires a host/,
  );
  await assert.rejects(
    drainPending({ workspace: '/workspace', host: 'zcode', store }),
    /requires a sessionId/,
  );
  await assert.rejects(
    drainPending({ host: 'zcode', sessionId: 's1', store }),
    /canonical workspace/,
  );
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
    drainPending({ workspace: '/workspace', host: 'plain', sessionId: 's1', store, renderer() { throw new Error('render crashed'); } }),
    /render crashed/,
  );
  assert.equal(state, 'claimed_hook');
  store.requeueExpiredLeases();
  assert.equal(state, 'pending');
});

test('renderer truncates UUID completion ids to the first segment but keeps custom ids', () => {
  const uuid = '6bbf0b7e-baf1-449c-8205-d9a79ff5175b';
  const truncated = renderCompletions([row(uuid)]);
  assert.match(truncated, /\(6bbf0b7e\)/);
  assert.doesNotMatch(truncated, /6bbf0b7e-baf1/);
  const custom = renderCompletions([row('completion-1')]);
  assert.match(truncated, /subagent finished/);
  assert.match(custom, /\(completion-1\)/);
});

test('host wrappers remain isolated and stable completion ids remain visible', () => {
  const completions = [row('duplicate-id'), row('duplicate-id')];
  const outputs = availableHosts().map((host) => renderCompletions(completions, host));
  assert.equal(new Set(outputs).size, availableHosts().length);
  assert.match(outputs[0], /duplicate-id/);
  assert.match(outputs[0], /subagent finished/);
});

test('zcode wrapper emits strict JSON and requests continuation only on Stop', () => {
  const completions = [row('json-completion')];
  const plain = JSON.parse(renderCompletions(completions, 'zcode'));
  assert.match(plain.additionalContext, /json-completion/);
  assert.equal(plain.decision, undefined);
  const stop = JSON.parse(renderCompletions(completions, 'zcode', { event: 'Stop' }));
  assert.equal(stop.decision, 'block');
  assert.match(stop.additionalContext, /json-completion/);
});

test('zcode wrapper never emits decision on tool/lifecycle events other than Stop', () => {
  const completions = [row('tool-completion')];
  // PostToolUse/PostToolUseFailure 的 hookSpecificOutput schema 不接受 decision/continue，
  // 误加会让整条输出作废并被记 hook failed。
  for (const event of ['PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit', 'PreToolUse']) {
    const parsed = JSON.parse(renderCompletions(completions, 'zcode', { event }));
    assert.match(parsed.additionalContext, /tool-completion/);
    assert.equal(parsed.decision, undefined, `${event} 不得输出 decision`);
    assert.equal(parsed.reason, undefined, `${event} 不得输出 reason`);
  }
});

test('drainPending can write through a backpressure-aware stream', async () => {
  const output = new PassThrough();
  const chunks = [];
  output.on('data', (chunk) => chunks.push(chunk.toString()));
  const store = {
    claimPendingHook() { return [row('stream-completion')]; },
    ackDelivery() { return { acknowledged: true }; },
  };
  const result = await drainPending({ workspace: '/workspace', host: 'plain', sessionId: 's1', store, output });
  assert.equal(result.acknowledged, true);
  assert.match(chunks.join(''), /stream-completion/);
});

test('Kimi blockable hooks explain that the original tool was not executed', () => {
  const completion = row('kimi-completion');
  const preTool = renderCompletions([completion], 'kimi-code', { event: 'PreToolUse' });
  assert.match(preTool, /original tool call has NOT been executed/i);
  assert.match(preTool, /<codex-completion>/);
  const stop = renderCompletions([completion], 'kimi-code', { event: 'Stop' });
  assert.match(stop, /before ending this turn/i);
  const userPrompt = renderCompletions([completion], 'kimi-code', { event: 'UserPromptSubmit' });
  assert.doesNotMatch(userPrompt, /NOT been executed/i);
  assert.match(userPrompt, /<codex-completion>/);
});

test('drainPending falls back to plain rendering for hosts without an envelope', async () => {
  const store = {
    claimPendingHook() { return [row('unknown-envelope')]; },
    ackDelivery() { return { acknowledged: true }; },
  };
  let written = '';
  await drainPending({
    workspace: '/workspace',
    host: 'unknown-host-example', // 无 envelope 的假想 host：原文输出而非崩溃
    sessionId: 's1',
    store,
    output: { write: (text) => { written += text; return true; } },
  });
  assert.match(written, /unknown-envelope/);
});
