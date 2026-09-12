// ZCode Host Protocol Adapter（实施规格 §3.2/§3.8）。
//
// ZCode 使用自己的 native Hook payload / Hook environment，不要求 ZCode 插件
// 改写 payload 来迁就 Kimi 字段名。session 身份只在 Hook 通道可得（Hook env
// 注入 ZCODE_SESSION_ID，MCP 进程 env 无 session 变量——CLAUDE.md 继承决策 8）。
export const hostId = 'zcode';

function optionalString(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

// ZCode Hook stdin payload 携带 hook_event_name / cwd / tool_name 等；
// sessionId 来自 Hook 通道注入的 env.ZCODE_SESSION_ID，缺失为 undefined
//（不得 fallback，也不得用 current_session 伪造）。
export function parseHookInvocation({ payload, env } = {}) {
  const native = payload && typeof payload === 'object' ? payload : {};
  const hookEnv = env && typeof env === 'object' ? env : {};
  return {
    sessionId: optionalString(hookEnv.ZCODE_SESSION_ID),
    cwd: optionalString(native.cwd),
    event: optionalString(native.hook_event_name),
    toolName: optionalString(native.tool_name),
    toolInput: native.tool_input,
    toolCallId: optionalString(native.tool_call_id),
  };
}

export default Object.freeze({
  hostId,
  parseHookInvocation,
});
