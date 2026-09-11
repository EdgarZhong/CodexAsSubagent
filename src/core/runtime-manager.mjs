import { randomUUID } from 'node:crypto';

import { createHistoryAdapter } from '../adapters/supervisor/history-adapter.mjs';
import {
  DomainError,
  ERROR_CODES,
  HistoryUnavailableError,
  SupervisorUnavailableError,
  ThreadWorkspaceMismatchError,
  WorkspaceUnavailableError,
  errorCode,
} from '../shared/errors.mjs';
import {
  MAX_ASSISTANT_MESSAGE_CHARS,
  MAX_CHANGED_FILES,
  publicProjection,
  summarizeChangedFiles,
  truncateAssistantMessage,
} from '../shared/protocol.mjs';
import { ModelService } from './model-service.mjs';
import { TerminalResult } from './terminal-result.mjs';
import { WorkspaceGuard } from './workspace-guard.mjs';

const DEFAULT_WAIT_TIMEOUT_MS = 500_000;
const MAX_THREADS = 25;
const MAX_ACTION_CHARS = 200;
const MAX_PREVIEW_CHARS = 600;
const TERMINAL_TYPES = new Set([
  'turn.completed',
  'turn.failed',
  'turn.interrupted',
  'supervisor.process.failed',
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredThreadId(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new DomainError(ERROR_CODES.THREAD_NOT_FOUND, 'A non-empty threadId is required.');
  }
  return value;
}

function terminalType(value) {
  return typeof value?.type === 'string' ? value.type.replaceAll('/', '.').toLowerCase() : '';
}

function terminalStatus(value) {
  const type = terminalType(value);
  if (type === 'turn.completed') return 'completed';
  if (type === 'turn.failed' || type === 'supervisor.process.failed') return 'failed';
  if (type === 'turn.interrupted') return 'interrupted';
  return typeof value?.status === 'string' ? value.status : null;
}

function isoNow(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return new Date().toISOString();
  return date.toISOString();
}

function safeText(value, limit) {
  return typeof value === 'string' ? value.slice(0, limit) : '';
}

function publicThread(thread) {
  if (!isRecord(thread)) return null;
  const threadId = typeof thread.id === 'string' ? thread.id : thread.threadId;
  if (typeof threadId !== 'string' || threadId.length === 0) return null;
  const result = { threadId };
  for (const key of ['title', 'status', 'createdAt', 'updatedAt']) {
    if (typeof thread[key] === 'string' && thread[key].length > 0) result[key] = thread[key];
  }
  return result;
}

function changesFromTurns(turns) {
  const files = [];
  for (const turn of turns) {
    if (Array.isArray(turn?.changes?.files)) files.push(...turn.changes.files);
  }
  return summarizeChangedFiles(files);
}

function asDomainError(error, fallbackCode = ERROR_CODES.SUPERVISOR_UNAVAILABLE, fallbackMessage = 'Supervisor operation failed.') {
  if (error?.code) return error;
  return new DomainError(fallbackCode, fallbackMessage, { cause: error });
}

function completionResult(completion) {
  if (!completion?.payload || !isRecord(completion.payload)) return null;
  try {
    return new TerminalResult(completion.payload);
  } catch {
    return null;
  }
}

export class RuntimeManager {
  constructor({
    adapter,
    workspaceGuard = new WorkspaceGuard(),
    modelService = new ModelService({ adapter }),
    executionStore,
    completionStore,
    completionRouter,
    historyAdapter = null,
    waitTimeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
    clock = () => new Date(),
    ownerInstanceId = randomUUID(),
  } = {}) {
    if (!adapter || typeof adapter.startThread !== 'function') {
      throw new TypeError('RuntimeManager requires a Supervisor adapter.');
    }
    if (!executionStore || typeof executionStore.createExecution !== 'function') {
      throw new TypeError('RuntimeManager requires an ExecutionStore.');
    }
    if (!completionStore || typeof completionStore.listCompletions !== 'function') {
      throw new TypeError('RuntimeManager requires a CompletionStore.');
    }
    if (!completionRouter || typeof completionRouter.onTerminal !== 'function') {
      throw new TypeError('RuntimeManager requires a CompletionRouter.');
    }
    if (!Number.isFinite(waitTimeoutMs) || waitTimeoutMs < 0) {
      throw new TypeError('waitTimeoutMs must be a non-negative number.');
    }

    this.adapter = adapter;
    this.workspaceGuard = workspaceGuard;
    this.modelService = modelService;
    this.executionStore = executionStore;
    this.completionStore = completionStore;
    this.completionRouter = completionRouter;
    this.historyAdapter = historyAdapter ?? createHistoryAdapter(adapter);
    this.waitTimeoutMs = waitTimeoutMs;
    this.clock = clock;
    this.ownerInstanceId = ownerInstanceId;
    this.states = new Map();
    this.settings = new Map();
    this.waiters = new Map();
    this.pendingTerminalEvents = new Map();
    this.deliveryIds = new WeakMap();
    this.locks = new Map();
    this.closed = false;
    this.stateChangeListeners = new Set();
    this.unsubscribe = typeof adapter.subscribeRuntimeEvents === 'function'
      ? adapter.subscribeRuntimeEvents((event) => this.#onRuntimeEvent(event))
      : null;
  }

  // Runtime Server 用它重算 idle：execution 在异步 terminal 事件里被移除后，
  // 没有任何请求边界会再触发 idle 判定，必须由状态变更主动通知。
  subscribeStateChanges(listener) {
    if (typeof listener !== 'function') throw new TypeError('subscribeStateChanges requires a listener.');
    this.stateChangeListeners.add(listener);
    return () => this.stateChangeListeners.delete(listener);
  }

  #emitStateChange() {
    for (const listener of [...this.stateChangeListeners]) {
      try {
        listener();
      } catch {
        // 空闲判定失败不得影响运行时主流程。
      }
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (typeof this.unsubscribe === 'function') this.unsubscribe();
    this.stateChangeListeners.clear();
    for (const waiters of this.waiters.values()) {
      for (const waiter of waiters) clearTimeout(waiter.timer);
    }
    this.waiters.clear();
    // 终止 supervisor 子进程，避免其 stdio 句柄持有事件循环导致进程无法退出。
    if (typeof this.adapter?.close === 'function') {
      try {
        await this.adapter.close();
      } catch {
        // 关闭必须尽力而为，不能因 supervisor 停止失败而阻塞 Server 退出。
      }
    }
  }

  async #workspace(ctx) {
    if (!ctx || typeof ctx.workspace !== 'string' || ctx.workspace.length === 0) {
      throw new WorkspaceUnavailableError();
    }
    return await this.workspaceGuard.resolve(ctx.workspace);
  }

  async #thread(ctx, threadId) {
    const id = requiredThreadId(threadId);
    const workspace = await this.#workspace(ctx);
    let metadata;
    try {
      metadata = await this.adapter.readThreadMetadata(id);
    } catch (error) {
      throw asDomainError(error, ERROR_CODES.THREAD_NOT_FOUND, `Thread ${id} was not found.`);
    }
    if (!metadata) {
      throw new DomainError(ERROR_CODES.THREAD_NOT_FOUND, `Thread ${id} was not found.`);
    }
    try {
      await this.workspaceGuard.assertThreadWorkspace(metadata, workspace);
    } catch (error) {
      if (error instanceof ThreadWorkspaceMismatchError || error?.code === ERROR_CODES.THREAD_WORKSPACE_MISMATCH) {
        throw error;
      }
      throw new ThreadWorkspaceMismatchError();
    }
    return { threadId: id, workspace, metadata };
  }

  async #withLock(threadId, operation) {
    const previous = this.locks.get(threadId) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    this.locks.set(threadId, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(threadId) === current) this.locks.delete(threadId);
    }
  }

  #state(threadId, execution = null) {
    let state = this.states.get(threadId);
    if (!state) {
      state = {
        threadId,
        status: execution ? 'running' : null,
        startedAt: execution?.startedAt ?? null,
        lastActivityAt: execution?.lastActivityAt ?? null,
        latestAction: '',
        latestAssistantPreview: '',
        filesChanged: 0,
      };
      this.states.set(threadId, state);
    }
    if (execution) {
      state.startedAt ??= execution.startedAt;
      state.lastActivityAt ??= execution.lastActivityAt;
      if (!state.status || state.status === 'completed' || state.status === 'failed' || state.status === 'interrupted') {
        state.status = 'running';
      }
    }
    return state;
  }

  #publicStatus(threadId, execution = null, metadata = null, workspace = undefined) {
    const state = this.#state(threadId, execution);
    const now = Date.parse(isoNow(this.clock));
    const lastActivity = Date.parse(state.lastActivityAt ?? execution?.lastActivityAt ?? metadata?.updatedAt ?? isoNow(this.clock));
    const idleForSec = Number.isFinite(lastActivity)
      ? Math.max(0, Math.floor((now - lastActivity) / 1000))
      : 0;
    const status = state.status ?? (execution ? 'running' : metadata?.status ?? 'idle');
    const snapshot = {
      threadId,
      status,
      ...(execution?.model ? { model: execution.model } : {}),
      ...(execution?.effort ? { effort: execution.effort } : {}),
      ...(state.startedAt ? { startedAt: state.startedAt } : {}),
      ...(state.lastActivityAt ? { lastActivityAt: state.lastActivityAt } : {}),
      idleForSec,
      latestAction: safeText(state.latestAction, MAX_ACTION_CHARS),
      latestAssistantPreview: safeText(state.latestAssistantPreview, MAX_PREVIEW_CHARS),
      filesChanged: Number.isSafeInteger(state.filesChanged) ? state.filesChanged : 0,
    };
    // Keep this explicit: workspace is context used for the lookup only.
    void workspace;
    return publicProjection(snapshot);
  }

  #rememberDelivery(result, deliveryId) {
    if (result && typeof result === 'object' && typeof deliveryId === 'string') {
      this.deliveryIds.set(result, deliveryId);
    }
    return result;
  }

  #completionFor(threadId, workspace, deliveryId = undefined) {
    const rows = this.completionStore.listCompletions({ workspace });
    return rows.find((entry) => entry.threadId === threadId
      && (deliveryId === undefined
        ? entry.deliveryState === 'claimed_direct' || entry.deliveryState === 'pending'
        : entry.deliveryId === deliveryId)) ?? null;
  }

  #notify(threadId) {
    const waiters = this.waiters.get(threadId);
    if (!waiters) return;
    for (const waiter of [...waiters]) waiter.check();
  }

  #onRuntimeEvent(event) {
    if (this.closed || !isRecord(event)) return;
    const threadId = typeof event.threadId === 'string' && event.threadId.length > 0
      ? event.threadId : null;
    if (!threadId) return;
    const execution = this.executionStore.getExecution(threadId);
    const state = this.#state(threadId, execution);
    state.lastActivityAt = typeof event.receivedAt === 'string' ? event.receivedAt : isoNow(this.clock);
    const type = terminalType(event);
    const action = event.latestAction ?? event.action ?? event.command ?? event.activity;
    if (typeof action === 'string') state.latestAction = safeText(action, MAX_ACTION_CHARS);
    const message = event.assistantMessage ?? event.latestAssistantPreview ?? event.text;
    if (typeof message === 'string') {
      state.latestAssistantPreview = truncateAssistantMessage(message).slice(0, MAX_PREVIEW_CHARS);
    }
    if (Number.isSafeInteger(event.changes?.filesChanged)) state.filesChanged = event.changes.filesChanged;

    if (TERMINAL_TYPES.has(type)) {
      if (!execution) {
        this.pendingTerminalEvents.set(threadId, event);
        return;
      }
      try {
        const completion = this.completionRouter.onTerminal(event);
        if (completion) {
          state.status = terminalStatus(event) ?? completion.terminalStatus ?? 'failed';
          this.#notify(threadId);
        }
      } catch {
        // A malformed or unverifiable terminal event must not tear down the runtime.
      }
      this.#emitStateChange();
      return;
    }
    if (type === 'thread.status.changed' && typeof event.status === 'string') {
      state.status = event.status;
    }
  }

  #drainPendingTerminalEvent(threadId) {
    const event = this.pendingTerminalEvents.get(threadId);
    if (!event) return;
    this.pendingTerminalEvents.delete(threadId);
    this.#onRuntimeEvent(event);
  }

  async spawn(ctx, input = {}) {
    const workspace = await this.#workspace(ctx);
    const prompt = typeof input.prompt === 'string' ? input.prompt : '';
    const resolved = await this.modelService.resolveSpawn(input.model, input.effort);
    let started;
    try {
      started = await this.adapter.startThread({ workspace, model: resolved.model, effort: resolved.effort });
    } catch (error) {
      throw asDomainError(error);
    }
    const thread = started?.thread ?? started;
    const threadId = typeof thread?.id === 'string' ? thread.id : started?.threadId;
    if (!threadId) throw new SupervisorUnavailableError('Supervisor returned no thread id.');
    if (thread?.cwd || thread?.workingDirectory || thread?.workspace) {
      await this.workspaceGuard.assertThreadWorkspace(thread, workspace);
    }
    let turn;
    try {
      turn = await this.adapter.startTurn({
        threadId,
        prompt,
        workspace,
        model: resolved.model,
        effort: resolved.effort,
      });
    } catch (error) {
      throw asDomainError(error);
    }
    const turnId = turn?.turnId ?? turn?.turn?.id;
    if (typeof turnId !== 'string' || turnId.length === 0) {
      throw new SupervisorUnavailableError('Supervisor returned no turn id.');
    }
    const startedAt = isoNow(this.clock);
    this.executionStore.createExecution({
      threadId,
      turnId,
      workspace,
      ownerInstanceId: this.ownerInstanceId,
      model: resolved.model,
      effort: resolved.effort,
      startedAt,
      lastActivityAt: startedAt,
    });
    this.#drainPendingTerminalEvent(threadId);
    this.settings.set(threadId, resolved);
    const state = this.#state(threadId);
    state.status = 'running';
    state.startedAt = startedAt;
    state.lastActivityAt = startedAt;
    this.#emitStateChange();
    return {
      threadId,
      status: 'running',
      model: resolved.model,
      effort: resolved.effort,
      startedAt,
    };
  }

  async send(ctx, input = {}) {
    const target = await this.#thread(ctx, input.threadId);
    return await this.#withLock(target.threadId, async () => {
      const current = this.executionStore.getExecution(target.threadId);
      if (current) throw new DomainError(ERROR_CODES.THREAD_BUSY, 'Thread already has an active turn.');
      const persisted = this.settings.get(target.threadId) ?? {
        model: target.metadata.model,
        effort: target.metadata.effort,
      };
      let resolved;
      try {
        resolved = await this.modelService.resolveSpawn(
          input.model ?? persisted.model,
          input.effort ?? persisted.effort,
        );
      } catch (error) {
        throw asDomainError(error, errorCode(error));
      }
      const resumed = await this.adapter.resumeThread({
        threadId: target.threadId,
        workspace: target.workspace,
        model: resolved.model,
        effort: resolved.effort,
      });
      if (resumed === null || resumed === undefined || resumed?.thread === null) {
        throw new DomainError(ERROR_CODES.THREAD_NOT_FOUND, `Thread ${target.threadId} was not found.`);
      }
      const turn = await this.adapter.startTurn({
        threadId: target.threadId,
        prompt: typeof input.prompt === 'string' ? input.prompt : '',
        workspace: target.workspace,
        model: resolved.model,
        effort: resolved.effort,
      });
      const turnId = turn?.turnId ?? turn?.turn?.id;
      if (!turnId) throw new SupervisorUnavailableError('Supervisor returned no turn id.');
      const startedAt = isoNow(this.clock);
      this.executionStore.createExecution({
        threadId: target.threadId,
        turnId,
        workspace: target.workspace,
        ownerInstanceId: this.ownerInstanceId,
        model: resolved.model,
        effort: resolved.effort,
        startedAt,
        lastActivityAt: startedAt,
      });
      this.#drainPendingTerminalEvent(target.threadId);
      this.settings.set(target.threadId, resolved);
      const state = this.#state(target.threadId);
      state.status = 'running';
      state.startedAt = startedAt;
      state.lastActivityAt = startedAt;
      this.#emitStateChange();
      return {
        threadId: target.threadId,
        status: 'running',
        model: resolved.model,
        effort: resolved.effort,
        startedAt,
      };
    });
  }

  async steer(ctx, input = {}) {
    const target = await this.#thread(ctx, input.threadId);
    return await this.#withLock(target.threadId, async () => {
      const execution = this.executionStore.getExecution(target.threadId);
      if (!execution) throw new DomainError(ERROR_CODES.NO_ACTIVE_TURN, 'Thread has no active turn.');
      await this.adapter.steerTurn({
        threadId: target.threadId,
        prompt: typeof input.prompt === 'string' ? input.prompt : '',
        expectedTurnId: execution.turnId,
      });
      const state = this.#state(target.threadId, execution);
      state.lastActivityAt = isoNow(this.clock);
      return { threadId: target.threadId, accepted: true, status: 'running' };
    });
  }

  async interrupt(ctx, threadId) {
    const target = await this.#thread(ctx, threadId);
    return await this.#withLock(target.threadId, async () => {
      const execution = this.executionStore.getExecution(target.threadId);
      if (!execution) throw new DomainError(ERROR_CODES.NO_ACTIVE_TURN, 'Thread has no active turn.');
      await this.adapter.interruptTurn({ threadId: target.threadId, turnId: execution.turnId });
      return {
        threadId: target.threadId,
        interruptRequested: true,
        requestedAt: isoNow(this.clock),
      };
    });
  }

  async status(ctx, threadId) {
    const target = await this.#thread(ctx, threadId);
    const execution = this.executionStore.getExecution(target.threadId);
    const completion = !execution
      ? this.completionStore.listCompletions({ workspace: target.workspace })
        .find((entry) => entry.threadId === target.threadId)
      : null;
    if (completion) {
      const result = completionResult(completion);
      return result ? { threadId: target.threadId, status: result.toJSON().status } : this.#publicStatus(target.threadId, null, target.metadata);
    }
    return this.#publicStatus(target.threadId, execution, target.metadata);
  }

  async #reserve(threadId, workspace, deliveryId) {
    const reservation = this.executionStore.reserveDirect({
      threadId,
      workspace,
      reservationId: deliveryId,
      now: isoNow(this.clock),
    });
    if (!reservation?.reserved) {
      if (reservation?.reason === 'already_reserved') {
        throw new DomainError(ERROR_CODES.THREAD_BUSY, 'Thread is already being waited on.');
      }
      throw new DomainError(ERROR_CODES.NO_ACTIVE_TURN, 'Thread has no active turn or pending completion.');
    }
    return reservation;
  }

  async #waitForReservations(reservations, workspace, deliveryId, { timeoutMs = this.waitTimeoutMs } = {}) {
    const threadIds = reservations.map((entry) => entry.threadId);
    const done = () => threadIds.every((threadId) => this.#completionFor(threadId, workspace, deliveryId));
    const collect = () => threadIds.map((threadId) => this.#completionFor(threadId, workspace, deliveryId));
    const initial = collect();
    if (initial.every(Boolean)) return { completions: initial, timedOut: false };

    const result = await new Promise((resolve) => {
      const waiting = new Set(threadIds);
      const waiter = {
        timer: null,
        check: () => {
          for (const threadId of [...waiting]) {
            if (this.#completionFor(threadId, workspace, deliveryId)) waiting.delete(threadId);
          }
          if (waiting.size === 0) {
            cleanup();
            resolve({ completions: collect(), timedOut: false });
          }
        },
      };
      const cleanup = () => {
        if (waiter.timer) clearTimeout(waiter.timer);
        for (const threadId of threadIds) {
          const set = this.waiters.get(threadId);
          set?.delete(waiter);
          if (set?.size === 0) this.waiters.delete(threadId);
        }
      };
      for (const threadId of threadIds) {
        if (!this.waiters.has(threadId)) this.waiters.set(threadId, new Set());
        this.waiters.get(threadId).add(waiter);
      }
      waiter.timer = setTimeout(() => {
        cleanup();
        resolve({ completions: collect(), timedOut: true });
      }, timeoutMs);
      waiter.timer.unref?.();
      waiter.check();
    });
    void done;
    return result;
  }

  async wait(ctx, threadId) {
    const target = await this.#thread(ctx, threadId);
    const deliveryId = randomUUID();
    const reservation = await this.#reserve(target.threadId, target.workspace, deliveryId);
    const waited = await this.#waitForReservations([reservation], target.workspace, deliveryId);
    const completion = waited.completions[0];
    if (completion) {
      const result = completionResult(completion);
      if (result) return this.#rememberDelivery(result, deliveryId);
    }
    this.executionStore.releaseReservation({ threadId: target.threadId, reservationId: deliveryId });
    const execution = this.executionStore.getExecution(target.threadId);
    return {
      ...this.#publicStatus(target.threadId, execution, target.metadata),
      timedOut: true,
    };
  }

  async waitMany(ctx, threads) {
    const workspace = await this.#workspace(ctx);
    let ids;
    if (threads === 'all') {
      ids = [...new Set(this.executionStore.listExecutions({ workspace }).map((entry) => entry.threadId))];
    } else if (Array.isArray(threads)) {
      ids = [...new Set(threads.map(requiredThreadId))];
    } else {
      throw new DomainError(ERROR_CODES.NO_ACTIVE_TURN, 'threads must be an array or "all".');
    }
    if (ids.length === 0) return { completed: [], pending: [], timedOut: false };
    const targets = [];
    for (const id of ids) targets.push(await this.#thread(ctx, id));
    const deliveryId = randomUUID();
    const reservations = [];
    try {
      for (const target of targets) reservations.push(await this.#reserve(target.threadId, workspace, deliveryId));
    } catch (error) {
      this.executionStore.releaseReservation({ reservationId: deliveryId });
      throw error;
    }
    const waited = await this.#waitForReservations(reservations, workspace, deliveryId);
    const completed = [];
    const pending = [];
    for (let index = 0; index < targets.length; index += 1) {
      const completion = waited.completions[index];
      if (completion) {
        const result = completionResult(completion);
        if (result) {
          this.#rememberDelivery(result, deliveryId);
          completed.push(result);
          continue;
        }
      }
      this.executionStore.releaseReservation({
        threadId: targets[index].threadId,
        reservationId: deliveryId,
      });
      const execution = this.executionStore.getExecution(targets[index].threadId);
      pending.push(this.#publicStatus(targets[index].threadId, execution, targets[index].metadata));
    }
    const batch = {
      completed,
      pending,
      timedOut: waited.timedOut,
    };
    this.#rememberDelivery(batch, deliveryId);
    return batch;
  }

  async ackDelivery(value) {
    const deliveryId = this.deliveryIds.get(value);
    if (typeof deliveryId !== 'string') return false;
    const acknowledged = this.completionStore.ackDelivery({ deliveryId, now: isoNow(this.clock) });
    return Boolean(acknowledged?.acknowledged);
  }

  // Runtime Server uses these bridges to keep delivery ids out of the public API.
  deliveryIdFor(value) {
    return this.deliveryIds.get(value) ?? null;
  }

  ackDeliveryId(deliveryId) {
    if (typeof deliveryId !== 'string' || deliveryId.length === 0) return false;
    const acknowledged = this.completionStore.ackDelivery({ deliveryId, now: isoNow(this.clock) });
    return Boolean(acknowledged?.acknowledged);
  }

  releaseDeliveryId(deliveryId) {
    if (typeof deliveryId !== 'string' || deliveryId.length === 0) return false;
    const released = this.executionStore.releaseReservation({ reservationId: deliveryId });
    return Boolean(released?.released);
  }

  async listThreads(ctx) {
    const workspace = await this.#workspace(ctx);
    let result;
    try {
      result = await this.adapter.listThreads({ workspace });
    } catch (error) {
      throw asDomainError(error);
    }
    const rawThreads = Array.isArray(result) ? result : result?.threads ?? [];
    const visible = [];
    for (const thread of rawThreads) {
      const projected = publicThread(thread);
      if (!projected) continue;
      try {
        await this.workspaceGuard.assertThreadWorkspace(thread, workspace);
      } catch {
        continue;
      }
      visible.push(projected);
    }
    visible.sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')));
    const threads = visible.slice(0, MAX_THREADS);
    return { threads, total: visible.length, truncated: visible.length > MAX_THREADS };
  }

  async readThread(ctx, threadId) {
    const target = await this.#thread(ctx, threadId);
    let history;
    try {
      history = await this.historyAdapter.readRecentTurns(target.threadId);
    } catch (error) {
      throw new HistoryUnavailableError('Thread history is unavailable.');
    }
    const turns = Array.isArray(history?.turns) ? history.turns : [];
    const assistantMessages = turns.flatMap((turn) => [turn.finalAssistantMessage, turn.lastAssistantMessage]
      .filter((message) => typeof message === 'string' && message.length > 0)
      .map((message) => safeText(message, MAX_ASSISTANT_MESSAGE_CHARS)));
    const changes = changesFromTurns(turns);
    return {
      threadId: target.threadId,
      status: typeof target.metadata.status === 'string' ? target.metadata.status : 'unknown',
      assistantMessages,
      recentActivity: turns.slice(-10).map((turn) => ({
        ...(typeof turn.status === 'string' ? { status: turn.status } : {}),
      })),
      changes: {
        files: changes.files.slice(0, MAX_CHANGED_FILES),
        filesChanged: changes.filesChanged,
        filesTruncated: changes.filesTruncated,
      },
      truncated: false,
    };
  }

  async models() {
    const defaultPair = await this.modelService.resolveSpawn();
    let rawModels;
    try {
      rawModels = await this.adapter.listModels();
    } catch (error) {
      throw asDomainError(error);
    }
    const entries = Array.isArray(rawModels)
      ? rawModels
      : rawModels?.models ?? rawModels?.data ?? [];
    const models = entries.map((entry) => {
      if (typeof entry === 'string') return { id: entry, supportedEfforts: [] };
      const id = entry?.id ?? entry?.model ?? entry?.slug ?? entry?.name;
      if (typeof id !== 'string' || id.length === 0) return null;
      const supportedEfforts = entry?.supportedReasoningEfforts
        ?? entry?.supportedEfforts
        ?? entry?.reasoningEfforts
        ?? entry?.efforts
        ?? [];
      return {
        id,
        supportedEfforts: Array.isArray(supportedEfforts)
          ? supportedEfforts.filter((effort) => typeof effort === 'string')
          : [],
      };
    }).filter(Boolean);
    return { default: defaultPair, models };
  }
}

export function createRuntimeManager(options) {
  return new RuntimeManager(options);
}
