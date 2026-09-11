import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import {
  CLI_ENTRY,
  PLUGIN_NAME,
  installKimiCodePlugin,
  localizeKimiManifest,
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

test('localizeKimiManifest uses absolute Node commands and preserves official hook fields', () => {
  const manifest = {
    mcpServers: { [PLUGIN_NAME]: { command: PLUGIN_NAME, args: ['mcp'] } },
    hooks: [{ event: 'Stop', command: `${PLUGIN_NAME} hook --host=kimi-code`, timeout: 30 }],
  };
  const localized = localizeKimiManifest(manifest, { cliPath: '/repo/src/cli/main.mjs', execPath: '/node/bin/node' });
  assert.equal(localized.mcpServers[PLUGIN_NAME].command, '/node/bin/node');
  assert.deepEqual(localized.mcpServers[PLUGIN_NAME].args, ['/repo/src/cli/main.mjs', 'mcp']);
  assert.match(localized.hooks[0].command, /\/node\/bin\/node/);
  assert.match(localized.hooks[0].command, /\/repo\/src\/cli\/main\.mjs/);
  assert.match(localized.hooks[0].command, /hook --host=kimi-code/);
});

test('installKimiCodePlugin copies, localizes, enables and preserves unrelated records', async (t) => {
  const { kimiCodeHome, paths } = await setup(t);
  const first = await installKimiCodePlugin({ kimiCodeHome, codexBinary: '/Applications/Codex.app/codex', now: () => new Date('2026-09-11T00:00:00.000Z') });
  assert.equal(first.id, PLUGIN_NAME);
  assert.ok(existsSync(first.installPath));
  assert.ok(existsSync(join(first.installPath, 'SYSTEM.md')));
  const manifest = await json(join(first.installPath, 'kimi.plugin.json'));
  assert.equal(manifest.mcpServers[PLUGIN_NAME].command, process.execPath);
  assert.deepEqual(manifest.mcpServers[PLUGIN_NAME].args, [CLI_ENTRY, 'mcp']);
  assert.match(manifest.hooks[0].command, /src\/cli\/main\.mjs/);
  assert.match(manifest.hooks.find((hook) => hook.event === 'SessionStart').command, /kimi-web --attach/);
  assert.doesNotMatch(JSON.stringify(manifest), /K3/);

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
