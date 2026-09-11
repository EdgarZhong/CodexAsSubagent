import { realpath } from 'node:fs/promises';
import { isAbsolute, join, sep } from 'node:path';

import { WorkspaceGuard } from '../core/workspace-guard.mjs';
import { WorkspaceUnavailableError } from '../shared/errors.mjs';

// 宿主把插件 MCP server 拉起在插件托管目录内时，process.cwd() 不是用户 workspace。
// 已知宿主插件根环境变量；命中即 fail-closed，禁止用错误 workspace 静默启动。
export const PLUGIN_ROOT_ENV_VARS = ['KIMI_PLUGIN_ROOT'];

export async function assertNotInsidePluginRoot(
  cwd,
  { env = process.env, realpathImpl = realpath } = {},
) {
    if (typeof cwd !== 'string' || cwd.trim().length === 0 || !isAbsolute(cwd)) return;
    let canonicalCwd;
    try {
      canonicalCwd = await realpathImpl(cwd);
    } catch {
      canonicalCwd = cwd;
    }
    for (const name of PLUGIN_ROOT_ENV_VARS) {
    const root = env?.[name];
    if (typeof root !== 'string' || root.trim().length === 0 || !isAbsolute(root)) continue;
    let canonicalRoot;
    try {
      canonicalRoot = await realpathImpl(root);
    } catch {
      continue;
    }
    if (canonicalCwd === canonicalRoot || canonicalCwd.startsWith(join(canonicalRoot, sep))) {
      throw new WorkspaceUnavailableError(
        `Workspace is unavailable: ${cwd} lies inside the host plugin root (${name}=${canonicalRoot}); ` +
          'the host spawned this MCP server with the plugin directory as cwd, so the real workspace is unknown. ' +
          'Register the MCP server in user-level MCP config so it starts with the workspace cwd.',
      );
    }
  }
}

export async function resolveWorkspaceContext({ cwd = process.cwd(), workspaceGuard = new WorkspaceGuard(), env, realpathImpl } = {}) {
  await assertNotInsidePluginRoot(cwd, { env, realpathImpl });
  const workspace = await workspaceGuard.resolve(cwd);
  return Object.freeze({ workspace });
}

export async function contextFromCanonicalCwd(options = {}) {
  return await resolveWorkspaceContext(options);
}
