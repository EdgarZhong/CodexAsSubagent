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

function renderOne(completion) {
  const payload = payloadOf(completion) || {};
  const threadId = typeof payload.threadId === 'string' ? payload.threadId : 'unknown-thread';
  const status = typeof payload.status === 'string' ? payload.status : 'unknown';
  const completionId = typeof completion?.completionId === 'string'
    ? ` (${completion.completionId})`
    : '';
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

export function renderCompletions(completions, host = 'plain') {
  if (!Array.isArray(completions)) throw new TypeError('completions must be an array.');
  const wrapper = resolveHost(host);
  const text = completions.map(renderOne).join('\n\n');
  const rendered = wrapper.wrap(text, completions);
  if (typeof rendered !== 'string') throw new TypeError('Host wrapper must return text.');
  return rendered;
}

export function availableHosts() {
  return [...HOSTS.keys()];
}
