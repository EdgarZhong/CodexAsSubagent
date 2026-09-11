import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';

import { DEFAULT_DATA_DIR } from '../adapters/sqlite/sqlite-store.mjs';
import { parseCodexConfigOverrides, resolveAppServerArgsWithConfig, probeCodexRuntime } from '../shared/codex-runtime.mjs';
import { option, hasFlag } from '../shared/argv.mjs';
import { probeSocket, readStartupLock } from '../server/startup-lock.mjs';

async function pathAccessible(path) {
  try {
    await access(path, constants.R_OK | constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function pathExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function safeConfigError(error) {
  const line = String(error?.message ?? '').match(/line \d+/i)?.[0];
  return line ? `invalid config.toml (${line})` : 'invalid config.toml';
}

function statusText(value) {
  return value ? 'ok' : 'failed';
}

export async function collectDoctorReport({
  dataDir = DEFAULT_DATA_DIR,
  probeRuntime = probeCodexRuntime,
  readLock = readStartupLock,
  isProcessAlive = async (pid) => {
    if (!Number.isSafeInteger(pid) || pid < 1) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
  },
  probeSocket: probe = probeSocket,
  accessPath = pathAccessible,
  existsPath = pathExists,
} = {}) {
  const configPath = join(dataDir, 'config.toml');
  const dataDirExists = await accessPath(dataDir);
  const config = { path: configPath, present: false, valid: true, keys: [], overrideCount: 0 };
  let appServerArgs = null;
  try {
    const overrides = await resolveAppServerArgsWithConfig({ dataDir });
    config.present = await existsPath(configPath);
    if (config.present) {
      // 只保留键名；不把模型、provider 或其他配置值写入诊断输出。
      const configText = await readFile(configPath, 'utf8');
      const entries = parseCodexConfigOverrides(configText);
      config.keys = entries.map((entry) => entry.slice(0, entry.indexOf('=')));
      config.overrideCount = entries.length;
    }
    appServerArgs = overrides;
  } catch (error) {
    config.valid = false;
    config.error = safeConfigError(error);
  }

  const lockRecord = await readLock(join(dataDir, 'server.lock'));
  const lock = { present: Boolean(lockRecord), healthy: null };
  if (lockRecord) {
    const processAlive = await isProcessAlive(lockRecord.pid);
    const socketHealthy = processAlive && await probe(lockRecord.socketPath);
    lock.healthy = Boolean(processAlive && socketHealthy);
    lock.pid = lockRecord.pid;
    lock.socketHealthy = Boolean(socketHealthy);
  }

  let runtime = { selected: null, diagnostics: [] };
  if (config.valid) {
    runtime = await probeRuntime({ args: appServerArgs });
  }
  const selected = runtime.selected
    ? {
      binary: runtime.selected.binary,
      version: runtime.selected.version,
      schemaHash: runtime.selected.schemaHash,
    }
    : null;
  const report = {
    ok: Boolean(config.valid && selected),
    dataDir: { path: dataDir, accessible: Boolean(dataDirExists) },
    files: {
      configToml: config.present,
      stateSqlite: await existsPath(join(dataDir, 'state.sqlite')),
      serverLog: await existsPath(join(dataDir, 'server.log')),
    },
    config,
    lock,
    runtime: { selected, diagnostics: runtime.diagnostics ?? [] },
  };
  return report;
}

export async function doctor(argv = [], {
  stdout = process.stdout,
  stderr = process.stderr,
  ...dependencies
} = {}) {
  const dataDir = option(argv, '--data-dir', DEFAULT_DATA_DIR);
  try {
    const report = await collectDoctorReport({ dataDir, ...dependencies });
    if (hasFlag(argv, '--json')) {
      stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      stdout.write([
        'Codex As Subagent doctor',
        `  data dir : ${report.dataDir.path} (${statusText(report.dataDir.accessible)})`,
        `  config   : ${report.config.present ? `${report.config.overrideCount} override(s)` : 'not configured'} (${statusText(report.config.valid)})`,
        `  lock     : ${report.lock.present ? `pid=${report.lock.pid} (${statusText(report.lock.healthy)})` : 'not present'}`,
        `  runtime  : ${report.runtime.selected ? `${report.runtime.selected.binary} ${report.runtime.selected.version}` : 'not available'}`,
        `  result   : ${report.ok ? 'PASS' : 'FAIL'}`,
      ].join('\n') + '\n');
    }
    return report.ok ? 0 : 1;
  } catch (error) {
    stderr.write(`[codex-as-subagent doctor] ${error?.message ?? error}\n`);
    return 1;
  }
}
