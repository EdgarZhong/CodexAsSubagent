import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { StdioBootstrap } from '../../src/mcp/stdio-bootstrap.mjs';

function parseOutput(output) {
  return JSON.parse(output.trim().split('\n')[0]);
}

function createBootstrap(forward) {
  const stdout = new PassThrough();
  let output = '';
  stdout.on('data', (chunk) => { output += chunk.toString(); });
  const bootstrap = new StdioBootstrap({
    socketPath: '/tmp/codex-as-subagent-test.sock',
    stdout,
    ensure: async () => {},
  });
  bootstrap.forward = forward;
  return { bootstrap, get output() { return output; } };
}

test('MCP initialize and tools/list expose a protocol-compatible ten-tool façade', async () => {
  const { bootstrap } = createBootstrap(async () => {
    throw new Error('tools/list must not reach Runtime Server');
  });
  const initialized = await bootstrap.handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'initialize' }, { host: 'zcode', workspace: '/workspace' });
  assert.equal(initialized.jsonrpc, '2.0');
  assert.equal(initialized.result.capabilities.tools !== undefined, true);
  assert.equal(initialized.result.serverInfo.name, 'codex-as-subagent');

  const listed = await bootstrap.handleMcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { host: 'zcode', workspace: '/workspace' });
  assert.equal(listed.result.tools.length, 10);
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), [
    'codex_spawn', 'codex_send', 'codex_steer', 'codex_status', 'codex_wait',
    'codex_wait_many', 'codex_interrupt', 'codex_list_threads', 'codex_read_thread', 'codex_models',
  ]);
  const unknown = await bootstrap.handleMcpRequest({ jsonrpc: '2.0', id: 3, method: 'unknown/method' }, { host: 'zcode', workspace: '/workspace' });
  assert.deepEqual(unknown.error, { code: -32601, message: 'Method not found: unknown/method' });
});

test('MCP tools/call maps all ten tools, validates arguments, projects responses, and ACKs delivery', async () => {
  const calls = [];
  const harness = createBootstrap(async (request, context) => {
    calls.push({ request, context });
    if (request.method === 'delivery.ack') return { id: request.id, result: { acknowledged: true } };
    const result = {
      threadId: 'thread-1',
      status: request.method === 'runtime.wait' ? 'completed' : 'running',
      turnId: 'turn-hidden',
      claimId: 'delivery-hidden',
      workspace: '/private/workspace',
    };
    return {
      id: request.id,
      result: request.method === 'runtime.models'
        ? { default: { id: 'gpt-5.6-luna', effort: 'xhigh' }, models: [{ id: 'gpt-5.6-luna' }] }
        : result,
      ...(request.method === 'runtime.wait' || request.method === 'runtime.wait_many'
        ? { claimId: 'delivery-1' }
        : {}),
    };
  });
  const { bootstrap } = harness;
  const context = { host: 'zcode', workspace: '/workspace/current' };
  const requests = [
    ['codex_spawn', { prompt: 'start' }, 'runtime.spawn'],
    ['codex_send', { threadId: 'thread-1', prompt: 'continue' }, 'runtime.send'],
    ['codex_steer', { threadId: 'thread-1', prompt: 'focus' }, 'runtime.steer'],
    ['codex_status', { threadId: 'thread-1' }, 'runtime.status'],
    ['codex_wait', { threadId: 'thread-1' }, 'runtime.wait'],
    ['codex_wait_many', { threads: ['thread-1'] }, 'runtime.wait_many'],
    ['codex_interrupt', { threadId: 'thread-1' }, 'runtime.interrupt'],
    ['codex_list_threads', {}, 'runtime.list_threads'],
    ['codex_read_thread', { threadId: 'thread-1' }, 'runtime.read_thread'],
    ['codex_models', {}, 'runtime.models'],
  ];

  for (let index = 0; index < requests.length; index += 1) {
    const [name, args, method] = requests[index];
    const response = await bootstrap.handleMcpRequest({ jsonrpc: '2.0', id: index + 10, method: 'tools/call', params: { name, arguments: args } }, context);
    assert.equal(response.result.isError, false, name);
    const body = JSON.parse(response.result.content[0].text);
    assert.equal(body.threadId ?? body.default?.id ?? body.models?.[0]?.id, body.threadId ? 'thread-1' : body.default?.id ?? 'gpt-5.6-luna');
    assert.equal(Object.hasOwn(body, 'turnId'), false, name);
    assert.equal(Object.hasOwn(body, 'claimId'), false, name);
    assert.equal(Object.hasOwn(body, 'workspace'), false, name);
    const forwarded = calls.find((entry) => entry.request.method === method && entry.request.id === index + 10);
    assert.deepEqual(forwarded?.context, context);
  }

  const ackCalls = calls.filter((entry) => entry.request.method === 'delivery.ack');
  assert.equal(ackCalls.length, 2);
  for (const entry of ackCalls) {
    assert.equal(entry.request.params.host, 'zcode', 'delivery.ack must carry the forwarding host');
  }
  assert.equal(parseOutput(harness.output).jsonrpc, '2.0');

  const beforeInvalid = calls.length;
  const invalid = await bootstrap.handleMcpRequest({
    jsonrpc: '2.0', id: 100, method: 'tools/call', params: { name: 'codex_spawn', arguments: { prompt: 'x', cwd: '/escape' } },
  }, context);
  assert.equal(invalid.result.isError, true);
  assert.equal(JSON.parse(invalid.result.content[0].text).code, 'invalid_arguments');
  assert.equal(calls.length, beforeInvalid);
});

test('MCP tool errors are returned as isError content and not leaked as runtime internals', async () => {
  const { bootstrap } = createBootstrap(async (request) => ({
    id: request.id,
    error: { code: 'thread_workspace_mismatch', message: 'Thread workspace does not match.' },
  }));
  const response = await bootstrap.handleMcpRequest({
    jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'codex_status', arguments: { threadId: 'thread-1' } },
  }, { host: 'zcode', workspace: '/workspace/current' });
  assert.equal(response.result.isError, true);
  assert.deepEqual(JSON.parse(response.result.content[0].text), {
    code: 'thread_workspace_mismatch',
    message: 'Thread workspace does not match.',
  });
});
