import assert from 'node:assert/strict';
import test from 'node:test';

import { getHostAdapter, KNOWN_HOST_IDS } from '../../src/hosts/registry.mjs';
import kimiCode from '../../src/hosts/kimi-code.mjs';
import zcode from '../../src/hosts/zcode.mjs';
import { UnknownHostError, ERROR_CODES } from '../../src/shared/errors.mjs';

test('registry exposes exactly kimi-code and zcode', () => {
  assert.deepEqual([...KNOWN_HOST_IDS], ['kimi-code', 'zcode']);
  assert.equal(getHostAdapter('kimi-code'), kimiCode);
  assert.equal(getHostAdapter('zcode'), zcode);
});

test('unknown host fails with UnknownHostError before any state access', () => {
  for (const bad of ['plain', 'kimi-code-web', 'kimi-code-tui', '', 'KIMI-CODE', null, undefined]) {
    assert.throws(() => getHostAdapter(bad), (error) => {
      assert.ok(error instanceof UnknownHostError, `expected UnknownHostError for ${JSON.stringify(bad)}`);
      assert.equal(error.code, ERROR_CODES.UNKNOWN_HOST);
      assert.match(error.message, /Unknown host/i);
      return true;
    });
  }
});

test('kimi-code adapter parses session/cwd/event from stdin payload fields only', () => {
  const parsed = kimiCode.parseHookInvocation({
    payload: {
      hook_event_name: 'PreToolUse',
      session_id: 'session_abc',
      cwd: '/repo/a',
      tool_name: 'codex_spawn',
      tool_input: { prompt: 'hi' },
      tool_call_id: 'call-1',
    },
    env: { ZCODE_SESSION_ID: 'must-not-be-used' },
  });
  assert.deepEqual(parsed, {
    sessionId: 'session_abc',
    cwd: '/repo/a',
    event: 'PreToolUse',
    toolName: 'codex_spawn',
    toolInput: { prompt: 'hi' },
    toolCallId: 'call-1',
  });
});

test('kimi-code adapter leaves missing optional fields undefined and never guesses', () => {
  // Stop/UserPromptSubmit payload 没有 tool 字段。
  const stop = kimiCode.parseHookInvocation({
    payload: { hook_event_name: 'Stop', session_id: 's1', cwd: '/repo/a' },
    env: {},
  });
  assert.deepEqual(stop, {
    sessionId: 's1',
    cwd: '/repo/a',
    event: 'Stop',
    toolName: undefined,
    toolInput: undefined,
    toolCallId: undefined,
  });
  // 空对象/坏类型一律 undefined，不做 fallback，不读 env。
  const empty = kimiCode.parseHookInvocation({
    payload: {},
    env: { KIMI_SESSION_ID: 'guess-attempt', ZCODE_SESSION_ID: 'guess-attempt' },
  });
  assert.deepEqual(empty, {
    sessionId: undefined,
    cwd: undefined,
    event: undefined,
    toolName: undefined,
    toolInput: undefined,
    toolCallId: undefined,
  });
  assert.deepEqual(kimiCode.parseHookInvocation({ payload: { session_id: 42 }, env: {} }).sessionId, undefined);
  assert.deepEqual(kimiCode.parseHookInvocation({ payload: null, env: undefined }).event, undefined);
});

test('zcode adapter takes sessionId from ZCODE_SESSION_ID env and the rest from payload', () => {
  const parsed = zcode.parseHookInvocation({
    payload: {
      hook_event_name: 'PostToolUse',
      cwd: '/repo/b',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_call_id: 'call-9',
    },
    env: { ZCODE_SESSION_ID: 'zc-session-1' },
  });
  assert.deepEqual(parsed, {
    sessionId: 'zc-session-1',
    cwd: '/repo/b',
    event: 'PostToolUse',
    toolName: 'Bash',
    toolInput: { command: 'ls' },
    toolCallId: 'call-9',
  });
});

test('zcode adapter treats a missing session env as undefined (Hook channel only)', () => {
  const parsed = zcode.parseHookInvocation({
    payload: { hook_event_name: 'UserPromptSubmit', cwd: '/repo/b' },
    env: {},
  });
  assert.equal(parsed.sessionId, undefined);
  assert.equal(parsed.event, 'UserPromptSubmit');
  // 完全没有 env 时同样 undefined，不猜测。
  assert.equal(zcode.parseHookInvocation({ payload: { cwd: '/r' } }).sessionId, undefined);
});

test('kimi-code adapter declares PreToolUse/Stop block delivery, the PreToolUse session gate, and full delivery coverage', () => {
  assert.deepEqual([...kimiCode.blockDeliveryEvents].sort(), ['PreToolUse', 'Stop']);
  assert.equal(kimiCode.sessionGateEvent, 'PreToolUse');
  // kimi 注册的三个事件全部承担回流。
  assert.deepEqual([...kimiCode.deliveryEvents].sort(), ['PreToolUse', 'Stop', 'UserPromptSubmit']);
  // zcode 无 block 语义（stdout 严格 JSON + decision 字段），
  // Session Gate 挂 PreToolUse；回流窗口不含 PreToolUse（门禁专用）。
  assert.equal(zcode.blockDeliveryEvents.size, 0);
  assert.equal(zcode.sessionGateEvent, 'PreToolUse');
  assert.deepEqual([...zcode.deliveryEvents].sort(), ['PostToolUse', 'Stop', 'UserPromptSubmit']);
});

test('kimi-code gate veto copy keeps the not-executed-then-retry semantics', () => {
  for (const kind of ['occupied', 'missing_session', 'unavailable', undefined]) {
    const text = kimiCode.gateVetoText(kind);
    assert.match(text, /NOT been executed/i, kind);
    assert.match(text, /retry/i, kind);
  }
  assert.match(kimiCode.gateVetoText('occupied'), /another Kimi session/i);
  assert.match(kimiCode.gateVetoText('missing_session'), /session identity/i);
  assert.match(kimiCode.gateVetoText('unavailable'), /unavailable/i);
});

test('adapter contracts declare gate/delivery events per host protocol', () => {
  assert.equal(kimiCode.sessionGateEvent, 'PreToolUse');
  assert.deepEqual([...kimiCode.deliveryEvents].sort(), ['PreToolUse', 'Stop', 'UserPromptSubmit']);
  assert.deepEqual([...kimiCode.blockDeliveryEvents].sort(), ['PreToolUse', 'Stop']);

  assert.equal(zcode.sessionGateEvent, 'PreToolUse');
  assert.deepEqual([...zcode.deliveryEvents].sort(), ['PostToolUse', 'Stop', 'UserPromptSubmit']);
  assert.equal(zcode.blockDeliveryEvents.size, 0, 'zcode deliveries are stdout JSON + exit 0, never exit-2 block');
  assert.match(zcode.gateVetoText('occupied'), /another ZCode session/i);
  assert.match(zcode.gateVetoText('missing_session'), /session identity/i);
  assert.match(zcode.gateVetoText('unavailable'), /unavailable/i);
});
