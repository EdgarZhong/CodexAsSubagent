// Kimi Code Host Protocol Adapter（实施规格 §3.2/§3.7）。
//
// 本文件是 kimi-code 的 Host-native 字段唯一出现处：cli/hook.mjs 等外层
// 不得直接读取 payload.session_id / hook_event_name / tool_name 等字段。
// Adapter 只做 native 字段提取，不做猜测、不做 fallback；workspace 的
// canonicalize 统一由 WorkspaceGuard 在 hook core 中执行。
import { renderGateVeto } from '../hook/hosts/kimi-code.mjs';

export const hostId = 'kimi-code';

// 回流注入走 block 语义（stderr + exit 2）的 Hook 事件
// （Kimi Hook 协议：仅 PreToolUse/Stop/UserPromptSubmit 可影响主流程，
// 其中 PreToolUse/Stop 用 exit 2 block 把 completion 送回上下文）。
export const BLOCK_DELIVERY_EVENTS = Object.freeze(new Set(['PreToolUse', 'Stop']));

// CAS Session 门禁只在 PreToolUse 上执行（串投修复说明 §三：Mailbox 回流优先，
// 门禁仅针对真正准备执行的 CAS MCP 工具）。
export const SESSION_GATE_EVENT = 'PreToolUse';

function optionalString(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

// Kimi Hook stdin payload（Kimi 知识库 §20 协议事实）：
//   { hook_event_name, session_id, cwd, tool_name?, tool_input?, tool_call_id? }
// session_id 只在 stdin payload 字段中，绝不从 env 或 current_session 猜测。
export function parseHookInvocation({ payload, env } = {}) {
  void env;
  const native = payload && typeof payload === 'object' ? payload : {};
  return {
    sessionId: optionalString(native.session_id),
    cwd: optionalString(native.cwd),
    event: optionalString(native.hook_event_name),
    toolName: optionalString(native.tool_name),
    toolInput: native.tool_input,
    toolCallId: optionalString(native.tool_call_id),
  };
}

export function gateVetoText(kind) {
  return renderGateVeto(kind);
}

export default Object.freeze({
  hostId,
  parseHookInvocation,
  blockDeliveryEvents: BLOCK_DELIVERY_EVENTS,
  sessionGateEvent: SESSION_GATE_EVENT,
  gateVetoText,
});
