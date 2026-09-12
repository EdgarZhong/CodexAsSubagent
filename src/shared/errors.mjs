export const ERROR_CODES = Object.freeze({
  DEFAULT_MODEL_UNAVAILABLE: 'default_model_unavailable',
  HISTORY_UNAVAILABLE: 'history_unavailable',
  HOST_REQUIRED: 'host_required',
  INVALID_EFFORT: 'invalid_effort',
  INVALID_MODEL: 'invalid_model',
  INVALID_TERMINAL_RESULT: 'invalid_terminal_result',
  INVALID_TERMINAL_STATUS: 'invalid_terminal_status',
  MULTIPLE_ACTIVE_HOST_SERVERS: 'multiple_active_host_servers',
  NO_ACTIVE_TURN: 'no_active_turn',
  SESSION_CONFLICT: 'session_conflict',
  SESSION_NOT_ESTABLISHED: 'session_not_established',
  SUPERVISOR_UNAVAILABLE: 'supervisor_unavailable',
  THREAD_BUSY: 'thread_busy',
  THREAD_HELD: 'thread_held',
  THREAD_LOCKED: 'thread_locked',
  THREAD_NOT_FOUND: 'thread_not_found',
  THREAD_WORKSPACE_MISMATCH: 'thread_workspace_mismatch',
  UNKNOWN_HOST: 'unknown_host',
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

// ctx 缺失 host（bootstrap 未提供）时 fail closed（规格 §2.2：Host 必须静态指定，
// 不得从 cwd/session/参数推断）。
export class HostRequiredError extends DomainError {
  constructor(message = 'A host context is required for this operation.') {
    super(ERROR_CODES.HOST_REQUIRED, message);
  }
}

// 弱 Host 无 current_session 时的正式行为（架构设计 §四）：self-recovering admission
// failure，恢复路径固定为重新经 PreToolUse Session Gate 建立 current_session 后重试。
export class SessionNotEstablishedError extends DomainError {
  constructor(message = 'Session is not established for this host and workspace. Establish the current session through the PreToolUse Session Gate, then retry.') {
    super(ERROR_CODES.SESSION_NOT_ESTABLISHED, message);
  }
}

// CAS Host Ownership 层的跨 Host 控制权冲突（实施规格 §3.10）。
// message 固定，holderHost 只能通过 data 携带；MCP 投影必须保留 error.data。
export class ThreadHeldError extends DomainError {
  constructor(holderHost) {
    super(ERROR_CODES.THREAD_HELD, 'Thread is currently held by another host.', {
      data: { holderHost },
    });
  }
}

// 未知 Host（实施规格 §3.2）：Host 是产品类型，只能取自 Host Protocol Registry；
// 未知 --host 必须在任何 CAS 状态读写之前失败（fail closed）。
export class UnknownHostError extends DomainError {
  constructor(hostId, { knownHostIds = [] } = {}) {
    const known = knownHostIds.length > 0 ? ` Known hosts: ${knownHostIds.join(', ')}.` : '';
    super(ERROR_CODES.UNKNOWN_HOST, `Unknown host: ${hostId ?? '(missing)'}.${known}`);
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
