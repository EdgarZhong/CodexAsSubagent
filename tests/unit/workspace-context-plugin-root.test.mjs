import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { WorkspaceUnavailableError } from '../../src/shared/errors.mjs';
import { assertNotInsidePluginRoot, resolveWorkspaceContext } from '../../src/mcp/workspace-context.mjs';

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'cas-plugin-root-'));
  const pluginRoot = join(root, 'plugins', 'managed', 'codex-as-subagent');
  const workspace = join(root, 'workspace');
  await mkdir(pluginRoot, { recursive: true });
  await mkdir(workspace, { recursive: true });
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  return { root, pluginRoot, workspace };
}

test('assertNotInsidePluginRoot rejects cwd inside KIMI_PLUGIN_ROOT', async (t) => {
  const { pluginRoot } = await setup(t);
  const sub = join(pluginRoot, 'bin');
  await mkdir(sub);
  await assert.rejects(
    () => assertNotInsidePluginRoot(pluginRoot, { env: { KIMI_PLUGIN_ROOT: pluginRoot } }),
    WorkspaceUnavailableError,
  );
  await assert.rejects(
    () => assertNotInsidePluginRoot(sub, { env: { KIMI_PLUGIN_ROOT: pluginRoot } }),
    WorkspaceUnavailableError,
  );
});

test('assertNotInsidePluginRoot compares canonical paths across symlinks', async (t) => {
  const { root, pluginRoot } = await setup(t);
  const link = join(root, 'link-to-plugin-root');
  await symlink(pluginRoot, link);
  // cwd 经符号链接指向插件根时同样必须拒绝。
  await assert.rejects(
    () => assertNotInsidePluginRoot(link, { env: { KIMI_PLUGIN_ROOT: pluginRoot } }),
    WorkspaceUnavailableError,
  );
});

test('assertNotInsidePluginRoot allows cwd outside the plugin root', async (t) => {
  const { pluginRoot, workspace } = await setup(t);
  await assert.doesNotReject(
    () => assertNotInsidePluginRoot(workspace, { env: { KIMI_PLUGIN_ROOT: pluginRoot } }),
  );
});

test('assertNotInsidePluginRoot is a no-op without plugin root env', async (t) => {
  const { workspace } = await setup(t);
  await assert.doesNotReject(() => assertNotInsidePluginRoot(workspace, { env: {} }));
  await assert.doesNotReject(
    () => assertNotInsidePluginRoot(workspace, { env: { KIMI_PLUGIN_ROOT: '   ' } }),
  );
});

test('resolveWorkspaceContext fails closed before workspace resolution', async (t) => {
  const { pluginRoot } = await setup(t);
  await assert.rejects(
    () => resolveWorkspaceContext({ cwd: pluginRoot, env: { KIMI_PLUGIN_ROOT: pluginRoot } }),
    (error) => error instanceof WorkspaceUnavailableError
      && /plugin root/i.test(error.message),
  );
});

test('resolveWorkspaceContext forwards the host into the V2 forwarding context', async (t) => {
  const { workspace } = await setup(t);
  const context = await resolveWorkspaceContext({
    cwd: workspace,
    host: 'kimi-code',
    workspaceGuard: { resolve: async (value) => `/canonical${value}` },
  });
  assert.deepEqual(context, { host: 'kimi-code', workspace: `/canonical${workspace}` });
  // 不传 host 时保持 {workspace} 形态（进程内/测试路径兼容）。
  const legacy = await resolveWorkspaceContext({
    cwd: workspace,
    workspaceGuard: { resolve: async (value) => value },
  });
  assert.deepEqual(legacy, { workspace });
});
