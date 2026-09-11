import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

async function json(relativePath) {
  return JSON.parse(await readFile(join(root, relativePath), 'utf8'));
}

test('ZCode plugin registers MCP and Hook without copying runtime logic', async () => {
  const manifest = await json('plugins/zcode/.zcode-plugin/plugin.json');
  const mcp = await json('plugins/zcode/.mcp.json');
  const hooks = await json('plugins/zcode/hooks/hooks.json');
  await access(join(root, 'plugins/zcode/README.md'));
  assert.equal(manifest.name, 'codex-as-subagent');
  assert.equal('mcpConfig' in manifest, false, 'ZCode 不识别 mcpConfig 字段');
  assert.equal('hooksConfig' in manifest, false, 'ZCode 不识别 hooksConfig 字段');
  const server = mcp.mcpServers['codex-as-subagent'];
  assert.equal(server.type, 'stdio');
  assert.equal(server.command, 'codex-as-subagent');
  assert.deepEqual(server.args, ['mcp']);
  for (const event of ['UserPromptSubmit', 'PostToolUse', 'Stop']) {
    const entries = hooks.hooks[event];
    assert.ok(Array.isArray(entries) && entries.length === 1, `hooks.hooks.${event} must exist`);
    const entry = entries[0].hooks[0];
    assert.equal(entry.type, 'process');
    assert.equal(entry.command, 'codex-as-subagent');
    assert.deepEqual(entry.args, ['hook', '--host=zcode']);
    assert.equal(typeof entry.timeoutMs, 'number');
  }
  // 工具事件必须匹配所有工具：省略 matcher 即全匹配（ZCode 官方语义）。
  assert.equal('matcher' in hooks.hooks.PostToolUse[0], false, 'PostToolUse 应省略 matcher 以匹配所有工具');
});

test('Kimi plugin uses the official manifest shape and Kimi-only hooks', async () => {
  const manifest = await json('plugins/kimi-code/kimi.plugin.json');
  await access(join(root, 'plugins/kimi-code/SYSTEM.md'));
  await access(join(root, 'plugins/kimi-code/README.md'));
  assert.equal(manifest.name, 'codex-as-subagent');
  assert.equal(manifest.systemPromptPath, './SYSTEM.md');
  assert.equal('mcpConfig' in manifest, false);
  assert.equal('hooksConfig' in manifest, false);
  const server = manifest.mcpServers?.['codex-as-subagent'];
  assert.equal(server.command, 'codex-as-subagent');
  assert.deepEqual(server.args, ['mcp']);
  assert.ok(server.startupTimeoutMs >= 60_000);
  assert.ok(server.toolTimeoutMs > 500_000);
  const events = manifest.hooks.map((hook) => hook.event).sort();
  assert.deepEqual(events, ['PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'TurnStarted', 'UserPromptSubmit']);
  for (const hook of manifest.hooks) {
    assert.equal(typeof hook.command, 'string');
    assert.equal(typeof hook.timeout, 'number');
    assert.ok(!hook.command.includes('/Users/'));
    assert.ok(!hook.command.includes('/src/cli/'));
  }
});
