import assert from 'node:assert/strict';
import test from 'node:test';

import { hasFlag, option } from '../../src/shared/argv.mjs';

test('option parses both --name=value and --name value forms', () => {
  assert.equal(option(['--host=zcode'], '--host', 'plain'), 'zcode');
  assert.equal(option(['--host', 'zcode'], '--host', 'plain'), 'zcode');
  assert.equal(option(['mcp', '--data-dir=/tmp/x', '--socket', '/tmp/y'], '--data-dir', null), '/tmp/x');
  assert.equal(option(['mcp', '--data-dir=/tmp/x', '--socket', '/tmp/y'], '--socket', null), '/tmp/y');
});

test('option returns the fallback when the flag is absent or valueless', () => {
  assert.equal(option([], '--host', 'plain'), 'plain');
  assert.equal(option(['--host'], '--host', 'plain'), 'plain');
  assert.equal(option(['--host='], '--host', 'plain'), 'plain');
  // 下一个 token 是另一个 flag 时不得被当作 value 吞掉。
  assert.equal(option(['--host', '--socket', '/tmp/y'], '--host', 'plain'), 'plain');
  assert.equal(option(undefined, '--host', 'plain'), 'plain');
});

test('option does not confuse a prefix flag name with a longer one', () => {
  assert.equal(option(['--hostname=evil'], '--host', 'plain'), 'plain');
  assert.equal(option(['--data-dir=/a'], '--data', null), null);
});

test('hasFlag matches only exact flag tokens', () => {
  assert.equal(hasFlag(['--help', 'serve'], '--help'), true);
  assert.equal(hasFlag(['serve'], '--help'), false);
  assert.equal(hasFlag(['--help=1'], '--help'), false);
});
