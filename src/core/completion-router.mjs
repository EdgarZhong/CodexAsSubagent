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

function hasVerifiedTerminalMarker(event) {
  return event.verified === true || event.verifiedTerminal === true;
}

function trustedCanonical(event, suppliedResult) {
  return event.provenance === 'canonical'
    && hasVerifiedTerminalMarker(event)
    && VERIFIED_TERMINAL_TYPES.has(eventType(event))
    && suppliedResult instanceof TerminalResult;
}

function trustedRecovery(event, suppliedResult) {
  return eventType(event) === 'recovery.terminal'
    && event.provenance === 'recovery'
    && hasVerifiedTerminalMarker(event)
    && suppliedResult instanceof TerminalResult;
}

function collectIdentityValues(values) {
  const identities = [];
  for (const value of values) {
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.length === 0) return null;
    identities.push(value);
  }
  return identities;
}

function consistentIdentity(values) {
  return values !== null && new Set(values).size <= 1;
}

function collectStatusValues(values) {
  const statuses = [];
  for (const value of values) {
    if (value === undefined) continue;
    const status = normalizeTerminalStatus(value);
    if (!status) return null;
    statuses.push(status);
  }
  return statuses;
}

function statusMatches(statuses, expected) {
  return statuses !== null && (statuses.length === 0 || statuses.every((status) => status === expected));
}

function terminalStatus(event, suppliedPayloads, suppliedResult) {
  const verifiedTypeStatus = VERIFIED_TERMINAL_TYPES.get(eventType(event));
  const payloadStatuses = suppliedPayloads.flatMap((payload) => [payload?.status, payload?.terminalStatus]);
  const statuses = collectStatusValues([
    event.status,
    event.reason,
    event.terminalStatus,
    event.turn?.status,
    event.turn?.reason,
    ...payloadStatuses,
  ]);
  if (verifiedTypeStatus) {
    return statusMatches(statuses, verifiedTypeStatus) ? verifiedTypeStatus : null;
  }
  if (!trustedRecovery(event, suppliedResult) || statuses === null || statuses.length === 0) return null;
  const [resultStatus, ...otherStatuses] = statuses;
  return otherStatuses.every((status) => status === resultStatus) ? resultStatus : null;
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
    const suppliedResults = [event.terminalResult, event.result].filter((result) => result !== undefined && result !== null);
    const suppliedPayloads = suppliedResults.map((result) => (
      typeof result?.toJSON === 'function' ? result.toJSON() : isRecord(result) ? result : null
    ));
    if (suppliedPayloads.some((payload) => payload === null)) return null;
    const suppliedResult = suppliedResults[0] ?? null;
    const suppliedPayload = suppliedPayloads[0] ?? null;
    const status = terminalStatus(event, suppliedPayloads, suppliedResult);
    if (!status) return null;
    if (suppliedResults.length > 0 && suppliedPayloads.some((payload) => !payload?.status)) return null;

    const eventThreadIds = collectIdentityValues([
      event.threadId,
      event.thread?.id,
      event.turn?.threadId,
      event.turn?.thread_id,
    ]);
    const resultThreadIds = collectIdentityValues(suppliedPayloads.flatMap((payload) => [
      payload?.threadId,
      payload?.thread?.id,
    ]));
    if (!consistentIdentity(eventThreadIds)
      || !consistentIdentity(resultThreadIds)
      || !consistentIdentity([...eventThreadIds, ...resultThreadIds])) return null;
    const threadIds = [...eventThreadIds, ...resultThreadIds];
    const threadId = firstString(...threadIds);
    if (!threadId) return null;

    const knownExecution = this.executions?.getExecution(threadId) ?? null;
    if (event.verifiedTurnIdentity !== undefined && event.verifiedTurnIdentity !== true) return null;
    const eventTurnIds = collectIdentityValues([
      event.turnId,
      event.internalTurnId,
      event.turn?.id,
      event.turn?.turnId,
      event.turn?.internalTurnId,
    ]);
    const resultTurnIds = collectIdentityValues(suppliedPayloads.flatMap((payload) => [
      payload?.turnId,
      payload?.internalTurnId,
      payload?.turn?.id,
      payload?.turn?.turnId,
    ]));
    if (!consistentIdentity(eventTurnIds) || !consistentIdentity(resultTurnIds)) return null;
    const turnIds = [...eventTurnIds, ...resultTurnIds];
    if (!consistentIdentity(turnIds)) return null;
    const eventTurnId = firstString(...eventTurnIds);
    const resultTurnId = firstString(...resultTurnIds);
    if (knownExecution && (!eventTurnId || eventTurnId !== knownExecution.turnId)) return null;
    if (knownExecution && event.workspace !== undefined && event.workspace !== knownExecution.workspace) return null;
    if (!knownExecution
      && !trustedCanonical(event, suppliedResult)
      && !trustedRecovery(event, suppliedResult)) return null;
    const turnId = eventTurnId ?? resultTurnId;
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
