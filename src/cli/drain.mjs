import { hook } from './hook.mjs';

export async function drain(argv = [], options = {}) {
  return await hook(['--host', 'plain', ...argv], options);
}
