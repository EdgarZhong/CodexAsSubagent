import net from 'node:net';
import { mkdir, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

import { LifecycleManager } from './lifecycle-manager.mjs';
import { RequestRouter } from './request-router.mjs';

function activeCount(runtime) {
  return runtime?.executionStore?.listExecutions?.().length ?? 0;
}

function unackedCount(runtime) {
  return runtime?.completionStore?.listCompletions?.({ deliveryState: 'claimed_waiter' }).length ?? 0;
}

export class RuntimeServer {
  constructor({
    runtime,
    requestRouter = null,
    lifecycle = null,
    socketPath = null,
    instanceId = randomUUID(),
    idleShutdownMs = 3_000,
    onShutdown = null,
    onClosed = null,
  } = {}) {
    if (!runtime) throw new TypeError('RuntimeServer requires a RuntimeManager.');
    this.runtime = runtime;
    this.requestRouter = requestRouter ?? new RequestRouter({ runtime });
    this.socketPath = socketPath;
    this.instanceId = instanceId;
    this.server = null;
    this.connections = new Set();
    this.closed = false;
    this.onShutdown = onShutdown;
    this.onClosed = onClosed;
    this.lifecycle = lifecycle ?? new LifecycleManager({
      idleShutdownMs,
      getActiveExecutionCount: () => activeCount(this.runtime),
      getUnackedDirectCount: () => unackedCount(this.runtime),
      onShutdown: async () => {
        if (typeof this.onShutdown === 'function') this.onShutdown('idle');
        await this.close();
      },
    });
    // 异步 terminal 事件会把 execution 从 SQLite 移除，但没有任何请求边界再触发
    // idle 判定；订阅运行时状态变更，才能让 idle shutdown 及时生效。
    this.unsubscribeStateChanges = typeof this.runtime.subscribeStateChanges === 'function'
      ? this.runtime.subscribeStateChanges(() => this.lifecycle.noteStateChange())
      : null;
  }

  async listen(socketPath = this.socketPath) {
    if (typeof socketPath !== 'string' || socketPath.length === 0) {
      throw new TypeError('RuntimeServer requires a socket path.');
    }
    if (this.server) return this;
    this.socketPath = socketPath;
    await mkdir(dirname(socketPath), { recursive: true });
    await unlink(socketPath).catch(() => {});
    this.server = net.createServer((socket) => this.#handleConnection(socket));
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        this.server?.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        this.server?.off('error', onError);
        resolve();
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(socketPath);
    });
    // Server 可能被 lazy 拉起却始终没有请求；先 armed 一次 idle 计时，
    // 保证空转的服务也能自行退出而不是永久驻留。
    this.lifecycle.noteStateChange();
    return this;
  }

  async handle(request) {
    this.lifecycle.noteRequestStart();
    try {
      return await this.requestRouter.handle(request);
    } finally {
      this.lifecycle.noteRequestEnd();
    }
  }

  #handleConnection(socket) {
    this.connections.add(socket);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', async (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let request;
        try {
          request = JSON.parse(line);
        } catch {
          await this.#write(socket, { id: null, error: { code: 'invalid_json', message: 'Request must be JSON.' } });
          continue;
        }
        const response = await this.handle(request);
        await this.#write(socket, response);
      }
    });
    socket.once('close', () => this.connections.delete(socket));
    socket.once('error', () => this.connections.delete(socket));
  }

  async #write(socket, response) {
    if (socket.destroyed) return false;
    const line = `${JSON.stringify(response)}\n`;
    if (socket.write(line)) return true;
    await new Promise((resolve) => socket.once('drain', resolve));
    return true;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.lifecycle.close();
    if (typeof this.unsubscribeStateChanges === 'function') this.unsubscribeStateChanges();
    this.unsubscribeStateChanges = null;
    for (const socket of this.connections) socket.destroy();
    this.connections.clear();
    if (this.server) {
      await new Promise((resolve) => this.server.close(() => resolve()));
      this.server = null;
    }
    if (this.socketPath) await unlink(this.socketPath).catch(() => {});
    // runtime.close 会一并终止 supervisor 子进程；必须 await，否则孤儿 app-server
    // 会拖住事件循环让 Server 进程无法退出。
    await this.runtime.close?.();
    if (typeof this.onClosed === 'function') this.onClosed();
  }
}

export function createRuntimeServer(options) {
  return new RuntimeServer(options);
}
