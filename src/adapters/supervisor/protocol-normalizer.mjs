import {
  isRecord,
  normalizeTerminalStatus,
  safeError,
  summarizeChangedFiles,
  truncateAssistantMessage,
} from '../../shared/protocol.mjs';

function firstString(...values) {
  return values.find((value) => typeof value === 'string' && value.length > 0) ?? null;
}

function eventParams(event) {
  return isRecord(event?.params) ? event.params : {};
}

function extractThreadId(event) {
  const params = eventParams(event);
  return firstString(
    event?.threadId,
    event?.thread?.id,
    params.threadId,
    params.thread?.id,
    params.turn?.threadId,
    params.item?.threadId,
  );
}

function extractTurnId(event) {
  const params = eventParams(event);
  return firstString(
    event?.turnId,
    event?.internalTurnId,
    params.turnId,
    params.item?.turnId,
  );
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

function fileChangesFromParams(params) {
  const files = [];
  if (isRecord(params.diff)) {
    if (Array.isArray(params.diff.files)) files.push(...params.diff.files);
    if (Array.isArray(params.diff.fileChanges)) files.push(...params.diff.fileChanges);
    if (isRecord(params.diff.changes) && Array.isArray(params.diff.changes.files)) {
      files.push(...params.diff.changes.files);
    }
  }
  if (Array.isArray(params.fileChanges)) files.push(...params.fileChanges);
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
    ...fileChangesFromParams(eventParams(event)),
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
  const normalized = method.replaceAll('/', '.');
  if (isProcessFailure(event, normalized)) return 'supervisor.process.failed';
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

function terminalStatus(event, type) {
  if (type === 'supervisor.process.failed') {
    return 'failed';
  }
  if (type === 'turn.failed') return 'failed';
  if (type === 'turn.interrupted') return 'interrupted';
  if (type !== 'turn.completed') return null;
  const params = eventParams(event);
  return normalizeTerminalStatus(
    event?.status
      ?? event?.turn?.status
      ?? params.status
      ?? params.turn?.status,
  ) ?? 'completed';
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
  const normalized = {
    type,
    threadId: extractThreadId(event),
  };
  const status = terminalStatus(event, type);
  if (status) normalized.status = status;
  const message = assistantText(event, type);
  if (message !== null) normalized.assistantMessage = truncateAssistantMessage(message);
  if (type === 'turn.completed' || type === 'turn.failed' || type === 'turn.interrupted' || type === 'turn.diff.updated') {
    normalized.changes = extractTurnChanges(event);
  }
  if (type === 'error' || type === 'supervisor.process.failed') {
    const params = eventParams(event);
    const error = event?.error ?? params.error ?? event?.message ?? params.message;
    normalized.error = type === 'supervisor.process.failed'
      ? { code: 'app_server_crash', message: 'Codex app-server process failed.' }
      : safeError(error);
  }
  return normalized;
}

export function normalizeTurn(turn) {
  if (!isRecord(turn)) {
    return null;
  }
  const rawStatus = turn.status?.type ?? turn.status;
  const status = typeof rawStatus === 'string' ? normalizeTerminalStatus(rawStatus) ?? rawStatus : null;
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
