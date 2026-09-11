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
  assert.equal(manifest.mcpConfig, '../.mcp.json');
  assert.equal(manifest.hooksConfig, '../hooks/hooks.json');
  assert.equal(mcp.mcpServers['codex-as-subagent'].command, 'codex-as-subagent');
  assert.deepEqual(mcp.mcpServers['codex-as-subagent'].args, ['mcp']);
  assert.equal(hooks.version, 1);
  assert.equal(hooks.hooks.length, 1);
  assert.equal(hooks.hooks[0].command, 'codex-as-subagent hook --host=zcode');
});
