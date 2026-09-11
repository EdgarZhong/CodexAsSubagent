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
  return runtime?.completionStore?.listCompletions?.({ deliveryState: 'claimed_direct' }).length ?? 0;
}

export class RuntimeServer {
  constructor({
    runtime,
    requestRouter = null,
    lifecycle = null,
    socketPath = null,
    instanceId = randomUUID(),
    idleShutdownMs = 3_000,
  } = {}) {
    if (!runtime) throw new TypeError('RuntimeServer requires a RuntimeManager.');
    this.runtime = runtime;
    this.requestRouter = requestRouter ?? new RequestRouter({ runtime });
    this.socketPath = socketPath;
    this.instanceId = instanceId;
    this.server = null;
    this.connections = new Set();
    this.closed = false;
    this.lifecycle = lifecycle ?? new LifecycleManager({
      idleShutdownMs,
      getActiveExecutionCount: () => activeCount(this.runtime),
      getUnackedDirectCount: () => unackedCount(this.runtime),
      onShutdown: async () => this.close(),
    });
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
    for (const socket of this.connections) socket.destroy();
    this.connections.clear();
    if (this.server) {
      await new Promise((resolve) => this.server.close(() => resolve()));
      this.server = null;
    }
    if (this.socketPath) await unlink(this.socketPath).catch(() => {});
    this.runtime.close?.();
  }
}

export function createRuntimeServer(options) {
  return new RuntimeServer(options);
}
