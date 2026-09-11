export const ERROR_CODES = Object.freeze({
  DEFAULT_MODEL_UNAVAILABLE: 'default_model_unavailable',
  HISTORY_UNAVAILABLE: 'history_unavailable',
  INVALID_EFFORT: 'invalid_effort',
  INVALID_MODEL: 'invalid_model',
  INVALID_TERMINAL_RESULT: 'invalid_terminal_result',
  INVALID_TERMINAL_STATUS: 'invalid_terminal_status',
  NO_ACTIVE_TURN: 'no_active_turn',
  SUPERVISOR_UNAVAILABLE: 'supervisor_unavailable',
  THREAD_BUSY: 'thread_busy',
  THREAD_LOCKED: 'thread_locked',
  THREAD_NOT_FOUND: 'thread_not_found',
  THREAD_WORKSPACE_MISMATCH: 'thread_workspace_mismatch',
  WORKSPACE_UNAVAILABLE: 'workspace_unavailable',
});

export class DomainError extends Error {
  constructor(code, message, { cause, data } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = new.target.name;
    this.code = code;
    if (data !== undefined) {
      this.data = data;
    }
  }
}

export class WorkspaceUnavailableError extends DomainError {
  constructor(message = 'Workspace is unavailable.') {
    super(ERROR_CODES.WORKSPACE_UNAVAILABLE, message);
  }
}

export class ThreadWorkspaceMismatchError extends DomainError {
  constructor(message = 'Thread workspace does not match the current workspace.') {
    super(ERROR_CODES.THREAD_WORKSPACE_MISMATCH, message);
  }
}

export class InvalidModelError extends DomainError {
  constructor(message = 'The requested model is not available.') {
    super(ERROR_CODES.INVALID_MODEL, message);
  }
}

export class InvalidEffortError extends DomainError {
  constructor(message = 'The requested reasoning effort is not available.') {
    super(ERROR_CODES.INVALID_EFFORT, message);
  }
}

export class DefaultModelUnavailableError extends DomainError {
  constructor(message = 'The configured default model is not available.') {
    super(ERROR_CODES.DEFAULT_MODEL_UNAVAILABLE, message);
  }
}

export class InvalidTerminalStatusError extends DomainError {
  constructor(message = 'Terminal result has an unsupported status.') {
    super(ERROR_CODES.INVALID_TERMINAL_STATUS, message);
  }
}

export class InvalidTerminalResultError extends DomainError {
  constructor(message = 'Terminal result requires a non-empty thread id.') {
    super(ERROR_CODES.INVALID_TERMINAL_RESULT, message);
  }
}

export class HistoryUnavailableError extends DomainError {
  constructor(message = 'Thread history is unavailable.') {
    super(ERROR_CODES.HISTORY_UNAVAILABLE, message);
  }
}

export class SupervisorUnavailableError extends DomainError {
  constructor(message = 'Supervisor adapter is unavailable.') {
    super(ERROR_CODES.SUPERVISOR_UNAVAILABLE, message);
  }
}

export function errorCode(error) {
  return typeof error?.code === 'string' ? error.code : 'internal_error';
}

// 唯一被规范化的上游错误：Codex app-server 在 thread 正被另一个 Codex 客户端
// 持有写锁时，返回 JSON-RPC -32600 且 message 为
// "thread <id> already has an active writer"。这是已知、可恢复的跨客户端争用
// （~/.codex 跨客户端共享），也是唯一允许改写的上游错误——其余上游错误一律保持
// 原样透传，不改 code、不改 message。
// 识别只能依据 message：上游此处复用通用码 -32600，没有可用的专用错误码。
const THREAD_LOCKED_PATTERN = /already has an active writer/i;
const THREAD_LOCKED_MESSAGE = 'Thread is locked by another Codex client. Close that client or use a new thread.';

export function normalizeSupervisorError(error) {
  if (!error || typeof error !== 'object') return error;
  if (error.code === ERROR_CODES.THREAD_LOCKED) return error;
  const message = typeof error.message === 'string' ? error.message : '';
  if (!THREAD_LOCKED_PATTERN.test(message)) return error;
  return new DomainError(ERROR_CODES.THREAD_LOCKED, THREAD_LOCKED_MESSAGE, { cause: error });
}
