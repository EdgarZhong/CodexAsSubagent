# Task 7：Hook 交付与 Host adapters

## 状态

DONE。已实现 completion Hook drain、六个 Host wrapper、`hook/drain` CLI 和 ZCode 插件注册骨架。本任务由主 Agent 直接完成，没有继续使用子 Agent。

## 实现内容

- `src/hook/drain.mjs`：canonicalize workspace，回收过期 delivery lease，原子 claim pending completion，渲染并在输出成功后 ACK；渲染失败不 ACK，依靠 lease 恢复。
- `src/hook/render-completions.mjs`：将 canonical TerminalResult 渲染为可读文本，并通过 `plain`、`zcode`、`kimi-code`、`claude-code`、`grok-build`、`pi` 薄 wrapper 隔离宿主差异。
- `src/cli/hook.mjs`、`src/cli/drain.mjs`：接通 `codex-as-subagent hook --host=<host>` 和 plain `drain`。
- `plugins/zcode/`：提供 `.zcode-plugin/plugin.json`、`.mcp.json`、`hooks/hooks.json` 和中文安装说明；插件只注册命令，不复制 Runtime/SQLite 逻辑。

## 关键裁决

1. Hook 直接共享 CompletionStore，不经 Runtime Server；pending completion 可在 Server idle shutdown 后继续由 Hook 消费。
2. claim 在 render 之前完成，ACK 在 stdout 写成功之后完成；崩溃边界保留 `claimed_hook`，由 30 秒 lease 回收为 pending，采用 at-least-once 偏置。
3. Hook 使用当前 CWD 的 canonical realpath 作为唯一 workspace；测试明确覆盖 macOS `/var` 到 `/private/var` 的 canonicalization 语义。
4. 详细规格没有锁定各 Host 的外部 Hook wire schema，因此当前 wrapper 使用稳定、可替换的文本 envelope；所有 Host-specific 分支均限制在 `src/hook/hosts/`，后续可按本机 Host 协议替换。

## 测试证据

Task 7 focused：

    node --test tests/unit/hook-drain.test.mjs tests/integration/hook-delivery.integration.test.mjs tests/unit/plugin-layout.test.mjs

结果：8/8 通过。

全量回归：

    npm test

结果：79/79 通过，无失败、取消或跳过。

静态与 CLI：

    npm run lint
    npm run smoke
    find src -type f -name '*.mjs' -exec node --check {} \;
    git diff --check

以上命令均退出码 0；使用临时 `--data-dir` 真实运行 `hook` 与 `drain`，两者均正常退出。

## 遗留范围

- Task 8 仍需执行跨任务用户级验收、最终 Review 和真实 Codex app-server/ZCode 外部状态限制记录。
