import assert from 'node:assert/strict';
import test from 'node:test';

import { drain } from '../../src/cli/drain.mjs';

function fakeStore({ pending = [] } = {}) {
  const calls = [];
  const store = {
    calls,
    recoverExpiredClaims(options) { calls.push(['requeue', options]); return 0; },
    claimPendingHook(input) { calls.push(['claim', input]); return pending; },
    ackDelivery(input) { calls.push(['ack', input]); return { acknowledged: true }; },
    close() { calls.push(['close']); },
  };
  return { store, openStore(dataDir) { calls.push(['open', dataDir]); return store; } };
}

const GUARD = { resolve: async (value) => `/canonical${value}` };

function createStderrSpy() {
  const state = { text: '' };
  return {
    state,
    stream: { write: (text) => { state.text += text; return true; } },
  };
}

function createStdoutSpy() {
  const state = { text: '' };
  return {
    state,
    stream: { write: (text) => { state.text += text; return true; } },
  };
}

test('drain requires --host, --workspace and --session (usage on stderr, non-zero exit)', async () => {
  const cases = [
    [],
    ['--host=zcode'],
    ['--host=zcode', '--workspace=/repo'],
    ['--workspace=/repo', '--session=s1'],
  ];
  for (const argv of cases) {
    const { store, openStore } = fakeStore();
    const stderr = createStderrSpy();
    const code = await drain(argv, { openStore, stderr: stderr.stream });
    assert.equal(code, 1, `expected failure for argv: ${argv.join(' ')}`);
    assert.match(stderr.state.text, /用法/);
    assert.match(stderr.state.text, /--host.*--workspace.*--session/s);
    assert.deepEqual(store.calls, [], 'no CAS state access when identity is incomplete');
  }
});

test('drain rejects unknown hosts before opening the store', async () => {
  const { store, openStore } = fakeStore();
  const stderr = createStderrSpy();
  const code = await drain(['--host=kimi-code-web', '--workspace=/repo', '--session=s1'], {
    openStore,
    stderr: stderr.stream,
  });
  assert.equal(code, 1);
  assert.deepEqual(store.calls, []);
});

test('drain constructs the full DeliveryContext (host + canonical workspace + session) and ACKs with host', async () => {
  const completion = {
    completionId: 'completion-1',
    payload: { threadId: 'thread-1', status: 'completed', finalAssistantMessage: 'done' },
  };
  const { store, openStore } = fakeStore({ pending: [completion] });
  const code = await drain(
    ['--host=kimi-code', '--workspace=/repo/a', '--session=session-A', '--data-dir=/tmp/drain-x'],
    { openStore, workspaceGuard: GUARD, stdout: createStdoutSpy().stream },
  );
  assert.equal(code, 0);
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
  assert.ok(store.calls.some(([kind]) => kind === 'close'));
});

test('drain renders completions in the registered host envelope form', async () => {
  const completion = {
    completionId: 'completion-2',
    payload: { threadId: 'thread-2', status: 'completed', finalAssistantMessage: 'payload text' },
  };
  const { store, openStore } = fakeStore({ pending: [completion] });
  const stdout = createStdoutSpy();
  const code = await drain(
    ['--host=zcode', '--workspace=/repo/b', '--session=zc-1', '--data-dir=/tmp/drain-x'],
    { openStore, workspaceGuard: GUARD, stdout: stdout.stream },
  );
  assert.equal(code, 0);
  const parsed = JSON.parse(stdout.state.text);
  assert.match(parsed.additionalContext, /payload text/);
});

test('drain does not read stdin at all', async () => {
  const { openStore } = fakeStore();
  const stdinThatMustNotBeRead = {
    isTTY: false,
    setEncoding() { throw new Error('drain must not read stdin'); },
    on() { throw new Error('drain must not read stdin'); },
  };
  const code = await drain(
    ['--host=zcode', '--workspace=/repo', '--session=s1', '--data-dir=/tmp/drain-x'],
    { openStore, workspaceGuard: GUARD, stdin: stdinThatMustNotBeRead, stdout: createStdoutSpy().stream },
  );
  assert.equal(code, 0);
});

test('drain reports store and drain failures with a non-zero exit', async () => {
  const openFailure = createStderrSpy();
  const codeOpen = await drain(['--host=zcode', '--workspace=/repo', '--session=s1'], {
    openStore() { throw new Error('no sqlite'); },
    stderr: openFailure.stream,
  });
  assert.equal(codeOpen, 1);
  assert.match(openFailure.state.text, /no sqlite/);

  const failingClaim = fakeStore();
  failingClaim.store.claimPendingHook = () => { throw new Error('claim boom'); };
  const claimFailure = createStderrSpy();
  const codeClaim = await drain(['--host=zcode', '--workspace=/repo', '--session=s1'], {
    openStore: failingClaim.openStore,
    workspaceGuard: GUARD,
    stderr: claimFailure.stream,
  });
  assert.equal(codeClaim, 1);
  assert.match(claimFailure.state.text, /claim boom/);
});
