const objectSchema = (properties = {}, required = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

const string = { type: 'string', minLength: 1 };

const toolCallProperties = Object.freeze({
  codex_spawn: { method: 'runtime.spawn', project: 'spawn' },
  codex_send: { method: 'runtime.send', project: 'spawn' },
  codex_steer: { method: 'runtime.steer', project: 'public' },
  codex_status: { method: 'runtime.status', project: 'status' },
  codex_wait: { method: 'runtime.wait', project: 'terminal' },
  codex_wait_many: { method: 'runtime.wait_many', project: 'waitMany' },
  codex_interrupt: { method: 'runtime.interrupt', project: 'interrupt' },
  codex_list_threads: { method: 'runtime.list_threads', project: 'listThreads' },
  codex_read_thread: { method: 'runtime.read_thread', project: 'readThread' },
  codex_models: { method: 'runtime.models', project: 'models' },
});

export const TOOL_DEFINITIONS = Object.freeze([
  { name: 'codex_spawn', description: '在当前 workspace 异步启动一个 Codex subagent。', inputSchema: objectSchema({ prompt: string, model: string, effort: string }, ['prompt']) },
  { name: 'codex_send', description: '向空闲的 Codex subagent 发送下一条任务。', inputSchema: objectSchema({ threadId: string, prompt: string, model: string, effort: string }, ['threadId', 'prompt']) },
  { name: 'codex_steer', description: '向当前 active turn 追加 guidance。', inputSchema: objectSchema({ threadId: string, prompt: string }, ['threadId', 'prompt']) },
  { name: 'codex_status', description: '读取当前 workspace 内 subagent 的紧凑 liveness snapshot。', inputSchema: objectSchema({ threadId: string }, ['threadId']) },
  { name: 'codex_wait', description: '等待一个 subagent 的 terminal result，固定最多等待 500 秒。', inputSchema: objectSchema({ threadId: string }, ['threadId']) },
  { name: 'codex_wait_many', description: '等待一组 subagent，或等待调用瞬间的全部 active threads。', inputSchema: objectSchema({ threads: { anyOf: [{ type: 'string', enum: ['all'] }, { type: 'array', items: string, minItems: 1 }] } }, ['threads']) },
  { name: 'codex_interrupt', description: '请求中断当前 active turn，返回请求 ACK。', inputSchema: objectSchema({ threadId: string }, ['threadId']) },
  { name: 'codex_list_threads', description: '列出当前 workspace 最近最多 25 个 subagent threads。', inputSchema: objectSchema() },
  { name: 'codex_read_thread', description: '读取一个 subagent 的紧凑历史摘要。', inputSchema: objectSchema({ threadId: string }, ['threadId']) },
  { name: 'codex_models', description: '读取 dedicated Codex profile 的默认模型和可用模型目录。', inputSchema: objectSchema() },
]);

export function getToolDefinition(name) {
  return TOOL_DEFINITIONS.find((tool) => tool.name === name) ?? null;
}

export function getToolCallDefinition(name) {
  return toolCallProperties[name] ?? null;
}

export function hasExactToolSet() {
  return TOOL_DEFINITIONS.length === 10
    && new Set(TOOL_DEFINITIONS.map((tool) => tool.name)).size === 10;
}
