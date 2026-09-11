import { open, readFile, unlink, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import net from 'node:net';

async function exists(path) {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

export async function readStartupLock(lockPath) {
  try {
    return JSON.parse(await readFile(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

export async function probeSocket(socketPath, { timeoutMs = 250 } = {}) {
  if (typeof socketPath !== 'string' || socketPath.length === 0) return false;
  return await new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    socket.once('connect', () => {
      clearTimeout(timer);
      finish(true);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      finish(false);
    });
  });
}

export async function waitForSocket(socketPath, { timeoutMs = 5_000, pollMs = 25, probe = probeSocket } = {}) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await probe(socketPath)) return true;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  } while (Date.now() < deadline);
  return false;
}

async function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function acquireStartupLock(lockPath, {
  socketPath = null,
  instanceId = randomUUID(),
  pid = process.pid,
  startedAt = new Date().toISOString(),
  isProcessAlive = processAlive,
  probe = probeSocket,
} = {}) {
  await mkdir(dirname(lockPath), { recursive: true });
  const record = { pid, instanceId, socketPath, startedAt };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
      await handle.close();
      let released = false;
      return {
        acquired: true,
        record,
        async release() {
          if (released) return;
          released = true;
          const current = await readStartupLock(lockPath);
          if (current?.instanceId === instanceId) await unlink(lockPath).catch(() => {});
        },
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const current = await readStartupLock(lockPath);
      const healthy = current
        && await isProcessAlive(current.pid)
        && await probe(current.socketPath ?? socketPath);
      if (healthy) return { acquired: false, record: current };
      if (attempt === 0 && await exists(lockPath)) {
        await unlink(lockPath).catch(() => {});
        continue;
      }
      return { acquired: false, stale: true, record: current };
    }
  }
  return { acquired: false };
}

export async function ensureServer({
  socketPath,
  lockPath,
  startServer,
  timeoutMs = 5_000,
  probe = probeSocket,
  ...lockOptions
} = {}) {
  if (await probe(socketPath)) return { started: false, socketPath };
  if (typeof startServer !== 'function') {
    throw new TypeError('ensureServer requires startServer when the socket is unavailable.');
  }
  const lock = await acquireStartupLock(lockPath, { socketPath, probe, ...lockOptions });
  if (lock.acquired) {
    try {
      await startServer({ socketPath, lockPath, instanceId: lock.record.instanceId });
    } finally {
      await lock.release();
    }
  }
  if (!await waitForSocket(socketPath, { timeoutMs, probe })) {
    throw new Error('Runtime Server did not become healthy before startup timeout.');
  }
  return { started: lock.acquired, socketPath };
}
