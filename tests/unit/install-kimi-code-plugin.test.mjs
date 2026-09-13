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
  buildHookWrapper,
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

test('buildUserMcpServerEntry uses absolute Node + CLI with --host and protocol-coverage timeouts', () => {
  const entry = buildUserMcpServerEntry({ cliPath: '/repo/src/cli/main.mjs', execPath: '/node/bin/node' });
  assert.equal(entry.command, '/node/bin/node');
  assert.deepEqual(entry.args, ['/repo/src/cli/main.mjs', 'mcp', '--host=kimi-code']);
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

test('localizeKimiHooks rewrites every hook command to the sh wrapper form', () => {
  const manifest = {
    hooks: [
      { event: 'Stop', command: `${PLUGIN_NAME} hook --host=kimi-code`, timeout: 30 },
      { event: 'PreToolUse', command: 'anything else', timeout: 30 },
    ],
  };
  const localized = localizeKimiHooks(manifest, { installPath: '/home/.kimi-code/plugins/managed/codex-as-subagent' });
  assert.equal(
    localized.hooks[0].command,
    'sh /home/.kimi-code/plugins/managed/codex-as-subagent/hook-wrapper.sh',
  );
  assert.equal(localized.hooks[1].command, localized.hooks[0].command);
});

test('buildHookWrapper embeds absolute Node + CLI and forwards host args', () => {
  const content = buildHookWrapper({ cliPath: '/repo/src/cli/main.mjs', execPath: '/node/bin/node' });
  assert.match(content, /^#!\/bin\/sh/);
  assert.match(content, /hook --host=kimi-code "\$@"/);
  assert.match(content, /\/node\/bin\/node/);
  assert.match(content, /\/repo\/src\/cli\/main\.mjs/);
});

test('installed wrapper is executable through real sh and reaches the hook CLI', async (t) => {
  const { kimiCodeHome, paths } = await setup(t);
  await installKimiCodePlugin({ kimiCodeHome });
  const wrapperPath = join(paths.installPath, 'hook-wrapper.sh');
  assert.ok(existsSync(wrapperPath), 'installer must write hook-wrapper.sh');
  const content = await readFile(wrapperPath, 'utf8');
  assert.match(content, new RegExp(`exec .*${CLI_ENTRY.replaceAll('/', '\\/')}.* hook --host=kimi-code`));

  // 真实 sh 执行 wrapper：UserPromptSubmit + 未知 session → hook fail-open exit 0。
  const dataDir = await mkdtemp(join(tmpdir(), 'cas-hook-wrapper-data-'));
  t.after(async () => { await rm(dataDir, { recursive: true, force: true }); });
  const payload = JSON.stringify({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'wrapper-e2e-session',
    cwd: kimiCodeHome,
  });
  const { execFileSync } = await import('node:child_process');
  const stdout = execFileSync('sh', [wrapperPath, `--data-dir=${dataDir}`], {
    input: payload,
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(stdout, '');
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
  assert.match(manifest.hooks[0].command, /^sh \/.*\/hook-wrapper\.sh$/, 'hook command must use the sh wrapper form');
  // V2：hooks 恰为 3 个回流事件，且无 legacy kimi-web/attach/detach 残留。
  assert.deepEqual(
    manifest.hooks.map((hook) => hook.event).sort(),
    ['PreToolUse', 'Stop', 'UserPromptSubmit'],
  );
  assert.doesNotMatch(JSON.stringify(manifest), /kimi-web|attach|detach/);
  assert.doesNotMatch(JSON.stringify(manifest), /K3/);

  const userMcp = await json(paths.userMcpJson);
  assert.deepEqual(userMcp.mcpServers.playwright, { command: '/bin/pw' });
  assert.equal(userMcp.mcpServers[USER_MCP_SERVER_NAME].command, process.execPath);
  assert.deepEqual(userMcp.mcpServers[USER_MCP_SERVER_NAME].args, [CLI_ENTRY, 'mcp', '--host=kimi-code']);
  assert.equal(userMcp.mcpServers[USER_MCP_SERVER_NAME].toolTimeoutMs, 520000);
  assert.ok(existsSync(`${paths.userMcpJson}.bak-cas`));

  const installed = await json(paths.installedPlugins);
  assert.equal(installed.version, 1);
  assert.equal(installed.plugins[0].id, PLUGIN_NAME);
  assert.equal(installed.plugins[0].enabled, true);
  assert.equal(installed.plugins[0].source, 'local-path', 'source must be a host-accepted enum value');
  assert.equal(installed.plugins[0].originalSource, 'plugins/kimi-code');

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
