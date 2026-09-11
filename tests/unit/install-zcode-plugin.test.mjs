import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import {
  CLI_ENTRY,
  MARKETPLACE_NAME,
  PLUGIN_NAME,
  REPO_ROOT,
  pluginId,
  installZcodePlugin,
  localizeHooksConfig,
  localizeMcpConfig,
  pluginPaths,
} from '../../src/install/zcode-plugin.mjs';

async function json(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function setup(t) {
  const zcodeRoot = await mkdtemp(join(tmpdir(), 'cas-zcode-root-'));
  t.after(async () => { await rm(zcodeRoot, { recursive: true, force: true }); });
  return { zcodeRoot, paths: pluginPaths(zcodeRoot) };
}

test('localizeMcpConfig rewrites the bare command into node + absolute CLI path', () => {
  const mcp = { mcpServers: { [PLUGIN_NAME]: { type: 'stdio', command: PLUGIN_NAME, args: ['mcp'] } } };
  const localized = localizeMcpConfig(mcp, { cliPath: '/repo/src/cli/main.mjs', env: { CODEX_BIN: '/x/codex' } });
  const server = localized.mcpServers[PLUGIN_NAME];
  assert.equal(server.type, 'stdio');
  assert.equal(server.command, process.execPath);
  assert.deepEqual(server.args, ['/repo/src/cli/main.mjs', 'mcp']);
  assert.equal(server.env.CODEX_BIN, '/x/codex');
});

test('localizeHooksConfig rewrites every event and preserves hook args and timeouts', () => {
  const hooks = {
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: 'process', command: PLUGIN_NAME, args: ['hook', '--host=zcode'], timeoutMs: 30000 }] }],
      Stop: [{ hooks: [{ type: 'process', command: PLUGIN_NAME, args: ['hook', '--host=zcode'], timeoutMs: 30000 }] }],
    },
  };
  const localized = localizeHooksConfig(hooks, { cliPath: '/repo/src/cli/main.mjs' });
  for (const event of ['UserPromptSubmit', 'Stop']) {
    const entry = localized.hooks[event][0].hooks[0];
    assert.equal(entry.command, process.execPath);
    assert.deepEqual(entry.args, ['/repo/src/cli/main.mjs', 'hook', '--host=zcode']);
    assert.equal(entry.timeoutMs, 30000);
  }
});

test('installZcodePlugin copies, localizes, registers and enables the plugin', async (t) => {
  const { zcodeRoot, paths } = await setup(t);
  const plan = await installZcodePlugin({
    zcodeRoot,
    codexBinary: '/Applications/ChatGPT.app/Contents/Resources/codex',
    now: () => new Date('2026-09-11T00:00:00.000Z'),
  });

  assert.equal(plan.id, pluginId());
  assert.ok(existsSync(plan.installPath), '插件应被拷贝到缓存目录');
  assert.ok(existsSync(join(plan.installPath, '.mcp.json')));
  assert.ok(existsSync(join(plan.installPath, 'hooks', 'hooks.json')));
  assert.ok(existsSync(join(plan.installPath, '.zcode-plugin', 'plugin.json')));

  const mcp = await json(join(plan.installPath, '.mcp.json'));
  const server = mcp.mcpServers[PLUGIN_NAME];
  assert.equal(server.command, process.execPath, '缓存版本应本地化为 node');
  assert.deepEqual(server.args, [CLI_ENTRY, 'mcp']);
  assert.equal(server.env.CODEX_BIN, '/Applications/ChatGPT.app/Contents/Resources/codex');
  assert.equal(server.env.CODEX_APP_SERVER_ARGS, '["app-server"]');

  const hooks = await json(join(plan.installPath, 'hooks', 'hooks.json'));
  assert.deepEqual(Object.keys(hooks.hooks).sort(), ['PostToolUse', 'Stop', 'UserPromptSubmit']);
  for (const event of Object.keys(hooks.hooks)) {
    const entry = hooks.hooks[event][0].hooks[0];
    assert.equal(entry.command, process.execPath);
    assert.deepEqual(entry.args, [CLI_ENTRY, 'hook', '--host=zcode']);
  }

  const known = await json(paths.knownMarketplaces);
  const marketplace = known.marketplaces.find((entry) => entry.id === MARKETPLACE_NAME);
  assert.equal(marketplace.source.source, 'directory');
  assert.equal(marketplace.source.path, REPO_ROOT);
  assert.equal(marketplace.pluginCount, 1);

  const installed = await json(paths.installedPlugins);
  const record = installed.plugins.find((entry) => entry.id === pluginId());
  assert.equal(record.installPath, plan.installPath);
  assert.equal(record.scope, 'user');

  const config = await json(paths.config);
  assert.equal(config.plugins.enabledPlugins[pluginId()], true);
});

test('installZcodePlugin is idempotent and preserves unrelated plugin state', async (t) => {
  const { zcodeRoot, paths } = await setup(t);
  const first = await installZcodePlugin({ zcodeRoot, codexBinary: null, now: () => new Date('2026-09-11T00:00:00.000Z') });
  // 模拟已存在其它插件与配置，安装不得破坏它们。
  const config = await json(paths.config);
  config.plugins.enabledPlugins['other-plugin@some-marketplace'] = false;
  await writeFile(paths.config, JSON.stringify(config, null, 2));

  const second = await installZcodePlugin({ zcodeRoot, codexBinary: null, now: () => new Date('2026-09-11T01:00:00.000Z') });
  assert.equal(second.installPath, first.installPath);

  const installed = await json(paths.installedPlugins);
  assert.equal(installed.plugins.filter((entry) => entry.id === pluginId()).length, 1, '重复安装不应产生重复记录');

  const after = await json(paths.config);
  assert.equal(after.plugins.enabledPlugins['other-plugin@some-marketplace'], false, '不得破坏其它插件状态');
  assert.equal(after.plugins.enabledPlugins[pluginId()], true);

  const known = await json(paths.knownMarketplaces);
  assert.equal(known.marketplaces.filter((entry) => entry.id === MARKETPLACE_NAME).length, 1);
});

test('dry run reports the plan without writing anything', async (t) => {
  const { zcodeRoot, paths } = await setup(t);
  const plan = await installZcodePlugin({ zcodeRoot, dryRun: true, codexBinary: null });
  assert.equal(plan.dryRun, true);
  assert.ok(plan.actions.length > 0);
  assert.equal(existsSync(plan.installPath), false, '预演不得拷贝插件');
  assert.equal(existsSync(paths.installedPlugins), false, '预演不得写安装记录');
  assert.equal(existsSync(paths.config), false, '预演不得写配置');
});

test('portable install keeps the bare command for PATH-resolved binaries', async (t) => {
  const { zcodeRoot } = await setup(t);
  const plan = await installZcodePlugin({ zcodeRoot, portable: true, codexBinary: null });
  const mcp = await json(join(plan.installPath, '.mcp.json'));
  const server = mcp.mcpServers[PLUGIN_NAME];
  assert.equal(server.command, PLUGIN_NAME);
  assert.deepEqual(server.args, ['mcp']);
});
