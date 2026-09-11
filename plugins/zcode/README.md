# Codex As Subagent ZCode 插件

本插件只注册两条 Host 入口，不复制 Runtime、SQLite 或 completion routing 逻辑：

- `.mcp.json` 注册 `codex-as-subagent mcp`，提供十个 MCP 工具。
- `hooks/hooks.json` 在 ZCode 合适的 turn 生命周期触发 `codex-as-subagent hook --host=zcode`，从当前 workspace 的持久 completion buffer 回流结果。

## 安装

1. 将 `plugins/zcode/` 作为 ZCode 插件目录安装，或按 ZCode 的插件管理方式导入 `.zcode-plugin/plugin.json`。
2. 确保 `codex-as-subagent` 已在 PATH 中，且本机 Codex 已登录并能启动 app-server。
3. 在项目 workspace 中启动 ZCode；插件会通过当前 canonical CWD 隔离 completion。

Hook 只读取已持久化完成结果，不会启动、恢复或中断 Codex thread。没有 Hook 能力时，仍可通过 `codex_wait`、`codex_wait_many`、`codex_status` 和 `codex_read_thread` 使用 Runtime。
