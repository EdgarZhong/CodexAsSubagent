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
  for (const event of ['UserPromptSubmit', 'Stop']) {
    const entries = hooks.hooks[event];
    assert.ok(Array.isArray(entries) && entries.length === 1, `hooks.hooks.${event} must exist`);
    const entry = entries[0].hooks[0];
    assert.equal(entry.type, 'process');
    assert.equal(entry.command, 'codex-as-subagent');
    assert.deepEqual(entry.args, ['hook', '--host=zcode']);
    assert.equal(typeof entry.timeoutMs, 'number');
  }
});
