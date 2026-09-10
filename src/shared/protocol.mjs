import {
  MAX_ASSISTANT_MESSAGE_CHARS,
  MAX_CHANGED_FILES,
  TERMINAL_STATUSES,
} from './constants.mjs';

export {
  MAX_ASSISTANT_MESSAGE_CHARS,
  MAX_CHANGED_FILES,
  TERMINAL_STATUSES,
};

export const MAX_FILES = MAX_CHANGED_FILES;
export const MAX_ASSISTANT_CHARS = MAX_ASSISTANT_MESSAGE_CHARS;

export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function truncateAssistantMessage(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.slice(0, MAX_ASSISTANT_MESSAGE_CHARS);
}

function normalizeFile(file) {
  if (typeof file === 'string' && file.length > 0) {
    return file;
  }
  if (!isRecord(file) || typeof file.path !== 'string' || file.path.length === 0) {
    return null;
  }

  const normalized = { path: file.path };
  const kind = file.kind ?? file.operation ?? file.status;
  if (typeof kind === 'string' && kind.length > 0) {
    normalized.kind = kind;
  }
  return normalized;
}

export function capChangedFiles(files) {
  if (!Array.isArray(files)) {
    return [];
  }

  const result = [];
  const seen = new Set();
  for (const file of files) {
    const normalized = normalizeFile(file);
    if (!normalized) {
      continue;
    }
    const key = typeof normalized === 'string' ? normalized : normalized.path;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
    if (result.length >= MAX_CHANGED_FILES) {
      break;
    }
  }
  return result;
}

export function normalizeTerminalStatus(value) {
  if (isRecord(value)) {
    return normalizeTerminalStatus(value.type ?? value.status);
  }
  if (typeof value !== 'string') {
    return null;
  }
  const status = value.toLowerCase().replaceAll('/', '.');
  if (status.endsWith('.completed') || status.endsWith('.complete')) return 'completed';
  if (status.endsWith('.interrupted') || status.endsWith('.cancelled') || status.endsWith('.canceled')) {
    return 'interrupted';
  }
  if (status.endsWith('.failed') || status.endsWith('.error')) return 'failed';
  if (status === 'completed' || status === 'complete' || status === 'success') {
    return 'completed';
  }
  if (status === 'interrupted' || status === 'interrupt' || status === 'cancelled' || status === 'canceled') {
    return 'interrupted';
  }
  if (status === 'failed' || status === 'error') {
    return 'failed';
  }
  return TERMINAL_STATUSES.includes(status) ? status : null;
}

export function safeError(error) {
  if (error === null || error === undefined) {
    return null;
  }
  if (typeof error === 'string') {
    return { code: 'upstream_error', message: error.slice(0, 4_000) };
  }
  if (!isRecord(error)) {
    return { code: 'upstream_error', message: String(error).slice(0, 4_000) };
  }

  const code = typeof error.code === 'string' && error.code.length > 0
    ? error.code
    : typeof error.type === 'string' && error.type.length > 0
      ? error.type
      : 'upstream_error';
  const messageValue = error.message ?? error.detail ?? error.reason ?? 'Supervisor operation failed.';
  return {
    code,
    message: String(messageValue).slice(0, 4_000),
  };
}

export function publicProjection(value) {
  if (!isRecord(value)) {
    return value;
  }
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'turnId' || key === 'eventCursor' || key === 'cursor' || key === 'raw') {
      continue;
    }
    result[key] = entry;
  }
  return result;
}
