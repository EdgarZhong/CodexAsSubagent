export const name = 'zcode';

export function wrap(text, completions) {
  void completions;
  return `<zcode-additional-context>\n${String(text ?? '')}\n</zcode-additional-context>`;
}

export default { name, wrap };
