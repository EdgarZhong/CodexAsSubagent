import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { WorkspaceGuard } from "../../src/core/workspace-guard.mjs";

async function temporaryWorkspace(name) {
  return await mkdtemp(join(tmpdir(), `codex-as-subagent-${name}-`));
}

test("WorkspaceGuard.resolve returns the canonical realpath", async () => {
  const workspace = await temporaryWorkspace("realpath");
  const nested = join(workspace, "nested");
  await mkdir(nested);
  const link = `${workspace}-link`;
  await symlink(workspace, link, "dir");

  const guard = new WorkspaceGuard();
  assert.equal(await guard.resolve(link), await guard.resolve(workspace));
});

test("WorkspaceGuard.resolve rejects a missing workspace", async () => {
  const missing = join(await temporaryWorkspace("missing"), "does-not-exist");
  await assert.rejects(
    () => WorkspaceGuard.resolve(missing),
    (error) => error.code === "workspace_unavailable",
  );
});

test("WorkspaceGuard.assertThreadWorkspace fails closed for missing metadata and cross-workspace threads", async () => {
  const first = await temporaryWorkspace("first");
  const second = await temporaryWorkspace("second");
  const guard = new WorkspaceGuard();
  const canonicalFirst = await guard.resolve(first);

  await assert.rejects(
    () => guard.assertThreadWorkspace({ id: "thread-no-cwd" }, canonicalFirst),
    (error) => error.code === "thread_workspace_mismatch",
  );
  await assert.rejects(
    () => guard.assertThreadWorkspace({ id: "thread-cross", cwd: second }, canonicalFirst),
    (error) => error.code === "thread_workspace_mismatch",
  );
  assert.equal(
    await guard.assertThreadWorkspace({ id: "thread-ok", workingDirectory: first }, canonicalFirst),
    canonicalFirst,
  );
});
