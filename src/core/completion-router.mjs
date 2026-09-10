import { TerminalResult } from './terminal-result.mjs';
import { CompletionStore } from './completion-store.mjs';
import { ExecutionStore } from './execution-store.mjs';
import { normalizeTerminalStatus } from '../shared/protocol.mjs';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function firstString(...values) {
  return values.find((value) => typeof value === 'string' && value.length > 0) ?? null;
}

function statusFromEvent(event) {
  const explicit = normalizeTerminalStatus(event.status ?? event.reason);
  if (explicit) return explicit;
  const type = typeof event.type === 'string' ? event.type.replaceAll('/', '.').toLowerCase() : '';
  if (type === 'turn.completed' || type === 'turn.complete') return 'completed';
  if (type === 'turn.failed' || type === 'turn.error' || type === 'supervisor.process.failed') return 'failed';
  if (type === 'turn.interrupted' || type === 'turn.cancelled' || type === 'turn.canceled') return 'interrupted';
  return null;
}

function storesFrom(options) {
  if (options && typeof options.insertCompletionFirst === 'function') {
    const isSqliteStore = typeof options.createExecution === 'function'
      && typeof options.getExecution === 'function';
    return {
      completions: options instanceof CompletionStore ? options : new CompletionStore(options),
      executions: isSqliteStore ? new ExecutionStore(options) : null,
    };
  }
  const source = options ?? {};
  const rawStore = source.store ?? source.sqliteStore ?? null;
  const completions = source.completions ?? source.completionStore
    ?? (rawStore ? new CompletionStore(rawStore) : null);
  const executions = source.executions ?? source.executionStore
    ?? (rawStore ? new ExecutionStore(rawStore) : null);
  if (!completions || typeof completions.insertCompletionFirst !== 'function') {
    throw new TypeError('CompletionRouter requires a CompletionStore.');
  }
  return {
    completions: completions instanceof CompletionStore ? completions : new CompletionStore(completions),
    executions: executions
      ? executions instanceof ExecutionStore ? executions : new ExecutionStore(executions)
      : null,
  };
}

export class CompletionRouter {
  constructor(options, completionStore) {
    const stores = completionStore === undefined
      ? storesFrom(options)
      : storesFrom({ executions: options, completions: completionStore });
    this.completions = stores.completions;
    this.executions = stores.executions;
  }

  onTerminal(event = {}) {
    if (!isRecord(event)) return null;
    const suppliedResult = event.terminalResult ?? event.result ?? null;
    const suppliedPayload = typeof suppliedResult?.toJSON === 'function'
      ? suppliedResult.toJSON()
      : isRecord(suppliedResult) ? suppliedResult : null;
    const status = statusFromEvent(event) ?? normalizeTerminalStatus(suppliedPayload?.status);
    if (!status) return null;
    const threadId = firstString(event.threadId, event.thread?.id, suppliedPayload?.threadId);
    if (!threadId) return null;

    const knownExecution = this.executions?.getExecution(threadId) ?? null;
    const turnId = firstString(
      event.turnId,
      event.internalTurnId,
      event.turn?.id,
      event.turn?.turnId,
      knownExecution?.turnId,
    );
    if (!turnId) return null;

    const terminalResult = suppliedResult ?? TerminalResult.fromTerminal({
        ...event,
        threadId,
        turnId,
        status,
        ...(suppliedPayload ? { ...suppliedPayload } : {}),
        ...(!event.turn && isRecord(event.changes)
          ? {
            turn: {
              id: turnId,
              status,
              changes: event.changes,
            },
          }
          : {}),
      });
    return this.completions.insertCompletionFirst({
      ...event,
      threadId,
      turnId,
      workspace: event.workspace ?? knownExecution?.workspace,
      terminalResult,
    });
  }
}

export function createCompletionRouter(options) {
  return new CompletionRouter(options);
}
