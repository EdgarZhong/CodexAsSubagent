export const name = 'pi';

export function wrap(text) {
  return `<pi-additional-context>\n${String(text ?? '')}\n</pi-additional-context>`;
}

export default { name, wrap };
