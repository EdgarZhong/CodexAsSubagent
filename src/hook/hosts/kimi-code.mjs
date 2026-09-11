export const name = 'kimi-code';

const BLOCKABLE_EVENTS = new Set(['PreToolUse', 'Stop']);

export function wrap(text, completions, context = {}) {
  const body = String(text ?? '');
  if (!Array.isArray(completions) || completions.length === 0) return body;
  if (BLOCKABLE_EVENTS.has(context?.event)) {
    const retry = context.event === 'PreToolUse'
      ? 'The original tool call has NOT been executed. Process the Codex result, then retry the same tool call if it is still needed.'
      : 'Process the Codex result before ending this turn.';
    return [
      'A background Codex subagent completed before the current Kimi turn could continue.',
      retry,
      '<codex-completion>',
      body,
      '</codex-completion>',
    ].join('\n');
  }
  return ['<codex-completion>', body, '</codex-completion>'].join('\n');
}

export default { name, wrap };
