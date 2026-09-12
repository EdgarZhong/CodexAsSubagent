import assert from 'node:assert/strict';
import test from 'node:test';

import { projectPublic } from '../../src/mcp/response-projector.mjs';
import { validateArguments } from '../../src/mcp/tool-handlers.mjs';
import { getToolCallDefinition, getToolDefinition, TOOL_DEFINITIONS } from '../../src/mcp/tool-registry.mjs';

const EXPECTED_TOOLS = [
  'codex_spawn',
  'codex_send',
  'codex_steer',
  'codex_status',
  'codex_wait',
  'codex_wait_many',
  'codex_interrupt',
  'codex_list_threads',
  'codex_read_thread',
  'codex_models',
];

test('MCP registry exposes exactly the ten stable tools with closed object schemas', () => {
  assert.deepEqual(TOOL_DEFINITIONS.map((tool) => tool.name), EXPECTED_TOOLS);
  assert.equal(new Set(TOOL_DEFINITIONS.map((tool) => tool.name)).size, 10);
  for (const tool of TOOL_DEFINITIONS) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.ok(getToolCallDefinition(tool.name)?.method.startsWith('runtime.'));
    assert.equal(getToolDefinition(tool.name), tool);
  }
});

test('tool schemas reject internal control arguments and malformed values', () => {
  for (const forbidden of ['cwd', 'workspace', 'sandbox', 'approval', 'cursor', 'eventCursor', 'turnId']) {
    assert.throws(
      () => validateArguments('codex_spawn', { prompt: 'work', [forbidden]: '/private' }),
      (error) => error.code === 'invalid_arguments',
    );
  }
  assert.throws(() => validateArguments('codex_spawn', {}), (error) => error.code === 'invalid_arguments');
  assert.throws(() => validateArguments('codex_spawn', { prompt: 42 }), (error) => error.code === 'invalid_arguments');
  assert.throws(() => validateArguments('codex_status', { threadId: '' }), (error) => error.code === 'invalid_arguments');
  assert.throws(() => validateArguments('codex_wait_many', { threads: [] }), (error) => error.code === 'invalid_arguments');
  assert.throws(() => validateArguments('codex_wait_many', { threads: [''] }), (error) => error.code === 'invalid_arguments');
  assert.deepEqual(validateArguments('codex_wait_many', { threads: 'all' }), { threads: 'all' });
  assert.deepEqual(validateArguments('codex_wait_many', { threads: ['thread-1'] }), { threads: ['thread-1'] });
});

test('public projection recursively removes runtime-only fields while preserving public data', () => {
  const projected = projectPublic({
    threadId: 'thread-1',
    status: 'completed',
    turnId: 'turn-hidden',
    claimId: 'delivery-hidden',
    workspace: '/private/workspace',
    changes: { files: ['src/app.mjs'], raw: { secret: true } },
    nested: { cursor: 'cursor-hidden', value: 'visible' },
    config: { model: 'private-config' },
    receivedAt: 'private-timestamp',
  });
  assert.deepEqual(projected, {
    threadId: 'thread-1',
    status: 'completed',
    changes: { files: ['src/app.mjs'] },
    nested: { value: 'visible' },
  });
});
