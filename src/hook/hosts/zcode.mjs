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

export default { name, wrap };
