import {
  isRecord,
  normalizeStatus,
  statusSources,
  STATUS_EVIDENCE_FIELDS,
  safeError,
  summarizeChangedFiles,
  truncateAssistantMessage,
} from '../../shared/protocol.mjs';

function firstString(...values) {
  return values.find((value) => typeof value === 'string' && value.length > 0) ?? null;
}

function identityState(candidates) {
  const values = candidates.map(({ value }) => value);
  const valid = values.every((value) => typeof value === 'string' && value.length > 0);
  const consistent = valid && new Set(values).size === 1;
  return {
    value: consistent ? values[0] : null,
    verified: consistent && values.length > 0,
    sources: candidates.map(({ source, value }) => ({ source, value })),
  };
}

function eventParams(event) {
  return isRecord(event?.params) ? event.params : {};
}

const TURN_EVIDENCE_KEYS = Object.freeze(['turn', 'turnRecord', 'currentTurn']);

function collectTurnEvidenceRecords(roots) {
  const evidence = [];
  for (const root of roots) {
    if (!isRecord(root.value)) continue;
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

function eventEvidenceRecords(event) {
  const params = eventParams(event);
  return collectTurnEvidenceRecords([
    { source: 'event', value: event, isTurnRecord: false },
    { source: 'event.item', value: event?.item, isTurnRecord: false },
    { source: 'event.diff', value: event?.diff, isTurnRecord: false },
    { source: 'params', value: params, isTurnRecord: false },
    { source: 'params.item', value: params.item, isTurnRecord: false },
    { source: 'params.diff', value: params.diff, isTurnRecord: false },
  ]);
}

function ownCandidates(candidates, evidence, fields) {
  for (const field of fields) {
    if (Object.hasOwn(evidence.value, field)) {
      candidates.push({
        source: `${evidence.source}.${field}`,
        value: evidence.value[field],
      });
    }
  }
}

function threadIdentityCandidates(event) {
  const candidates = [];
  for (const evidence of eventEvidenceRecords(event)) {
    ownCandidates(candidates, evidence, ['threadId', 'thread_id']);
    if (isRecord(evidence.value.thread)) {
      ownCandidates(candidates, {
        source: `${evidence.source}.thread`,
        value: evidence.value.thread,
      }, ['id', 'threadId', 'thread_id']);
    }
  }
  return candidates;
}

function extractThreadId(event) {
  return identityState(threadIdentityCandidates(event)).value;
}

function turnIdentityCandidates(event) {
  const candidates = [];
  for (const evidence of eventEvidenceRecords(event)) {
    ownCandidates(candidates, evidence, ['turnId', 'turn_id', 'internalTurnId']);
    if (evidence.isTurnRecord) {
      ownCandidates(candidates, evidence, ['id']);
    }
  }
  return candidates;
}

function extractTurnId(event) {
  return identityState(turnIdentityCandidates(event)).value;
}

function currentTurnRecord(event) {
  if (!isRecord(event)) {
    return null;
  }
  const params = eventParams(event);
  return isRecord(event.turn)
    ? event.turn
    : isRecord(event.turnRecord)
      ? event.turnRecord
      : isRecord(event.currentTurn)
        ? event.currentTurn
        : isRecord(params.turn)
          ? params.turn
          : null;
}

function turnId(turn) {
  return firstString(turn?.id, turn?.turnId);
}

function scopedTurn(event) {
  const eventTurnId = extractTurnId(event);
  if (!eventTurnId) {
    return null;
  }

  const turn = currentTurnRecord(event);
  const recordTurnId = turnId(turn);
  if (recordTurnId && recordTurnId !== eventTurnId) {
    return null;
  }

  const params = eventParams(event);
  const diffTurnId = firstString(params.diff?.turnId, params.diff?.turn?.id);
  const itemTurnId = firstString(params.item?.turnId, params.item?.turn?.id);
  if ((diffTurnId && diffTurnId !== eventTurnId) || (itemTurnId && itemTurnId !== eventTurnId)) {
    return null;
  }
  return { eventTurnId, turn };
}

function itemFileChanges(item) {
  if (!isRecord(item)) {
    return [];
  }
  const itemType = typeof item.type === 'string' ? item.type.toLowerCase() : '';
  if (!itemType.includes('filechange') && !itemType.includes('file_change')) {
    return [];
  }
  if (Array.isArray(item.fileChanges)) return item.fileChanges;
  if (Array.isArray(item.changes)) return item.changes;
  if (isRecord(item.changes) && Array.isArray(item.changes.files)) return item.changes.files;
  if (typeof item.path === 'string') return [{ path: item.path, kind: item.kind ?? item.operation }];
  return [];
}

function fileChangesFromTurn(turn) {
  if (!isRecord(turn)) {
    return [];
  }
  const files = [];
  if (Array.isArray(turn.fileChanges)) files.push(...turn.fileChanges);
  if (isRecord(turn.changes)) {
    if (Array.isArray(turn.changes.files)) files.push(...turn.changes.files);
    if (Array.isArray(turn.changes.fileChanges)) files.push(...turn.changes.fileChanges);
  }
  if (Array.isArray(turn.changes)) files.push(...turn.changes);
  if (Array.isArray(turn.items)) {
    for (const item of turn.items) files.push(...itemFileChanges(item));
  }
  return files;
}

function scopedFileChanges(value, expectedTurnId) {
  if (Array.isArray(value)) {
    return value.filter((file) => (
      isRecord(file)
      && firstString(file.turnId, file.turn?.id) === expectedTurnId
    ));
  }
  if (!isRecord(value) || firstString(value.turnId, value.turn?.id) !== expectedTurnId) {
    return [];
  }
  if (Array.isArray(value.files)) return value.files;
  if (Array.isArray(value.fileChanges)) return value.fileChanges;
  if (isRecord(value.changes) && Array.isArray(value.changes.files)) return value.changes.files;
  if (Array.isArray(value.changes)) return value.changes;
  return [];
}

function fileChangesFromParams(params, expectedTurnId) {
  const files = [];
  if (isRecord(params.diff)) {
    if (Array.isArray(params.diff.files)) files.push(...params.diff.files);
    if (Array.isArray(params.diff.fileChanges)) files.push(...params.diff.fileChanges);
    if (isRecord(params.diff.changes) && Array.isArray(params.diff.changes.files)) {
      files.push(...params.diff.changes.files);
    }
  }
  files.push(...scopedFileChanges(params.fileChanges, expectedTurnId));
  files.push(...itemFileChanges(params.item));
  return files;
}

export function extractTurnChanges(event) {
  const scoped = scopedTurn(event);
  if (!scoped) {
    return summarizeChangedFiles([]);
  }
  return summarizeChangedFiles([
    ...fileChangesFromTurn(scoped.turn),
    ...fileChangesFromParams(eventParams(event), scoped.eventTurnId),
  ]);
}

function itemAssistantText(item) {
  if (!isRecord(item)) {
    return null;
  }
  const type = typeof item.type === 'string' ? item.type.toLowerCase() : '';
  if (!type.includes('agentmessage') && !type.includes('agent_message')) {
    return null;
  }
  if (typeof item.text === 'string' && item.text.length > 0) return item.text;
  if (typeof item.message === 'string' && item.message.length > 0) return item.message;
  if (Array.isArray(item.content)) {
    const text = item.content
      .map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .join('');
    if (text.length > 0) return text;
  }
  return null;
}

export function extractAssistantMessage(turn) {
  if (!isRecord(turn)) {
    return null;
  }
  const direct = firstString(
    turn.finalAssistantMessage,
    turn.lastAssistantMessage,
    turn.assistantMessage,
    turn.text,
    turn.message,
  );
  if (direct) return direct;
  if (Array.isArray(turn.items)) {
    for (const item of [...turn.items].reverse()) {
      const text = itemAssistantText(item);
      if (text) return text;
    }
  }
  return null;
}

function isProcessFailure(event, normalizedMethod = '') {
  const params = eventParams(event);
  const source = event?.source ?? event?.error?.source ?? params.error?.source;
  return (
    normalizedMethod === 'process.failure'
    || normalizedMethod === 'supervisor.process.failure'
    || normalizedMethod === 'supervisor.process.failed'
    || event?.type === 'process_failure'
    || (event?.kind === 'lifecycle' && source === 'app-server-process')
  );
}

function eventType(event) {
  const params = eventParams(event);
  const method = firstString(event?.method, event?.type, params.method) ?? 'unknown';
  if (isProcessFailure(event, method.replaceAll('/', '.'))) return 'supervisor.process.failed';
  return methodType(method);
}

function methodType(method) {
  if (typeof method !== 'string') return 'unknown';
  const normalized = method.replaceAll('/', '.');
  if (isProcessFailure({ type: method }, normalized)) return 'supervisor.process.failed';
  if (normalized === 'turn.completed' || normalized === 'turn.complete') return 'turn.completed';
  if (normalized === 'turn.failed' || normalized === 'turn.error') return 'turn.failed';
  if (normalized === 'turn.interrupted' || normalized === 'turn.cancelled' || normalized === 'turn.canceled') {
    return 'turn.interrupted';
  }
  if (normalized === 'turn.started' || normalized === 'turn.start') return 'turn.started';
  if (normalized === 'item.agentMessage.delta') return 'assistant.delta';
  if (normalized === 'item.completed') return 'item.completed';
  if (normalized === 'turn.diff.updated') return 'turn.diff.updated';
  if (normalized === 'thread.status.changed') return 'thread.status.changed';
  if (normalized === 'error') return 'error';
  return normalized;
}

const TERMINAL_EVENT_STATUSES = new Map([
  ['turn.completed', 'completed'],
  ['turn.failed', 'failed'],
  ['turn.interrupted', 'interrupted'],
  ['supervisor.process.failed', 'failed'],
]);

function collectStatusSources(event) {
  const sources = [{ source: 'event.type', status: null }];
  for (const [source, record, field] of [
    ['event.method', event, 'method'], ['event.type', event, 'type'],
    ['params.method', eventParams(event), 'method'],
  ]) {
    if (!isRecord(record) || !Object.hasOwn(record, field)) continue;
    const type = methodType(record[field]);
    // A process lifecycle error is the adapter's explicit thread-scoped crash signal.
    const status = type === 'error' && isProcessFailure(event)
      ? 'failed' : TERMINAL_EVENT_STATUSES.get(type) ?? null;
    sources.push({ source, status });
  }
  for (const evidence of eventEvidenceRecords(event)) {
    const fields = evidence.isTurnRecord ? ['type', ...STATUS_EVIDENCE_FIELDS] : STATUS_EVIDENCE_FIELDS;
    for (const field of fields) {
      if (Object.hasOwn(evidence.value, field)) {
        sources.push(...statusSources(evidence.value[field], `${evidence.source}.${field}`));
      }
    }
  }
  return sources;
}

function terminalStatus(event, type) {
  const expected = TERMINAL_EVENT_STATUSES.get(type);
  const sources = collectStatusSources(event);
  if (!expected) return { status: null, sources: [] };

  sources[0].status = expected;
  const valid = sources.every(({ status }) => status === expected);
  return { status: valid ? expected : null, sources };
}

function assistantText(event, type) {
  const params = eventParams(event);
  if (type === 'assistant.delta') {
    return firstString(event?.delta, params.delta);
  }
  const direct = firstString(event?.assistantMessage, event?.text, event?.turn?.assistantMessage);
  if (direct) return direct;
  const turn = currentTurnRecord(event);
  const fromTurn = extractAssistantMessage(turn);
  if (fromTurn) return fromTurn;
  return itemAssistantText(params.item);
}

export function normalizeEvent(event) {
  const type = eventType(event);
  const threadIdentity = identityState(threadIdentityCandidates(event));
  const turnIdentity = identityState(turnIdentityCandidates(event));
  const threadId = threadIdentity.value;
  const internalTurnId = turnIdentity.value;
  const publicType = type === 'supervisor.process.failed' && !threadId
    ? 'supervisor.process.notice'
    : type;
  const normalized = {
    type: publicType,
    threadId,
  };
  const statusInfo = terminalStatus(event, type);
  const statusVerified = publicType !== 'supervisor.process.notice'
    && statusInfo.status !== null
    && threadIdentity.verified
    && turnIdentity.verified;
  const status = statusVerified ? statusInfo.status : null;
  if (status) normalized.status = status;
  const message = assistantText(event, type);
  if (message !== null) normalized.assistantMessage = truncateAssistantMessage(message);
  if (publicType === 'turn.completed' || publicType === 'turn.failed' || publicType === 'turn.interrupted' || publicType === 'turn.diff.updated') {
    normalized.changes = extractTurnChanges(event);
  }
  if (type === 'error' || type === 'supervisor.process.failed') {
    const params = eventParams(event);
    const error = event?.error ?? params.error ?? event?.message ?? params.message;
    normalized.error = type === 'supervisor.process.failed'
      ? { code: 'app_server_crash', message: 'Codex app-server process failed.' }
      : safeError(error);
  }
  const hiddenProperties = {
    internalThreadIdentitySources: {
      value: Object.freeze(threadIdentity.sources.map((source) => Object.freeze({ ...source }))),
      enumerable: false,
    },
    verifiedThreadIdentity: {
      value: threadIdentity.verified,
      enumerable: false,
    },
    internalTurnIdentitySources: {
      value: Object.freeze(turnIdentity.sources.map((source) => Object.freeze({ ...source }))),
      enumerable: false,
    },
    verifiedTurnIdentity: {
      value: turnIdentity.verified,
      enumerable: false,
    },
  };
  if (internalTurnId) {
    hiddenProperties.internalTurnId = {
      value: internalTurnId,
      enumerable: false,
    };
  }
  if (TERMINAL_EVENT_STATUSES.has(type) && publicType !== 'supervisor.process.notice') {
    hiddenProperties.internalStatusSources = {
      value: Object.freeze(statusInfo.sources.map((source) => Object.freeze({ ...source }))),
      enumerable: false,
    };
    hiddenProperties.verifiedTerminalStatus = {
      value: statusVerified,
      enumerable: false,
    };
  }
  Object.defineProperties(normalized, hiddenProperties);
  return normalized;
}

export function normalizeTurn(turn) {
  if (!isRecord(turn)) {
    return null;
  }
  const status = normalizeStatus(turn);
  const message = extractAssistantMessage(turn);
  const result = {};
  if (status) result.status = status;
  if (message) {
    const key = status === 'completed' ? 'finalAssistantMessage' : 'lastAssistantMessage';
    result[key] = truncateAssistantMessage(message);
  }
  const id = turnId(turn);
  result.changes = id
    ? extractTurnChanges({ turnId: id, turn })
    : summarizeChangedFiles([]);
  return result;
}
