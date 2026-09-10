import {
  capChangedFiles,
  isRecord,
  normalizeTerminalStatus,
  safeError,
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
    event?.turn?.id,
    params.turnId,
    params.turn?.id,
    params.item?.turnId,
  );
}

function currentTurnRecord(event) {
  if (!isRecord(event)) {
    return null;
  }
  return isRecord(event.turn)
    ? event.turn
    : isRecord(event.turnRecord)
      ? event.turnRecord
      : isRecord(event.currentTurn)
        ? event.currentTurn
        : null;
}

function fileChangesFromTurn(turn) {
  if (!isRecord(turn)) {
    return [];
  }
  if (Array.isArray(turn.fileChanges)) {
    return turn.fileChanges;
  }
  if (isRecord(turn.changes) && Array.isArray(turn.changes.files)) {
    return turn.changes.files;
  }
  if (Array.isArray(turn.changes)) {
    return turn.changes;
  }
  return [];
}

export function extractTurnChanges(event) {
  const turn = currentTurnRecord(event);
  if (!turn) {
    return { files: [] };
  }

  const eventTurnId = extractTurnId(event);
  const turnId = firstString(turn.id, turn.turnId);
  if (eventTurnId && turnId && eventTurnId !== turnId) {
    return { files: [] };
  }
  return { files: capChangedFiles(fileChangesFromTurn(turn)) };
}

function eventType(event) {
  const method = firstString(event?.method, event?.type, eventParams(event).method) ?? 'unknown';
  const normalized = method.replaceAll('/', '.');
  if (normalized === 'turn.completed' || normalized === 'turn.complete') return 'turn.completed';
  if (normalized === 'turn.started' || normalized === 'turn.start') return 'turn.started';
  if (normalized === 'item.agentMessage.delta') return 'assistant.delta';
  if (normalized === 'item.completed') return 'item.completed';
  if (normalized === 'turn.diff.updated') return 'turn.diff.updated';
  if (normalized === 'thread.status.changed') return 'thread.status.changed';
  if (normalized === 'error') return 'error';
  return normalized;
}

function assistantText(event, type) {
  const params = eventParams(event);
  const value = firstString(
    event?.assistantMessage,
    event?.text,
    event?.delta,
    event?.message,
    event?.turn?.assistantMessage,
    event?.turn?.text,
    event?.turn?.message,
    params.assistantMessage,
    params.text,
    params.delta,
    params.item?.text,
  );
  if (!value) {
    return null;
  }
  return type === 'assistant.delta' ? value : truncateAssistantMessage(value);
}

function eventStatus(event, type) {
  const params = eventParams(event);
  const direct = normalizeTerminalStatus(
    firstString(event?.status, event?.turn?.status, params.status, params.turn?.status),
  );
  if (direct) {
    return direct;
  }
  if (type === 'turn.completed') return 'completed';
  if (type === 'error') return 'failed';
  return null;
}

export function normalizeEvent(event) {
  const type = eventType(event);
  const normalized = {
    type,
    threadId: extractThreadId(event),
  };
  const status = eventStatus(event, type);
  if (status) {
    normalized.status = status;
  }
  const message = assistantText(event, type);
  if (message !== null) {
    normalized.assistantMessage = message;
  }
  if (type === 'turn.completed' || type === 'turn.diff.updated') {
    normalized.changes = extractTurnChanges(event);
  }
  if (type === 'error') {
    const params = eventParams(event);
    normalized.error = safeError(event?.error ?? params.error ?? event?.message ?? params.message);
  }
  return normalized;
}

export function normalizeTurn(turn) {
  if (!isRecord(turn)) {
    return null;
  }
  const result = {};
  if (typeof turn.id === 'string') result.id = turn.id;
  if (typeof turn.status === 'string') result.status = normalizeTerminalStatus(turn.status) ?? turn.status;
  const message = firstString(turn.assistantMessage, turn.text, turn.message);
  if (message !== null) result.assistantMessage = truncateAssistantMessage(message);
  result.changes = { files: capChangedFiles(fileChangesFromTurn(turn)) };
  return result;
}
