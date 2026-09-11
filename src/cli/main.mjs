#!/usr/bin/env node

import { DEFAULT_EFFORT, DEFAULT_MODEL } from '../shared/constants.mjs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { serve } from './serve.mjs';
import { mcp } from './mcp.mjs';

const commands = [
  ['serve', '启动 Runtime Server'],
  ['mcp', '启动 MCP stdio Bootstrap'],
  ['hook', '运行 Host Hook wrapper'],
  ['drain', '读取并交付待处理 completion']
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

  console.error(`未知命令: ${command}`);
  console.error('运行 codex-as-subagent --help 查看帮助。');
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
