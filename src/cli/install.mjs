import { hasFlag, option } from '../shared/argv.mjs';
import { installZcodePlugin } from '../install/zcode-plugin.mjs';

export async function install(argv = [], { stdout = process.stdout, stderr = process.stderr } = {}) {
  const host = option(argv, '--host', 'zcode');
  if (host !== 'zcode') {
    stderr.write(`[codex-as-subagent install] 不支持的 host: ${host}（当前仅支持 zcode）\n`);
    return 2;
  }
  try {
    const plan = await installZcodePlugin({
      zcodeRoot: option(argv, '--zcode-root', undefined),
      dryRun: hasFlag(argv, '--dry-run'),
      portable: hasFlag(argv, '--portable'),
    });
    const heading = plan.dryRun
      ? 'Codex As Subagent ZCode 插件安装预演（未写入任何文件）'
      : 'Codex As Subagent ZCode 插件安装完成';
    const lines = [
      heading,
      `  zcodeRoot    : ${plan.zcodeRoot}`,
      `  插件          : ${plan.id} (v${plan.version})`,
      `  安装路径      : ${plan.installPath}`,
      `  Codex 运行时  : ${plan.codexBinary ?? '(未探测到；运行时还会再次自动发现)'}`,
      `  命令模式      : ${plan.portable ? 'portable（裸命令，依赖 PATH）' : 'localized（node + 绝对路径）'}`,
      '  动作:',
      ...plan.actions.map((action) => `    - ${action}`),
    ];
    if (!plan.dryRun) {
      lines.push('  提示: 重启 ZCode 或新开会话后生效；三个 hook 事件为 UserPromptSubmit / PostToolUse / Stop。');
    }
    stdout.write(`${lines.join('\n')}\n`);
    return 0;
  } catch (error) {
    stderr.write(`[codex-as-subagent install] 安装失败: ${error?.message ?? error}\n`);
    return 1;
  }
}
