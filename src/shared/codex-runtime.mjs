import { accessSync, constants } from 'node:fs';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

// 设计 6.4：发现目标不是"机器上有没有叫 codex 的文件"，而是"哪些 Codex runtime
// 满足本项目所需的 stable app-server contract"。顺序固定，不扫描 IDE 私有 runtime，
// 不按版本号排序（alpha 版本号可能高于 stable）。
export function codexBinaryCandidates(env = process.env) {
  const candidates = [];
  if (typeof env.CODEX_BIN === 'string' && env.CODEX_BIN.length > 0) {
    candidates.push(env.CODEX_BIN);
  }
  const path = typeof env.PATH === 'string' ? env.PATH : '';
  for (const dir of path.split(':')) {
    if (dir.length > 0) candidates.push(join(dir, 'codex'));
  }
  candidates.push(join(homedir(), '.codex', 'packages', 'standalone', 'current', 'bin', 'codex'));
  candidates.push(join(homedir(), '.local', 'bin', 'codex'));
  candidates.push('/opt/homebrew/bin/codex');
  candidates.push('/usr/local/bin/codex');
  candidates.push('/Applications/ChatGPT.app/Contents/Resources/codex');
  candidates.push('/Applications/Codex.app/Contents/Resources/codex');
  return [...new Set(candidates)];
}

// adapter 必须能依赖的 wire method（与 src/adapters/supervisor/app-server-adapter.mjs 一致）。
export const REQUIRED_APP_SERVER_METHODS = Object.freeze([
  'thread/start',
  'thread/resume',
  'turn/start',
  'turn/steer',
  'turn/interrupt',
  'thread/list',
  'thread/read',
  'model/list',
  'config/read',
]);

const DEFAULT_APP_SERVER_ARGS = Object.freeze(['app-server']);

// vendor 默认启动参数会让部分 app-server 版本直接退出（CLAUDE.md 决策 12），
// 因此缺省必须是干净的 `app-server`；仅当显式配置为合法 JSON 字符串数组时才采用。
export function resolveAppServerArgs(env = process.env) {
  const raw = env.CODEX_APP_SERVER_ARGS;
  if (typeof raw === 'string' && raw.trim().length > 0) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((v) => typeof v === 'string')) {
        return parsed;
      }
    } catch {
      // 非法 JSON 回退默认，而不是把垃圾参数传给子进程。
    }
  }
  return [...DEFAULT_APP_SERVER_ARGS];
}

function isExecutableSync(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// 同步快速预过滤：只验证可执行性并取第一个候选。供 adapter 在无预解析结果时兜底；
// 完整能力探测（version/schema/initialize）由 probeCodexRuntime 在 serve 启动时完成。
export function discoverCodexBinary({ env = process.env, exists = isExecutableSync } = {}) {
  for (const candidate of codexBinaryCandidates(env)) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

function defaultRun(command, args, { timeoutMs = 20_000 } = {}) {
  return new Promise((resolvePromise) => {
    execFile(command, args, { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolvePromise({ ok: !error, stdout: stdout ?? '', stderr: stderr ?? '', error: error ?? null });
    });
  });
}

// 拉起 ephemeral app-server 完成 initialize/initialized 握手后立即终止。
// 这是"该 runtime 真能跑起来"的最强判据，也是设计 6.4 的最后一关。
function defaultInitializeSmoke(command, args, { timeoutMs = 20_000 } = {}) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch (error) {
      resolvePromise({ ok: false, reason: `spawn failed: ${error?.message ?? error}` });
      return;
    }
    let buffer = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      resolvePromise(value);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: `initialize timed out after ${timeoutMs}ms` }), timeoutMs);
    timer.unref?.();
    child.on('error', (error) => finish({ ok: false, reason: `process error: ${error?.message ?? error}` }));
    child.on('exit', (code, signal) => {
      if (!settled) finish({ ok: false, reason: `exited before initialize (code=${code}, signal=${signal})` });
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1) {
          if (message.error) {
            finish({ ok: false, reason: `initialize error: ${JSON.stringify(message.error)}` });
          } else {
            try { child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`); } catch { /* ignore */ }
            finish({ ok: true });
          }
        }
      }
    });
    const request = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'codex_as_subagent_probe', title: 'Codex As Subagent Probe', version: '1.0.0' },
        capabilities: { experimentalApi: false },
      },
    };
    try {
      child.stdin.write(`${JSON.stringify(request)}\n`);
    } catch (error) {
      finish({ ok: false, reason: `write failed: ${error?.message ?? error}` });
    }
  });
}

async function fileExecutable(path) {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// 对单个候选执行 6.4 的探测：可执行 → --version → generate-json-schema 必需 method
// → ephemeral initialize 冒烟。返回 {ok:true, version, schemaHash} 或 {ok:false, reason}。
async function probeCandidate(binary, {
  run,
  initializeSmoke,
  args,
  schemaOutDir,
  requireInitialize,
  exists,
  readSchema,
}) {
  if (!await exists(binary)) return { ok: false, reason: 'not executable' };

  const versionResult = await run(binary, ['--version']);
  if (!versionResult.ok) {
    const detail = `${versionResult.stdout}${versionResult.stderr}`.trim() || versionResult.error?.message;
    return { ok: false, reason: `--version failed: ${detail}` };
  }
  const versionText = `${versionResult.stdout}${versionResult.stderr}`.trim();
  const version = versionText.split(/\s+/).filter(Boolean).pop() ?? versionText;

  const out = join(schemaOutDir, createHash('sha1').update(binary).digest('hex').slice(0, 12));
  const schemaResult = await run(binary, ['app-server', 'generate-json-schema', '--out', out]);
  if (!schemaResult.ok) {
    const detail = (schemaResult.stderr || schemaResult.error?.message || '').trim();
    return { ok: false, reason: `generate-json-schema failed: ${detail.slice(0, 300)}` };
  }
  let schemaText;
  try {
    schemaText = await readSchema(join(out, 'codex_app_server_protocol.v2.schemas.json'));
  } catch (error) {
    return { ok: false, reason: `schema bundle missing: ${error?.message ?? error}` };
  }
  const missing = REQUIRED_APP_SERVER_METHODS.filter((method) => !schemaText.includes(method));
  if (missing.length > 0) return { ok: false, reason: `schema missing methods: ${missing.join(', ')}` };
  const schemaHash = createHash('sha256').update(schemaText).digest('hex').slice(0, 16);

  if (requireInitialize) {
    const smoke = await initializeSmoke(binary, args);
    if (!smoke.ok) return { ok: false, reason: `initialize smoke failed: ${smoke.reason}` };
  }
  return { ok: true, version, schemaHash };
}

// 完整发现入口：返回 {selected, diagnostics}。selected 形如
// {binary, version, schemaHash, args}；全部失败时 selected=null，diagnostics 含每候选原因。
// 调用方（serve/doctor）据此 fail-closed，并输出诊断。
export async function probeCodexRuntime(options = {}) {
  const env = options.env ?? process.env;
  const run = options.run ?? defaultRun;
  const initializeSmoke = options.initializeSmoke ?? defaultInitializeSmoke;
  const args = options.args ?? resolveAppServerArgs(env);
  const requireInitialize = options.requireInitialize !== false;
  const candidates = options.candidates ?? codexBinaryCandidates(env);
  const exists = options.exists ?? fileExecutable;
  const readSchema = options.readSchema ?? ((path) => readFile(path, 'utf8'));
  const diagnostics = [];
  const schemaOutDir = await mkdtemp(join(tmpdir(), 'cas-probe-'));
  try {
    for (const candidate of candidates) {
      const result = await probeCandidate(candidate, {
        run, initializeSmoke, args, schemaOutDir, requireInitialize, exists, readSchema,
      });
      if (result.ok) {
        diagnostics.push({ candidate, ok: true, version: result.version, schemaHash: result.schemaHash });
        return { selected: { binary: candidate, version: result.version, schemaHash: result.schemaHash, args }, diagnostics };
      }
      diagnostics.push({ candidate, ok: false, reason: result.reason });
    }
    return { selected: null, diagnostics };
  } finally {
    await rm(schemaOutDir, { recursive: true, force: true }).catch(() => {});
  }
}
