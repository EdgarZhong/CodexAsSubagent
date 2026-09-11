import { WorkspaceGuard } from '../core/workspace-guard.mjs';

export async function resolveWorkspaceContext({ cwd = process.cwd(), workspaceGuard = new WorkspaceGuard() } = {}) {
  const workspace = await workspaceGuard.resolve(cwd);
  return Object.freeze({ workspace });
}

export async function contextFromCanonicalCwd(options = {}) {
  return await resolveWorkspaceContext(options);
}
