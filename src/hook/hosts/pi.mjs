export const name = 'pi';

export function wrap(text, completions) {
  void completions;
  return `<pi-additional-context>\n${String(text ?? '')}\n</pi-additional-context>`;
}

export default { name, wrap };
