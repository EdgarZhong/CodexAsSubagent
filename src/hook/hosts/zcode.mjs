export const name = 'zcode';

export function wrap(text) {
  return `<zcode-additional-context>\n${String(text ?? '')}\n</zcode-additional-context>`;
}

export default { name, wrap };
