import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { DEFAULT_DATA_DIR } from '../adapters/sqlite/sqlite-store.mjs';
import {
  DEFAULT_KIMI_CODE_HOME,
  discoverKimiServer,
  runKimiWebWorker,
} from '../hook/kimi-web.mjs';
import { hasFlag, option } from '../shared/argv.mjs';

const execFileAsync = promisify(execFile);

function requiredString(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${name} must be a non-empty string.`);
  return value;
}

export function resolveKimiCodeHome(options = {}) {
  const explicit = options.kimiCodeHome;
  if (typeof explicit === 'string' && explicit.length > 0) return resolve(explicit);
  const envValue = options.env?.KIMI_CODE_HOME ?? process.env.KIMI_CODE_HOME;
  if (typeof envValue === 'string' && envValue.length > 0) return resolve(envValue);
  return DEFAULT_KIMI_CODE_HOME;
}

export function workerRegistryPath(dataDir = DEFAULT_DATA_DIR) {
  return join(resolve(dataDir), 'kimi-web-workers.json');
}

export function workerKey({ kimiHome, sessionId, workspace }) {
  return `${kimiHome}|${sessionId}|${workspace}`;
}

async function readRegistry(path) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

async function writeRegistry(path, registry) {
  await mkdir(resolve(path, '..'), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  await rename(tmp, path);
}

async function defaultLookupPid(pid) {
  try {
    const result = await execFileAsync('ps', ['-p', String(pid), '-o', 'command=']);
    return result.stdout.trim();
  } catch {
    return '';
  }
}

export async function workerMatches(entry, { lookupPid = defaultLookupPid } = {}) {
  if (!entry || !Number.isSafeInteger(entry.pid) || entry.pid < 1) return false;
  const command = await lookupPid(entry.pid);
  return typeof command === 'string'
    && command.includes('kimi-web')
    && typeof entry.command === 'string'
    && command.includes(entry.command);
}

function hookInput(input) {
  return input && typeof input === 'object' ? input : {};
}

async function readStdin(stdin = process.stdin) {
  if (!stdin || stdin.isTTY) return {};
  let data = '';
  stdin.setEncoding('utf8');
  await new Promise((resolveRead) => {
    stdin.on('data', (chunk) => { data += chunk; });
    stdin.on('end', resolveRead);
    stdin.on('error', resolveRead);
  });
  try {
    const value = JSON.parse(data);
    return hookInput(value);
  } catch {
    return {};
  }
}

function workerArgs({ cliPath, dataDir, kimiHome, sessionId, workspace, key, pollMs }) {
  return [
    cliPath,
    'kimi-web',
    '--worker',
    `--data-dir=${dataDir}`,
    `--kimi-code-home=${kimiHome}`,
    `--session-id=${sessionId}`,
    `--workspace=${workspace}`,
    `--worker-key=${key}`,
    `--poll-ms=${pollMs}`,
  ];
}

export async function attachKimiWebWorker({
  dataDir = DEFAULT_DATA_DIR,
  kimiHome = DEFAULT_KIMI_CODE_HOME,
  sessionId,
  workspace,
  cliPath,
  pollMs = 1000,
  env = process.env,
  discover = discoverKimiServer,
  spawnImpl = spawn,
  lookupPid = defaultLookupPid,
  now = () => new Date(),
} = {}) {
  requiredString(sessionId, 'sessionId');
  requiredString(workspace, 'workspace');
  requiredString(cliPath, 'cliPath');
  const server = await discover({ home: kimiHome, sessionId, workspace });
  if (!server) return { attached: false, reason: 'server_unavailable' };
  const canonicalWorkspace = server.workspace ?? workspace;

  const path = workerRegistryPath(dataDir);
  const registry = await readRegistry(path);
  const key = workerKey({ kimiHome, sessionId, workspace: canonicalWorkspace });
  const existing = registry[key];
  if (existing && await workerMatches(existing, { lookupPid })) {
    return { attached: false, existing: true, key, pid: existing.pid };
  }
  if (existing) delete registry[key];

  const command = `--worker-key=${key}`;
  const child = spawnImpl(process.execPath, workerArgs({
    cliPath,
    dataDir: resolve(dataDir),
    kimiHome,
    sessionId,
    workspace: canonicalWorkspace,
    key,
    pollMs,
  }), {
    detached: true,
    stdio: 'ignore',
    env: { ...env, KIMI_CODE_HOME: kimiHome },
  });
  child.unref?.();
  registry[key] = {
    pid: child.pid,
    command,
    sessionId,
    workspace: canonicalWorkspace,
    kimiHome,
    startedAt: now().toISOString(),
  };
  await writeRegistry(path, registry);
  return { attached: true, key, pid: child.pid, registryPath: path };
}

export async function detachKimiWebWorker({
  dataDir = DEFAULT_DATA_DIR,
  kimiHome = DEFAULT_KIMI_CODE_HOME,
  sessionId,
  workspace,
  lookupPid = defaultLookupPid,
  kill = (pid) => process.kill(pid, 'SIGTERM'),
} = {}) {
  if (typeof sessionId !== 'string' || typeof workspace !== 'string') return { detached: false, reason: 'missing_identity' };
  const path = workerRegistryPath(dataDir);
  const registry = await readRegistry(path);
  const key = workerKey({ kimiHome, sessionId, workspace });
  const entry = registry[key];
  if (!entry || !(await workerMatches(entry, { lookupPid }))) {
    return { detached: false, reason: 'worker_not_owned', key };
  }
  try { kill(entry.pid); } catch { /* worker may have exited between lookup and signal */ }
  delete registry[key];
  await writeRegistry(path, registry);
  return { detached: true, key, pid: entry.pid };
}

export async function runKimiWebCli(argv = [], {
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  cliPath,
  env = process.env,
  discover = discoverKimiServer,
  spawnImpl = spawn,
  lookupPid = defaultLookupPid,
  kill,
  worker = runKimiWebWorker,
  now,
} = {}) {
  const input = await readStdin(stdin);
  const kimiHome = resolveKimiCodeHome({ kimiCodeHome: option(argv, '--kimi-code-home', input.kimi_code_home), env });
  const dataDir = option(argv, '--data-dir', DEFAULT_DATA_DIR);
  const sessionId = option(argv, '--session-id', input.session_id);
  const workspace = option(argv, '--workspace', input.cwd ?? process.cwd());
  const resolvedCliPath = cliPath ?? join(resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'cli', 'main.mjs'));

  try {
    if (hasFlag(argv, '--worker')) {
      const key = option(argv, '--worker-key', '');
      const result = await worker({
        sessionId,
        workspace,
        dataDir,
        kimiHome,
        pollMs: Number(option(argv, '--poll-ms', '1000')) || 1000,
        now,
      });
      if (key) {
        const path = workerRegistryPath(dataDir);
        const registry = await readRegistry(path);
        if (registry[key]?.pid === process.pid && registry[key]?.command === `--worker-key=${key}`) {
          delete registry[key];
          await writeRegistry(path, registry);
        }
      }
      if (result.error) throw result.error;
      return 0;
    }
    if (hasFlag(argv, '--detach')) {
      await detachKimiWebWorker({
        dataDir,
        kimiHome,
        sessionId,
        workspace,
        lookupPid,
        ...(kill ? { kill } : {}),
      });
      return 0;
    }
    if (hasFlag(argv, '--attach')) {
      await attachKimiWebWorker({
        dataDir,
        kimiHome,
        sessionId,
        workspace,
        cliPath: resolvedCliPath,
        env,
        discover,
        spawnImpl,
        lookupPid,
        now,
      });
      return 0;
    }
    stderr.write('[codex-as-subagent kimi-web] 需要 --attach、--detach 或内部 --worker。\n');
    return 2;
  } catch (error) {
    stderr.write(`[codex-as-subagent kimi-web] ${error?.message ?? error}\n`);
    return 1;
  }
}
