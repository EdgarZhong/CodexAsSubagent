# Codex As Subagent ZCode 插件

本插件只注册 Host 入口，不复制 Runtime、SQLite 或 completion routing 逻辑：

- `.mcp.json` 注册 `codex-as-subagent mcp`，提供十个 MCP 工具。
- `hooks/hooks.json` 在 `UserPromptSubmit`、`PostToolUse`（省略 matcher，匹配所有工具）与 `Stop` 三个事件触发 `codex-as-subagent hook --host=zcode`，从当前 workspace 的持久 completion buffer 回流结果。

三个事件的职责：

| 事件 | 作用 |
| --- | --- |
| `PostToolUse` | turn 进行中即时回流：每次工具调用返回时顺带查一次，子 agent 若已完成则当场注入，模型立刻可见 |
| `UserPromptSubmit` | 跨 turn 兜底：用户提交新 prompt 时捞取未被消费的 completion |
| `Stop` | turn 结束时兜底：覆盖"最后一次工具调用之后、turn 结束之前"落地的结果，以 `decision:block` 续轮送达 |

Hook 只读取已持久化完成结果，不启动、恢复或中断 Codex thread，也不等待子 agent（无 pending 时约 20–30ms 返回）。没有 Hook 能力时，仍可通过 `codex_wait`、`codex_wait_many`、`codex_status` 和 `codex_read_thread` 使用 Runtime。

## 安装

1. 将 `plugins/zcode/` 作为 ZCode 插件目录安装，或按 ZCode 的插件管理方式导入 `.zcode-plugin/plugin.json`。
2. 确保 `codex-as-subagent` 已在 PATH 中，且本机 Codex 已登录并能启动 app-server。
3. 在项目 workspace 中启动 ZCode；插件会通过当前 canonical CWD 隔离 completion。

Hook 只读取已持久化完成结果，不会启动、恢复或中断 Codex thread。没有 Hook 能力时，仍可通过 `codex_wait`、`codex_wait_many`、`codex_status` 和 `codex_read_thread` 使用 Runtime。
