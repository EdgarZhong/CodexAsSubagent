import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { collectDoctorReport, doctor } from '../../src/cli/doctor.mjs';

test('collectDoctorReport diagnoses data dir, config, lock and selected runtime without leaking values', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cas-doctor-'));
  t.after(async () => { await rm(dataDir, { recursive: true, force: true }); });
  await writeFile(join(dataDir, 'config.toml'), 'model = "secret-model"\n');
  const report = await collectDoctorReport({
    dataDir,
    probeRuntime: async ({ args }) => ({ selected: { binary: '/codex', version: '0.1.0', schemaHash: 'abcd', args }, diagnostics: [{ candidate: '/codex', ok: true }] }),
    readLock: async () => ({ pid: 123, instanceId: 'instance-1', socketPath: join(dataDir, 'server.sock') }),
    isProcessAlive: async () => true,
    probeSocket: async () => true,
  });
  assert.equal(report.ok, true);
  assert.equal(report.config.overrideCount, 1);
  assert.deepEqual(report.config.keys, ['model']);
  assert.doesNotMatch(JSON.stringify(report), /secret-model/);
  assert.equal(report.lock.healthy, true);
  assert.equal(report.runtime.selected.binary, '/codex');
});

test('doctor reports malformed config/runtime failure and returns exit code 1', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cas-doctor-fail-'));
  t.after(async () => { await rm(dataDir, { recursive: true, force: true }); });
  await writeFile(join(dataDir, 'config.toml'), 'model =\n');
  const output = { text: '', write(value) { this.text += value; } };
  const code = await doctor(['--data-dir', dataDir], {
    stdout: output,
    stderr: output,
    probeRuntime: async () => ({ selected: null, diagnostics: [{ candidate: '/codex', ok: false, reason: 'broken' }] }),
  });
  assert.equal(code, 1);
  assert.match(output.text, /config|runtime/i);
});
