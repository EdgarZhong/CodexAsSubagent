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
