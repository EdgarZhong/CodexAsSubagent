import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { DEFAULT_EFFORT, DEFAULT_MODEL } from '../../src/shared/constants.mjs';

const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

async function exists(relativePath) {
  await access(join(projectRoot, relativePath));
}

test('project layout exposes the V1 foundation', async () => {
  const packageJson = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));
  const gitmodules = await readFile(join(projectRoot, '.gitmodules'), 'utf8');

  assert.equal(packageJson.type, 'module');
  assert.equal(packageJson.scripts.test, "node --test 'tests/**/*.test.mjs'");
  assert.equal(packageJson.scripts.lint, "find src -type f -name '*.mjs' -print0 | xargs -0 -n1 node --check");
  assert.equal(packageJson.scripts.smoke, './src/cli/main.mjs --help');
  assert.equal(packageJson.bin?.['codex-as-subagent'], 'src/cli/main.mjs');
  assert.equal(DEFAULT_MODEL, 'gpt-5.6-luna');
  assert.equal(DEFAULT_EFFORT, 'xhigh');
  assert.match(gitmodules, /path = vendor\/codex-supervisor-mcp/);

  for (const directory of [
    'src/adapters/supervisor',
    'src/adapters/sqlite',
    'src/core',
    'src/server',
    'src/mcp',
    'src/hook',
    'src/cli',
    'src/shared',
    'plugins',
    'vendor',
    'tests/unit',
    'tests/integration',
    'tests/e2e',
    'tests/fixtures'
  ]) {
    await exists(directory);
  }

  await exists('vendor/codex-supervisor-mcp');
  await exists('README.md');
  await exists('AGENTS.md');
  await exists('CLAUDE.md');
  await exists('src/cli/main.mjs');
  await exists('src/shared/constants.mjs');
});
