export const name = 'kimi-code';

export function wrap(text) {
  return `<kimi-code-additional-context>\n${String(text ?? '')}\n</kimi-code-additional-context>`;
}

export default { name, wrap };
