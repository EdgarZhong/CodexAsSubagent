import { TerminalResult } from './terminal-result.mjs';
import { CompletionStore } from './completion-store.mjs';
import { ExecutionStore } from './execution-store.mjs';
import { normalizeStatus, normalizeTerminalStatus, STATUS_EVIDENCE_FIELDS } from '../shared/protocol.mjs';

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

function statusEvidenceValues(evidenceRecords, includeRootType = false) {
  const values = [];
  for (const [index, evidence] of evidenceRecords.entries()) {
    ownValues(values, evidence, STATUS_EVIDENCE_FIELDS);
    if (evidence.isTurnRecord || (index === 0 && includeRootType)) ownValues(values, evidence, ['type']);
  }
  return values;
}

function collectIdentityValues(values) {
  const identities = [];
  for (const value of values) {
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
  if (!Object.hasOwn(event, key)) return [];
  if (!Array.isArray(sources) || sources.length === 0) return null;
  return sources.map((source) => (
    isRecord(source) && Object.hasOwn(source, 'value') ? source.value : null
  ));
}

function hiddenStatusValues(event) {
  const sources = event?.internalStatusSources;
  if (!Object.hasOwn(event, 'internalStatusSources')) return [];
  if (!Array.isArray(sources) || sources.length === 0) return null;
  return sources.map((source) => (
    isRecord(source) && Object.hasOwn(source, 'status') ? source : null
  ));
}

function verifiedMarkerMatches(event, marker, sourceValues) {
  if (!Object.hasOwn(event, marker)) return sourceValues !== null && sourceValues.length === 0;
  return event[marker] === true && sourceValues !== null && sourceValues.length > 0;
}

function collectStatusValues(values, normalize = normalizeTerminalStatus) {
  const statuses = [];
  for (const value of values) {
    const status = normalize(value);
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

// The same gate applies to raw/hidden event, result and active-execution evidence.
function validateEvidence(value, prefix, { active = false, includeRootType = false } = {}) {
  if (!isRecord(value)) return null;
  const records = collectTurnEvidenceRecords(value, prefix);
  const threadValues = threadIdentityValues(records);
  const turnValues = turnIdentityValues(records);
  const statusValues = statusEvidenceValues(records, includeRootType);
  for (const { value: record } of records) {
    const hiddenThreads = hiddenSourceValues(record, 'internalThreadIdentitySources');
    const hiddenTurns = hiddenSourceValues(record, 'internalTurnIdentitySources');
    const hiddenStatuses = hiddenStatusValues(record);
    if (!verifiedMarkerMatches(record, 'verifiedThreadIdentity', hiddenThreads)
      || !verifiedMarkerMatches(record, 'verifiedTurnIdentity', hiddenTurns)
      || !verifiedMarkerMatches(record, 'verifiedTerminalStatus', hiddenStatuses)) return null;
    threadValues.push(...hiddenThreads);
    turnValues.push(...hiddenTurns);
    statusValues.push(...hiddenStatuses);
  }
  const threadIds = collectIdentityValues(threadValues);
  const turnIds = collectIdentityValues(turnValues);
  const statuses = collectStatusValues(statusValues, active ? normalizeStatus : normalizeTerminalStatus);
  if (!consistentIdentity(threadIds) || !consistentIdentity(turnIds)
    || statuses === null || new Set(statuses).size > 1
    || (active && statuses.some((status) => !ACTIVE_EXECUTION_STATUS_TOKENS.has(status)))) return null;
  return { threadIds, turnIds, statuses };
}

function terminalStatus(event, evidence, suppliedResult) {
  for (const record of [event, event.params]) {
    if (isRecord(record) && Object.hasOwn(record, 'method')
      && eventType({ type: record.method }) !== eventType(event)) return null;
  }
  const verifiedTypeStatus = VERIFIED_TERMINAL_TYPES.get(eventType(event));
  const statuses = evidence.flatMap((entry) => entry.statuses);
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
      && typeof options.getExecutionByPhysicalThreadId === 'function';
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
    const single = completionStore === undefined;
    const stores = single
      ? storesFrom(options)
      : storesFrom({ executions: options, completions: completionStore });
    this.completions = stores.completions;
    this.executions = stores.executions;
    // V2 事件驱动 Web delivery（适配说明 §四）：经构造参数注入，缺省 undefined
    // 表示不启用，保持纯 store 路径可测。
    const extras = single && isRecord(options) && !Array.isArray(options) ? options : {};
    this.webDelivery = extras.webDelivery ?? null;
    this.logger = extras.logger ?? null;
  }

  onTerminal(event = {}) {
    if (!isRecord(event)) return null;
    const suppliedResults = [event.terminalResult, event.result].filter((result) => result !== undefined && result !== null);
    const resultEvidence = suppliedResults.map((result, index) => (
      validateEvidence(result, `result[${index}]`, { includeRootType: true })
    ));
    if (resultEvidence.some((evidence) => evidence === null)) return null;
    const suppliedPayloads = suppliedResults.map((result) => (
      typeof result?.toJSON === 'function' ? result.toJSON() : isRecord(result) ? result : null
    ));
    if (suppliedPayloads.some((payload) => !isRecord(payload))) return null;
    const suppliedResult = suppliedResults[0] ?? null;
    const eventEvidence = validateEvidence(event, 'event');
    const payloadEvidence = suppliedPayloads.map((payload, index) => (
      validateEvidence(payload, `payload[${index}]`, { includeRootType: true })
    ));
    if (!eventEvidence || payloadEvidence.some((evidence) => evidence === null)) return null;
    const evidence = [eventEvidence, ...resultEvidence, ...payloadEvidence];
    const status = terminalStatus(event, evidence, suppliedResult);
    if (!status) return null;
    if (suppliedResults.length > 0 && suppliedPayloads.some((payload) => !payload?.status)) return null;

    const threadIds = evidence.flatMap((entry) => entry.threadIds);
    const turnIds = evidence.flatMap((entry) => entry.turnIds);
    if (!consistentIdentity(threadIds) || !consistentIdentity(turnIds)) return null;
    const threadId = firstString(...threadIds);
    if (!threadId) return null;

    // onTerminal 只出现在 trusted supervisor event path / recovery（规格 §2.8），
    // 是唯一允许按物理 Thread ID 关联 Execution 的内部例外。
    const knownExecution = this.executions?.getExecutionByPhysicalThreadId(threadId) ?? null;
    const eventTurnId = firstString(...eventEvidence.turnIds);
    const executionEvidence = knownExecution
      ? validateEvidence(knownExecution, 'execution', { active: true, includeRootType: true }) : null;
    if (knownExecution && (
      !executionEvidence
      || !consistentIdentity([...threadIds, ...executionEvidence.threadIds])
      || !consistentIdentity([...turnIds, ...executionEvidence.turnIds])
      || !eventTurnId || eventTurnId !== firstString(...executionEvidence.turnIds)
    )) return null;
    if (knownExecution && event.workspace !== undefined && event.workspace !== knownExecution.workspace) return null;
    if (!knownExecution
      && !trustedCanonical(event, suppliedResult)
      && !trustedRecovery(event, suppliedResult)) return null;
    const turnId = firstString(...turnIds);
    if (!turnId) return null;

    const terminalResult = suppliedResult ?? TerminalResult.fromTerminal({
      ...event,
      threadId,
      turnId,
      status,
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
    // provenance（规格 §2.4）：事件显式携带 host/workspace/sessionId 时原样透传
    // （由 insertCompletionFirst 与 execution 行做一致性校验，冲突 fail closed）；
    // 未携带时从 execution 行继承；无 Execution 的 trusted/recovery 合成路径缺失
    // provenance 时 insertCompletionFirst fail closed。
    const completion = this.completions.insertCompletionFirst({
      ...event,
      threadId,
      turnId,
      host: event.host ?? knownExecution?.host,
      workspace: event.workspace ?? knownExecution?.workspace,
      sessionId: event.sessionId ?? knownExecution?.sessionId,
      status,
      terminalResult: safeTerminalResult,
    });
    this.#attemptWebDelivery(completion);
    return completion;
  }

  // V2 事件驱动 Web delivery（适配说明 §四）：Mailbox durable COMMIT（
  // insertCompletionFirst 事务）成功之后，对本次新落库、仍为 pending 且
  // host=kimi-code 的 completion fire-and-forget 触发。不得 await——不得阻塞
  // terminal 响应，也不改变 idle 判定语义；投递失败由 web-delivery 内部记录
  // 到 server.log，进程异常靠 delivery lease 过期回退。
  #attemptWebDelivery(completion) {
    const delivery = this.webDelivery;
    if (!delivery || typeof delivery.attemptWebDelivery !== 'function') return;
    if (!isRecord(completion) || completion.inserted === false) return;
    if (completion.host !== 'kimi-code' || completion.deliveryState !== 'pending') return;
    let promise;
    try {
      promise = delivery.attemptWebDelivery({ completion });
    } catch (error) {
      this.#logWebDeliveryFailure(error);
      return;
    }
    if (promise && typeof promise.catch === 'function') {
      promise.catch((error) => this.#logWebDeliveryFailure(error));
    }
  }

  #logWebDeliveryFailure(error) {
    try {
      this.logger?.warn?.('completion.web_delivery.unhandled_failure', {
        error: error?.message ?? String(error),
      });
    } catch {
      // 日志失败不得影响 terminal 路径。
    }
  }
}

export function createCompletionRouter(options) {
  return new CompletionRouter(options);
}
