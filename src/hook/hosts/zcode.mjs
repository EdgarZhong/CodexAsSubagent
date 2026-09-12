export const name = 'zcode';

// ZCode 只解析以 `{` 开头的严格 JSON stdout，纯文本会被完全忽略。
// Stop 事件必须同时给 decision:block 和 additionalContext 才会续轮处理回流结果（最多 3 次）。
export function wrap(text, completions, context = {}) {
  void completions;
  const output = { additionalContext: String(text ?? '') };
  if (context?.event === 'Stop') {
    output.decision = 'block';
    output.reason = 'codex-as-subagent delivered subagent completion(s); continue to process them.';
  }
  return JSON.stringify(output);
}

// CAS Session Gate veto 文案（ZCode 协议：exit 2 = 阻断本次工具调用，门禁 veto 时
// 当前工具未执行，冲突解除后重试同一工具）。kind:
//   - 'occupied': current_session 属于其他仍有 active Execution 的 session，
//     或同一 workspace 出现多个 active session（fail closed）。
//   - 'missing_session': PreToolUse payload/env 缺 session 身份，无法确认会话。
//   - 'unavailable': gate 求值异常（store 打不开等），fail closed。
const GATE_VETO_MESSAGES = Object.freeze({
  occupied: [
    'The Codex As Subagent session gate blocked this tool call: the CAS runtime in this workspace is currently occupied by another ZCode session.',
  ],
  missing_session: [
    'The Codex As Subagent session gate blocked this tool call: the current ZCode session identity could not be confirmed.',
  ],
  unavailable: [
    'The Codex As Subagent session gate could not be evaluated (runtime storage unavailable).',
  ],
});

export function renderGateVeto(kind = 'occupied') {
  const lines = GATE_VETO_MESSAGES[kind] ?? GATE_VETO_MESSAGES.occupied;
  const retry = kind === 'occupied'
    ? 'The original tool call has NOT been executed. Wait for the other session\'s Codex work to finish (it will hand over automatically), then retry the same tool call.'
    : 'The original tool call has NOT been executed. Retry the same tool call; if the problem persists, start a new ZCode session.';
  return [...lines, retry].join('\n');
}

export default { name, wrap, renderGateVeto };
