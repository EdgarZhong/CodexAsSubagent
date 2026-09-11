import net from 'node:net';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';

import { ensureServer } from '../server/startup-lock.mjs';
import { errorCode, normalizeSupervisorError } from '../shared/errors.mjs';
import { projectPublic } from './response-projector.mjs';
import { getToolCallDefinition, TOOL_DEFINITIONS } from './tool-registry.mjs';
import { validateArguments } from './tool-handlers.mjs';
import { resolveWorkspaceContext } from './workspace-context.mjs';

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
    workspaceGuard,
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
    this.workspaceGuard = workspaceGuard;
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
    if (this.stdout.write(line)) return;
    await new Promise((resolve) => this.stdout.once('drain', resolve));
  }

  async handleRequest(request, context) {
    const response = await this.forward(request, context);
    const publicResponse = { id: response.id };
    if (response.error) publicResponse.error = response.error;
    else publicResponse.result = response.result;
    await this.#write(publicResponse);
    if (response.deliveryId) {
      try {
        await this.forward({
          id: nextId(),
          method: 'delivery.ack',
          params: { deliveryId: response.deliveryId },
        }, context);
      } catch {
        await this.forward({
          id: nextId(),
          method: 'delivery.nack',
          params: { deliveryId: response.deliveryId },
        }, context).catch(() => {});
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
      deliveryId: response.deliveryId ?? null,
    };
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
      await this.#write(response);
      return response;
    }
    const { response, deliveryId } = forwarded;
    await this.#write(response);
    if (deliveryId) {
      try {
        await this.forward({ id: nextId(), method: 'delivery.ack', params: { deliveryId } }, context);
      } catch {
        await this.forward({ id: nextId(), method: 'delivery.nack', params: { deliveryId } }, context).catch(() => {});
      }
    }
    return response;
  }

  async run() {
    const context = await resolveWorkspaceContext({ cwd: this.cwd, workspaceGuard: this.workspaceGuard });
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
  }
}

export function createStdioBootstrap(options) {
  return new StdioBootstrap(options);
}
