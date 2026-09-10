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

const VERIFIED_TERMINAL_TYPES = new Map([
  ['turn.completed', 'completed'],
  ['turn.failed', 'failed'],
  ['turn.interrupted', 'interrupted'],
  ['supervisor.process.failed', 'failed'],
]);

function eventType(event) {
  return typeof event.type === 'string' ? event.type.replaceAll('/', '.').toLowerCase() : '';
}

function trustedCanonical(event, suppliedResult) {
  return suppliedResult instanceof TerminalResult
    && (event.provenance === 'canonical' || event.provenance === 'recovery');
}

function terminalStatus(event, suppliedPayload, suppliedResult) {
  const verifiedTypeStatus = VERIFIED_TERMINAL_TYPES.get(eventType(event));
  const eventStatus = normalizeTerminalStatus(event.status ?? event.reason);
  const resultStatus = normalizeTerminalStatus(suppliedPayload?.status);

  if (verifiedTypeStatus) {
    if (eventStatus && eventStatus !== verifiedTypeStatus) return null;
    if (resultStatus && resultStatus !== verifiedTypeStatus) return null;
    return verifiedTypeStatus;
  }
  if (!trustedCanonical(event, suppliedResult) || !resultStatus) return null;
  if (eventStatus && eventStatus !== resultStatus) return null;
  return resultStatus;
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
    const status = terminalStatus(event, suppliedPayload, suppliedResult);
    if (!status) return null;
    const eventThreadId = firstString(event.threadId, event.thread?.id);
    const resultThreadId = firstString(suppliedPayload?.threadId);
    if (eventThreadId && resultThreadId && eventThreadId !== resultThreadId) return null;
    const threadId = eventThreadId ?? resultThreadId;
    if (!threadId) return null;

    const knownExecution = this.executions?.getExecution(threadId) ?? null;
    const eventTurnId = firstString(
      event.turnId,
      event.internalTurnId,
      event.turn?.id,
      event.turn?.turnId,
    );
    if (knownExecution && eventTurnId && eventTurnId !== knownExecution.turnId) return null;
    if (!knownExecution && !trustedCanonical(event, suppliedResult)) return null;
    const turnId = eventTurnId ?? knownExecution?.turnId;
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
    const safeTerminalResult = !suppliedResult && !event.turn && isRecord(event.changes)
      ? new TerminalResult({ ...terminalResult.toJSON(), changes: event.changes })
      : terminalResult;
    return this.completions.insertCompletionFirst({
      ...event,
      threadId,
      turnId,
      workspace: event.workspace ?? knownExecution?.workspace,
      status,
      terminalResult: safeTerminalResult,
    });
  }
}

export function createCompletionRouter(options) {
  return new CompletionRouter(options);
}
