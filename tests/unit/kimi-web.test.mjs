import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import {
  DEFAULT_KIMI_CODE_HOME,
  KIMI_WEB_MODEL,
  KimiWebClient,
  discoverKimiServer,
  promptIdForCompletion,
  resolveKimiCodeHome,
} from '../../src/core/kimi-web-client.mjs';
import { createWebDelivery } from '../../src/core/web-delivery.mjs';
import { ERROR_CODES } from '../../src/shared/errors.mjs';

const WORKSPACE = '/project';
const SESSION = 'session-1';

function response(body, status = 200) {
  return { status, ok: status >= 200 && status < 300, async json() { return body; } };
}

// 建一个带 instance registry 与统一 token 的 KIMI_CODE_HOME fixture。
async function kimiHome(t, instances = [], token = 'secret-token') {
  const home = await mkdtemp(join(tmpdir(), 'cas-kimi-home-'));
  await mkdir(join(home, 'server', 'instances'), { recursive: true });
  for (const [index, instance] of instances.entries()) {
    await writeFile(join(home, 'server', 'instances', `server-${index}.json`), JSON.stringify(instance));
  }
  if (token !== null) await writeFile(join(home, 'server.token'), `${token}\n`);
  t.after(async () => { await rm(home, { recursive: true, force: true }); });
  return home;
}

const IDENTITY_RESOLVER = async (value) => value;

function fakeLogger() {
  const entries = [];
  const record = (level) => (message, details) => entries.push({ level, message, details });
  return { entries, error: record('error'), warn: record('warn'), info: record('info'), debug: record('debug') };
}

function fakeStore({ claimResult, claimError } = {}) {
  const calls = [];
  return {
    calls,
    claimPendingHook(input) {
      calls.push(['claim', input]);
      if (claimError) throw claimError;
      if (claimResult) return claimResult;
      return [{
        completionId: 'completion-1',
        threadId: 'thread-1',
        host: 'kimi-code',
        workspace: WORKSPACE,
        sessionId: SESSION,
        deliveryState: 'claimed_hook',
      }];
    },
    ackDelivery(input) {
      calls.push(['ack', input]);
      return { acknowledged: true };
    },
    nackDelivery(input) {
      calls.push(['nack', input]);
      return { nacked: true };
    },
  };
}

function completionSnapshot(overrides = {}) {
  return {
    completionId: 'completion-1',
    threadId: 'thread-1',
    host: 'kimi-code',
    workspace: WORKSPACE,
    sessionId: SESSION,
    deliveryState: 'pending',
    ...overrides,
  };
}

// 构造 web-delivery + fake client factory；返回 calls 记录 client 收到的每次调用。
function fakeClientFactory({ session, sessionError, submitError } = {}) {
  const calls = [];
  return {
    calls,
    factory: ({ baseUrl, token, sessionId }) => {
      calls.push(['client', { baseUrl, token, sessionId }]);
      return {
        async readSession({ sessionId: id } = {}) {
          calls.push(['readSession', id]);
          if (sessionError) throw sessionError;
          return { accepted: true, data: session ?? { id: SESSION, metadata: { cwd: WORKSPACE } } };
        },
        async submitCompletion(input) {
          calls.push(['submit', input]);
          if (submitError) throw submitError;
          return { accepted: true, promptId: promptIdForCompletion(input.completionId), steered: false };
        },
      };
    },
  };
}

// --- KimiWebClient / discovery ---

test('discoverKimiServer validates session ownership and canonical workspace', async (t) => {
  const home = await kimiHome(t, [{ server_id: 'server-a', base_url: 'http://127.0.0.1:58627' }]);
  const requests = [];
  const server = await discoverKimiServer({
    home,
    sessionId: 'session-1',
    workspace: '/alias/project',
    resolveWorkspace: async (value) => value === '/alias/project' ? '/project' : value,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return response({ code: 0, msg: 'success', data: { id: 'session-1', metadata: { cwd: '/project' } } });
    },
  });
  assert.equal(server.serverId, 'server-a');
  assert.equal(server.baseUrl, 'http://127.0.0.1:58627');
  assert.equal(server.token, 'secret-token');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer secret-token');
});

test('discoverKimiServer fails closed on a session workspace mismatch', async (t) => {
  const home = await kimiHome(t, [{ server_id: 'server-a', url: 'http://127.0.0.1:58627' }]);
  const result = await discoverKimiServer({
    home,
    sessionId: 'session-1',
    workspace: '/project',
    resolveWorkspace: async (value) => value,
    fetchImpl: async () => response({ code: 0, data: { id: 'session-1', metadata: { cwd: '/other' } } }),
  });
  assert.equal(result, null);
});

test('KimiWebClient submits official content blocks and steers only its own prompt', async () => {
  const calls = [];
  const client = new KimiWebClient({
    baseUrl: 'http://127.0.0.1:58627',
    token: 'secret-token',
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (url.endsWith('/prompts') && options.method === 'POST') return response({ code: 0, data: { prompt_id: 'cas-c1' } });
      if (url.includes(':steer')) return response({ code: 0, data: { steered: true } });
      return response({ code: 0, data: { active: { prompt_id: 'user-1' }, queued: [] } });
    },
  });
  const result = await client.submitCompletion({ sessionId: 'session-1', completionId: 'c1', text: 'done' });
  assert.equal(result.accepted, true);
  assert.equal(result.steered, true);
  assert.equal(result.model, KIMI_WEB_MODEL);
  assert.equal(result.promptId, promptIdForCompletion('c1'));
  const submit = calls.find((call) => call.url.endsWith('/prompts') && call.options.method === 'POST');
  const body = JSON.parse(submit.options.body);
  assert.deepEqual(body.content, [{ type: 'text', text: 'done' }]);
  assert.equal(body.prompt_id, promptIdForCompletion('c1'));
  assert.equal(body.model, KIMI_WEB_MODEL);
  assert.ok(calls.some((call) => call.url.endsWith(`/${body.prompt_id}:steer`)));
  assert.ok(calls.every((call) => call.options.headers.Authorization === 'Bearer secret-token'));
});

test('KimiWebClient treats accepted prompt replay conflicts as idempotent', async () => {
  const client = new KimiWebClient({
    baseUrl: 'http://127.0.0.1:58627',
    token: 'secret-token',
    fetchImpl: async (url) => url.endsWith('/prompts')
      ? response({ code: 40903, msg: 'prompt already completed' }, 409)
      : response({ code: 0, data: {} }),
  });
  client.readPromptQueue = async () => ({ active: null, queued: [] });
  const result = await client.submitCompletion({ sessionId: 'session-1', completionId: 'c1', text: 'done' });
  assert.equal(result.accepted, true);
  assert.equal(result.idempotent, true);
});

test('KimiWebClient treats idempotent steer conflicts as an accepted steer', async () => {
  const client = new KimiWebClient({
    baseUrl: 'http://127.0.0.1:58627',
    token: 'secret-token',
    fetchImpl: async (url, options = {}) => {
      if (url.includes(':steer')) return response({ code: 40402, msg: 'prompt no longer pending' }, 409);
      if (url.endsWith('/prompts') && options.method === 'POST') return response({ code: 0, data: { prompt_id: 'cas-c1' } });
      return response({ code: 0, data: { active: { prompt_id: 'user-1' }, queued: [] } });
    },
  });
  const result = await client.submitCompletion({ sessionId: 'session-1', completionId: 'c1', text: 'done' });
  assert.equal(result.accepted, true);
  assert.equal(result.steered, true);
  assert.equal(result.idempotent, false);
});

test('KimiWebClient surfaces non-idempotent steer failures to the caller', async () => {
  const client = new KimiWebClient({
    baseUrl: 'http://127.0.0.1:58627',
    token: 'secret-token',
    fetchImpl: async (url, options = {}) => {
      if (url.includes(':steer')) return response({ code: 500, msg: 'network glitch' }, 500);
      if (url.endsWith('/prompts') && options.method === 'POST') return response({ code: 0, data: { prompt_id: 'cas-c1' } });
      return response({ code: 0, data: { active: { prompt_id: 'user-1' }, queued: [] } });
    },
  });
  await assert.rejects(
    () => client.submitCompletion({ sessionId: 'session-1', completionId: 'c1', text: 'done' }),
    /network glitch/,
  );
});

test('KimiWebClient readSession returns the envelope data for ownership checks', async () => {
  const requests = [];
  const client = new KimiWebClient({
    baseUrl: 'http://127.0.0.1:58627',
    token: 'secret-token',
    sessionId: 'session-1',
    fetchImpl: async (url, options = {}) => {
      requests.push({ url, options });
      return response({ code: 0, data: { id: 'session-1', metadata: { cwd: '/project' } } });
    },
  });
  const result = await client.readSession();
  assert.equal(result.data.id, 'session-1');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'http://127.0.0.1:58627/api/v1/sessions/session-1');
  assert.equal(requests[0].options.method, 'GET');
});

test('resolveKimiCodeHome honors explicit, env and default resolution', async () => {
  const previous = process.env.KIMI_CODE_HOME;
  delete process.env.KIMI_CODE_HOME;
  try {
    assert.equal(resolveKimiCodeHome({ kimiCodeHome: '/custom/home' }), '/custom/home');
    process.env.KIMI_CODE_HOME = '/env/home';
    assert.equal(resolveKimiCodeHome({}), '/env/home');
    delete process.env.KIMI_CODE_HOME;
    assert.equal(resolveKimiCodeHome({}), DEFAULT_KIMI_CODE_HOME);
  } finally {
    if (previous === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = previous;
  }
});

// --- createWebDelivery：Server 计数三分支 ---

test('web delivery skips without claiming when no server instance exists', async (t) => {
  const home = await kimiHome(t, []);
  const store = fakeStore();
  const logger = fakeLogger();
  const delivery = createWebDelivery({
    store, kimiCodeHome: home, logger, resolveWorkspace: IDENTITY_RESOLVER,
  });
  const result = await delivery.attemptWebDelivery({ completion: completionSnapshot() });
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'server_unavailable');
  assert.equal(store.calls.length, 0);
  assert.ok(logger.entries.some((entry) => entry.level === 'debug' && entry.message === 'web_delivery.server_unavailable'));
});

test('web delivery skips without claiming when the server token is missing', async (t) => {
  const home = await kimiHome(t, [{ base_url: 'http://127.0.0.1:58627' }], null);
  const store = fakeStore();
  const delivery = createWebDelivery({ store, kimiCodeHome: home, resolveWorkspace: IDENTITY_RESOLVER });
  const result = await delivery.attemptWebDelivery({ completion: completionSnapshot() });
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'server_unavailable');
  assert.equal(store.calls.length, 0);
});

test('web delivery fails closed with multiple_active_host_servers and never sends', async (t) => {
  const home = await kimiHome(t, [
    { server_id: 'server-a', base_url: 'http://127.0.0.1:58627' },
    { server_id: 'server-b', base_url: 'http://127.0.0.1:58628' },
  ]);
  const store = fakeStore();
  const logger = fakeLogger();
  const delivery = createWebDelivery({ store, kimiCodeHome: home, logger, resolveWorkspace: IDENTITY_RESOLVER });
  const result = await delivery.attemptWebDelivery({ completion: completionSnapshot() });
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, ERROR_CODES.MULTIPLE_ACTIVE_HOST_SERVERS);
  assert.equal(store.calls.length, 0);
  assert.ok(logger.entries.some((entry) => entry.level === 'warn'
    && entry.message === 'web_delivery.multiple_active_host_servers'
    && entry.details.code === ERROR_CODES.MULTIPLE_ACTIVE_HOST_SERVERS));
});

// --- createWebDelivery：claim → push → ACK / NACK ---

test('web delivery claims with the full predicate then ACKs after acceptance', async (t) => {
  const home = await kimiHome(t, [{ server_id: 'server-a', base_url: 'http://127.0.0.1:58627' }]);
  const store = fakeStore();
  const { factory, calls } = fakeClientFactory();
  const delivery = createWebDelivery({
    store, clientFactory: factory, kimiCodeHome: home, resolveWorkspace: IDENTITY_RESOLVER,
  });
  const result = await delivery.attemptWebDelivery({ completion: completionSnapshot() });

  assert.equal(result.status, 'delivered');
  assert.equal(result.delivered, true);
  assert.ok(result.deliveryId.startsWith('web-'));
  const claim = store.calls.find(([name]) => name === 'claim')?.[1];
  assert.equal(claim.host, 'kimi-code');
  assert.equal(claim.workspace, WORKSPACE);
  assert.equal(claim.sessionId, SESSION);
  assert.equal(claim.limit, 1);
  assert.ok(claim.deliveryId.startsWith('web-'));
  const ack = store.calls.find(([name]) => name === 'ack')?.[1];
  assert.equal(ack.host, 'kimi-code');
  assert.equal(ack.deliveryId, result.deliveryId);
  assert.deepEqual(store.calls.filter(([name]) => name === 'nack'), []);
  assert.equal(calls.find(([name]) => name === 'client')?.[1].baseUrl, 'http://127.0.0.1:58627');
  assert.equal(calls.find(([name]) => name === 'client')?.[1].token, 'secret-token');
  assert.equal(calls.find(([name]) => name === 'readSession')?.[1], SESSION);
  const submit = calls.find(([name]) => name === 'submit')?.[1];
  assert.equal(submit.sessionId, SESSION);
  assert.equal(submit.completionId, 'completion-1');
  assert.equal(submit.model, KIMI_WEB_MODEL);
});

test('web delivery returns silently when the claim does not match any pending completion', async (t) => {
  const home = await kimiHome(t, [{ base_url: 'http://127.0.0.1:58627' }]);
  const store = fakeStore({ claimResult: [] });
  const delivery = createWebDelivery({ store, kimiCodeHome: home, resolveWorkspace: IDENTITY_RESOLVER });
  const result = await delivery.attemptWebDelivery({ completion: completionSnapshot() });
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'no_pending_completion');
  assert.deepEqual(store.calls.filter(([name]) => name !== 'claim'), []);
});

test('web delivery NACKs back to pending when the session workspace does not match', async (t) => {
  const home = await kimiHome(t, [{ base_url: 'http://127.0.0.1:58627' }]);
  const store = fakeStore();
  const { factory } = fakeClientFactory({ session: { id: SESSION, metadata: { cwd: '/other' } } });
  const delivery = createWebDelivery({
    store, clientFactory: factory, kimiCodeHome: home, resolveWorkspace: IDENTITY_RESOLVER,
  });
  const result = await delivery.attemptWebDelivery({ completion: completionSnapshot() });
  assert.equal(result.status, 'nacked');
  assert.equal(result.reason, 'session_workspace_mismatch');
  const nack = store.calls.find(([name]) => name === 'nack')?.[1];
  assert.equal(nack.host, 'kimi-code');
  assert.equal(nack.deliveryId, result.deliveryId);
  assert.deepEqual(store.calls.filter(([name]) => name === 'ack'), []);
});

test('web delivery NACKs when the API rejects the submit', async (t) => {
  const home = await kimiHome(t, [{ base_url: 'http://127.0.0.1:58627' }]);
  const store = fakeStore();
  const { factory } = fakeClientFactory({ submitError: new Error('prompt rejected') });
  const delivery = createWebDelivery({
    store, clientFactory: factory, kimiCodeHome: home, resolveWorkspace: IDENTITY_RESOLVER,
  });
  const result = await delivery.attemptWebDelivery({ completion: completionSnapshot() });
  assert.equal(result.status, 'nacked');
  assert.equal(result.reason, 'submit_rejected');
  assert.match(result.error, /prompt rejected/);
  assert.notEqual(store.calls.find(([name]) => name === 'nack'), undefined);
  assert.equal(store.calls.find(([name]) => name === 'ack'), undefined);
});

test('web delivery never throws when the store fails and logs the failure', async (t) => {
  const home = await kimiHome(t, [{ base_url: 'http://127.0.0.1:58627' }]);
  const store = fakeStore({ claimError: new Error('database is locked') });
  const logger = fakeLogger();
  const delivery = createWebDelivery({
    store, kimiCodeHome: home, logger, resolveWorkspace: IDENTITY_RESOLVER,
  });
  const result = await delivery.attemptWebDelivery({ completion: completionSnapshot() });
  assert.equal(result.status, 'error');
  assert.equal(result.reason, 'unexpected_failure');
  assert.match(result.message, /database is locked/);
  assert.ok(logger.entries.some((entry) => entry.level === 'error' && entry.message === 'web_delivery.unexpected_failure'));
});

test('web delivery skips non-pending or non-kimi-code completions defensively', async (t) => {
  const home = await kimiHome(t, [{ base_url: 'http://127.0.0.1:58627' }]);
  const store = fakeStore();
  const delivery = createWebDelivery({ store, kimiCodeHome: home, resolveWorkspace: IDENTITY_RESOLVER });
  for (const completion of [
    completionSnapshot({ host: 'zcode' }),
    completionSnapshot({ deliveryState: 'claimed_direct' }),
    completionSnapshot({ deliveryState: 'delivered' }),
  ]) {
    const result = await delivery.attemptWebDelivery({ completion });
    assert.equal(result.status, 'skipped');
  }
  assert.equal(store.calls.length, 0);
});

// --- legacy kimi-web CLI 移除 ---

test('legacy kimi-web command is removed from the CLI dispatch and help', async () => {
  const { main } = await import('../../src/cli/main.mjs');
  const logs = [];
  const errors = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => errors.push(args.join(' '));
  try {
    assert.equal(await main([]), 0);
    assert.equal(await main(['kimi-web', '--help']), 1);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  assert.ok(!logs.join('\n').includes('kimi-web'));
  assert.ok(errors.some((line) => line.includes('未知命令: kimi-web')));
});
