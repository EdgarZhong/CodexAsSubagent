import { access, copyFile, cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PLUGIN_SOURCE_DIR = join(REPO_ROOT, 'plugins', 'kimi-code');
export const CLI_ENTRY = join(REPO_ROOT, 'src', 'cli', 'main.mjs');
export const PLUGIN_NAME = 'codex-as-subagent';
// 插件 manifest 注册的 MCP 会被宿主以 cwd=插件托管目录拉起，workspace 永远错配；
// MCP 必须注册在用户级 mcp.json（宿主以 workspace.cwd 作为 stdio 默认工作目录），
// 插件 manifest 只承载 hooks / system prompt 等与 cwd 无关的资源。
export const USER_MCP_SERVER_NAME = PLUGIN_NAME;
// Kimi 用户级配置根目录（由安装器自有定义）。
export const DEFAULT_KIMI_CODE_HOME = join(homedir(), '.kimi-code');
export const USER_MCP_STARTUP_TIMEOUT_MS = 60000;
// CAS codex_wait/wait_many 协议上限 500s，超时需覆盖协议上限并留传输余量（知识库 §19）。
export const USER_MCP_TOOL_TIMEOUT_MS = 520000;

export function resolveKimiCodeHome(options = {}) {
  const explicit = options.kimiCodeHome;
  if (typeof explicit === 'string' && explicit.length > 0) return resolve(explicit);
  const env = options.env?.KIMI_CODE_HOME ?? process.env.KIMI_CODE_HOME;
  if (typeof env === 'string' && env.length > 0) return resolve(env);
  return DEFAULT_KIMI_CODE_HOME;
}

export function pluginPaths(kimiCodeHome) {
  const home = resolve(kimiCodeHome);
  return {
    kimiCodeHome: home,
    pluginsDir: join(home, 'plugins'),
    managedDir: join(home, 'plugins', 'managed'),
    installPath: join(home, 'plugins', 'managed', PLUGIN_NAME),
    installedPlugins: join(home, 'plugins', 'installed.json'),
    userMcpJson: join(home, 'mcp.json'),
  };
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tmp, path);
}

async function backupOnce(path) {
  const backup = `${path}.bak-cas`;
  try {
    await access(backup, constants.F_OK);
    return backup;
  } catch {
    // 首次覆盖才建立备份。
  }
  try {
    await copyFile(path, backup);
    return backup;
  } catch {
    try {
      await cp(path, backup, { recursive: true, force: false, errorOnExist: true });
      return backup;
    } catch {
      return null;
    }
  }
}

function quoteShell(value) {
  const text = String(value);
  return `'${text.replaceAll("'", "'\\''")}'`;
}

function hookCommand(command, { cliPath, execPath }) {
  const tokens = String(command ?? '').trim().split(/\s+/).filter(Boolean);
  if (tokens[0] === PLUGIN_NAME) tokens.shift();
  return [quoteShell(execPath), quoteShell(cliPath), ...tokens].join(' ');
}

export function buildUserMcpServerEntry({ cliPath = CLI_ENTRY, execPath = process.execPath } = {}) {
  return {
    command: execPath,
    // V2：mcp --host 必填，Kimi 统一 host = kimi-code（TUI/Web 同一 Host）。
    args: [cliPath, 'mcp', '--host=kimi-code'],
    startupTimeoutMs: USER_MCP_STARTUP_TIMEOUT_MS,
    toolTimeoutMs: USER_MCP_TOOL_TIMEOUT_MS,
  };
}

export function mergeUserMcpConfig(existing, entry) {
  const base = existing && typeof existing === 'object' ? existing : {};
  const servers = { ...(base.mcpServers ?? {}) };
  servers[USER_MCP_SERVER_NAME] = entry;
  return { ...base, mcpServers: servers };
}

export function localizeKimiManifest(manifest) {
  const { mcpServers: _stripped, ...rest } = manifest ?? {};
  return rest;
}

export function localizeKimiHooks(manifest, { cliPath = CLI_ENTRY, execPath = process.execPath } = {}) {
  const hooks = (Array.isArray(manifest?.hooks) ? manifest.hooks : []).map((hook) => ({
    ...hook,
    command: hookCommand(hook.command, { cliPath, execPath }),
  }));
  return { ...manifest, hooks };
}

function upsertPlugin(list, entry) {
  const index = list.findIndex((item) => item?.id === entry.id);
  if (index >= 0) list[index] = { ...list[index], ...entry };
  else list.push(entry);
}

export async function installKimiCodePlugin(options = {}) {
  const kimiCodeHome = resolveKimiCodeHome(options);
  const paths = pluginPaths(kimiCodeHome);
  const pluginSource = options.pluginSource ?? PLUGIN_SOURCE_DIR;
  const cliPath = options.cliPath ?? CLI_ENTRY;
  const execPath = options.execPath ?? process.execPath;
  const dryRun = options.dryRun === true;
  const now = (options.now ?? (() => new Date()))().toISOString();
  const manifest = await readJson(join(pluginSource, 'kimi.plugin.json'), null);
  if (!manifest || typeof manifest.version !== 'string') {
    throw new Error(`Kimi 插件源缺少有效 manifest: ${pluginSource}`);
  }

  const installed = await readJson(paths.installedPlugins, { version: 1, plugins: [] });
  installed.version ??= 1;
  installed.plugins ??= [];
  const record = {
    id: PLUGIN_NAME,
    root: paths.installPath,
    source: 'plugins/kimi-code',
    version: manifest.version,
    enabled: true,
    installedAt: installed.plugins.find((entry) => entry?.id === PLUGIN_NAME)?.installedAt ?? now,
    updatedAt: now,
  };
  upsertPlugin(installed.plugins, record);
  const userMcpEntry = buildUserMcpServerEntry({ cliPath, execPath });
  const plan = {
    kimiCodeHome,
    installPath: paths.installPath,
    installedPlugins: paths.installedPlugins,
    userMcpJson: paths.userMcpJson,
    id: PLUGIN_NAME,
    version: manifest.version,
    dryRun,
    actions: [
      `copy ${pluginSource} -> ${paths.installPath}`,
      `register MCP server "${USER_MCP_SERVER_NAME}" in ${paths.userMcpJson}`,
      `register ${PLUGIN_NAME} in ${paths.installedPlugins}`,
      `enable ${PLUGIN_NAME}`,
      'localize hook commands with absolute Node and CLI paths',
    ],
  };
  if (dryRun) return plan;

  const backupPlugin = await backupOnce(paths.installPath);
  if (backupPlugin) plan.actions.push(`backup ${paths.installPath} -> ${backupPlugin}`);
  const backupInstalled = await backupOnce(paths.installedPlugins);
  if (backupInstalled) plan.actions.push(`backup ${paths.installedPlugins} -> ${backupInstalled}`);
  const backupUserMcp = await backupOnce(paths.userMcpJson);
  if (backupUserMcp) plan.actions.push(`backup ${paths.userMcpJson} -> ${backupUserMcp}`);

  await mkdir(paths.managedDir, { recursive: true });
  // 托管副本必须与源严格一致：先清空再拷贝，避免旧版本残留文件（如已废弃的 launcher）。
  await rm(paths.installPath, { recursive: true, force: true });
  await cp(pluginSource, paths.installPath, { recursive: true, force: true });
  const localized = localizeKimiHooks(localizeKimiManifest(manifest), { cliPath, execPath });
  await writeJsonAtomic(join(paths.installPath, 'kimi.plugin.json'), localized);
  await writeJsonAtomic(paths.installedPlugins, installed);

  const existingUserMcp = await readJson(paths.userMcpJson, null);
  await writeJsonAtomic(paths.userMcpJson, mergeUserMcpConfig(existingUserMcp, userMcpEntry));
  return plan;
}
