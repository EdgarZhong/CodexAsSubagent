export const name = 'claude-code';

export function wrap(text) {
  return `<claude-code-additional-context>\n${String(text ?? '')}\n</claude-code-additional-context>`;
}

export default { name, wrap };
