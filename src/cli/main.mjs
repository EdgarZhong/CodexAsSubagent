#!/usr/bin/env node

import { DEFAULT_EFFORT, DEFAULT_MODEL } from '../shared/constants.mjs';
import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serve } from './serve.mjs';
import { mcp } from './mcp.mjs';
import { hook } from './hook.mjs';
import { drain } from './drain.mjs';
import { install } from './install.mjs';
import { runKimiWebCli } from './kimi-web.mjs';
import { doctor } from './doctor.mjs';

const commands = [
  ['serve', '启动 Runtime Server'],
  ['mcp', '启动 MCP stdio Bootstrap'],
  ['hook', '运行 Host Hook wrapper'],
  ['drain', '读取并交付待处理 completion'],
  ['kimi-web', '连接 Kimi Web session 并回流 completion'],
  ['doctor', '诊断数据目录、配置、锁和 Codex runtime'],
  ['install', '把 Host 插件安装到本机插件缓存']
];

function rootHelp() {
  const commandLines = commands.map(([name, description]) => `  ${name.padEnd(8)} ${description}`).join('\n');
  return [
    'Codex As Subagent',
    '',
    '用法:',
    '  codex-as-subagent [command] [--help]',
    '',
    '命令:',
    commandLines,
    '',
    `默认模型: ${DEFAULT_MODEL}`,
    `默认 effort: ${DEFAULT_EFFORT}`
  ].join('\n');
}

function commandHelp(command) {
  const entry = commands.find(([name]) => name === command);
  if (!entry) return null;
  return [
    `codex-as-subagent ${command}`,
    '',
    `${entry[1]}。`,
    '',
    `用法: codex-as-subagent ${command} [--help]`
  ].join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  const [command] = argv;
  if (!command || command === '--help' || command === '-h') {
    console.log(rootHelp());
    return 0;
  }

  if (argv.includes('--help') || argv.includes('-h')) {
    const help = commandHelp(command);
    if (help) {
      console.log(help);
      return 0;
    }
  }

  if (command === 'serve') {
    await serve(argv.slice(1));
    return 0;
  }
  if (command === 'mcp') return await mcp(argv.slice(1));
  if (command === 'hook') return await hook(argv.slice(1));
  if (command === 'drain') return await drain(argv.slice(1));
  if (command === 'kimi-web') return await runKimiWebCli(argv.slice(1), { cliPath: fileURLToPath(import.meta.url) });
  if (command === 'doctor') return await doctor(argv.slice(1));
  if (command === 'install') return await install(argv.slice(1));

  console.error(`未知命令: ${command}`);
  console.error('运行 codex-as-subagent --help 查看帮助。');
  return 1;
}

// 通过软链或 npm 全局安装调用时 process.argv[1] 是软链路径，
// 与 moduleUrl（真实路径）不同；必须 realpath 归一化后再比较，
// 否则入口守卫不成立，命令会静默不执行。
export function isDirectInvocation(argv1, moduleUrl) {
  if (!argv1) return false;
  try {
    return pathToFileURL(realpathSync(argv1)).href === moduleUrl;
  } catch {
    return moduleUrl === pathToFileURL(resolve(argv1)).href;
  }
}

if (isDirectInvocation(process.argv[1], import.meta.url)) {
  process.exitCode = await main();
}
