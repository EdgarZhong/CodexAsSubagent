import plain from './hosts/plain.mjs';
import zcode from './hosts/zcode.mjs';
import kimiCode from './hosts/kimi-code.mjs';
import claudeCode from './hosts/claude-code.mjs';
import grokBuild from './hosts/grok-build.mjs';
import pi from './hosts/pi.mjs';

const HOSTS = Object.freeze(new Map([
  [plain.name, plain],
  [zcode.name, zcode],
  [kimiCode.name, kimiCode],
  [claudeCode.name, claudeCode],
  [grokBuild.name, grokBuild],
  [pi.name, pi],
]));

function payloadOf(completion) {
  return completion?.payload ?? completion?.result ?? completion ?? {};
}

function messageOf(payload) {
  return payload.status === 'completed'
    ? payload.finalAssistantMessage
    : payload.lastAssistantMessage;
}

// completionId 仅用于交付去重与日志比对，模型可见接口只认 threadId。
// UUID 形态的 id 截到第一段（8 位十六进制）足以区分，避免把内部主键整条外泄。
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function shortCompletionId(value) {
  if (typeof value !== 'string' || value.length === 0) return '';
  if (!UUID_PATTERN.test(value)) return value;
  return value.slice(0, 8);
}

function renderOne(completion) {
  const payload = payloadOf(completion) || {};
  const threadId = typeof payload.threadId === 'string' ? payload.threadId : 'unknown-thread';
  const status = typeof payload.status === 'string' ? payload.status : 'unknown';
  const shortId = shortCompletionId(completion?.completionId);
  const completionId = shortId.length > 0 ? ` (${shortId})` : '';
  const lines = [`Codex subagent ${threadId} ${status}${completionId}`];
  const message = messageOf(payload);
  if (typeof message === 'string' && message.length > 0) lines.push(message);
  const files = payload.changes?.files;
  if (Array.isArray(files) && files.length > 0) {
    const paths = files.map((file) => typeof file === 'string' ? file : file?.path).filter(Boolean);
    if (paths.length > 0) lines.push(`Changed files: ${paths.join(', ')}`);
  }
  if (payload.error?.message) lines.push(`Error: ${payload.error.message}`);
  return lines.join('\n');
}

function resolveHost(host) {
  if (typeof host === 'object' && typeof host?.wrap === 'function') return host;
  if (typeof host !== 'string' || !HOSTS.has(host)) {
    throw new TypeError(`Unknown completion host: ${host}`);
  }
  return HOSTS.get(host);
}

export function renderCompletions(completions, host = 'plain', context = {}) {
  if (!Array.isArray(completions)) throw new TypeError('completions must be an array.');
  const wrapper = resolveHost(host);
  const text = completions.map(renderOne).join('\n\n');
  const rendered = wrapper.wrap(text, completions, context);
  if (typeof rendered !== 'string') throw new TypeError('Host wrapper must return text.');
  return rendered;
}

export function availableHosts() {
  return [...HOSTS.keys()];
}
