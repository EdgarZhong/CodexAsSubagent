import net from 'node:net';
import readline from 'node:readline';
import { spawn } from 'node:child_process';

import { ensureServer } from '../server/startup-lock.mjs';
import { resolveWorkspaceContext } from './workspace-context.mjs';

function nextId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function defaultStartServer({ socketPath, lockPath }) {
  const cli = process.env.CODEX_AS_SUBAGENT_CLI ?? process.argv[1];
  if (typeof cli !== 'string' || cli.length === 0) {
    throw new Error('Cannot lazily start Runtime Server without a CLI entrypoint.');
  }
  const child = spawn(process.execPath, [cli, 'serve', '--socket', socketPath, '--lock', lockPath], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
}

export class StdioBootstrap {
  constructor({
    socketPath,
    lockPath,
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
      await this.handleRequest(request, context);
    }
  }
}

export function createStdioBootstrap(options) {
  return new StdioBootstrap(options);
}
