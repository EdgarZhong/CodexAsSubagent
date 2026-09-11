import { join } from 'node:path';

import { DEFAULT_DATA_DIR } from '../adapters/sqlite/sqlite-store.mjs';
import { StdioBootstrap } from '../mcp/stdio-bootstrap.mjs';

function option(argv, name, fallback) {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

export async function mcp(argv = []) {
  const dataDir = option(argv, '--data-dir', DEFAULT_DATA_DIR);
  const bootstrap = new StdioBootstrap({
    socketPath: option(argv, '--socket', join(dataDir, 'server.sock')),
    lockPath: option(argv, '--lock', join(dataDir, 'server.lock')),
  });
  await bootstrap.run();
  return 0;
}
