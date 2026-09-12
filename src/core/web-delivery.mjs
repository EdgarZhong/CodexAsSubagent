import { randomUUID } from 'node:crypto';
import { readdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';

import { renderCompletions } from '../hook/render-completions.mjs';
import { ERROR_CODES } from '../shared/errors.mjs';
import {
  KIMI_WEB_MODEL,
  KimiWebClient,
  canonicalWorkspace,
  instanceBaseUrl,
  readInstanceFiles,
  resolveKimiCodeHome,
  sessionWorkspace,
} from './kimi-web-client.mjs';

// V2 Kimi Web 主动回流（适配说明 §四）：Runtime 内部事件驱动 delivery。
// 由 CompletionRouter 在 terminal COMMIT 之后 fire-and-forget 调用：
//
//   pending completion (host=kimi-code)
//   → 原子 claim（pending → claimed_hook, deliveryId `web-<uuid>`）
//   → Kimi Server API /sessions/{completion.sessionId}/...
//   → 成功 ACK / 确定失败 NACK（→ pending）/ 进程异常靠 delivery lease 过期回退
//
// 硬约束：
// - Mailbox durable COMMIT 先于任何外部 Web API side effect（本函数只会在
//   insertCompletionFirst 事务成功后被调用，且 claim 先于任何 HTTP 请求）。
// - `claimed_direct`（Direct Wait reservation）永不 web 发送。
// - 不读取/建立/切换/清除 current_session；不 acquire/release Thread Hold；
//   不触碰 current_sessions、thread_holds、host_presence；无定时器/轮询/常驻进程。
// - 任何 store/网络异常都不得向上抛出中断 terminal 路径：全部捕获并记 logger。

export const WEB_DELIVERY_HOST = 'kimi-code';

function requiredString(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${name} must be a non-empty string.`);
  return value;
}

function asNow(value) {
  return typeof value === 'function' ? value() : (value ?? new Date());
}

function skipped(reason, details = {}) {
  return { status: 'skipped', delivered: false, reason, ...details };
}

export function createWebDelivery({
  store,
  clientFactory,
  kimiCodeHome,
  fetchImpl = globalThis.fetch,
  resolveWorkspace = realpath,
  readDir = readdir,
  readJsonFile = readFile,
  logger = null,
  now = () => new Date(),
  renderer = (completions) => renderCompletions(completions, 'plain'),
} = {}) {
  if (!store
    || typeof store.claimPendingHook !== 'function'
    || typeof store.ackDelivery !== 'function'
    || typeof store.nackDelivery !== 'function') {
    throw new TypeError('createWebDelivery requires a CompletionStore with claimPendingHook/ackDelivery/nackDelivery.');
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('createWebDelivery requires fetchImpl.');
  if (typeof renderer !== 'function') throw new TypeError('createWebDelivery requires a renderer.');
  const home = resolveKimiCodeHome(kimiCodeHome === undefined ? {} : { kimiCodeHome });
  const createClient = clientFactory ?? (({ baseUrl, token, sessionId }) => (
    new KimiWebClient({ baseUrl, token, sessionId, fetchImpl })
  ));

  async function requeue(deliveryId, reason, details = {}) {
    // 确定失败 → NACK 回 pending（Mailbox 记录不丢失，等待恢复途径）。
    try {
      store.nackDelivery({ host: WEB_DELIVERY_HOST, deliveryId, now: asNow(now) });
    } catch (error) {
      logger?.error?.('web_delivery.nack_failed', { deliveryId, reason, error: error?.message ?? String(error) });
    }
    logger?.info?.(`web_delivery.${reason}`, { deliveryId, ...details });
    return { status: 'nacked', delivered: false, reason, deliveryId, ...details };
  }

  async function attemptWebDelivery({ completion } = {}) {
    try {
      // 1. 防御性再校验（调用方 CompletionRouter 保证，这里不信任快照之外的字段）。
      if (completion?.host !== WEB_DELIVERY_HOST) return skipped('unsupported_host', { host: completion?.host ?? null });
      if (completion.deliveryState !== 'pending') {
        return skipped('not_pending', { deliveryState: completion.deliveryState ?? null });
      }
      const workspace = requiredString(completion.workspace, 'completion.workspace');
      const sessionId = requiredString(completion.sessionId, 'completion.sessionId');

      // 2. 单 active Server 假设（适配说明 §四）：计数而非路由。
      const instances = await readInstanceFiles(home, { readDir, readJsonFile });
      let token = null;
      try {
        token = (await readJsonFile(join(home, 'server.token'), 'utf8')).trim() || null;
      } catch {
        token = null;
      }
      if (instances.length === 0 || !token) {
        logger?.debug?.('web_delivery.server_unavailable', {
          host: WEB_DELIVERY_HOST,
          workspace,
          sessionId,
          instances: instances.length,
          token: Boolean(token),
        });
        return skipped('server_unavailable', { workspace, sessionId });
      }
      if (instances.length > 1) {
        logger?.warn?.('web_delivery.multiple_active_host_servers', {
          code: ERROR_CODES.MULTIPLE_ACTIVE_HOST_SERVERS,
          host: WEB_DELIVERY_HOST,
          workspace,
          sessionId,
          instances: instances.length,
        });
        return skipped(ERROR_CODES.MULTIPLE_ACTIVE_HOST_SERVERS, { workspace, sessionId });
      }

      // 3. 原子 claim：完整谓词 host+workspace+session+pending（SQL WHERE 内生效）。
      //    claim 不到（已被消费/已不是 pending）→ 静默返回。
      const deliveryId = `web-${randomUUID()}`;
      const claimedRows = store.claimPendingHook({
        host: WEB_DELIVERY_HOST,
        workspace,
        sessionId,
        limit: 1,
        deliveryId,
        now: asNow(now),
      });
      const claimed = Array.isArray(claimedRows) ? claimedRows[0] : null;
      if (!claimed) return skipped('no_pending_completion', { deliveryId, workspace, sessionId });

      const baseUrl = instanceBaseUrl(instances[0].value);
      if (!baseUrl) {
        return requeue(deliveryId, 'instance_base_url_missing', {
          completionId: claimed.completionId,
          sessionId: claimed.sessionId,
        });
      }
      const client = createClient({ baseUrl, token, sessionId: claimed.sessionId, instance: instances[0].value });

      // 4. Session 归属校验：GET session 的 workspace 必须与 completion.workspace
      //    canonical 一致；不匹配 → NACK 回 pending（fail closed，不投递）。
      let session = null;
      try {
        const result = await client.readSession({ sessionId: claimed.sessionId });
        session = result?.data ?? null;
      } catch (error) {
        return requeue(deliveryId, 'session_lookup_failed', {
          completionId: claimed.completionId,
          sessionId: claimed.sessionId,
          error: error?.message ?? String(error),
        });
      }
      const returnedId = session?.id ?? session?.session_id;
      const returnedWorkspace = sessionWorkspace(session);
      let returnedCanonical = null;
      if (returnedId === claimed.sessionId && returnedWorkspace) {
        try {
          returnedCanonical = await canonicalWorkspace(returnedWorkspace, resolveWorkspace);
        } catch {
          returnedCanonical = null;
        }
      }
      if (returnedId !== claimed.sessionId || returnedCanonical !== workspace) {
        return requeue(deliveryId, 'session_workspace_mismatch', {
          completionId: claimed.completionId,
          sessionId: claimed.sessionId,
          expected: workspace,
          actual: returnedCanonical,
        });
      }

      // 5. 投递：POST /api/v1/sessions/{session_id}/prompts（active 时对自身 prompt :steer）。
      let submitted;
      try {
        submitted = await client.submitCompletion({
          sessionId: claimed.sessionId,
          completionId: claimed.completionId,
          text: renderer([claimed]),
          model: KIMI_WEB_MODEL,
        });
      } catch (error) {
        return requeue(deliveryId, 'submit_rejected', {
          completionId: claimed.completionId,
          sessionId: claimed.sessionId,
          error: error?.message ?? String(error),
        });
      }

      // 6. 成功 → ACK。
      const ack = store.ackDelivery({ host: WEB_DELIVERY_HOST, deliveryId, now: asNow(now) });
      if (!ack?.acknowledged) throw new Error('Web delivery was accepted but completion ACK failed.');
      logger?.info?.('web_delivery.delivered', {
        deliveryId,
        completionId: claimed.completionId,
        sessionId: claimed.sessionId,
        promptId: submitted?.promptId ?? null,
        steered: Boolean(submitted?.steered),
      });
      return {
        status: 'delivered',
        delivered: true,
        deliveryId,
        completionId: claimed.completionId,
        sessionId: claimed.sessionId,
        promptId: submitted?.promptId ?? null,
        steered: Boolean(submitted?.steered),
      };
    } catch (error) {
      // store/网络等任何异常都不得向上抛出中断 terminal 路径；
      // 已 claim 未回退的记录由 delivery lease 过期机制恢复为 pending。
      logger?.error?.('web_delivery.unexpected_failure', {
        completionId: completion?.completionId ?? null,
        error: error?.message ?? String(error),
      });
      return {
        status: 'error',
        delivered: false,
        reason: 'unexpected_failure',
        message: error?.message ?? String(error),
      };
    }
  }

  return { attemptWebDelivery, host: WEB_DELIVERY_HOST };
}
