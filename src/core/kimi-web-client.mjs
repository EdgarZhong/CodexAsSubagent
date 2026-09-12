import { readdir, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

// V2 Kimi Web 集成（适配说明 §四）：本模块只保留 Server discovery 原语与
// session-addressed HTTP client。legacy 的 detached worker / 轮询循环 /
// worker registry 已废除，Web 回流由 src/core/web-delivery.mjs 事件驱动。

export const KIMI_WEB_MODEL = 'kimi-code/kimi-for-coding';
export const DEFAULT_KIMI_CODE_HOME = join(homedir(), '.kimi-code');

// KIMI_CODE_HOME 解析（自 legacy src/cli/kimi-web.mjs 迁移）：
// 显式参数 > 环境变量 > 用户默认目录。
export function resolveKimiCodeHome(options = {}) {
  const explicit = options.kimiCodeHome;
  if (typeof explicit === 'string' && explicit.length > 0) return resolve(explicit);
  const envValue = options.env?.KIMI_CODE_HOME ?? process.env.KIMI_CODE_HOME;
  if (typeof envValue === 'string' && envValue.length > 0) return resolve(envValue);
  return DEFAULT_KIMI_CODE_HOME;
}

function requiredString(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${name} must be a non-empty string.`);
  return value;
}

function apiError(message, details = {}) {
  const error = new Error(message);
  Object.assign(error, details);
  return error;
}

function jsonResponse(value) {
  return value && typeof value.json === 'function' ? value.json() : value;
}

function envelopeData(body, response, { idempotentCodes = [] } = {}) {
  const code = body?.code;
  const status = Number(response?.status ?? 200);
  if (idempotentCodes.includes(code) || idempotentCodes.includes(String(code))) {
    return { accepted: true, idempotent: true, data: body?.data ?? null, code };
  }
  if (!(status >= 200 && status < 300)) {
    throw apiError(`Kimi Server API HTTP ${status}${body?.msg ? `: ${body.msg}` : ''}`, {
      status,
      code,
      data: body?.data,
    });
  }
  if (body && body.code !== undefined && body.code !== 0 && body.code !== '0') {
    throw apiError(`Kimi Server API error ${body.code}${body.msg ? `: ${body.msg}` : ''}`, {
      status,
      code,
      data: body.data,
    });
  }
  return { accepted: true, idempotent: false, data: body?.data ?? body ?? null, code: body?.code ?? 0 };
}

export function instanceBaseUrl(instance) {
  const raw = instance?.base_url
    ?? instance?.baseUrl
    ?? instance?.server_url
    ?? instance?.serverUrl
    ?? instance?.url
    ?? (instance?.host && instance?.port ? `http://${instance.host}:${instance.port}` : null);
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    return new URL(raw).toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

export function sessionWorkspace(session) {
  const value = session?.metadata?.cwd
    ?? session?.metadata?.workspace
    ?? session?.cwd
    ?? session?.workspace?.cwd
    ?? session?.workspace?.path
    ?? (typeof session?.workspace === 'string' ? session.workspace : null);
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export async function canonicalWorkspace(value, resolver = realpath) {
  requiredString(value, 'workspace');
  return resolve(await resolver(value));
}

// Server instance registry（知识库 §10.1）：$KIMI_CODE_HOME/server/instances/<serverId>.json。
// JSON 无法解析的记录被跳过（不阻止发现其他实例），但仍会留在返回值之外由调用方计数。
export async function readInstanceFiles(home, { readDir = readdir, readJsonFile = readFile } = {}) {
  const directory = join(home, 'server', 'instances');
  let entries;
  try {
    entries = await readDir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = entries
    .filter((entry) => (typeof entry === 'string' ? entry : entry.name)?.endsWith('.json'))
    .map((entry) => typeof entry === 'string' ? entry : entry.name)
    .sort();
  const result = [];
  for (const file of files) {
    try {
      const raw = await readJsonFile(join(directory, file), 'utf8');
      const value = JSON.parse(String(raw));
      if (value && typeof value === 'object') result.push({ file, value });
    } catch {
      // 一个损坏的实例记录不能阻止其他 Server 被发现。
    }
  }
  return result;
}

export async function discoverKimiServer({
  home = DEFAULT_KIMI_CODE_HOME,
  sessionId,
  workspace,
  fetchImpl = globalThis.fetch,
  readDir = readdir,
  readJsonFile = readFile,
  resolveWorkspace = realpath,
} = {}) {
  requiredString(sessionId, 'sessionId');
  const canonical = await canonicalWorkspace(workspace, resolveWorkspace);
  if (typeof fetchImpl !== 'function') throw new TypeError('discoverKimiServer requires fetchImpl.');

  let token;
  try {
    token = (await readJsonFile(join(home, 'server.token'), 'utf8')).trim();
  } catch {
    return null;
  }
  if (token.length === 0) return null;

  for (const { file, value: instance } of await readInstanceFiles(home, { readDir, readJsonFile })) {
    const baseUrl = instanceBaseUrl(instance);
    if (!baseUrl) continue;
    const headers = { Authorization: `Bearer ${token}` };
    try {
      const response = await fetchImpl(
        `${baseUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}`,
        { method: 'GET', headers },
      );
      const body = await jsonResponse(response);
      const result = envelopeData(body, response);
      const session = result.data;
      const returnedId = session?.id ?? session?.session_id;
      const returnedWorkspace = sessionWorkspace(session);
      if (returnedId !== sessionId || !returnedWorkspace) continue;
      const returnedCanonical = await canonicalWorkspace(returnedWorkspace, resolveWorkspace);
      if (returnedCanonical !== canonical) continue;
      return {
        serverId: instance.server_id ?? instance.serverId ?? instance.id ?? file.replace(/\.json$/, ''),
        baseUrl,
        token,
        sessionId,
        workspace: canonical,
        instance,
      };
    } catch {
      // 404、过期实例和短暂网络错误都只淘汰当前候选，继续扫描其他实例。
    }
  }
  return null;
}

export function promptIdForCompletion(completionId) {
  requiredString(completionId, 'completionId');
  const safe = completionId.replace(/[^A-Za-z0-9._~-]/g, '-');
  return `codex-as-subagent-${safe}`;
}

export class KimiWebClient {
  constructor({ baseUrl, token, fetchImpl = globalThis.fetch, sessionId } = {}) {
    this.baseUrl = requiredString(baseUrl, 'baseUrl').replace(/\/$/, '');
    this.token = requiredString(token, 'token');
    this.fetchImpl = fetchImpl;
    this.sessionId = sessionId;
    if (typeof fetchImpl !== 'function') throw new TypeError('KimiWebClient requires fetchImpl.');
  }

  async #request(path, { method = 'GET', body, idempotentCodes = [] } = {}) {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const parsed = await jsonResponse(response);
    return envelopeData(parsed, response, { idempotentCodes });
  }

  // Session 归属校验入口（适配说明 §四：Web 投递前必须确认目标 Session 存在
  // 且 workspace 与 completion 一致）。
  async readSession({ sessionId = this.sessionId } = {}) {
    requiredString(sessionId, 'sessionId');
    return this.#request(`/api/v1/sessions/${encodeURIComponent(sessionId)}`);
  }

  async readPromptQueue({ sessionId = this.sessionId } = {}) {
    requiredString(sessionId, 'sessionId');
    const result = await this.#request(`/api/v1/sessions/${encodeURIComponent(sessionId)}/prompts`);
    return result.data ?? { active: null, queued: [] };
  }

  async submitCompletion({ sessionId = this.sessionId, completionId, text, model = KIMI_WEB_MODEL } = {}) {
    requiredString(sessionId, 'sessionId');
    requiredString(completionId, 'completionId');
    if (model !== KIMI_WEB_MODEL) throw new TypeError(`Kimi Web delivery only permits ${KIMI_WEB_MODEL}.`);
    const promptId = promptIdForCompletion(completionId);
    const queue = await this.readPromptQueue({ sessionId });
    const submitted = await this.#request(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/prompts`,
      {
        method: 'POST',
        body: {
          prompt_id: promptId,
          content: [{ type: 'text', text: String(text ?? '') }],
          model: KIMI_WEB_MODEL,
        },
        idempotentCodes: [40903, '40903', 40927, '40927'],
      },
    );
    let steered = false;
    if (queue?.active) {
      try {
        await this.#request(
          `/api/v1/sessions/${encodeURIComponent(sessionId)}/prompts/${encodeURIComponent(promptId)}:steer`,
          { method: 'POST', idempotentCodes: [40402, '40402', 40903, '40903'] },
        );
        steered = true;
      } catch (error) {
        // submit 已接受但 prompt 可能已经被 active loop 消费；这类丢队列是幂等成功。
        if (!(error?.code === 40402 || error?.code === '40402' || error?.code === 40903 || error?.code === '40903')) {
          throw error;
        }
      }
    }
    return {
      accepted: true,
      idempotent: Boolean(submitted.idempotent),
      promptId,
      model: KIMI_WEB_MODEL,
      steered,
      data: submitted.data,
    };
  }
}
