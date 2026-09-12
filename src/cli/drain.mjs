import { DEFAULT_DATA_DIR, openSqliteStore } from '../adapters/sqlite/sqlite-store.mjs';
import { WorkspaceGuard } from '../core/workspace-guard.mjs';
import { drainPending } from '../hook/drain.mjs';
import { getHostAdapter } from '../hosts/registry.mjs';
import { option } from '../shared/argv.mjs';

const USAGE = [
  '用法: codex-as-subagent drain --host <HOST> --workspace <PATH> --session <SESSION_ID> [--data-dir PATH]',
  '',
  'V2 起 drain 是显式低层接口：host / workspace / session 三项身份全部必填，',
  '不再读取 stdin，也不再作为 hook 的 alias；不支持 workspace-only drain。',
].join('\n');

export async function drain(argv = [], {
  stdout = process.stdout,
  stderr = process.stderr,
  openStore = (dataDir) => openSqliteStore(dataDir),
  workspaceGuard = new WorkspaceGuard(),
  now,
} = {}) {
  const host = option(argv, '--host');
  const workspace = option(argv, '--workspace');
  const sessionId = option(argv, '--session');
  const missing = [
    ['--host', host],
    ['--workspace', workspace],
    ['--session', sessionId],
  ].filter(([, value]) => typeof value !== 'string' || value.length === 0)
    .map(([name]) => name);
  if (missing.length > 0) {
    stderr.write(`${USAGE}\n缺少必填参数: ${missing.join(' ')}\n`);
    return 1;
  }
  try {
    // 未知 host 在任何 CAS 状态读写之前失败（实施规格 §3.13）。
    getHostAdapter(host);
  } catch (err) {
    stderr.write(`${err?.message ?? err}\n`);
    return 1;
  }
  const dataDir = option(argv, '--data-dir', DEFAULT_DATA_DIR);
  let store;
  try {
    store = openStore(dataDir);
  } catch (err) {
    stderr.write(`${err?.message ?? err}\n`);
    return 1;
  }
  try {
    // --workspace 先经 WorkspaceGuard canonicalize，再构成 DeliveryContext。
    const canonicalWorkspace = await workspaceGuard.resolve(workspace);
    // drain 无 pending 时同样成功退出（低层查询语义），错误路径返回 1。
    await drainPending({
      // DeliveryContext：host + canonical workspace + sessionId 三元组。
      host,
      workspace: canonicalWorkspace,
      sessionId,
      store,
      output: stdout,
      ...(now ? { now } : {}),
    });
    return 0;
  } catch (err) {
    stderr.write(`[codex-as-subagent drain] ${err?.message ?? err}\n`);
    return 1;
  } finally {
    store.close();
  }
}
