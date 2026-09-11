export const name = 'plain';

export function wrap(text) {
  return String(text ?? '');
}

export default { name, wrap };
