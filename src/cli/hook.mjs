import { join } from 'node:path';

import { openSqliteStore, DEFAULT_DATA_DIR } from '../adapters/sqlite/sqlite-store.mjs';
import { createCompletionStore } from '../core/completion-store.mjs';
import { drainPending } from '../hook/drain.mjs';
import { option } from '../shared/argv.mjs';

async function readHookStdin(stdin, timeoutMs = 3000) {
  if (!stdin || stdin.isTTY) return {};
  let data = '';
  stdin.setEncoding('utf8');
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    stdin.on('data', (chunk) => { data += chunk; });
    stdin.on('end', () => { clearTimeout(timer); resolve(); });
    stdin.on('error', () => { clearTimeout(timer); resolve(); });
  });
  try {
    const parsed = JSON.parse(data);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export async function hook(argv = [], { stdout = process.stdout, stdin = process.stdin, stderr = process.stderr } = {}) {
  const input = await readHookStdin(stdin);
  const event = input.hook_event_name ?? input.hookEventName;
  const workspace = option(argv, '--workspace', input.cwd ?? process.cwd());
  const dataDir = option(argv, '--data-dir', DEFAULT_DATA_DIR);
  const host = option(argv, '--host', 'plain');
  const blockKimiEvent = host === 'kimi-code' && (event === 'PreToolUse' || event === 'Stop');
  try {
    const store = openSqliteStore(dataDir);
    try {
      const result = await drainPending({
        workspace,
        host,
        store: createCompletionStore(store),
        output: blockKimiEvent ? stderr : stdout,
        context: { event },
      });
      return blockKimiEvent && result.count > 0 ? 2 : 0;
    } finally {
      store.close();
    }
  } catch (err) {
    // Hook 失败必须静默（exit 0）：非零退出会被 Host 记为 hook failure 并污染会话日志。
    stderr.write(`[codex-as-subagent hook] ${err?.message ?? err}\n`);
  }
  return 0;
}
