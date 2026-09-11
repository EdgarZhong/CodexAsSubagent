import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import {
  CLI_ENTRY,
  MCP_LAUNCHER_COMMAND,
  MCP_LAUNCHER_REL,
  PLUGIN_NAME,
  installKimiCodePlugin,
  localizeKimiHooks,
  localizeKimiManifest,
  pluginPaths,
  renderMcpLauncher,
} from '../../src/install/kimi-code-plugin.mjs';

async function json(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function setup(t) {
  const kimiCodeHome = await mkdtemp(join(tmpdir(), 'cas-kimi-install-'));
  t.after(async () => { await rm(kimiCodeHome, { recursive: true, force: true }); });
  return { kimiCodeHome, paths: pluginPaths(kimiCodeHome) };
}

test('localizeKimiManifest rewrites MCP command to an in-plugin launcher', () => {
  const manifest = {
    mcpServers: { [PLUGIN_NAME]: { command: PLUGIN_NAME, args: ['mcp'], toolTimeoutMs: 520000 } },
  };
  const localized = localizeKimiManifest(manifest);
  // Kimi 只接受裸 PATH 命令或 "./" 相对插件根目录的 command；绝对路径会被静默丢弃。
  assert.equal(localized.mcpServers[PLUGIN_NAME].command, MCP_LAUNCHER_COMMAND);
  assert.ok(MCP_LAUNCHER_COMMAND.startsWith('./'));
  assert.ok(!MCP_LAUNCHER_COMMAND.includes('/Users/'));
  assert.deepEqual(localized.mcpServers[PLUGIN_NAME].args, ['mcp']);
  assert.equal(localized.mcpServers[PLUGIN_NAME].toolTimeoutMs, 520000);
});

test('renderMcpLauncher execs absolute Node and CLI paths with pass-through args', () => {
  const launcher = renderMcpLauncher({ cliPath: '/repo/src/cli/main.mjs', execPath: '/node/bin/node' });
  assert.match(launcher, /^#!\/bin\/sh\n/);
  assert.match(launcher, /exec '\/node\/bin\/node' '\/repo\/src\/cli\/main\.mjs' "\$@"\n$/);
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

test('installKimiCodePlugin copies, writes launcher, localizes, enables and preserves unrelated records', async (t) => {
  const { kimiCodeHome, paths } = await setup(t);
  const first = await installKimiCodePlugin({ kimiCodeHome, codexBinary: '/Applications/Codex.app/codex', now: () => new Date('2026-09-11T00:00:00.000Z') });
  assert.equal(first.id, PLUGIN_NAME);
  assert.ok(existsSync(first.installPath));
  assert.ok(existsSync(join(first.installPath, 'SYSTEM.md')));
  const manifest = await json(join(first.installPath, 'kimi.plugin.json'));
  assert.equal(manifest.mcpServers[PLUGIN_NAME].command, MCP_LAUNCHER_COMMAND);
  assert.deepEqual(manifest.mcpServers[PLUGIN_NAME].args, ['mcp']);
  assert.match(manifest.hooks[0].command, /src\/cli\/main\.mjs/);
  assert.match(manifest.hooks.find((hook) => hook.event === 'SessionStart').command, /kimi-web --attach/);
  assert.doesNotMatch(JSON.stringify(manifest), /K3/);

  const launcherPath = join(first.installPath, MCP_LAUNCHER_REL);
  const launcherStat = await stat(launcherPath);
  assert.ok(launcherStat.mode & 0o111, 'launcher must be executable');
  const launcher = await readFile(launcherPath, 'utf8');
  assert.match(launcher, /^#!\/bin\/sh\n/);
  assert.ok(launcher.includes(process.execPath));
  assert.ok(launcher.includes(CLI_ENTRY));

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
});

test('Kimi installer dry-run computes actions without writing', async (t) => {
  const { kimiCodeHome, paths } = await setup(t);
  const plan = await installKimiCodePlugin({ kimiCodeHome, dryRun: true });
  assert.equal(plan.dryRun, true);
  assert.ok(plan.actions.length > 0);
  assert.equal(existsSync(plan.installPath), false);
  assert.equal(existsSync(paths.installedPlugins), false);
});
