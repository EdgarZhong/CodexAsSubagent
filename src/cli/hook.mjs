import { join } from 'node:path';

import { openSqliteStore, DEFAULT_DATA_DIR } from '../adapters/sqlite/sqlite-store.mjs';
import { createCompletionStore } from '../core/completion-store.mjs';
import { drainPending } from '../hook/drain.mjs';

function option(argv, name, fallback) {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

export async function hook(argv = [], { stdout = process.stdout } = {}) {
  const dataDir = option(argv, '--data-dir', DEFAULT_DATA_DIR);
  const store = openSqliteStore(dataDir);
  try {
    await drainPending({
      workspace: option(argv, '--workspace', process.cwd()),
      host: option(argv, '--host', 'plain'),
      store: createCompletionStore(store),
      output: stdout,
    });
    return 0;
  } finally {
    store.close();
  }
}
