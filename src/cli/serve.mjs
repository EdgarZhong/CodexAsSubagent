import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { createSupervisorAdapter } from '../adapters/supervisor/app-server-adapter.mjs';
import { openSqliteStore, DEFAULT_DATA_DIR } from '../adapters/sqlite/sqlite-store.mjs';
import { createCompletionRouter } from '../core/completion-router.mjs';
import { createCompletionStore } from '../core/completion-store.mjs';
import { createExecutionStore } from '../core/execution-store.mjs';
import { ModelService } from '../core/model-service.mjs';
import { createRuntimeManager } from '../core/runtime-manager.mjs';
import { WorkspaceGuard } from '../core/workspace-guard.mjs';
import { createHistoryAdapter } from '../adapters/supervisor/history-adapter.mjs';
import { createRuntimeServer } from '../server/server.mjs';
import { recoverState } from '../server/recovery.mjs';
import { createServerLogger } from '../shared/server-log.mjs';
import { option } from '../shared/argv.mjs';

export async function serve(argv = []) {
  const dataDir = option(argv, '--data-dir', DEFAULT_DATA_DIR);
  const socketPath = option(argv, '--socket', join(dataDir, 'server.sock'));
  const lockPath = option(argv, '--lock', join(dataDir, 'server.lock'));
  const idleShutdownMs = Number(option(argv, '--idle-shutdown-ms', '3000'));
  const logger = createServerLogger({ dataDir });
  logger.info('serve.start', { dataDir, socketPath, lockPath, idleShutdownMs });
  const store = openSqliteStore(dataDir);
  const adapter = createSupervisorAdapter();
  const executions = createExecutionStore(store);
  const completions = createCompletionStore(store);
  const router = createCompletionRouter({ executions, completions });
  const history = createHistoryAdapter(adapter);
  const runtime = createRuntimeManager({
    adapter,
    workspaceGuard: new WorkspaceGuard(),
    modelService: new ModelService({ adapter }),
    executionStore: executions,
    completionStore: completions,
    completionRouter: router,
    historyAdapter: history,
    ownerInstanceId: randomUUID(),
  });
  await recoverState({ executionStore: executions, historyAdapter: history, completionRouter: router });
  let storeClosed = false;
  const server = createRuntimeServer({
    runtime,
    socketPath,
    idleShutdownMs,
    onShutdown: (reason) => logger.info('serve.shutdown', { reason }),
    onClosed: () => {
      if (storeClosed) return;
      storeClosed = true;
      store.close();
      logger.info('serve.closed', { socketPath });
    },
  });
  await server.listen(socketPath);
  logger.info('serve.listening', { socketPath });
  const shutdown = async (signal) => {
    logger.info('serve.signal', { signal });
    await server.close();
  };
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.once('SIGINT', () => { void shutdown('SIGINT'); });
  void lockPath;
  return { server, runtime, store, socketPath, lockPath, shutdown, logger };
}
