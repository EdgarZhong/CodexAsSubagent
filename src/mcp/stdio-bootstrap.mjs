import net from 'node:net';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { appendFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { DEFAULT_DATA_DIR, openSqliteStore } from '../adapters/sqlite/sqlite-store.mjs';
import { HEARTBEAT_INTERVAL_MS, PRESENCE_LEASE_MS } from '../shared/constants.mjs';
import { ensureServer } from '../server/startup-lock.mjs';
import { errorCode, normalizeSupervisorError } from '../shared/errors.mjs';
import { projectPublic } from './response-projector.mjs';
import { getToolCallDefinition, TOOL_DEFINITIONS } from './tool-registry.mjs';
import { validateArguments } from './tool-handlers.mjs';
import { resolveWorkspaceContext } from './workspace-context.mjs';
import { getHostAdapter } from '../hosts/registry.mjs';

function nextId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function defaultStartServer({ socketPath, lockPath, dataDir }) {
  const cli = process.env.CODEX_AS_SUBAGENT_CLI ?? process.argv[1];
  if (typeof cli !== 'string' || cli.length === 0) {
    throw new Error('Cannot lazily start Runtime Server without a CLI entrypoint.');
  }
  // serve 需要 --data-dir 才能把 SQLite 落在与 socket/lock 相同的目录；
  // 只传 socket/lock 时 serve 会退回默认 data dir，导致两处状态分叉。
  const resolvedDataDir = typeof dataDir === 'string' && dataDir.length > 0
    ? dataDir
    : dirname(socketPath);
  const child = spawn(process.execPath, [
    cli,
    'serve',
    '--socket', socketPath,
    '--lock', lockPath,
    '--data-dir', resolvedDataDir,
  ], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
}

// MCP Presence 生产实现（实施规格 §3.5 / §1.4）：Bootstrap 进程直写 SQLite
// attach/heartbeat/detach，不经 Runtime Server RPC，也不得唤醒 Runtime Server。
// intervalMs/leaseMs/clock 均可注入（测试禁止真实等待）。
export function createSqlitePresenceHelper({
  host,
  dataDir = null,
  intervalMs = HEARTBEAT_INTERVAL_MS,
  leaseMs = PRESENCE_LEASE_MS,
  instanceId = randomUUID(),
  openStore = openSqliteStore,
  now = () => new Date().toISOString(),
} = {}) {
  let store = null;
  return {
    host,
    intervalMs,
    leaseMs,
    instanceId,
    attach(workspace) {
      store = openStore(dataDir ?? undefined);
      store.attachHostPresence({ host, workspace, instanceId, now: now(), leaseMs });
    },
    heartbeat(workspace) {
      if (!store) return;
      store.heartbeatHostPresence({ host, workspace, instanceId, now: now(), leaseMs });
    },
    detach(workspace) {
      if (!store) return;
      try {
        store.detachHostPresence({ host, workspace, instanceId });
      } finally {
        store.close();
        store = null;
      }
    },
  };
}

// 进程退出钩子（SIGINT/SIGTERM/beforeExit）注册器；测试可注入替身避免污染真实 process。
export function defaultExitHooks(handler) {
  const onSignal = () => {
    handler();
    process.exit(0);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  process.once('beforeExit', handler);
  return () => {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('beforeExit', handler);
  };
}

const SERVER_INFO = Object.freeze({
  name: 'codex-as-subagent',
  version: '0.1.0',
});

function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id, code, message, data = undefined) {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
  };
}

function toolContent(value) {
  return [{ type: 'text', text: JSON.stringify(value) }];
}

function toolErrorContent(error) {
  // 唯一允许改写的上游错误：跨客户端线程写锁争用（见 shared/errors.mjs）。
  // 其余错误的 code/message 一律原样透传。
  const normalized = normalizeSupervisorError(error);
  return toolContent({
    code: errorCode(normalized),
    message: normalized?.message ?? 'Tool call failed.',
  });
}

export class StdioBootstrap {
  constructor({
    socketPath,
    lockPath,
    dataDir = null,
    cwd = process.cwd(),
    host = null,
    workspaceGuard,
    presenceHelper = null,
    exitHooks = defaultExitHooks,
    instanceId,
    stdin = process.stdin,
    stdout = process.stdout,
    ensure = ensureServer,
    startServer = null,
    connect = null,
  } = {}) {
    if (typeof socketPath !== 'string' || socketPath.length === 0) throw new TypeError('StdioBootstrap requires socketPath.');
    this.socketPath = socketPath;
    this.lockPath = lockPath;
    this.dataDir = dataDir;
    this.cwd = cwd;
    this.host = host;
    this.workspaceGuard = workspaceGuard;
    this.presenceHelper = presenceHelper;
    this.exitHooks = exitHooks;
    this.instanceId = instanceId;
    this.stdin = stdin;
    this.stdout = stdout;
    this.ensure = ensure;
    this.startServer = startServer ?? defaultStartServer;
    this.connect = connect;
  }

  async #socketRequest(request) {
    const socket = this.connect ? await this.connect(this.socketPath) : net.createConnection(this.socketPath);
    return await new Promise((resolve, reject) => {
      let buffer = '';
      const onData = (chunk) => {
        buffer += chunk.toString();
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        const line = buffer.slice(0, newline).trim();
        socket.end();
        try {
          resolve(JSON.parse(line));
        } catch (error) {
          reject(error);
        }
      };
      socket.setEncoding?.('utf8');
      socket.on('data', onData);
      socket.once('error', reject);
      const send = () => socket.write(`${JSON.stringify(request)}\n`);
      if (socket.readyState === 'open' || socket.writable) send();
      else socket.once('connect', send);
    });
  }

  async forward(request, context) {
    await this.ensure({
      socketPath: this.socketPath,
      lockPath: this.lockPath,
      dataDir: this.dataDir,
      startServer: this.startServer,
    });
    return await this.#socketRequest({ ...request, context });
  }

  async #write(value) {
    const line = `${JSON.stringify(value)}\n`;
    await new Promise((resolve, reject) => {
      // write callback 在该行被底层处理（或失败）时触发；出错必须传播，
      // 让调用方有机会对已 claim 的 delivery 发送 NACK。
      this.stdout.write(line, (error) => (error ? reject(error) : resolve()));
    });
  }

  async #reportDelivery(context, method, claimId) {
    return await this.forward({
      id: nextId(),
      method,
      params: { claimId, host: context?.host },
    }, context);
  }

  async handleRequest(request, context) {
    const response = await this.forward(request, context);
    const publicResponse = { id: response.id };
    if (response.error) publicResponse.error = response.error;
    else publicResponse.result = response.result;
    try {
      await this.#write(publicResponse);
    } catch (error) {
      // stdout 写出失败：宿主永远看不到该 delivery，立即 NACK 回 pending
      // （V2：不再放任 lease 过期），然后让错误传播终止循环。
      if (response.claimId) {
        await this.#reportDelivery(context, 'delivery.nack', response.claimId).catch(() => {});
      }
      throw error;
    }
    if (response.claimId) {
      try {
        await this.#reportDelivery(context, 'delivery.ack', response.claimId);
      } catch {
        await this.#reportDelivery(context, 'delivery.nack', response.claimId).catch(() => {});
      }
    }
    return publicResponse;
  }

  async #forwardToolCall(id, name, args, context) {
    try {
      validateArguments(name, args);
    } catch (error) {
      return {
        response: jsonRpcResult(id, {
          content: toolErrorContent(error),
          isError: true,
        }),
      };
    }
    const tool = getToolCallDefinition(name);
    if (!tool) {
      return { response: jsonRpcResult(id, {
        content: toolErrorContent(new Error(`Unknown tool: ${name}`)),
        isError: true,
      }) };
    }
    const response = await this.forward({ id, method: tool.method, params: args }, context);
    const value = response.error ? response.error : projectPublic(response.result);
    const result = {
      content: response.error ? toolErrorContent(response.error) : toolContent(value),
      isError: Boolean(response.error),
    };
    return {
      response: jsonRpcResult(id, result),
      claimId: response.claimId ?? null,
    };
  }

  // 宿主协议探针：仅当 <dataDir>/mcp-debug 标志文件存在时，把 initialize 原文和
  // 进程上下文追加到 <dataDir>/mcp-debug.log。用于确认宿主（如 Kimi 插件 MCP）
  // 是否在 initialize 中携带 workspace 信息。调试通道，永不影响协议行为。
  async #debugLogInitialize(request) {
    if (typeof this.dataDir !== 'string' || this.dataDir.length === 0) return;
    try {
      const flag = join(this.dataDir, 'mcp-debug');
      if (!(await stat(flag)).isFile()) return;
      const line = `${JSON.stringify({
        at: new Date().toISOString(),
        pid: process.pid,
        cwd: process.cwd(),
        kimiPluginRoot: process.env.KIMI_PLUGIN_ROOT ?? null,
        request,
      })}\n`;
      await appendFile(join(this.dataDir, 'mcp-debug.log'), line, 'utf8');
    } catch {
      // 调试日志失败必须静默。
    }
  }

  async handleMcpRequest(request, context) {
    const id = request?.id ?? null;
    const method = request?.method;
    if (typeof method !== 'string') {
      return jsonRpcError(id, -32600, 'Request method is required.');
    }
    if (method === 'notifications/initialized' || method.startsWith('notifications/')) return null;
    if (method === 'ping') return jsonRpcResult(id, {});
    if (method === 'initialize') {
      await this.#debugLogInitialize(request);
      return jsonRpcResult(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }
    if (method === 'tools/list') {
      return jsonRpcResult(id, { tools: TOOL_DEFINITIONS });
    }
    if (method !== 'tools/call') return jsonRpcError(id, -32601, `Method not found: ${method}`);
    const params = request.params && typeof request.params === 'object' ? request.params : {};
    if (typeof params.name !== 'string' || params.name.length === 0) {
      return jsonRpcError(id, -32602, 'tools/call requires a tool name.');
    }
    const args = params.arguments === undefined ? {} : params.arguments;
    let forwarded;
    try {
      forwarded = await this.#forwardToolCall(id, params.name, args, context);
    } catch (error) {
      const response = jsonRpcResult(id, {
        content: toolErrorContent(error),
        isError: true,
      });
      try {
        await this.#write(response);
      } catch (writeError) {
        if (forwarded?.claimId) {
          await this.#reportDelivery(context, 'delivery.nack', forwarded.claimId).catch(() => {});
        }
        throw writeError;
      }
      return response;
    }
    const { response, claimId } = forwarded;
    try {
      await this.#write(response);
    } catch (error) {
      if (claimId) {
        await this.#reportDelivery(context, 'delivery.nack', claimId).catch(() => {});
      }
      throw error;
    }
    if (claimId) {
      try {
        await this.#reportDelivery(context, 'delivery.ack', claimId);
      } catch {
        await this.#reportDelivery(context, 'delivery.nack', claimId).catch(() => {});
      }
    }
    return response;
  }

  async run() {
    // Host 身份 fail closed：未知/缺失 host 必须在任何 CAS 状态读写（含 presence
    // attach）之前失败（实施规格 §3.2/§3.13）。
    getHostAdapter(this.host);
    const context = await resolveWorkspaceContext({
      cwd: this.cwd,
      host: this.host,
      workspaceGuard: this.workspaceGuard,
    });
    // Presence 生命周期（§3.5）：注册成功后才进入 MCP 处理循环；heartbeat 按
    // interval 直写 SQLite；进程退出 best-effort detach。
    const presence = this.presenceHelper
      ?? createSqlitePresenceHelper({ host: this.host, dataDir: this.dataDir, instanceId: this.instanceId });
    presence.attach(context.workspace);
    let detached = false;
    const detachOnce = () => {
      if (detached) return;
      detached = true;
      try {
        presence.detach(context.workspace);
      } catch {
        // best-effort：退出路径的 detach 失败不得阻塞进程终止。
      }
    };
    const unregisterHooks = this.exitHooks(detachOnce);
    const heartbeatTimer = setInterval(() => {
      try {
        presence.heartbeat(context.workspace);
      } catch {
        // 单次心跳失败静默：lease 远大于 interval，下个周期自动补齐。
      }
    }, presence.intervalMs);
    heartbeatTimer.unref?.();
    try {
      const lines = readline.createInterface({ input: this.stdin, crlfDelay: Infinity });
      for await (const line of lines) {
        if (!line.trim()) continue;
        let request;
        try {
          request = JSON.parse(line);
        } catch {
          await this.#write({ id: null, error: { code: 'invalid_json', message: 'Request must be JSON.' } });
          continue;
        }
        const isMcp = request?.jsonrpc === '2.0'
          || (typeof request?.method === 'string'
            && (request.method === 'initialize'
              || request.method === 'notifications/initialized'
              || request.method === 'tools/list'
              || request.method === 'tools/call'
              || request.method === 'ping'
              || request.method.startsWith('notifications/')));
        if (isMcp) {
          const response = await this.handleMcpRequest(request, context);
          if (response) {
            // tools/call writes inside handleMcpRequest after ACK-safe projection.
            if (request.method !== 'tools/call') await this.#write(response);
          }
        } else {
          await this.handleRequest(request, context);
        }
      }
    } finally {
      clearInterval(heartbeatTimer);
      unregisterHooks();
      detachOnce();
    }
  }
}

export function createStdioBootstrap(options) {
  return new StdioBootstrap(options);
}
