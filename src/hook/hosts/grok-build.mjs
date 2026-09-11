export const name = 'grok-build';

export function wrap(text) {
  return `<grok-build-additional-context>\n${String(text ?? '')}\n</grok-build-additional-context>`;
}

export default { name, wrap };
