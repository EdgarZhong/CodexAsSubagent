import { EventEmitter } from 'node:events';

import { AppServerClient } from '../../../vendor/codex-supervisor-mcp/src/app-server-client.mjs';
import { EventStore } from '../../../vendor/codex-supervisor-mcp/src/event-store.mjs';
import { discoverCodexBinary, resolveAppServerArgs } from '../../shared/codex-runtime.mjs';
import { normalizeEvent } from './protocol-normalizer.mjs';

export const SUPERVISOR_ADAPTER_METHODS = Object.freeze([
  'startThread',
  'resumeThread',
  'startTurn',
  'steerTurn',
  'interruptTurn',
  'listThreads',
  'readThreadMetadata',
  'readRecentTurns',
  'listModels',
  'readEffectiveConfig',
  'subscribeRuntimeEvents',
  'close',
]);

function compact(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null),
  );
}

function workspaceOf(input = {}) {
  return input.workspace ?? input.cwd;
}

function emitSafeRuntimeEvent(emitter, event) {
  emitter.emit('event', normalizeEvent(event));
}

class BridgedEventStore extends EventStore {
  constructor(emitter, options) {
    super(options);
    this.emitter = emitter;
  }

  record(...args) {
    const event = super.record(...args);
    emitSafeRuntimeEvent(this.emitter, event);
    return event;
  }

  recordProcessFailure(...args) {
    return super.recordProcessFailure(...args);
  }
}

function bridgeSuppliedEventStore(eventStore, emitter) {
  if (!eventStore || typeof eventStore.record !== 'function' || eventStore.__codexAsSubagentBridged) {
    return;
  }
  const originalRecord = eventStore.record.bind(eventStore);
  eventStore.record = (...args) => {
    const event = originalRecord(...args);
    emitSafeRuntimeEvent(emitter, event);
    return event;
  };
  Object.defineProperty(eventStore, '__codexAsSubagentBridged', {
    value: true,
    configurable: true,
  });
}

function assertFunction(value, name) {
  if (typeof value !== 'function') {
    throw new TypeError(`Supervisor adapter method ${name} must be a function.`);
  }
}

export function assertSupervisorAdapter(adapter) {
  for (const method of SUPERVISOR_ADAPTER_METHODS) {
    assertFunction(adapter?.[method], method);
  }
  return adapter;
}

export function createFakeSupervisorAdapter(implementation = {}) {
  if (implementation === null || typeof implementation !== 'object' || Array.isArray(implementation)) {
    throw new TypeError('Fake supervisor adapter implementation must be an object.');
  }
  for (const [method, value] of Object.entries(implementation)) {
    if (!SUPERVISOR_ADAPTER_METHODS.includes(method)) {
      throw new TypeError(`Unknown supervisor adapter method ${method}.`);
    }
    assertFunction(value, method);
  }
  const unsupported = (method) => async () => {
    throw new Error(`Fake supervisor adapter method ${method} is not configured.`);
  };
  const adapter = {};
  for (const method of SUPERVISOR_ADAPTER_METHODS) {
    // close 是资源回收钩子，缺省必须是安全的 no-op，否则测试里的 fake adapter
    // 会在 runtime.close() 时抛出无关错误。
    adapter[method] = method === 'close'
      ? (implementation[method] ?? (async () => {}))
      : (implementation[method] ?? unsupported(method));
  }
  return assertSupervisorAdapter(adapter);
}

export function createSupervisorAdapter(options = {}) {
  if (options.adapter) {
    return assertSupervisorAdapter(options.adapter);
  }

  const runtimeEvents = new EventEmitter();
  const suppliedClient = options.client ?? options.appServerClient;
  const suppliedEventStore = options.eventStore ?? suppliedClient?.eventStore;
  const eventStore = suppliedEventStore ?? new BridgedEventStore(runtimeEvents, options.eventStoreOptions);
  // 设计 6.4：缺省 CODEX_BIN 时必须自动发现为绝对路径。GUI Host 拉起的进程
  // PATH 可能不含用户安装路径，仅靠 vendor 默认的裸 "codex" 会启动失败。
  const clientOptions = options.clientOptions ?? {};
  const environment = options.env ?? process.env;
  const resolvedCommand = clientOptions.command
    ?? options.command
    ?? (typeof environment.CODEX_BIN === 'string' && environment.CODEX_BIN.length > 0
      ? environment.CODEX_BIN
      : discoverCodexBinary({ env: environment }) ?? 'codex');
  const client = suppliedClient ?? new AppServerClient({
    ...clientOptions,
    command: resolvedCommand,
    args: clientOptions.args ?? resolveAppServerArgs(environment),
    env: environment,
    eventStore,
  });

  if (suppliedEventStore?.on) {
    const eventHandler = (event) => emitSafeRuntimeEvent(runtimeEvents, event);
    suppliedEventStore.on('event', eventHandler);
  } else if (suppliedEventStore) {
    bridgeSuppliedEventStore(suppliedEventStore, runtimeEvents);
  }
  if (typeof options.subscribeRuntimeEvents === 'function') {
    options.subscribeRuntimeEvents((event) => emitSafeRuntimeEvent(runtimeEvents, event));
  }

  const request = async (method, params) => await client.request(method, params);

  const adapter = {
    async startThread(input = {}) {
      return await request('thread/start', compact({
        cwd: workspaceOf(input),
        model: input.model,
        approvalPolicy: input.approvalPolicy,
        sandbox: input.sandbox,
      }));
    },

    async resumeThread(input = {}) {
      return await request('thread/resume', compact({
        threadId: input.threadId,
        cwd: workspaceOf(input),
        model: input.model,
        approvalPolicy: input.approvalPolicy,
        sandbox: input.sandbox,
      }));
    },

    async startTurn(input = {}) {
      const result = await request('turn/start', compact({
        threadId: input.threadId,
        input: [{ type: 'text', text: input.prompt ?? '' }],
        cwd: workspaceOf(input),
        model: input.model,
        effort: input.effort,
        approvalPolicy: input.approvalPolicy,
        sandboxPolicy: input.sandboxPolicy,
      }));
      return {
        threadId: input.threadId,
        turnId: result?.turn?.id ?? null,
        turn: result?.turn ?? null,
      };
    },

    async steerTurn(input = {}) {
      const result = await request('turn/steer', compact({
        threadId: input.threadId,
        input: [{ type: 'text', text: input.prompt ?? '' }],
        expectedTurnId: input.expectedTurnId,
      }));
      return {
        threadId: input.threadId,
        turnId: result?.turnId ?? input.expectedTurnId ?? null,
      };
    },

    async interruptTurn(input = {}) {
      await request('turn/interrupt', compact({
        threadId: input.threadId,
        turnId: input.turnId,
      }));
      return { threadId: input.threadId, interrupted: true };
    },

    async listThreads(input = {}) {
      const result = await request('thread/list', compact({
        limit: input.limit,
        cursor: input.cursor,
        searchTerm: input.searchTerm,
        cwd: workspaceOf(input),
      }));
      return {
        threads: result?.data ?? result?.threads ?? [],
        nextCursor: result?.nextCursor ?? null,
      };
    },

    async readThreadMetadata(threadId) {
      const result = await request('thread/read', {
        threadId,
        includeTurns: false,
      });
      return result?.thread ?? null;
    },

    async readRecentTurns(threadId, optionsForRead = {}) {
      const { turnId } = optionsForRead;
      const result = await request('thread/read', {
        threadId,
        includeTurns: true,
      });
      const turns = result?.thread?.turns ?? result?.turns ?? [];
      return {
        turns: turnId === undefined ? turns : turns.filter((turn) => turn?.id === turnId || turn?.turnId === turnId),
        ...(result?.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
      };
    },

    async listModels() {
      const result = await request('model/list', {});
      return result?.data ?? result?.models ?? [];
    },

    async readEffectiveConfig() {
      const result = await request('config/read', {});
      return result?.config ?? result ?? {};
    },

    subscribeRuntimeEvents(listener) {
      assertFunction(listener, 'runtime event listener');
      runtimeEvents.on('event', listener);
      return () => runtimeEvents.off('event', listener);
    },

    // 关闭 Runtime 时必须真正终止 app-server 子进程：否则子进程的 stdio 句柄会
    // 让 Node 事件循环无法自然退出，Runtime Server 会变成无法回收的孤儿进程。
    async close() {
      if (typeof client.stop === 'function') await client.stop();
    },
  };

  return assertSupervisorAdapter(adapter);
}
