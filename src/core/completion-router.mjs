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

function hiddenSourceValues(event, key) {
  const sources = event?.[key];
  if (sources === undefined) return [];
  if (!Array.isArray(sources) || sources.length === 0) return null;
  return sources.map((source) => (
    isRecord(source) && Object.hasOwn(source, 'value') ? source.value : null
  ));
}

function hiddenStatusValues(event) {
  const sources = event?.internalStatusSources;
  if (sources === undefined) return [];
  if (!Array.isArray(sources) || sources.length === 0) return null;
  return sources.map((source) => (
    isRecord(source) && Object.hasOwn(source, 'status') ? source.status : null
  ));
}

function verifiedMarkerMatches(event, marker, sourceValues) {
  if (event?.[marker] === undefined) return sourceValues !== null && sourceValues.length === 0;
  return event[marker] === true && sourceValues !== null && sourceValues.length > 0;
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

const ACTIVE_EXECUTION_STATUS_TOKENS = new Set([
  'active',
  'inprogress',
  'queued',
  'running',
  'waiting',
  'waitingonapproval',
]);

function statusToken(value) {
  if (isRecord(value)) return statusToken(value.type ?? value.status);
  return typeof value === 'string'
    ? value.toLowerCase().replaceAll(/[-_\s]/g, '')
    : null;
}

function activeExecutionStatusIsConsistent(execution) {
  const values = [
    execution?.status,
    execution?.executionStatus,
    execution?.turn?.status,
    execution?.turnRecord?.status,
  ].filter((value) => value !== undefined);
  return values.every((value) => (
    !normalizeTerminalStatus(value) && ACTIVE_EXECUTION_STATUS_TOKENS.has(statusToken(value))
  ));
}

function terminalStatus(event, suppliedPayloads, suppliedResult) {
  const hiddenStatuses = hiddenStatusValues(event);
  if (event.internalStatusSources !== undefined
    && (!verifiedMarkerMatches(event, 'verifiedTerminalStatus', hiddenStatuses))) return null;
  if (event.verifiedTerminalStatus !== undefined && event.verifiedTerminalStatus !== true) return null;
  const verifiedTypeStatus = VERIFIED_TERMINAL_TYPES.get(eventType(event));
  const payloadStatuses = suppliedPayloads.flatMap((payload) => [payload?.status, payload?.terminalStatus]);
  const statuses = collectStatusValues([
    event.status,
    event.reason,
    event.terminalStatus,
    event.turn?.status,
    event.turn?.reason,
    event.turn?.terminalStatus,
    event.turnRecord?.status,
    event.turnRecord?.reason,
    event.turnRecord?.terminalStatus,
    event.currentTurn?.status,
    event.currentTurn?.reason,
    event.currentTurn?.terminalStatus,
    event.params?.status,
    event.params?.reason,
    event.params?.terminalStatus,
    event.params?.turn?.status,
    event.params?.turn?.reason,
    event.params?.turn?.terminalStatus,
    event.params?.turnRecord?.status,
    event.params?.turnRecord?.reason,
    event.params?.turnRecord?.terminalStatus,
    event.params?.currentTurn?.status,
    event.params?.currentTurn?.reason,
    event.params?.currentTurn?.terminalStatus,
    ...(hiddenStatuses ?? []),
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

    const hiddenThreadIds = hiddenSourceValues(event, 'internalThreadIdentitySources');
    const hiddenTurnIds = hiddenSourceValues(event, 'internalTurnIdentitySources');
    if (!verifiedMarkerMatches(event, 'verifiedThreadIdentity', hiddenThreadIds)
      || !verifiedMarkerMatches(event, 'verifiedTurnIdentity', hiddenTurnIds)) return null;
    const eventThreadIds = collectIdentityValues([
      event.threadId,
      event.thread?.id,
      event.thread?.threadId,
      event.turn?.threadId,
      event.turn?.thread_id,
      event.turn?.thread?.id,
      event.turn?.thread?.threadId,
      event.turnRecord?.threadId,
      event.turnRecord?.thread_id,
      event.turnRecord?.thread?.id,
      event.turnRecord?.thread?.threadId,
      event.currentTurn?.threadId,
      event.currentTurn?.thread_id,
      event.currentTurn?.thread?.id,
      event.currentTurn?.thread?.threadId,
      event.params?.threadId,
      event.params?.thread?.id,
      event.params?.thread?.threadId,
      event.params?.turn?.threadId,
      event.params?.turn?.thread_id,
      event.params?.turn?.thread?.id,
      event.params?.turn?.thread?.threadId,
      event.params?.turnRecord?.threadId,
      event.params?.turnRecord?.thread_id,
      event.params?.turnRecord?.thread?.id,
      event.params?.turnRecord?.thread?.threadId,
      event.params?.currentTurn?.threadId,
      event.params?.currentTurn?.thread_id,
      event.params?.currentTurn?.thread?.id,
      event.params?.currentTurn?.thread?.threadId,
      event.params?.item?.threadId,
      event.params?.item?.thread?.id,
      event.params?.item?.thread?.threadId,
      event.params?.item?.turn?.threadId,
      event.params?.item?.turn?.thread_id,
      event.params?.item?.turn?.thread?.id,
      event.params?.item?.turn?.thread?.threadId,
      ...(hiddenThreadIds ?? []),
    ]);
    const resultThreadIds = collectIdentityValues(suppliedPayloads.flatMap((payload) => [
      payload?.threadId,
      payload?.thread?.id,
      payload?.thread?.threadId,
      payload?.turn?.threadId,
      payload?.turn?.thread_id,
      payload?.turn?.thread?.id,
      payload?.turn?.thread?.threadId,
      payload?.turnRecord?.threadId,
      payload?.turnRecord?.thread_id,
      payload?.turnRecord?.thread?.id,
      payload?.currentTurn?.threadId,
      payload?.currentTurn?.thread_id,
      payload?.currentTurn?.thread?.id,
      payload?.currentTurn?.thread?.threadId,
    ]));
    if (!consistentIdentity(eventThreadIds)
      || !consistentIdentity(resultThreadIds)
      || !consistentIdentity([...eventThreadIds, ...resultThreadIds])) return null;
    const threadIds = [...eventThreadIds, ...resultThreadIds];
    const threadId = firstString(...threadIds);
    if (!threadId) return null;

    const knownExecution = this.executions?.getExecution(threadId) ?? null;
    if (knownExecution && !activeExecutionStatusIsConsistent(knownExecution)) return null;
    if (event.verifiedTurnIdentity !== undefined && event.verifiedTurnIdentity !== true) return null;
    const eventTurnIds = collectIdentityValues([
      event.turnId,
      event.internalTurnId,
      event.turn?.id,
      event.turn?.turnId,
      event.turn?.internalTurnId,
      event.turnRecord?.id,
      event.turnRecord?.turnId,
      event.turnRecord?.internalTurnId,
      event.currentTurn?.id,
      event.currentTurn?.turnId,
      event.currentTurn?.internalTurnId,
      event.params?.turnId,
      event.params?.turn?.id,
      event.params?.turn?.turnId,
      event.params?.turn?.internalTurnId,
      event.params?.turnRecord?.id,
      event.params?.turnRecord?.turnId,
      event.params?.turnRecord?.internalTurnId,
      event.params?.currentTurn?.id,
      event.params?.currentTurn?.turnId,
      event.params?.currentTurn?.internalTurnId,
      event.params?.item?.turnId,
      event.params?.item?.turn?.id,
      event.params?.item?.turn?.turnId,
      event.params?.item?.internalTurnId,
      event.params?.diff?.turnId,
      event.params?.diff?.turn?.id,
      ...(hiddenTurnIds ?? []),
    ]);
    const resultTurnIds = collectIdentityValues(suppliedPayloads.flatMap((payload) => [
      payload?.turnId,
      payload?.internalTurnId,
      payload?.turn?.id,
      payload?.turn?.turnId,
      payload?.turn?.internalTurnId,
      payload?.turnRecord?.id,
      payload?.turnRecord?.turnId,
      payload?.turnRecord?.internalTurnId,
      payload?.currentTurn?.id,
      payload?.currentTurn?.turnId,
      payload?.currentTurn?.internalTurnId,
    ]));
    if (!consistentIdentity(eventTurnIds) || !consistentIdentity(resultTurnIds)) return null;
    const turnIds = [...eventTurnIds, ...resultTurnIds];
    if (!consistentIdentity(turnIds)) return null;
    const eventTurnId = firstString(...eventTurnIds);
    const resultTurnId = firstString(...resultTurnIds);
    const executionThreadIds = collectIdentityValues([
      knownExecution?.threadId,
      knownExecution?.thread?.id,
    ]);
    const executionTurnIds = collectIdentityValues([
      knownExecution?.turnId,
      knownExecution?.turn?.id,
      knownExecution?.turn?.turnId,
      knownExecution?.turnRecord?.id,
      knownExecution?.turnRecord?.turnId,
    ]);
    if (knownExecution && (
      !consistentIdentity(executionThreadIds)
      || !consistentIdentity(executionTurnIds)
      || !consistentIdentity([...eventThreadIds, ...executionThreadIds])
      || !consistentIdentity([...eventTurnIds, ...executionTurnIds])
    )) return null;
    if (knownExecution && (!eventTurnId || eventTurnId !== firstString(...executionTurnIds))) return null;
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
