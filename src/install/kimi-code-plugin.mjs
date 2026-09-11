import { access, copyFile, cp, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_KIMI_CODE_HOME } from '../hook/kimi-web.mjs';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PLUGIN_SOURCE_DIR = join(REPO_ROOT, 'plugins', 'kimi-code');
export const CLI_ENTRY = join(REPO_ROOT, 'src', 'cli', 'main.mjs');
export const PLUGIN_NAME = 'codex-as-subagent';

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

export function localizeKimiManifest(manifest, { cliPath = CLI_ENTRY, execPath = process.execPath } = {}) {
  const servers = { ...(manifest?.mcpServers ?? {}) };
  const current = servers[PLUGIN_NAME] ?? {};
  servers[PLUGIN_NAME] = {
    ...current,
    command: execPath,
    args: [cliPath, ...(Array.isArray(current.args) ? current.args : ['mcp'])],
  };
  const hooks = (Array.isArray(manifest?.hooks) ? manifest.hooks : []).map((hook) => ({
    ...hook,
    command: hookCommand(hook.command, { cliPath, execPath }),
  }));
  return { ...manifest, mcpServers: servers, hooks };
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
  const plan = {
    kimiCodeHome,
    installPath: paths.installPath,
    installedPlugins: paths.installedPlugins,
    id: PLUGIN_NAME,
    version: manifest.version,
    dryRun,
    actions: [
      `copy ${pluginSource} -> ${paths.installPath}`,
      `register ${PLUGIN_NAME} in ${paths.installedPlugins}`,
      `enable ${PLUGIN_NAME}`,
      `localize commands with ${execPath} ${cliPath}`,
    ],
  };
  if (dryRun) return plan;

  const backupPlugin = await backupOnce(paths.installPath);
  if (backupPlugin) plan.actions.push(`backup ${paths.installPath} -> ${backupPlugin}`);
  const backupInstalled = await backupOnce(paths.installedPlugins);
  if (backupInstalled) plan.actions.push(`backup ${paths.installedPlugins} -> ${backupInstalled}`);

  await mkdir(paths.managedDir, { recursive: true });
  await cp(pluginSource, paths.installPath, { recursive: true, force: true });
  const localized = localizeKimiManifest(manifest, { cliPath, execPath });
  await writeJsonAtomic(join(paths.installPath, 'kimi.plugin.json'), localized);
  await writeJsonAtomic(paths.installedPlugins, installed);
  return plan;
}
