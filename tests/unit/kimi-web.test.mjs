import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import {
  KIMI_WEB_MODEL,
  KimiWebClient,
  discoverKimiServer,
  promptIdForCompletion,
  runKimiWebWorker,
} from '../../src/hook/kimi-web.mjs';

function response(body, status = 200) {
  return { status, ok: status >= 200 && status < 300, async json() { return body; } };
}

async function kimiHome(t, instance, token = 'secret-token') {
  const home = await mkdtemp(join(tmpdir(), 'cas-kimi-home-'));
  await mkdir(join(home, 'server', 'instances'), { recursive: true });
  await writeFile(join(home, 'server', 'instances', 'server-a.json'), JSON.stringify(instance));
  await writeFile(join(home, 'server.token'), `${token}\n`);
  t.after(async () => { await rm(home, { recursive: true, force: true }); });
  return home;
}

test('discoverKimiServer validates session ownership and canonical workspace', async (t) => {
  const home = await kimiHome(t, { server_id: 'server-a', base_url: 'http://127.0.0.1:58627' });
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
  const home = await kimiHome(t, { server_id: 'server-a', url: 'http://127.0.0.1:58627' });
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
      if (url.endsWith('/prompts')) return response({ code: 0, data: { prompt_id: 'cas-c1' } });
      if (url.includes(':steer')) return response({ code: 0, data: { steered: true } });
      if (url.endsWith('/prompts')) return response({ code: 0, data: { active: { prompt_id: 'user-1' }, queued: [] } });
      return response({ code: 0, data: {} });
    },
  });
  // Explicitly inject the active queue snapshot; the client must not steer a user prompt.
  client.readPromptQueue = async () => ({ active: { prompt_id: 'user-1' }, queued: [] });
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

test('runKimiWebWorker ACKs only after accepted delivery', async () => {
  const events = [];
  const store = {
    requeueExpiredLeases() { events.push('requeue'); },
    claimPendingHook(input) {
      events.push(['claim', input.deliveryId]);
      return events.some((event) => Array.isArray(event) && event[0] === 'claim') && !events.some((event) => event === 'claimed')
        ? [{ completionId: 'c1', payload: { threadId: 'thread-1', status: 'completed', finalAssistantMessage: 'done', changes: { files: [] } } }]
        : [];
    },
    ackDelivery(input) { events.push(['ack', input.deliveryId]); events.push('claimed'); return { acknowledged: true }; },
  };
  const result = await runKimiWebWorker({
    server: { baseUrl: 'http://127.0.0.1:58627', token: 'token', sessionId: 'session-1', workspace: '/project' },
    sessionId: 'session-1',
    workspace: '/project',
    store,
    client: { async submitCompletion(input) { events.push(['submit', input.model, input.text]); return { accepted: true }; } },
    resolveWorkspace: async () => '/project',
  });
  assert.equal(result.delivered, 1);
  assert.ok(events.some((event) => Array.isArray(event) && event[0] === 'ack'));
  assert.equal(result.model, KIMI_WEB_MODEL);
});

test('runKimiWebWorker leaves a lease unacked on network failure', async () => {
  let acked = false;
  const result = await runKimiWebWorker({
    server: { baseUrl: 'http://127.0.0.1:58627', token: 'token', sessionId: 'session-1', workspace: '/project' },
    sessionId: 'session-1',
    workspace: '/project',
    store: {
      requeueExpiredLeases() {},
      claimPendingHook() { return [{ completionId: 'c1', payload: { threadId: 'thread-1', status: 'completed', finalAssistantMessage: 'done', changes: { files: [] } } }]; },
      ackDelivery() { acked = true; return { acknowledged: true }; },
    },
    client: { async submitCompletion() { throw new Error('network down'); } },
    resolveWorkspace: async () => '/project',
  });
  assert.equal(result.delivered, 0);
  assert.equal(acked, false);
  assert.match(result.error.message, /network down/);
});
