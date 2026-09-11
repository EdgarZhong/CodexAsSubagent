import { randomUUID } from 'node:crypto';

import { WorkspaceGuard } from '../core/workspace-guard.mjs';
import { renderCompletions } from './render-completions.mjs';

async function writeOutput(output, text) {
  if (!output || typeof output.write !== 'function') return;
  if (output.write(`${text}\n`)) return;
  await new Promise((resolve) => output.once('drain', resolve));
}

function acknowledged(value) {
  return Boolean(value?.acknowledged ?? value);
}

export async function drainPending({
  workspace,
  host = 'plain',
  store,
  workspaceGuard = new WorkspaceGuard(),
  limit = 100,
  deliveryId = randomUUID(),
  now = new Date(),
  leaseMs,
  output = null,
  renderer = renderCompletions,
  context = {},
} = {}) {
  if (!store || typeof store.claimPendingHook !== 'function' || typeof store.ackDelivery !== 'function') {
    throw new TypeError('drainPending requires a CompletionStore.');
  }
  const canonicalWorkspace = await workspaceGuard.resolve(workspace);
  if (typeof store.requeueExpiredLeases === 'function') {
    store.requeueExpiredLeases({ now, ...(leaseMs === undefined ? {} : { leaseMs }) });
  }
  const completions = store.claimPendingHook({
    workspace: canonicalWorkspace,
    host,
    limit,
    deliveryId,
    now,
  });
  if (!Array.isArray(completions)) throw new TypeError('CompletionStore.claimPendingHook must return an array.');
  if (completions.length === 0) {
    return {
      workspace: canonicalWorkspace,
      host,
      deliveryId,
      completions: [],
      text: '',
      acknowledged: false,
      count: 0,
    };
  }
  const text = renderer(completions, host, context);
  await writeOutput(output, text);
  const ack = store.ackDelivery({ deliveryId, now });
  return {
    workspace: canonicalWorkspace,
    host,
    deliveryId,
    completions,
    text,
    acknowledged: acknowledged(ack),
    count: completions.length,
  };
}
