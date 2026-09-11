import { hook } from './hook.mjs';
import { option } from '../shared/argv.mjs';

export async function drain(argv = [], options = {}) {
  // 默认 plain，但用户显式指定的 --host 必须优先，否则 drain --host=zcode 会静默退回 plain。
  const hasHost = option(argv, '--host', undefined) !== undefined;
  return await hook(hasHost ? [...argv] : ['--host', 'plain', ...argv], options);
}
