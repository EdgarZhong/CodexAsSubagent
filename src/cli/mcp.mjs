import { join } from 'node:path';

import { DEFAULT_DATA_DIR } from '../adapters/sqlite/sqlite-store.mjs';
import { StdioBootstrap } from '../mcp/stdio-bootstrap.mjs';
import { getHostAdapter } from '../hosts/registry.mjs';
import { option } from '../shared/argv.mjs';

const USAGE = [
  '用法: codex-as-subagent mcp --host <HOST> [--data-dir PATH] [--socket PATH] [--lock PATH]',
  '',
  'V2 起 --host 为必填参数（kimi-code / zcode）。MCP 进程将以该 Host 身份注册',
  'Host Presence（heartbeat 直写 SQLite），并以 {host, workspace} 上下文转发 Runtime 请求。',
].join('\n');

function defaultCreateBootstrap(options) {
  return new StdioBootstrap(options);
}

export async function mcp(argv = [], { stderr = process.stderr, createBootstrap = defaultCreateBootstrap } = {}) {
  const host = option(argv, '--host');
  if (typeof host !== 'string' || host.length === 0) {
    stderr.write(`${USAGE}\n`);
    return 1;
  }
  try {
    // 未知 host 在任何 CAS 状态（含 presence attach）之前失败（实施规格 §3.13）。
    getHostAdapter(host);
  } catch (err) {
    stderr.write(`${err?.message ?? err}\n`);
    return 1;
  }
  const dataDir = option(argv, '--data-dir', DEFAULT_DATA_DIR);
  const bootstrap = createBootstrap({
    socketPath: option(argv, '--socket', join(dataDir, 'server.sock')),
    lockPath: option(argv, '--lock', join(dataDir, 'server.lock')),
    dataDir,
    host,
  });
  await bootstrap.run();
  return 0;
}
