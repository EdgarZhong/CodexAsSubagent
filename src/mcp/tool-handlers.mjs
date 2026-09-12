import { DomainError } from '../shared/errors.mjs';
import {
  projectInterrupt,
  projectListThreads,
  projectModels,
  projectPublic,
  projectReadThread,
  projectSpawnAck,
  projectStatus,
  projectTerminalResult,
  projectWaitMany,
} from './response-projector.mjs';
import { getToolDefinition } from './tool-registry.mjs';

function validateArguments(name, args) {
  const definition = getToolDefinition(name);
  if (!definition) throw new DomainError('tool_not_found', `Unknown tool: ${name}`);
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new DomainError('invalid_arguments', `Arguments for ${name} must be an object.`);
  }
  const schema = definition.inputSchema;
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(schema.properties ?? {}, key)) {
      throw new DomainError('invalid_arguments', `Argument ${key} is not accepted by ${name}.`);
    }
  }
  for (const [key, value] of Object.entries(args)) {
    const property = schema.properties?.[key];
    if (property?.type === 'string' && (typeof value !== 'string' || value.length < (property.minLength ?? 0))) {
      throw new DomainError('invalid_arguments', `Argument ${key} must be a non-empty string.`);
    }
    if (property?.anyOf && !property.anyOf.some((candidate) => (
      (candidate.type === 'string' && candidate.enum?.includes(value))
      || (candidate.type === 'array' && Array.isArray(value))
    ))) {
      throw new DomainError('invalid_arguments', `Argument ${key} has an invalid value.`);
    }
  }
  for (const key of schema.required ?? []) {
    if (!Object.hasOwn(args, key)) {
      throw new DomainError('invalid_arguments', `Argument ${key} is required by ${name}.`);
    }
  }
  if (name === 'codex_wait_many'
    && !(args.threads === 'all'
      || (Array.isArray(args.threads)
        && args.threads.length > 0
        && args.threads.every((id) => typeof id === 'string' && id.length > 0)))) {
    throw new DomainError('invalid_arguments', 'threads must be "all" or a non-empty string array.');
  }
  return args;
}

// 进程内直连路径：ctx 协议与 RequestRouter 一致——调用方提供 {host, workspace}，
// 在此处统一经 runtime.sessionContext() 解析 SessionContext（缺失 → session_not_established）。
export async function handleToolCall(name, args, ctx = {}) {
  const runtime = ctx.runtime;
  if (!runtime) throw new DomainError('supervisor_unavailable', 'Runtime Manager is unavailable.');
  const input = validateArguments(name, args === undefined ? {} : args);
  const session = await runtime.sessionContext(ctx);
  switch (name) {
    case 'codex_spawn': return projectSpawnAck(await runtime.spawn(session, input));
    case 'codex_send': return projectSpawnAck(await runtime.send(session, input));
    case 'codex_steer': return projectPublic(await runtime.steer(session, input));
    case 'codex_status': return projectStatus(await runtime.status(session, input.threadId));
    case 'codex_wait': return projectTerminalResult(await runtime.wait(session, input.threadId));
    case 'codex_wait_many': return projectWaitMany(await runtime.waitMany(session, input.threads));
    case 'codex_interrupt': return projectInterrupt(await runtime.interrupt(session, input.threadId));
    case 'codex_list_threads': return projectListThreads(await runtime.listThreads(session));
    case 'codex_read_thread': return projectReadThread(await runtime.readThread(session, input.threadId));
    case 'codex_models': return projectModels(await runtime.models(session));
    default: throw new DomainError('tool_not_found', `Unknown tool: ${name}`);
  }
}

export { validateArguments };
