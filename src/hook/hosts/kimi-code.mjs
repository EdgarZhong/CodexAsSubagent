export const name = 'kimi-code';

const BLOCKABLE_EVENTS = new Set(['PreToolUse', 'Stop']);

export function wrap(text, completions, context = {}) {
  const body = String(text ?? '');
  if (!Array.isArray(completions) || completions.length === 0) return body;
  if (BLOCKABLE_EVENTS.has(context?.event)) {
    const intro = context.event === 'PreToolUse'
      ? 'A background Codex subagent assigned to this Kimi session completed and delivered its result.'
      : 'A background Codex subagent assigned to this Kimi session completed before this turn ended.';
    const retry = context.event === 'PreToolUse'
      ? 'The original tool call has NOT been executed. Process the Codex result, then retry the same tool call if it is still needed.'
      : 'Process the Codex result before ending this turn.';
    return [
      intro,
      retry,
      '<codex-completion>',
      body,
      '</codex-completion>',
    ].join('\n');
  }
  return ['<codex-completion>', body, '</codex-completion>'].join('\n');
}

// CAS Session Gate veto 文案（串投修复说明 §三：门禁 veto 时当前工具未执行，
// 冲突解除后重试同一工具）。kind:
//   - 'occupied': current_session 属于其他仍有 active Execution 的 session，
//     或同一 workspace 出现多个 active session（fail closed）。
//   - 'missing_session': PreToolUse payload 缺 session_id，无法确认会话身份。
//   - 'unavailable': gate 求值异常（store 打不开等），fail closed。
const GATE_VETO_MESSAGES = Object.freeze({
  occupied: [
    'The Codex As Subagent session gate blocked this tool call: the CAS runtime in this workspace is currently occupied by another Kimi session.',
  ],
  missing_session: [
    'The Codex As Subagent session gate blocked this tool call: the current Kimi session identity could not be confirmed.',
  ],
  unavailable: [
    'The Codex As Subagent session gate could not be evaluated (runtime storage unavailable).',
  ],
});

export function renderGateVeto(kind = 'occupied') {
  const lines = GATE_VETO_MESSAGES[kind] ?? GATE_VETO_MESSAGES.occupied;
  const retry = kind === 'occupied'
    ? 'The original tool call has NOT been executed. Wait for the other session\'s Codex work to finish (it will hand over automatically), then retry the same tool call.'
    : 'The original tool call has NOT been executed. Retry the same tool call; if the problem persists, start a new Kimi session.';
  return [...lines, retry].join('\n');
}

export default { name, wrap, renderGateVeto };
