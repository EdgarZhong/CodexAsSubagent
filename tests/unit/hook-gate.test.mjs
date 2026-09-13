import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { hook } from '../../src/cli/hook.mjs';

const COMPLETION = {
  completionId: 'completion-1',
  payload: {
    threadId: 'thread-1',
    status: 'completed',
    finalAssistantMessage: 'subagent finished',
  },
};

function stdinFrom(payload) {
  const stdin = new PassThrough();
  stdin.end(JSON.stringify(payload));
  return stdin;
}

function collect(stream) {
  const chunks = [];
  stream.on('data', (chunk) => chunks.push(chunk.toString()));
  return () => chunks.join('');
}

function fakeStore({
  pending = [],
  gate = { decision: 'allow' },
  gateError = null,
  claimError = null,
  openError = null,
} = {}) {
  const calls = [];
  const store = {
    calls,
    recoverExpiredClaims(options) { calls.push(['requeue', options]); return 0; },
    claimPendingHook(input) {
      calls.push(['claim', input]);
      if (claimError) throw claimError;
      return pending;
    },
    ackDelivery(input) { calls.push(['ack', input]); return { acknowledged: true }; },
    sessionGateTransition(input) {
      calls.push(['gate', input]);
      if (gateError) throw gateError;
      return gate;
    },
    close() { calls.push(['close']); },
  };
  return { store, openStore(dataDir) { calls.push(['open', dataDir]); if (openError) throw openError; return store; } };
}

const GUARD = { resolve: async (value) => `/canonical${value === process.cwd() ? '/fallback-cwd' : value}` };

function basePayload(overrides = {}) {
  return {
    hook_event_name: 'PreToolUse',
    session_id: 'session-A',
    cwd: '/repo/a',
    tool_name: 'codex_spawn',
    tool_input: { prompt: 'hi' },
    tool_call_id: 'call-1',
    ...overrides,
  };
}

async function runHook(argv, { payload = basePayload(), env = {}, stdin = stdinFrom(payload), workspaceGuard = GUARD, ...deps } = {}) {
  const stderr = new PassThrough();
  const stdout = new PassThrough();
  const readStderr = collect(stderr);
  const readStdout = collect(stdout);
  const code = await hook(argv, { stdin, stdout, stderr, env, workspaceGuard, ...deps });
  return { code, stderr: readStderr(), stdout: readStdout() };
}

test('hook requires --host and fails before opening the store', async () => {
  const { store, openStore } = fakeStore();
  const result = await runHook([], { openStore });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /--host/);
  assert.match(result.stderr, /用法/);
  assert.deepEqual(store.calls, [], 'no CAS state access without --host');
});

test('hook rejects unknown hosts with UnknownHostError before any state access', async () => {
  const { store, openStore } = fakeStore();
  const result = await runHook(['--host=claude-code', '--data-dir=/tmp/hook-x'], { openStore });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Unknown host/i);
  assert.deepEqual(store.calls, [], 'unknown host must fail before opening SQLite');
});

test('pending mailbox delivery wins: injects via block semantics and skips the session gate', async () => {
  const { store, openStore } = fakeStore({ pending: [COMPLETION] });
  const result = await runHook(['--host=kimi-code', '--data-dir=/tmp/hook-x'], { openStore });
  assert.equal(result.code, 2, 'kimi PreToolUse injection uses block semantics (stderr + exit 2)');
  assert.match(result.stderr, /subagent finished/);
  assert.match(result.stderr, /NOT been executed/i);
  assert.equal(result.stdout, '');
  const claim = store.calls.find(([kind]) => kind === 'claim');
  assert.deepEqual(claim[1], {
    host: 'kimi-code',
    workspace: '/canonical/repo/a',
    sessionId: 'session-A',
    limit: 100,
    claimId: claim[1].claimId,
    now: claim[1].now,
  });
  const ack = store.calls.find(([kind]) => kind === 'ack');
  assert.equal(ack[1].host, 'kimi-code');
  assert.ok(ack[1].claimId);
  assert.equal(store.calls.some(([kind]) => kind === 'gate'), false, 'injection must bypass the gate');
});

test('without pending completions a CAS tool on PreToolUse goes through the session gate (allow)', async () => {
  const { store, openStore } = fakeStore({ gate: { decision: 'allow', reason: 'session_authorized' } });
  const result = await runHook(['--host=kimi-code', '--data-dir=/tmp/hook-x'], { openStore });
  assert.equal(result.code, 0);
  const gate = store.calls.find(([kind]) => kind === 'gate');
  assert.deepEqual(gate[1], {
    host: 'kimi-code',
    workspace: '/canonical/repo/a',
    sessionId: 'session-A',
  });
});

test('host-qualified MCP tool names (mcp__<server>__<tool>) are normalized for the gate', async () => {
  const { store, openStore } = fakeStore({ gate: { decision: 'allow' } });
  const result = await runHook(['--host=kimi-code', '--data-dir=/tmp/hook-x'], {
    openStore,
    payload: basePayload({ tool_name: 'mcp__codex-as-subagent__codex_models' }),
  });
  assert.equal(result.code, 0);
  const gate = store.calls.find(([kind]) => kind === 'gate');
  assert.ok(gate, 'qualified MCP tool name must still trigger the session gate');
  assert.equal(gate[1].sessionId, 'session-A');
});

test('a vetoed session gate blocks the CAS tool with the not-executed envelope', async () => {
  const { store, openStore } = fakeStore({ gate: { decision: 'veto', reason: 'other_session_active' } });
  const result = await runHook(['--host=kimi-code', '--data-dir=/tmp/hook-x'], { openStore });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /another Kimi session/i);
  assert.match(result.stderr, /NOT been executed/i);
  assert.equal(result.stdout, '');
});

test('non-CAS host tools pass through without touching the gate', async () => {
  const { store, openStore } = fakeStore();
  const result = await runHook(['--host=kimi-code', '--data-dir=/tmp/hook-x'], {
    payload: basePayload({ tool_name: 'Bash', tool_input: { command: 'ls' } }),
    openStore,
  });
  assert.equal(result.code, 0);
  assert.equal(store.calls.some(([kind]) => kind === 'gate'), false);
});

test('a PreToolUse without session_id is admitted-rejected: veto without claiming the mailbox', async () => {
  const { store, openStore } = fakeStore({ pending: [COMPLETION] });
  const result = await runHook(['--host=kimi-code', '--data-dir=/tmp/hook-x'], {
    payload: basePayload({ session_id: undefined }),
    openStore,
  });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /session identity/i);
  // 缺 sessionId 拒绝 claim，绝不 workspace-only fallback。
  assert.equal(store.calls.some(([kind]) => kind === 'claim'), false);
  assert.equal(store.calls.some(([kind]) => kind === 'gate'), false);
});

test('a gate evaluation error fails closed with the unavailable envelope', async () => {
  const { store, openStore } = fakeStore({ gateError: new Error('db corrupted') });
  const result = await runHook(['--host=kimi-code', '--data-dir=/tmp/hook-x'], { openStore });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /unavailable/i);
  assert.match(result.stderr, /NOT been executed/i);
});

test('an unopenable store vetoes gate-relevant PreToolUse calls but stays fail-open otherwise', async () => {
  const gateBlocked = fakeStore({ openError: new Error('cannot open sqlite') });
  const blocked = await runHook(['--host=kimi-code', '--data-dir=/tmp/hook-x'], { openStore: gateBlocked.openStore });
  assert.equal(blocked.code, 2);
  assert.match(blocked.stderr, /unavailable/i);

  const plainPass = fakeStore({ openError: new Error('cannot open sqlite') });
  const passed = await runHook(['--host=kimi-code', '--data-dir=/tmp/hook-x'], {
    payload: basePayload({ tool_name: 'Bash' }),
    openStore: plainPass.openStore,
  });
  assert.equal(passed.code, 0, 'non-CAS tools must not be broken by storage failures');
});

test('Stop only performs mailbox delivery: injects on block semantics, passes silently when empty', async () => {
  const injected = fakeStore({ pending: [COMPLETION] });
  const stopInject = await runHook(['--host=kimi-code', '--data-dir=/tmp/hook-x'], {
    payload: basePayload({ hook_event_name: 'Stop', tool_name: undefined, tool_input: undefined, tool_call_id: undefined }),
    openStore: injected.openStore,
  });
  assert.equal(stopInject.code, 2);
  assert.match(stopInject.stderr, /before ending this turn/i);
  assert.equal(injected.store.calls.some(([kind]) => kind === 'gate'), false);

  const empty = fakeStore();
  const stopEmpty = await runHook(['--host=kimi-code', '--data-dir=/tmp/hook-x'], {
    payload: basePayload({ hook_event_name: 'Stop', tool_name: undefined, tool_input: undefined, tool_call_id: undefined }),
    openStore: empty.openStore,
  });
  assert.equal(stopEmpty.code, 0);
  assert.equal(stopEmpty.stdout, '');
  assert.equal(empty.store.calls.some(([kind]) => kind === 'gate'), false, 'Stop never runs the session gate');
});

test('zcode PostToolUse delivers through stdout with exit 0 and never runs a session gate', async () => {
  const { store, openStore } = fakeStore({ pending: [COMPLETION] });
  const result = await runHook(['--host=zcode', '--data-dir=/tmp/hook-x'], {
    payload: {
      hook_event_name: 'PostToolUse',
      cwd: '/repo/b',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    },
    env: { ZCODE_SESSION_ID: 'zc-1' },
    openStore,
  });
  assert.equal(result.code, 0, 'zcode has no block-delivery events');
  assert.match(result.stdout, /codex-completion|subagent finished/);
  assert.equal(store.calls.some(([kind]) => kind === 'gate'), false, 'delivery events never run the gate');
  const claim = store.calls.find(([kind]) => kind === 'claim');
  assert.equal(claim[1].sessionId, 'zc-1');
  assert.equal(claim[1].host, 'zcode');
});

test('claim failures do not bypass the gate for CAS tools and stay fail-open for other tools', async () => {
  const gateCase = fakeStore({ claimError: new Error('claim boom'), gate: { decision: 'allow' } });
  const gated = await runHook(['--host=kimi-code', '--data-dir=/tmp/hook-x'], { openStore: gateCase.openStore });
  assert.equal(gated.code, 0, 'gate still evaluated after a claim failure');
  assert.equal(gateCase.store.calls.some(([kind]) => kind === 'gate'), true);

  const plainCase = fakeStore({ claimError: new Error('claim boom') });
  const plain = await runHook(['--host=kimi-code', '--data-dir=/tmp/hook-x'], {
    payload: basePayload({ tool_name: 'Bash' }),
    openStore: plainCase.openStore,
  });
  assert.equal(plain.code, 0);
});

test('hook workspace is canonicalized from the native payload cwd and never from --workspace', async () => {
  const { store, openStore } = fakeStore({ gate: { decision: 'allow' } });
  await runHook(['--host=kimi-code', '--workspace=/evil/override', '--data-dir=/tmp/hook-x'], { openStore });
  const gate = store.calls.find(([kind]) => kind === 'gate');
  assert.equal(gate[1].workspace, '/canonical/repo/a', 'payload cwd wins; --workspace must be ignored');
});

test('a missing payload cwd falls back to process.cwd() for the workspace guard', async () => {
  const { store, openStore } = fakeStore({ gate: { decision: 'allow' } });
  await runHook(['--host=kimi-code', '--data-dir=/tmp/hook-x'], {
    payload: basePayload({ cwd: undefined }),
    openStore,
  });
  const gate = store.calls.find(([kind]) => kind === 'gate');
  assert.equal(gate[1].workspace, '/canonical/fallback-cwd');
});

test('zcode PreToolUse is gate-only: CAS tool goes through the gate without a mailbox claim', async () => {
  const { store, openStore } = fakeStore({ pending: [COMPLETION], gate: { decision: 'allow', reason: 'session_established' } });
  const result = await runHook(['--host=zcode', '--data-dir=/tmp/hook-x'], {
    env: { ZCODE_SESSION_ID: 'zc-1' },
    payload: basePayload({ hook_event_name: 'PreToolUse' }),
    openStore,
  });
  assert.equal(result.code, 0);
  assert.equal(store.calls.some(([kind]) => kind === 'claim'), false, 'zcode PreToolUse must not claim the mailbox');
  const gate = store.calls.find(([kind]) => kind === 'gate');
  assert.deepEqual(gate[1], { host: 'zcode', workspace: '/canonical/repo/a', sessionId: 'zc-1' });
  assert.equal(store.calls.some(([kind]) => kind === 'gate'), true);
});

test('zcode PreToolUse veto blocks the CAS tool with the zcode envelope', async () => {
  const { store, openStore } = fakeStore({ gate: { decision: 'veto', reason: 'other_session_active' } });
  const result = await runHook(['--host=zcode', '--data-dir=/tmp/hook-x'], {
    env: { ZCODE_SESSION_ID: 'zc-1' },
    payload: basePayload({ hook_event_name: 'PreToolUse' }),
    openStore,
  });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /another ZCode session/i);
  assert.match(result.stderr, /NOT been executed/i);
  assert.equal(result.stdout, '');
});

test('zcode Stop delivers pending completions as stdout JSON with decision:block (exit 0)', async () => {
  const { store, openStore } = fakeStore({ pending: [COMPLETION] });
  const result = await runHook(['--host=zcode', '--data-dir=/tmp/hook-x'], {
    env: { ZCODE_SESSION_ID: 'zc-1' },
    payload: basePayload({ hook_event_name: 'Stop' }),
    openStore,
  });
  assert.equal(result.code, 0, 'zcode deliveries always exit 0');
  const output = JSON.parse(result.stdout);
  assert.match(output.additionalContext, /subagent finished/);
  assert.equal(output.decision, 'block');
  assert.equal(result.stderr, '');
  assert.ok(store.calls.some(([kind]) => kind === 'claim'));
  assert.ok(store.calls.some(([kind]) => kind === 'ack'));
  assert.equal(store.calls.some(([kind]) => kind === 'gate'), false, 'delivery events never run the gate');
});
