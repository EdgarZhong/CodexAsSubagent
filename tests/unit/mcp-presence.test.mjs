import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { StdioBootstrap, createSqlitePresenceHelper } from '../../src/mcp/stdio-bootstrap.mjs';
import { mcp } from '../../src/cli/mcp.mjs';
import { UnknownHostError } from '../../src/shared/errors.mjs';
import { HEARTBEAT_INTERVAL_MS, PRESENCE_LEASE_MS } from '../../src/shared/constants.mjs';

function fakeSocketFactory(respond) {
  return async () => {
    const socket = {
      writable: true,
      readyState: 'open',
      dataHandler: null,
      errorHandler: null,
      setEncoding() {},
      on(event, handler) { if (event === 'data') this.dataHandler = handler; },
      once(event, handler) { if (event === 'error') this.errorHandler = handler; },
      write(text) {
        const request = JSON.parse(text);
        const response = respond(request);
        queueMicrotask(() => this.dataHandler(`${JSON.stringify(response)}\n`));
        return true;
      },
      end() {},
    };
    return socket;
  };
}

function createPresenceSpy({ attachError = null, intervalMs = 3, leaseMs = PRESENCE_LEASE_MS } = {}) {
  const events = [];
  return {
    events,
    helper: {
      host: 'kimi-code',
      intervalMs,
      leaseMs,
      instanceId: 'instance-test',
      attach(workspace) {
        events.push(['attach', workspace]);
        if (attachError) throw attachError;
      },
      heartbeat(workspace) { events.push(['heartbeat', workspace]); },
      detach(workspace) { events.push(['detach', workspace]); },
    },
  };
}

function collect(stream) {
  const chunks = [];
  stream.on('data', (chunk) => chunks.push(chunk.toString()));
  return () => chunks.join('');
}

async function settle(ms = 30) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

test('run registers presence before processing requests, heartbeats, and detaches exactly once', async (t) => {
  const presence = createPresenceSpy();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const readStdout = collect(stdout);
  const unregistered = [];
  const bootstrap = new StdioBootstrap({
    socketPath: '/tmp/cas-presence-test.sock',
    lockPath: '/tmp/cas-presence-test.lock',
    host: 'kimi-code',
    stdin,
    stdout,
    presenceHelper: presence.helper,
    ensure: async () => {},
    connect: fakeSocketFactory((request) => ({ id: request.id, result: {} })),
    exitHooks: (handler) => {
      unregistered.push(handler);
      return () => { unregistered.length = 0; };
    },
  });
  const runPromise = bootstrap.run();
  await settle(5);
  stdin.write(`${JSON.stringify({ id: 1, method: 'initialize', params: {} })}\n`);
  await settle(25);
  stdin.end();
  await runPromise;

  const events = presence.events.map(([kind]) => kind);
  assert.equal(events[0], 'attach', 'presence must be registered before any request processing');
  assert.ok(readStdout().includes('"id":1'), 'request was processed after presence attach');
  const heartbeats = presence.events.filter(([kind]) => kind === 'heartbeat');
  assert.ok(heartbeats.length >= 2, `expected multiple heartbeats, got ${heartbeats.length}`);
  assert.deepEqual(events[events.length - 1], 'detach', 'presence detaches after the loop exits');
  assert.equal(presence.events.filter(([kind]) => kind === 'detach').length, 1, 'detach is idempotent');
  assert.equal(unregistered.length, 0, 'exit hooks are unregistered on normal exit');
  const attachWorkspace = presence.events[0][1];
  for (const [, workspace] of presence.events) assert.equal(workspace, attachWorkspace);
});

test('a failed presence attach prevents the MCP processing loop entirely', async () => {
  const presence = createPresenceSpy({ attachError: new Error('sqlite locked') });
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const readStdout = collect(stdout);
  const bootstrap = new StdioBootstrap({
    socketPath: '/tmp/cas-presence-fail.sock',
    lockPath: '/tmp/cas-presence-fail.lock',
    host: 'kimi-code',
    stdin,
    stdout,
    presenceHelper: presence.helper,
    ensure: async () => {},
    connect: fakeSocketFactory(() => { throw new Error('must not be called'); }),
    exitHooks: () => () => {},
  });
  await assert.rejects(() => bootstrap.run(), /sqlite locked/);
  assert.equal(readStdout(), '');
  assert.equal(presence.events.length, 1, 'no heartbeat/detach after a failed attach');
  assert.equal(presence.events[0][0], 'attach');
  stdin.destroy();
});

test('run fails closed on unknown or missing host before any presence attach', async () => {
  for (const host of ['kimi-code-web', null]) {
    const presence = createPresenceSpy();
    const bootstrap = new StdioBootstrap({
      socketPath: '/tmp/cas-presence-host.sock',
      lockPath: '/tmp/cas-presence-host.lock',
      host,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      presenceHelper: presence.helper,
      ensure: async () => {},
      connect: fakeSocketFactory(() => { throw new Error('must not be called'); }),
    });
    await assert.rejects(() => bootstrap.run(), UnknownHostError);
    assert.deepEqual(presence.events, []);
  }
});

test('createSqlitePresenceHelper heartbeats and detaches through the SQLite store directly', () => {
  const calls = [];
  const fakeStore = {
    attachHostPresence(input) { calls.push(['attach', input]); return {}; },
    heartbeatHostPresence(input) { calls.push(['heartbeat', input]); return { refreshed: true }; },
    detachHostPresence(input) { calls.push(['detach', input]); return { detached: true }; },
    close() { calls.push(['close']); },
  };
  let clock = 1_000;
  const helper = createSqlitePresenceHelper({
    host: 'zcode',
    intervalMs: HEARTBEAT_INTERVAL_MS,
    leaseMs: PRESENCE_LEASE_MS,
    instanceId: 'instance-1',
    openStore: () => fakeStore,
    now: () => {
      clock += 1_000;
      return new Date(clock).toISOString();
    },
  });
  assert.equal(helper.instanceId, 'instance-1');
  assert.equal(helper.intervalMs, HEARTBEAT_INTERVAL_MS);
  assert.equal(helper.leaseMs, PRESENCE_LEASE_MS);
  helper.attach('/repo/a');
  helper.heartbeat('/repo/a');
  helper.heartbeat('/repo/a');
  helper.detach('/repo/a');
  helper.detach('/repo/a');
  assert.deepEqual(calls, [
    ['attach', { host: 'zcode', workspace: '/repo/a', instanceId: 'instance-1', now: '1970-01-01T00:00:02.000Z', leaseMs: PRESENCE_LEASE_MS }],
    ['heartbeat', { host: 'zcode', workspace: '/repo/a', instanceId: 'instance-1', now: '1970-01-01T00:00:03.000Z', leaseMs: PRESENCE_LEASE_MS }],
    ['heartbeat', { host: 'zcode', workspace: '/repo/a', instanceId: 'instance-1', now: '1970-01-01T00:00:04.000Z', leaseMs: PRESENCE_LEASE_MS }],
    ['detach', { host: 'zcode', workspace: '/repo/a', instanceId: 'instance-1' }],
    ['close'],
  ]);
});

test('delivery.ack and stdout-failure delivery.nack carry the host from the forwarding context', async () => {
  const requests = [];
  const stdout = new PassThrough();
  const readStdout = collect(stdout);
  const bootstrap = new StdioBootstrap({
    socketPath: '/tmp/cas-ack-host.sock',
    lockPath: '/tmp/cas-ack-host.lock',
    host: 'kimi-code',
    stdout,
    ensure: async () => {},
    connect: fakeSocketFactory((request) => {
      requests.push(request);
      if (request.method === 'runtime.wait') {
        return { id: request.id, result: { threadId: 't-1', status: 'completed' }, deliveryId: 'delivery-9' };
      }
      return { id: request.id, result: { acknowledged: true } };
    }),
  });
  const response = await bootstrap.handleRequest(
    { id: 1, method: 'runtime.wait', params: { threadId: 't-1' } },
    { host: 'kimi-code', workspace: '/repo/a' },
  );
  assert.equal(response.result.threadId, 't-1');
  const ack = requests.find((request) => request.method === 'delivery.ack');
  assert.equal(ack.params.deliveryId, 'delivery-9');
  assert.equal(ack.params.host, 'kimi-code');
  assert.equal(ack.context.host, 'kimi-code');
  await settle(2);
  assert.equal(readStdout().includes('"threadId":"t-1"'), true);
});

test('a stdout write failure NACKs the claimed delivery instead of letting the lease expire', async () => {
  const requests = [];
  const brokenStdout = {
    write(line, callback) {
      queueMicrotask(() => callback(new Error('EPIPE: stdout closed')));
      return false;
    },
  };
  const bootstrap = new StdioBootstrap({
    socketPath: '/tmp/cas-nack.sock',
    lockPath: '/tmp/cas-nack.lock',
    host: 'kimi-code',
    stdout: brokenStdout,
    ensure: async () => {},
    connect: fakeSocketFactory((request) => {
      requests.push(request);
      if (request.method === 'runtime.wait') {
        return { id: request.id, result: { threadId: 't-1', status: 'completed' }, deliveryId: 'delivery-77' };
      }
      return { id: request.id, result: { acknowledged: true } };
    }),
  });
  await assert.rejects(
    () => bootstrap.handleRequest(
      { id: 1, method: 'runtime.wait', params: { threadId: 't-1' } },
      { host: 'kimi-code', workspace: '/repo/a' },
    ),
    /EPIPE/,
  );
  const nack = requests.find((request) => request.method === 'delivery.nack');
  assert.ok(nack, 'write failure must send delivery.nack');
  assert.equal(nack.params.deliveryId, 'delivery-77');
  assert.equal(nack.params.host, 'kimi-code');
  assert.equal(requests.some((request) => request.method === 'delivery.ack'), false, 'no ACK after a failed write');
});

test('mcp CLI requires --host and validates it against the registry', async (t) => {
  const missing = [];
  const codeMissing = await mcp([], { stderr: { write: (text) => { missing.push(text); return true; } } });
  assert.equal(codeMissing, 1);
  assert.match(missing.join(''), /--host/);

  const unknown = [];
  const codeUnknown = await mcp(['--host=kimi-code-tui'], { stderr: { write: (text) => { unknown.push(text); return true; } } });
  assert.equal(codeUnknown, 1);
  assert.match(unknown.join(''), /Unknown host/i);
});

test('mcp CLI forwards the validated host into the bootstrap', async () => {
  const created = [];
  const code = await mcp(['--host=zcode', '--data-dir=/tmp/mcp-x'], {
    stderr: { write: () => true },
    createBootstrap: (options) => {
      created.push(options);
      return { run: async () => created.push(['run']) };
    },
  });
  assert.equal(code, 0);
  assert.equal(created[0].host, 'zcode');
  assert.equal(created[0].dataDir, '/tmp/mcp-x');
  assert.deepEqual(created[1], ['run']);
});
