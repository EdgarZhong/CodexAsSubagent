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

const INTERNAL_PROJECTION_KEYS = new Set([
  'approval',
  'cursor',
  'eventCursor',
  'params',
  'raw',
  'receivedAt',
  'request',
  'requestId',
  'requestKey',
  'sequence',
  'turnId',
]);

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
  return summarizeChangedFiles(files).files;
}

export function summarizeChangedFiles(files) {
  if (!Array.isArray(files)) {
    return { files: [], filesChanged: 0, filesTruncated: false };
  }

  const allFiles = [];
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
    allFiles.push(normalized);
  }
  return {
    files: allFiles.slice(0, MAX_CHANGED_FILES),
    filesChanged: allFiles.length,
    filesTruncated: allFiles.length > MAX_CHANGED_FILES,
  };
}

export const STATUS_EVIDENCE_FIELDS = Object.freeze([
  'status', 'reason', 'terminalStatus', 'terminal_status', 'executionStatus',
]);

function statusToken(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const status = value.toLowerCase().trim();
  if (status === 'completed' || status === 'complete' || status === 'success') {
    return 'completed';
  }
  if (status === 'interrupted' || status === 'interrupt' || status === 'cancelled' || status === 'canceled') {
    return 'interrupted';
  }
  if (status === 'failed' || status === 'error') {
    return 'failed';
  }
  if (['active', 'queued', 'running', 'waiting'].includes(status)) return status;
  if (['inprogress', 'in_progress', 'in-progress', 'in progress'].includes(status)) return 'inprogress';
  if (['waitingonapproval', 'waiting_on_approval', 'waiting-on-approval', 'waiting on approval'].includes(status)) {
    return 'waitingonapproval';
  }
  return null;
}

// Keep every explicit discriminator: null is invalid evidence, never an absent source.
export function statusSources(value, source = 'status', seen = new WeakSet()) {
  if (!isRecord(value)) return [{ source, status: statusToken(value) }];
  if (seen.has(value)) return [{ source, status: null }];
  seen.add(value);
  const fields = ['type', ...STATUS_EVIDENCE_FIELDS].filter((field) => Object.hasOwn(value, field));
  const sources = fields.length === 0 ? [{ source, status: null }] : fields.flatMap((field) => (
    statusSources(value[field], `${source}.${field}`, seen)
  ));
  seen.delete(value);
  return sources;
}

export function normalizeStatus(value) {
  const sources = statusSources(value);
  const status = sources[0].status;
  return status !== null && sources.every((entry) => entry.status === status) ? status : null;
}

export function normalizeTerminalStatus(value) {
  const status = normalizeStatus(value);
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
  const seen = new WeakSet();
  const project = (entry) => {
    if (Array.isArray(entry)) {
      return entry.map(project);
    }
    if (!isRecord(entry)) {
      return entry;
    }
    if (seen.has(entry)) {
      return undefined;
    }
    seen.add(entry);
    const result = {};
    for (const [key, child] of Object.entries(entry)) {
      if (INTERNAL_PROJECTION_KEYS.has(key)) {
        continue;
      }
      result[key] = project(child);
    }
    seen.delete(entry);
    return result;
  };

  if (!isRecord(value) && !Array.isArray(value)) {
    return value;
  }
  return project(value);
}
