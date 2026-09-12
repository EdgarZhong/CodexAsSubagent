// ZCode Host Protocol Adapter（实施规格 §3.2/§3.8）。
//
// ZCode 使用自己的 native Hook payload / Hook environment，不要求 ZCode 插件
// 改写 payload 来迁就 Kimi 字段名。session 身份只在 Hook 通道可得（Hook env
// 注入 ZCODE_SESSION_ID，MCP 进程 env 无 session 变量——CLAUDE.md 继承决策 8）。
import { renderGateVeto } from '../hook/hosts/zcode.mjs';

export const hostId = 'zcode';

// ZCode 的回流投递全部走 stdout 严格 JSON + exit 0（ZCode 协议：无 ACK 机制，
// exit 0 + 合法 JSON 即完成；Stop 续轮由 envelope 内 decision:block 表达）。
// 因此没有任何事件使用 Kimi 式 stderr + exit 2 block 语义。
export const BLOCK_DELIVERY_EVENTS = Object.freeze(new Set());

// CAS Session 门禁只在 PreToolUse 上执行（ZCode 7 事件含 PreToolUse，
// exit 2 = 阻断，与 Kimi 同构；Mailbox 回流优先级规则相同）。
export const SESSION_GATE_EVENT = 'PreToolUse';

// Mailbox 回流的消费窗口。PreToolUse 仅做门禁、不做回流：ZCode 对 PreToolUse
// stdout additionalContext 的注入行为未经实证，若在此 claim 可能被宿主丢弃
// （claim→ack 后结果丢失），且 PreToolUse 是最高频事件。pending completion
// 会由紧随其后的 PostToolUse 即时接管。
export const DELIVERY_EVENTS = Object.freeze(new Set(['UserPromptSubmit', 'PostToolUse', 'Stop']));

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

export function gateVetoText(kind) {
  return renderGateVeto(kind);
}

export default Object.freeze({
  hostId,
  parseHookInvocation,
  blockDeliveryEvents: BLOCK_DELIVERY_EVENTS,
  sessionGateEvent: SESSION_GATE_EVENT,
  deliveryEvents: DELIVERY_EVENTS,
  gateVetoText,
});
