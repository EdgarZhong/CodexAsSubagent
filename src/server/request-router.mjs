import { DomainError, ERROR_CODES, errorCode } from '../shared/errors.mjs';
import { publicProjection } from '../shared/protocol.mjs';
import { TerminalResult } from '../core/terminal-result.mjs';

const METHODS = Object.freeze({
  'runtime.spawn': 'spawn',
  'runtime.send': 'send',
  'runtime.steer': 'steer',
  'runtime.status': 'status',
  'runtime.wait': 'wait',
  'runtime.wait_many': 'waitMany',
  'runtime.interrupt': 'interrupt',
  'runtime.list_threads': 'listThreads',
  'runtime.read_thread': 'readThread',
  'runtime.models': 'models',
  'codex_spawn': 'spawn',
  'codex_send': 'send',
  'codex_steer': 'steer',
  'codex_status': 'status',
  'codex_wait': 'wait',
  'codex_wait_many': 'waitMany',
  'codex_interrupt': 'interrupt',
  'codex_list_threads': 'listThreads',
  'codex_read_thread': 'readThread',
  'codex_models': 'models',
});

function project(value) {
  if (value instanceof TerminalResult) return value.toJSON();
  if (Array.isArray(value)) return value.map(project);
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, entry] of Object.entries(value)) result[key] = project(entry);
    return publicProjection(result);
  }
  return value;
}

function internalParams(request) {
  return request?.params && typeof request.params === 'object' ? request.params : {};
}

export class RequestRouter {
  constructor({ runtime } = {}) {
    if (!runtime) throw new TypeError('RequestRouter requires a RuntimeManager.');
    this.runtime = runtime;
  }

  async dispatch(method, params, context) {
    if (method === 'delivery.ack') {
      return { acknowledged: Boolean(this.runtime.ackDeliveryId(params.deliveryId)) };
    }
    if (method === 'delivery.nack') {
      return { released: Boolean(this.runtime.releaseDeliveryId(params.deliveryId)) };
    }
    const operation = METHODS[method];
    if (!operation) throw new DomainError('method_not_found', `Unknown Runtime method: ${method}`);
    const ctx = { workspace: context?.workspace };
    switch (operation) {
      case 'spawn': return await this.runtime.spawn(ctx, params);
      case 'send': return await this.runtime.send(ctx, params);
      case 'steer': return await this.runtime.steer(ctx, params);
      case 'status': return await this.runtime.status(ctx, params.threadId);
      case 'wait': return await this.runtime.wait(ctx, params.threadId);
      case 'waitMany': return await this.runtime.waitMany(ctx, params.threads);
      case 'interrupt': return await this.runtime.interrupt(ctx, params.threadId);
      case 'listThreads': return await this.runtime.listThreads(ctx);
      case 'readThread': return await this.runtime.readThread(ctx, params.threadId);
      case 'models': return await this.runtime.models();
      default: throw new DomainError('method_not_found', `Unknown Runtime method: ${method}`);
    }
  }

  async handle(request) {
    if (!request || request.id === undefined || typeof request.method !== 'string') {
      return { id: request?.id ?? null, error: { code: 'invalid_request', message: 'Request id and method are required.' } };
    }
    try {
      const params = internalParams(request);
      const value = await this.dispatch(request.method, params, request.context);
      const deliveryId = (request.method === 'runtime.wait' || request.method === 'runtime.wait_many'
        || request.method === 'codex_wait' || request.method === 'codex_wait_many')
        ? this.runtime.deliveryIdFor(value)
        : null;
      return {
        id: request.id,
        result: project(value),
        ...(deliveryId ? { deliveryId } : {}),
      };
    } catch (error) {
      return {
        id: request.id,
        error: {
          code: errorCode(error),
          message: error?.message ?? 'Runtime request failed.',
        },
      };
    }
  }
}

export function createRequestRouter(options) {
  return new RequestRouter(options);
}
