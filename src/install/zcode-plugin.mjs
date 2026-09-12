import { access, copyFile, cp, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { discoverCodexBinary as discoverCodexBinaryShared } from '../shared/codex-runtime.mjs';

// src/install/zcode-plugin.mjs -> 仓库根（npm 全局安装时同样成立，因包内保持同一相对结构）
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PLUGIN_SOURCE_DIR = join(REPO_ROOT, 'plugins', 'zcode');
export const CLI_ENTRY = join(REPO_ROOT, 'src', 'cli', 'main.mjs');

export const PLUGIN_NAME = 'codex-as-subagent';
export const MARKETPLACE_NAME = 'codex-as-subagent-local';
// 决策 12：vendor 默认启动参数会让 app-server 退出，必须显式指定。
export const DEFAULT_APP_SERVER_ARGS = '["app-server"]';

export function resolveZcodeRoot(options = {}) {
  const explicit = options.zcodeRoot;
  if (typeof explicit === 'string' && explicit.length > 0) return resolve(explicit);
  const env = process.env.ZCODE_HOME;
  if (typeof env === 'string' && env.length > 0) return resolve(env);
  return join(homedir(), '.zcode', 'cli');
}

export function pluginPaths(zcodeRoot) {
  const pluginsDir = join(zcodeRoot, 'plugins');
  return {
    zcodeRoot,
    pluginsDir,
    cacheDir: join(pluginsDir, 'cache'),
    knownMarketplaces: join(pluginsDir, 'known_marketplaces.json'),
    installedPlugins: join(pluginsDir, 'installed_plugins.json'),
    config: join(zcodeRoot, 'config.json'),
  };
}

export function pluginId() {
  return `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(path, value) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tmp, path);
}

// 首次覆盖前保留一份原始备份；已存在则不覆盖，保证用户始终能回到安装前状态。
async function backupOnce(path) {
  const backup = `${path}.bak-cas`;
  try {
    await access(backup, constants.F_OK);
    return backup;
  } catch {
    // 备份不存在，继续创建。
  }
  try {
    await copyFile(path, backup);
    return backup;
  } catch {
    return null;
  }
}

// 与 Server 端共用设计 6.4 的解析顺序，避免两份实现漂移。
// 注意：这是"存在性"快速选择，只用于把 CODEX_BIN 作为显式配置写进插件 env（优先级 0 的
// 提前命中，属可选优化）。真正的能力探测在 Server 冷启动时执行（probeCodexRuntime），
// 因此即使此处未命中，运行时仍会自动发现。
export async function discoverCodexBinary({ env = process.env } = {}) {
  return discoverCodexBinaryShared({ env });
}

// 把插件里的裸命令改写成 `node <cli>`，使插件不依赖 PATH 解析我们的命令。
export function localizeMcpConfig(mcp, { cliPath = CLI_ENTRY, env = {} } = {}) {
  const servers = { ...(mcp?.mcpServers ?? {}) };
  const current = servers[PLUGIN_NAME] ?? {};
  servers[PLUGIN_NAME] = {
    ...current,
    type: 'stdio',
    command: process.execPath,
    args: [cliPath, ...(Array.isArray(current.args) ? current.args : ['mcp'])],
    ...(Object.keys(env).length > 0 ? { env: { ...(current.env ?? {}), ...env } } : {}),
  };
  return { ...mcp, mcpServers: servers };
}

export function localizeHooksConfig(hooks, { cliPath = CLI_ENTRY } = {}) {
  const events = {};
  for (const [event, groups] of Object.entries(hooks?.hooks ?? {})) {
    events[event] = (Array.isArray(groups) ? groups : []).map((group) => ({
      ...group,
      hooks: (Array.isArray(group?.hooks) ? group.hooks : []).map((hook) => ({
        ...hook,
        command: process.execPath,
        args: [cliPath, ...(Array.isArray(hook?.args) ? hook.args : [])],
      })),
    }));
  }
  return { ...hooks, hooks: events };
}

function upsertById(list, entry) {
  const index = list.findIndex((item) => item?.id === entry.id);
  if (index >= 0) list[index] = { ...list[index], ...entry };
  else list.push(entry);
  return list;
}

export async function installZcodePlugin(options = {}) {
  const zcodeRoot = resolveZcodeRoot(options);
  const paths = pluginPaths(zcodeRoot);
  const now = (options.now ?? (() => new Date()))().toISOString();
  const portable = options.portable === true;
  const dryRun = options.dryRun === true;
  const cliPath = options.cliPath ?? CLI_ENTRY;
  const pluginSource = options.pluginSource ?? PLUGIN_SOURCE_DIR;
  const execPath = options.execPath ?? process.execPath;

  const manifest = await readJson(join(pluginSource, '.zcode-plugin', 'plugin.json'), null);
  if (!manifest || typeof manifest.version !== 'string') {
    throw new Error(`插件源缺少有效 manifest: ${pluginSource}`);
  }
  const version = manifest.version;
  const installPath = join(paths.cacheDir, MARKETPLACE_NAME, PLUGIN_NAME, version);
  const id = pluginId();

  const codexBinary = options.codexBinary ?? await discoverCodexBinary({ env: options.env ?? process.env });
  const pluginEnv = {
    ...(codexBinary ? { CODEX_BIN: codexBinary } : {}),
    CODEX_APP_SERVER_ARGS: options.appServerArgs ?? DEFAULT_APP_SERVER_ARGS,
  };

  const plan = {
    zcodeRoot,
    installPath,
    id,
    version,
    portable,
    dryRun,
    codexBinary,
    files: [],
    actions: [],
  };

  // 1) 拷贝插件源到缓存目录
  plan.actions.push(`copy ${pluginSource} -> ${installPath}`);
  plan.files.push(join(installPath, '.mcp.json'));
  plan.files.push(join(installPath, 'hooks', 'hooks.json'));

  // 2) 注册 marketplace
  const known = await readJson(paths.knownMarketplaces, { version: 1, marketplaces: [] });
  known.version ??= 1;
  known.marketplaces ??= [];
  plan.actions.push(`register marketplace ${MARKETPLACE_NAME} -> ${REPO_ROOT}`);
  upsertById(known.marketplaces, {
    id: MARKETPLACE_NAME,
    source: { source: 'directory', path: REPO_ROOT },
    name: MARKETPLACE_NAME,
    description: 'Local marketplace for Codex As Subagent (installed via CLI).',
    addedAt: now,
    lastUpdated: now,
    pluginCount: 1,
  });

  // 3) 写安装记录
  const installed = await readJson(paths.installedPlugins, { version: 1, plugins: [] });
  installed.version ??= 1;
  installed.plugins ??= [];
  plan.actions.push(`register plugin ${id} (v${version})`);
  upsertById(installed.plugins, {
    id,
    name: PLUGIN_NAME,
    marketplace: MARKETPLACE_NAME,
    version,
    installPath,
    installedAt: now,
    updatedAt: now,
    scope: 'user',
    source: 'plugins/zcode',
  });

  // 4) 启用插件
  const config = await readJson(paths.config, {});
  config.plugins ??= {};
  config.plugins.enabledPlugins ??= {};
  plan.actions.push(`enable ${id}`);
  config.plugins.enabledPlugins[id] = true;

  plan.installedPlugins = installed;
  plan.knownMarketplaces = known;
  plan.config = config;

  if (dryRun) return plan;

  // 备份原状态文件（仅一次）
  for (const file of [paths.knownMarketplaces, paths.installedPlugins, paths.config]) {
    const backup = await backupOnce(file);
    if (backup) plan.actions.push(`backup ${file} -> ${backup}`);
  }

  // 拷贝 + 本地化
  await mkdir(dirname(installPath), { recursive: true });
  await cp(pluginSource, installPath, { recursive: true, force: true });

  const mcpPath = join(installPath, '.mcp.json');
  const hooksPath = join(installPath, 'hooks', 'hooks.json');
  if (portable) {
    plan.actions.push('portable: 保留裸命令（要求 codex-as-subagent 在 PATH 中）');
  } else {
    const mcp = await readJson(mcpPath, null);
    const hooks = await readJson(hooksPath, null);
    if (mcp) await writeJsonAtomic(mcpPath, localizeMcpConfig(mcp, { cliPath, env: pluginEnv }));
    if (hooks) await writeJsonAtomic(hooksPath, localizeHooksConfig(hooks, { cliPath }));
    plan.actions.push(`localize: command=${execPath} args=[${cliPath} ...]`);
  }

  await writeJsonAtomic(paths.knownMarketplaces, known);
  await writeJsonAtomic(paths.installedPlugins, installed);
  await writeJsonAtomic(paths.config, config);

  return plan;
}
