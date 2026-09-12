import { DEFAULT_DATA_DIR, openSqliteStore } from '../adapters/sqlite/sqlite-store.mjs';
import { WorkspaceGuard } from '../core/workspace-guard.mjs';
import { drainPending } from '../hook/drain.mjs';
import { getHostAdapter } from '../hosts/registry.mjs';
import { TOOL_DEFINITIONS } from '../mcp/tool-registry.mjs';
import { option } from '../shared/argv.mjs';

// CAS MCP 工具集直接来自 tool-registry（10 个 codex_* 工具），禁止在本文件硬编码工具名。
const CAS_TOOL_NAMES = Object.freeze(new Set(TOOL_DEFINITIONS.map((tool) => tool.name)));

const USAGE = [
  '用法: codex-as-subagent hook --host <HOST> [--data-dir PATH]',
  '',
  'V2 起 --host 为必填参数（kimi-code / zcode），不再提供默认 host 或 plain fallback；',
  'workspace 只来自 Hook native payload，不得用 --workspace 覆盖。',
].join('\n');

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

function failOpenMessage(error) {
  return `[codex-as-subagent hook] ${error?.message ?? error}\n`;
}

export async function hook(argv = [], {
  stdout = process.stdout,
  stdin = process.stdin,
  stderr = process.stderr,
  env = process.env,
  openStore = (dataDir) => openSqliteStore(dataDir),
  workspaceGuard = new WorkspaceGuard(),
  dataDir: dataDirOverride,
} = {}) {
  const host = option(argv, '--host');
  if (typeof host !== 'string' || host.length === 0) {
    stderr.write(`${USAGE}\n`);
    return 1;
  }
  let adapter;
  try {
    // 未知 host 必须在任何 CAS 状态读写之前失败（实施规格 §3.2/§3.13）。
    adapter = getHostAdapter(host);
  } catch (err) {
    stderr.write(failOpenMessage(err));
    return 1;
  }

  const payload = await readHookStdin(stdin);
  let parsed;
  try {
    parsed = adapter.parseHookInvocation({ payload, env });
  } catch (err) {
    // Adapter 解析失败不得破坏宿主：fail-open，工具照常执行。
    stderr.write(failOpenMessage(err));
    return 0;
  }

  let workspace;
  try {
    // cwd 缺失时 fallback process.cwd()（保留既有行为）；canonicalize 统一由 WorkspaceGuard 执行。
    workspace = await workspaceGuard.resolve(parsed.cwd ?? process.cwd());
  } catch (err) {
    stderr.write(failOpenMessage(err));
    return 0;
  }

  const hookContext = Object.freeze({
    host,
    workspace,
    sessionId: parsed.sessionId,
    event: parsed.event,
    toolName: parsed.toolName,
    toolInput: parsed.toolInput,
    toolCallId: parsed.toolCallId,
  });

  // 门禁触发条件：adapter 声明 gate 事件（kimi-code: PreToolUse）+ 当前工具属于 CAS MCP 工具集。
  const gateApplies = typeof adapter.sessionGateEvent === 'string'
    && hookContext.event === adapter.sessionGateEvent
    && typeof hookContext.toolName === 'string'
    && CAS_TOOL_NAMES.has(hookContext.toolName);
  // 回流注入的 block 语义事件（kimi-code: PreToolUse/Stop → stderr + exit 2）。
  const blockDelivery = Boolean(adapter.blockDeliveryEvents?.has(hookContext.event));
  const dataDir = dataDirOverride ?? option(argv, '--data-dir', DEFAULT_DATA_DIR);

  let store;
  try {
    store = openStore(dataDir);
  } catch (err) {
    if (gateApplies) {
      // 门禁无法求值 → fail closed：阻止本次 CAS 工具执行（规格：gate 异常 veto）。
      stderr.write(`${adapter.gateVetoText('unavailable')}\n`);
      return 2;
    }
    stderr.write(failOpenMessage(err));
    return 0;
  }

  try {
    // ① Mailbox 主动回流优先：仅在 adapter 声明的回流事件上消费（如 zcode 的
    //    PreToolUse 只做门禁不做回流），有 sessionId 才允许 claim（缺 sessionId 拒绝，
    //    不做 workspace-only fallback）；注入 completion 后本次事件到此结束，不再执行
    //    Session 门禁（回流与 CAS 使用权解耦）。
    if (adapter.deliveryEvents.has(hookContext.event) && hookContext.sessionId) {
      let injected = false;
      try {
        const result = await drainPending({
          host: hookContext.host,
          workspace: hookContext.workspace,
          sessionId: hookContext.sessionId,
          store,
          output: blockDelivery ? stderr : stdout,
          context: { event: hookContext.event },
        });
        injected = result.count > 0;
      } catch (err) {
        // 回流失败不得跳过门禁；非门禁路径保持 fail-open（不破坏宿主）。
        stderr.write(failOpenMessage(err));
        if (!gateApplies) return 0;
      }
      if (injected) {
        return blockDelivery ? 2 : 0;
      }
    }

    // ② CAS Session 门禁：仅当本次工具真正准备调用 CAS MCP 工具且未注入任何 completion。
    if (gateApplies) {
      if (!hookContext.sessionId) {
        // admission 拒绝：无法确认会话身份 → veto（不得从 current_session 伪造）。
        stderr.write(`${adapter.gateVetoText('missing_session')}\n`);
        return 2;
      }
      let gate;
      try {
        gate = store.sessionGateTransition({
          host: hookContext.host,
          workspace: hookContext.workspace,
          sessionId: hookContext.sessionId,
        });
      } catch (err) {
        stderr.write(`${adapter.gateVetoText('unavailable')}\n[codex-as-subagent hook] ${err?.message ?? err}\n`);
        return 2;
      }
      if (gate?.decision === 'allow') {
        return 0;
      }
      stderr.write(`${adapter.gateVetoText('occupied')}\n`);
      return 2;
    }

    // ③ 非 CAS 工具（Bash/Read/其他 MCP）与无门禁事件 → 放行。
    return 0;
  } catch (err) {
    // Hook 失败必须静默（exit 0）：非零退出会被 Host 记为 hook failure 并污染会话日志。
    // 门禁路径的异常在上面各自 fail closed，此处只兜底回流等非门禁路径。
    stderr.write(failOpenMessage(err));
  } finally {
    store.close();
  }
  return 0;
}
