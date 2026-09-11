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

function option(argv, name, fallback) {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

export async function serve(argv = []) {
  const dataDir = option(argv, '--data-dir', DEFAULT_DATA_DIR);
  const socketPath = option(argv, '--socket', join(dataDir, 'server.sock'));
  const lockPath = option(argv, '--lock', join(dataDir, 'server.lock'));
  const idleShutdownMs = Number(option(argv, '--idle-shutdown-ms', '3000'));
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
  const server = createRuntimeServer({ runtime, socketPath, idleShutdownMs });
  await server.listen(socketPath);
  const shutdown = async () => {
    await server.close();
    store.close();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  void lockPath;
  return { server, runtime, store, socketPath, lockPath, shutdown };
}
