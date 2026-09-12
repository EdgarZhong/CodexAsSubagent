export const DEFAULT_MODEL = 'gpt-5.6-luna';
export const DEFAULT_EFFORT = 'xhigh';

export const MAX_CHANGED_FILES = 20;
export const MAX_ASSISTANT_MESSAGE_CHARS = 16_000;
export const TERMINAL_STATUSES = Object.freeze([
  'completed',
  'failed',
  'interrupted',
]);

// V2 Host Presence：MCP Bootstrap 心跳间隔与 Presence 租约时长。
// Store 的 attach/heartbeat 支持通过参数注入覆盖（测试禁止真实等待）。
export const HEARTBEAT_INTERVAL_MS = 20_000;
export const PRESENCE_LEASE_MS = 60_000;
