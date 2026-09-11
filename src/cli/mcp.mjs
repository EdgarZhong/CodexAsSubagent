import { join } from 'node:path';

import { DEFAULT_DATA_DIR } from '../adapters/sqlite/sqlite-store.mjs';
import { StdioBootstrap } from '../mcp/stdio-bootstrap.mjs';
import { option } from '../shared/argv.mjs';

export async function mcp(argv = []) {
  const dataDir = option(argv, '--data-dir', DEFAULT_DATA_DIR);
  const bootstrap = new StdioBootstrap({
    socketPath: option(argv, '--socket', join(dataDir, 'server.sock')),
    lockPath: option(argv, '--lock', join(dataDir, 'server.lock')),
    dataDir,
  });
  await bootstrap.run();
  return 0;
}
