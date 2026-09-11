import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import {
  CLI_ENTRY,
  PLUGIN_NAME,
  USER_MCP_SERVER_NAME,
  buildUserMcpServerEntry,
  installKimiCodePlugin,
  localizeKimiHooks,
  localizeKimiManifest,
  mergeUserMcpConfig,
  pluginPaths,
} from '../../src/install/kimi-code-plugin.mjs';

async function json(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function setup(t) {
  const kimiCodeHome = await mkdtemp(join(tmpdir(), 'cas-kimi-install-'));
  t.after(async () => { await rm(kimiCodeHome, { recursive: true, force: true }); });
  return { kimiCodeHome, paths: pluginPaths(kimiCodeHome) };
}

test('localizeKimiManifest strips mcpServers so the host never spawns plugin-cwd MCP', () => {
  const manifest = {
    mcpServers: { [PLUGIN_NAME]: { command: PLUGIN_NAME, args: ['mcp'], toolTimeoutMs: 520000 } },
    hooks: [{ event: 'Stop', command: 'x' }],
  };
  const localized = localizeKimiManifest(manifest);
  assert.equal(localized.mcpServers, undefined);
  assert.deepEqual(localized.hooks, manifest.hooks);
});

test('buildUserMcpServerEntry uses absolute Node + CLI with protocol-coverage timeouts', () => {
  const entry = buildUserMcpServerEntry({ cliPath: '/repo/src/cli/main.mjs', execPath: '/node/bin/node' });
  assert.equal(entry.command, '/node/bin/node');
  assert.deepEqual(entry.args, ['/repo/src/cli/main.mjs', 'mcp']);
  assert.equal(entry.startupTimeoutMs, 60000);
  // CAS codex_wait 上限 500s，toolTimeoutMs 必须覆盖协议上限。
  assert.equal(entry.toolTimeoutMs, 520000);
});

test('mergeUserMcpConfig preserves unrelated servers and overwrites only the CAS entry', () => {
  const existing = {
    mcpServers: {
      playwright: { command: '/bin/playwright-mcp' },
      [USER_MCP_SERVER_NAME]: { command: '/stale/path', args: ['mcp'] },
    },
  };
  const merged = mergeUserMcpConfig(existing, { command: '/node', args: ['cli', 'mcp'] });
  assert.deepEqual(merged.mcpServers.playwright, { command: '/bin/playwright-mcp' });
  assert.deepEqual(merged.mcpServers[USER_MCP_SERVER_NAME], { command: '/node', args: ['cli', 'mcp'] });
  assert.equal(mergeUserMcpConfig(null, { command: '/node' }).mcpServers[USER_MCP_SERVER_NAME].command, '/node');
});

test('localizeKimiHooks localizes hook commands with absolute Node and CLI paths', () => {
  const manifest = {
    hooks: [{ event: 'Stop', command: `${PLUGIN_NAME} hook --host=kimi-code`, timeout: 30 }],
  };
  const localized = localizeKimiHooks(manifest, { cliPath: '/repo/src/cli/main.mjs', execPath: '/node/bin/node' });
  assert.match(localized.hooks[0].command, /\/node\/bin\/node/);
  assert.match(localized.hooks[0].command, /\/repo\/src\/cli\/main\.mjs/);
  assert.match(localized.hooks[0].command, /hook --host=kimi-code/);
});

test('installKimiCodePlugin copies, registers user-level MCP, localizes, enables and preserves unrelated records', async (t) => {
  const { kimiCodeHome, paths } = await setup(t);
  await writeFile(paths.userMcpJson, `${JSON.stringify({ mcpServers: { playwright: { command: '/bin/pw' } } }, null, 2)}\n`, 'utf8');
  const first = await installKimiCodePlugin({ kimiCodeHome, now: () => new Date('2026-09-11T00:00:00.000Z') });
  assert.equal(first.id, PLUGIN_NAME);
  assert.ok(existsSync(first.installPath));
  assert.ok(existsSync(join(first.installPath, 'SYSTEM.md')));
  const manifest = await json(join(first.installPath, 'kimi.plugin.json'));
  assert.equal(manifest.mcpServers, undefined, 'managed manifest must not carry mcpServers');
  assert.match(manifest.hooks[0].command, /src\/cli\/main\.mjs/);
  assert.match(manifest.hooks.find((hook) => hook.event === 'SessionStart').command, /kimi-web --attach/);
  assert.doesNotMatch(JSON.stringify(manifest), /K3/);

  const userMcp = await json(paths.userMcpJson);
  assert.deepEqual(userMcp.mcpServers.playwright, { command: '/bin/pw' });
  assert.equal(userMcp.mcpServers[USER_MCP_SERVER_NAME].command, process.execPath);
  assert.deepEqual(userMcp.mcpServers[USER_MCP_SERVER_NAME].args, [CLI_ENTRY, 'mcp']);
  assert.equal(userMcp.mcpServers[USER_MCP_SERVER_NAME].toolTimeoutMs, 520000);
  assert.ok(existsSync(`${paths.userMcpJson}.bak-cas`));

  const installed = await json(paths.installedPlugins);
  assert.equal(installed.version, 1);
  assert.equal(installed.plugins[0].id, PLUGIN_NAME);
  assert.equal(installed.plugins[0].enabled, true);
  assert.equal(installed.plugins[0].source, 'plugins/kimi-code');

  installed.plugins.push({ id: 'other-plugin', enabled: false });
  await writeFile(paths.installedPlugins, `${JSON.stringify(installed, null, 2)}\n`);
  const second = await installKimiCodePlugin({ kimiCodeHome, now: () => new Date('2026-09-11T01:00:00.000Z') });
  assert.equal(second.installPath, first.installPath);
  const after = await json(paths.installedPlugins);
  assert.equal(after.plugins.filter((entry) => entry.id === PLUGIN_NAME).length, 1);
  assert.equal(after.plugins.find((entry) => entry.id === 'other-plugin').enabled, false);
  assert.ok(existsSync(`${paths.installedPlugins}.bak-cas`));
  // 幂等：重装后用户级 mcp.json 仍保留外部 server，CAS entry 以最新路径覆盖。
  const userMcpAfter = await json(paths.userMcpJson);
  assert.deepEqual(userMcpAfter.mcpServers.playwright, { command: '/bin/pw' });
  assert.equal(userMcpAfter.mcpServers[USER_MCP_SERVER_NAME].command, process.execPath);
});

test('Kimi installer creates user-level mcp.json when absent', async (t) => {
  const { kimiCodeHome, paths } = await setup(t);
  await installKimiCodePlugin({ kimiCodeHome });
  const userMcp = await json(paths.userMcpJson);
  assert.deepEqual(Object.keys(userMcp.mcpServers), [USER_MCP_SERVER_NAME]);
  assert.equal(existsSync(`${paths.userMcpJson}.bak-cas`), false, 'no backup for a file that did not exist');
});

test('Kimi installer dry-run computes actions without writing', async (t) => {
  const { kimiCodeHome, paths } = await setup(t);
  const plan = await installKimiCodePlugin({ kimiCodeHome, dryRun: true });
  assert.equal(plan.dryRun, true);
  assert.ok(plan.actions.some((action) => action.includes('mcp.json')));
  assert.equal(existsSync(plan.installPath), false);
  assert.equal(existsSync(paths.installedPlugins), false);
  assert.equal(existsSync(paths.userMcpJson), false);
});
