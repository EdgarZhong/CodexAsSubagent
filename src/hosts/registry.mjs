// Host Protocol Registry（实施规格 §3.2）。
//
// Host 是产品类型，由 Host integration 静态指定（--host=<host-id>），
// 不得从 cwd / session / 进程名 / 工具参数推断。getHostAdapter 对未知 host
// 抛 UnknownHostError——调用点必须在读取或修改任何 CAS 状态之前调用它，
// 保证未知 host 在任何 SQLite 访问前 fail closed。
import { UnknownHostError } from '../shared/errors.mjs';
import kimiCode from './kimi-code.mjs';
import zcode from './zcode.mjs';

export const KNOWN_HOST_IDS = Object.freeze([kimiCode.hostId, zcode.hostId]);

const ADAPTERS = new Map([
  [kimiCode.hostId, kimiCode],
  [zcode.hostId, zcode],
]);

export function getHostAdapter(hostId) {
  const adapter = typeof hostId === 'string' ? ADAPTERS.get(hostId) : undefined;
  if (!adapter) {
    throw new UnknownHostError(hostId, { knownHostIds: KNOWN_HOST_IDS });
  }
  return adapter;
}

export function isKnownHost(hostId) {
  return typeof hostId === 'string' && ADAPTERS.has(hostId);
}
