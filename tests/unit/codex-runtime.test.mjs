import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import {
  REQUIRED_APP_SERVER_METHODS,
  codexBinaryCandidates,
  discoverCodexBinary,
  probeCodexRuntime,
  resolveAppServerArgs,
  parseCodexConfigOverrides,
  resolveAppServerArgsWithConfig,
} from '../../src/shared/codex-runtime.mjs';

const SCHEMA_OK = JSON.stringify({ defs: REQUIRED_APP_SERVER_METHODS });

test('candidate order follows design 6.4: explicit CODEX_BIN, PATH, standalone, homebrew, app bundles', () => {
  const candidates = codexBinaryCandidates({ CODEX_BIN: '/custom/codex', PATH: '/a/bin:/b/bin' });
  assert.equal(candidates[0], '/custom/codex');
  assert.ok(candidates.indexOf('/a/bin/codex') < candidates.indexOf('/b/bin/codex'));
  assert.ok(candidates.indexOf('/b/bin/codex') < candidates.findIndex((c) => c.includes('.codex/packages/standalone')));
  assert.ok(candidates.some((c) => c === '/opt/homebrew/bin/codex'));
  assert.ok(candidates.some((c) => c === '/usr/local/bin/codex'));
  assert.ok(candidates.some((c) => c === '/Applications/ChatGPT.app/Contents/Resources/codex'));
  assert.ok(candidates.some((c) => c === '/Applications/Codex.app/Contents/Resources/codex'));
});

test('candidates are deduplicated and tolerate a missing PATH', () => {
  const candidates = codexBinaryCandidates({ CODEX_BIN: '/a/bin/codex', PATH: '/a/bin' });
  assert.equal(candidates.filter((c) => c === '/a/bin/codex').length, 1);
  assert.ok(codexBinaryCandidates({}).length > 0);
});

test('discoverCodexBinary picks the first existing absolute candidate and fails closed with null', () => {
  assert.equal(
    discoverCodexBinary({ env: { PATH: '/nonexistent' }, exists: (p) => p === '/opt/homebrew/bin/codex' }),
    '/opt/homebrew/bin/codex',
  );
  assert.equal(discoverCodexBinary({ env: {}, exists: () => false }), null);
});

test('resolveAppServerArgs never relies on vendor defaults that break app-server', () => {
  assert.deepEqual(resolveAppServerArgs({}), ['app-server']);
  assert.deepEqual(resolveAppServerArgs({ CODEX_APP_SERVER_ARGS: '["app-server"]' }), ['app-server']);
  assert.deepEqual(resolveAppServerArgs({ CODEX_APP_SERVER_ARGS: '["app-server","--flag"]' }), ['app-server', '--flag']);
  assert.deepEqual(resolveAppServerArgs({ CODEX_APP_SERVER_ARGS: 'not-json' }), ['app-server']);
  assert.deepEqual(resolveAppServerArgs({ CODEX_APP_SERVER_ARGS: '[]' }), ['app-server']);
  assert.deepEqual(resolveAppServerArgs({ CODEX_APP_SERVER_ARGS: '"app-server"' }), ['app-server']);
});

test('parseCodexConfigOverrides translates flat keys and TOML tables without Server settings', () => {
  assert.deepEqual(parseCodexConfigOverrides(`
    # Subagent-only Codex config
    model = "gpt-5.6-luna" # inline comment
    model_reasoning_effort = "xhigh"
    [features]
    shell_tool = true
  `), [
    'model="gpt-5.6-luna"',
    'model_reasoning_effort="xhigh"',
    'features.shell_tool=true',
  ]);
});

test('resolveAppServerArgsWithConfig inserts -c overrides before app-server and ignores a missing file', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cas-config-'));
  t.after(async () => { await rm(dataDir, { recursive: true, force: true }); });
  assert.deepEqual(await resolveAppServerArgsWithConfig({ dataDir, env: {} }), ['app-server']);
  await writeFile(join(dataDir, 'config.toml'), 'model = "gpt-5.6-luna"\nmodel_reasoning_effort = "xhigh"\n');
  assert.deepEqual(await resolveAppServerArgsWithConfig({ dataDir, env: {} }), [
    '-c', 'model="gpt-5.6-luna"',
    '-c', 'model_reasoning_effort="xhigh"',
    'app-server',
  ]);
});

test('config parser fails closed on malformed assignments', () => {
  assert.throws(() => parseCodexConfigOverrides('model =\n'), /assignment|value/);
  assert.throws(() => parseCodexConfigOverrides('[[]\nmodel = true\n'), /table/);
});

// 下面这组是 server 启动自主发现的核心行为：预设绝对路径 + probe，逐候选推进。
function harness({ versions = {}, schema = {}, init = {}, exists } = {}) {
  const probed = [];
  return {
    probed,
    options: {
      env: { PATH: '/nonexistent' },
      candidates: ['/abs/a/codex', '/abs/b/codex', '/abs/c/codex'],
      exists: exists ?? (async () => true),
      run: async (binary, args) => {
        if (args[0] === '--version') {
          const outcome = versions[binary];
          if (outcome === 'fail') return { ok: false, stdout: '', stderr: 'boom', error: new Error('boom') };
          return { ok: true, stdout: `codex-cli ${outcome ?? '1.0.0'}`, stderr: '' };
        }
        if (args[1] === 'generate-json-schema') {
          const outcome = schema[binary];
          if (outcome === 'fail') return { ok: false, stdout: '', stderr: 'no schema', error: new Error('no schema') };
          return { ok: true, stdout: '', stderr: '' };
        }
        return { ok: false, stdout: '', stderr: '', error: new Error('unexpected') };
      },
      readSchema: async () => {
        // 以"最后一个 run 的 binary"无法得知，改用初始化阶段记录的顺序：
        // 这里简单返回全量 schema；缺失场景由 initialize 或 version 阶段覆盖。
        return SCHEMA_OK;
      },
      initializeSmoke: async (binary) => {
        probed.push(binary);
        return init[binary] === 'fail' ? { ok: false, reason: 'init blew up' } : { ok: true };
      },
    },
  };
}

test('probeCodexRuntime selects the first candidate that passes version + schema + initialize', async () => {
  const h = harness();
  const { selected, diagnostics } = await probeCodexRuntime(h.options);
  assert.equal(selected.binary, '/abs/a/codex');
  assert.equal(selected.version, '1.0.0');
  assert.ok(selected.schemaHash);
  assert.deepEqual(selected.args, ['app-server']);
  assert.deepEqual(h.probed, ['/abs/a/codex'], '选中即止，不再探测后续候选');
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].ok, true);
});

test('probeCodexRuntime skips broken candidates and records a reason for each', async () => {
  const h = harness({
    versions: { '/abs/a/codex': 'fail' },
    init: { '/abs/b/codex': 'fail' },
  });
  // /abs/a 版本失败、/abs/b 初始化失败，应落到 /abs/c。
  const { selected, diagnostics } = await probeCodexRuntime(h.options);
  assert.equal(selected.binary, '/abs/c/codex');
  assert.equal(diagnostics.length, 3);
  assert.match(diagnostics[0].reason, /--version failed/);
  assert.match(diagnostics[1].reason, /initialize smoke failed/);
  assert.equal(diagnostics[2].ok, true);
});

test('probeCodexRuntime fails closed when every candidate is unusable', async () => {
  const { selected, diagnostics } = await probeCodexRuntime({
    env: { PATH: '/nonexistent' },
    candidates: ['/abs/a/codex'],
    exists: async () => true,
    run: async () => ({ ok: false, stdout: '', stderr: 'nope', error: new Error('nope') }),
    initializeSmoke: async () => ({ ok: true }),
  });
  assert.equal(selected, null);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].ok, false);
});

test('probeCodexRuntime rejects a runtime whose schema lacks required methods', async () => {
  const { selected, diagnostics } = await probeCodexRuntime({
    env: { PATH: '/nonexistent' },
    candidates: ['/abs/a/codex'],
    exists: async () => true,
    run: async (binary, args) => (args[0] === '--version'
      ? { ok: true, stdout: 'codex-cli 1.0.0', stderr: '' }
      : { ok: true, stdout: '', stderr: '' }),
    // 缺少 turn/steer 等必需 method 的 runtime 必须被拒绝。
    readSchema: async () => JSON.stringify({ defs: ['thread/start'] }),
    initializeSmoke: async () => ({ ok: true }),
  });
  assert.equal(selected, null);
  assert.match(diagnostics[0].reason, /schema missing methods/);
});

test('probeCodexRuntime can skip the initialize stage when explicitly disabled', async () => {
  let initCalled = false;
  const { selected } = await probeCodexRuntime({
    env: { PATH: '/nonexistent' },
    candidates: ['/abs/a/codex'],
    exists: async () => true,
    run: async (binary, args) => ({ ok: true, stdout: args[0] === '--version' ? 'codex-cli 9.9.9' : '', stderr: '' }),
    readSchema: async () => SCHEMA_OK,
    initializeSmoke: async () => { initCalled = true; return { ok: true }; },
    requireInitialize: false,
  });
  assert.equal(selected.binary, '/abs/a/codex');
  assert.equal(initCalled, false);
});
