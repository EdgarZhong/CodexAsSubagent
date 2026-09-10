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

const TURN_EVIDENCE_KEYS = Object.freeze(['turn', 'turnRecord', 'currentTurn']);
const STATUS_EVIDENCE_FIELDS = Object.freeze(['status', 'reason', 'terminalStatus', 'terminal_status']);

function collectTurnEvidenceRecords(value, prefix) {
  if (!isRecord(value)) return [];
  const roots = [{ source: prefix, value, isTurnRecord: false }];
  for (const key of ['item', 'diff']) {
    if (isRecord(value[key])) {
      roots.push({ source: `${prefix}.${key}`, value: value[key], isTurnRecord: false });
    }
  }
  if (isRecord(value.params)) {
    roots.push({ source: `${prefix}.params`, value: value.params, isTurnRecord: false });
    for (const key of ['item', 'diff']) {
      if (isRecord(value.params[key])) {
        roots.push({
          source: `${prefix}.params.${key}`,
          value: value.params[key],
          isTurnRecord: false,
        });
      }
    }
  }

  const evidence = [];
  for (const root of roots) {
    const pending = [root];
    const seen = new WeakSet();
    while (pending.length > 0) {
      const current = pending.shift();
      if (seen.has(current.value)) continue;
      seen.add(current.value);
      evidence.push(current);
      for (const key of TURN_EVIDENCE_KEYS) {
        const child = current.value[key];
        if (isRecord(child)) {
          pending.push({
            source: `${current.source}.${key}`,
            value: child,
            isTurnRecord: true,
          });
        }
      }
    }
  }
  return evidence;
}

function ownValues(values, evidence, fields) {
  for (const field of fields) {
    if (Object.hasOwn(evidence.value, field)) values.push(evidence.value[field]);
  }
}

function threadIdentityValues(evidenceRecords) {
  const values = [];
  for (const evidence of evidenceRecords) {
    ownValues(values, evidence, ['threadId', 'thread_id']);
    if (isRecord(evidence.value.thread)) {
      ownValues(values, { value: evidence.value.thread }, ['id', 'threadId', 'thread_id']);
    }
  }
  return values;
}

function turnIdentityValues(evidenceRecords) {
  const values = [];
  for (const evidence of evidenceRecords) {
    ownValues(values, evidence, ['turnId', 'turn_id', 'internalTurnId']);
    if (evidence.isTurnRecord) ownValues(values, evidence, ['id']);
  }
  return values;
}

function statusEvidenceValues(evidenceRecords, extraFields = []) {
  const values = [];
  const fields = [...STATUS_EVIDENCE_FIELDS, ...extraFields];
  for (const evidence of evidenceRecords) ownValues(values, evidence, fields);
  return values;
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
  const values = statusEvidenceValues(
    collectTurnEvidenceRecords(execution, 'execution'),
    ['executionStatus'],
  );
  return values.every((value) => (
    !normalizeTerminalStatus(value) && ACTIVE_EXECUTION_STATUS_TOKENS.has(statusToken(value))
  ));
}

function terminalStatus(event, eventEvidence, resultEvidence, suppliedResult) {
  const hiddenStatuses = hiddenStatusValues(event);
  if (event.internalStatusSources !== undefined
    && (!verifiedMarkerMatches(event, 'verifiedTerminalStatus', hiddenStatuses))) return null;
  if (event.verifiedTerminalStatus !== undefined && event.verifiedTerminalStatus !== true) return null;
  const verifiedTypeStatus = VERIFIED_TERMINAL_TYPES.get(eventType(event));
  const statuses = collectStatusValues([
    ...statusEvidenceValues(eventEvidence),
    ...(hiddenStatuses ?? []),
    ...statusEvidenceValues(resultEvidence),
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
    const eventEvidence = collectTurnEvidenceRecords(event, 'event');
    const resultEvidence = suppliedPayloads.flatMap((payload, index) => (
      collectTurnEvidenceRecords(payload, `result[${index}]`)
    ));
    const status = terminalStatus(event, eventEvidence, resultEvidence, suppliedResult);
    if (!status) return null;
    if (suppliedResults.length > 0 && suppliedPayloads.some((payload) => !payload?.status)) return null;

    const hiddenThreadIds = hiddenSourceValues(event, 'internalThreadIdentitySources');
    const hiddenTurnIds = hiddenSourceValues(event, 'internalTurnIdentitySources');
    if (!verifiedMarkerMatches(event, 'verifiedThreadIdentity', hiddenThreadIds)
      || !verifiedMarkerMatches(event, 'verifiedTurnIdentity', hiddenTurnIds)) return null;
    const eventThreadIds = collectIdentityValues([
      ...threadIdentityValues(eventEvidence),
      ...(hiddenThreadIds ?? []),
    ]);
    const resultThreadIds = collectIdentityValues(threadIdentityValues(resultEvidence));
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
      ...turnIdentityValues(eventEvidence),
      ...(hiddenTurnIds ?? []),
    ]);
    const resultTurnIds = collectIdentityValues(turnIdentityValues(resultEvidence));
    if (!consistentIdentity(eventTurnIds) || !consistentIdentity(resultTurnIds)) return null;
    const turnIds = [...eventTurnIds, ...resultTurnIds];
    if (!consistentIdentity(turnIds)) return null;
    const eventTurnId = firstString(...eventTurnIds);
    const resultTurnId = firstString(...resultTurnIds);
    const executionEvidence = collectTurnEvidenceRecords(knownExecution, 'execution');
    const executionThreadIds = collectIdentityValues(threadIdentityValues(executionEvidence));
    const executionTurnIds = collectIdentityValues(turnIdentityValues(executionEvidence));
    if (knownExecution && (
      !consistentIdentity(executionThreadIds)
      || !consistentIdentity(executionTurnIds)
      || !consistentIdentity([...eventThreadIds, ...resultThreadIds, ...executionThreadIds])
      || !consistentIdentity([...eventTurnIds, ...resultTurnIds, ...executionTurnIds])
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
