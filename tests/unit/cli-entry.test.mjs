import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { isDirectInvocation } from '../../src/cli/main.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const CLI = join(ROOT, 'src', 'cli', 'main.mjs');
const CLI_URL = pathToFileURL(CLI).href;

test('isDirectInvocation accepts the real script path', () => {
  assert.equal(isDirectInvocation(CLI, CLI_URL), true);
});

test('isDirectInvocation accepts a symlink that resolves to the module', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cas-invoke-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const link = join(dir, 'codex-as-subagent');
  await symlink(CLI, link);
  // 软链调用是方式 A（GUI 安装的裸命令）的核心路径，必须成立。
  assert.equal(isDirectInvocation(link, CLI_URL), true);
});

test('isDirectInvocation rejects an unrelated or missing entry', () => {
  assert.equal(isDirectInvocation('/tmp/other-script.mjs', CLI_URL), false);
  assert.equal(isDirectInvocation(undefined, CLI_URL), false);
});

test('the CLI runs when invoked through a symlink on PATH', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cas-invoke-e2e-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const link = join(dir, 'codex-as-subagent');
  await symlink(CLI, link);
  const output = execFileSync(process.execPath, [link, '--help'], { encoding: 'utf8' });
  assert.match(output, /Codex As Subagent/);
  assert.match(output, /install/);
});
