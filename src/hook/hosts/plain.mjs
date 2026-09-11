export const name = 'plain';

export function wrap(text, completions) {
  void completions;
  return String(text ?? '');
}

export default { name, wrap };
