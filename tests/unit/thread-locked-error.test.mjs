import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  DomainError,
  ERROR_CODES,
  errorCode,
  normalizeSupervisorError,
} from '../../src/shared/errors.mjs';
import { StdioBootstrap } from '../../src/mcp/stdio-bootstrap.mjs';

// 上游真实形状（实测 0.153.4）：JSON-RPC code -32600（通用 Invalid Request），
// 没有专用错误码，只能靠 message 识别。此处用与实测一致的原文。
function upstreamLockError(threadId) {
  const error = new Error(`thread ${threadId} already has an active writer`);
  error.name = 'AppServerError';
  error.code = -32600;
  error.method = 'thread/resume';
  return error;
}

// 服务端序列化后的形态：errorCode(数字 code) 落为 internal_error，message 保留原文。
// 这正是模型实际收到的那一跳。
function serializedResponseError(raw, id = 2) {
  return { id, error: { code: errorCode(raw), message: raw.message } };
}

function bootstrapWith(forward) {
  const bootstrap = new StdioBootstrap({
    socketPath: '/tmp/cas-test.sock',
    lockPath: '/tmp/cas-test.lock',
    stdout: new PassThrough(),
    ensure: async () => {},
  });
  bootstrap.forward = forward;
  return bootstrap;
}

function toolCall(name, args) {
  return { id: 1, method: 'tools/call', params: { name, arguments: args } };
}

function toolError(response) {
  return JSON.parse(response.result.content[0].text);
}

test('normalizeSupervisorError maps the known writer-lock error to thread_locked', () => {
  const normalized = normalizeSupervisorError(upstreamLockError('t-1'));
  assert.equal(normalized.code, ERROR_CODES.THREAD_LOCKED);
  assert.equal(errorCode(normalized), 'thread_locked');
  assert.equal(normalized.message, 'Thread is locked by another Codex client. Close that client or use a new thread.');
  assert.doesNotMatch(normalized.message, /already has an active writer|t-1/);
  // 幂等：已是 thread_locked 不再包一层。
  assert.equal(normalizeSupervisorError(normalized), normalized);
});

test('normalizeSupervisorError passes every other error through unchanged', () => {
  const cases = [
    { name: 'supervisor_unavailable', error: new DomainError(ERROR_CODES.SUPERVISOR_UNAVAILABLE, 'Supervisor adapter is unavailable.') },
    { name: 'thread_not_found', error: new DomainError(ERROR_CODES.THREAD_NOT_FOUND, 'Thread t-1 was not found.') },
    { name: 'thread_busy', error: new DomainError(ERROR_CODES.THREAD_BUSY, 'Thread already has an active turn.') },
    { name: 'upstream thread not found', error: Object.assign(new Error('thread not found: t-1'), { name: 'AppServerError', code: -32600 }) },
    { name: 'upstream auth error', error: Object.assign(new Error('unauthorized: token expired'), { name: 'AppServerError', code: -32001 }) },
    { name: 'plain error', error: new Error('boom') },
  ];
  for (const { name, error } of cases) {
    const normalized = normalizeSupervisorError(error);
    assert.equal(normalized, error, name);
    assert.equal(normalized.message, error.message, name);
  }
  assert.equal(normalizeSupervisorError(null), null);
  assert.equal(normalizeSupervisorError(undefined), undefined);
});

test('model-facing tool error is thread_locked when the server returns the writer-lock error', async () => {
  const bootstrap = bootstrapWith(async () => serializedResponseError(upstreamLockError('t-1')));
  const response = await bootstrap.handleMcpRequest(toolCall('codex_send', { threadId: 't-1', prompt: 'hi' }), { workspace: process.cwd() });
  const error = toolError(response);
  assert.equal(response.result.isError, true);
  assert.equal(error.code, 'thread_locked');
  assert.doesNotMatch(error.message, /already has an active writer/);
  assert.equal(error.message, 'Thread is locked by another Codex client. Close that client or use a new thread.');
});

test('model-facing tool error stays untouched for other upstream failures', async () => {
  const raw = Object.assign(new Error('thread not found: t-2'), { name: 'AppServerError', code: -32600 });
  const bootstrap = bootstrapWith(async () => serializedResponseError(raw));
  const response = await bootstrap.handleMcpRequest(toolCall('codex_send', { threadId: 't-2', prompt: 'hi' }), { workspace: process.cwd() });
  const error = toolError(response);
  assert.equal(error.code, 'internal_error');
  assert.equal(error.message, 'thread not found: t-2');
});

test('thrown lock error is normalized at the tool exit too', async () => {
  const bootstrap = bootstrapWith(async () => { throw upstreamLockError('t-3'); });
  const response = await bootstrap.handleMcpRequest(toolCall('codex_send', { threadId: 't-3', prompt: 'hi' }), { workspace: process.cwd() });
  const error = toolError(response);
  assert.equal(error.code, 'thread_locked');
  assert.doesNotMatch(error.message, /already has an active writer/);
});
