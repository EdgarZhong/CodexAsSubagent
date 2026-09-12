import { randomUUID } from 'node:crypto';

import { availableHosts, renderCompletions } from './render-completions.mjs';

async function writeOutput(output, text) {
  if (!output || typeof output.write !== 'function') return;
  if (output.write(`${text}\n`)) return;
  await new Promise((resolve) => output.once('drain', resolve));
}

function acknowledged(value) {
  return Boolean(value?.acknowledged ?? value);
}

// 默认渲染：host 在 envelope 注册表中 → 用该 host 的 envelope 形态；
// 否则原文输出（plain）。drain 等显式 CLI 对未知 envelope host 不应崩溃。
function defaultRenderer(completions, host, context) {
  if (availableHosts().includes(host)) return renderCompletions(completions, host, context);
  return renderCompletions(completions, 'plain', context);
}

// 统一 Mailbox drain 核心。入参即 DeliveryContext：{host, workspace, sessionId}，
// 其中 workspace 必须已经 WorkspaceGuard canonicalize（canonicalize 是 hook/drain
// CLI 层的职责，本核心不做二次 resolve）。V2 claim 谓词必须完整携带
// host + workspace + sessionId（workspace-only drain 已废除）。
export async function drainPending({
  host,
  workspace,
  sessionId,
  store,
  limit = 100,
  deliveryId = randomUUID(),
  now = new Date(),
  leaseMs,
  output = null,
  renderer = defaultRenderer,
  context = {},
} = {}) {
  if (typeof host !== 'string' || host.length === 0) {
    throw new TypeError('drainPending requires a host.');
  }
  if (typeof workspace !== 'string' || workspace.length === 0) {
    throw new TypeError('drainPending requires a canonical workspace.');
  }
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new TypeError('drainPending requires a sessionId; workspace-only drain is not allowed.');
  }
  if (!store || typeof store.claimPendingHook !== 'function' || typeof store.ackDelivery !== 'function') {
    throw new TypeError('drainPending requires a CompletionStore.');
  }
  if (typeof store.requeueExpiredLeases === 'function') {
    store.requeueExpiredLeases({ now, ...(leaseMs === undefined ? {} : { leaseMs }) });
  }
  const completions = store.claimPendingHook({
    workspace: workspace,
    host,
    sessionId,
    limit,
    deliveryId,
    now,
  });
  if (!Array.isArray(completions)) throw new TypeError('CompletionStore.claimPendingHook must return an array.');
  if (completions.length === 0) {
    return {
      workspace: workspace,
      host,
      sessionId,
      deliveryId,
      completions: [],
      text: '',
      acknowledged: false,
      count: 0,
    };
  }
  const text = renderer(completions, host, context);
  await writeOutput(output, text);
  const ack = store.ackDelivery({ deliveryId, now, host });
  return {
    workspace: workspace,
    host,
    sessionId,
    deliveryId,
    completions,
    text,
    acknowledged: acknowledged(ack),
    count: completions.length,
  };
}
