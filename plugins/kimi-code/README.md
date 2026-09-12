# Codex As Subagent Kimi Code 插件

本插件只注册 Kimi Code 的 Hook 与 system prompt，不复制 Codex Runtime、SQLite 或 completion routing 逻辑。MCP server 不在插件 manifest 内注册——宿主会以插件托管目录为 cwd 拉起插件 MCP，导致 workspace 永远错配；MCP 必须注册在用户级 `mcp.json`（见下）。Kimi TUI 与 Web 统一为同一个 Host：`host = kimi-code`。

## 回流方式

- TUI：Hook 统一走 `codex-as-subagent hook --host=kimi-code`（`PreToolUse`/`Stop`/`UserPromptSubmit` 三个事件）。`PreToolUse` 承担双职责，固定顺序：先 Mailbox 主动回流（存在当前 Session 的 pending completion 时 claim 并注入，同时 veto 当前工具一次并提示原工具尚未执行），再对 CAS MCP 工具执行弱 Session Gate；`Stop` 是 turn-end 兜底，`UserPromptSubmit` 是跨 turn 兜底，二者只承担 Mailbox Delivery。
- Web：completion 由 Runtime 内部事件驱动 delivery 直接通过 Kimi Server API 投递到来源 Session（`/api/v1/sessions/{session_id}/...`，存在 active turn 时 steer）。无常驻进程、无 sidecar、无轮询；投递失败不丢失 completion，记录保留在 Mailbox 按 lease/ACK 机制恢复。本插件不包含任何 Web 回流代码。
- 两种方式共用同一 SQLite Mailbox；没有可用 Web Server 时仍可用 TUI Hook 或 `codex_wait` 消费结果。

## 项目 CLI 安装（优先路径）

在项目根目录执行：

```bash
node src/cli/main.mjs install --host=kimi-code
```

也支持：

```bash
npm run install:kimi-code
```

安装器会：

1. 把干净的 `plugins/kimi-code/` 拷贝到 `$KIMI_CODE_HOME/plugins/managed/codex-as-subagent/`（默认 `~/.kimi-code`），安装副本 manifest 不携带 `mcpServers`，Hook 命令本地化为绝对 Node + CLI 路径；
2. 把 MCP server 合并写入用户级 `$KIMI_CODE_HOME/mcp.json` 的 `mcpServers["codex-as-subagent"]`（`node <绝对路径>/src/cli/main.mjs mcp --host=kimi-code`，`startupTimeoutMs` 60000、`toolTimeoutMs` 520000），保留文件中已有的其它 server 与首次覆盖前的 `.bak-cas` 备份；
3. 原子更新 `$KIMI_CODE_HOME/plugins/installed.json`，保留其它插件与首次覆盖前的 `.bak-cas` 备份；
4. 启用插件。重复执行幂等。

支持 `--dry-run` 查看动作而不写入文件，支持 `--kimi-code-home <path>` 做隔离安装测试。安装后在 Kimi 中执行 `/reload` 或新开 session。

## Kimi 官方插件路径

也可以在 Kimi Code 中执行：

```text
/plugins install <本仓库路径>
```

或从包含本目录的 GitHub 仓库/压缩包安装，再执行 `/reload` 或 `/new`。官方路径会从 `plugins/managed/<id>/` 运行托管副本；不要手工编辑 Kimi 缓存。**注意：官方路径只安装 hooks，不注册 MCP**——MCP 必须通过上面的 CLI 安装器写入用户级 `mcp.json`，或手工把 `codex-as-subagent mcp --host=kimi-code` server 添加进 `$KIMI_CODE_HOME/mcp.json`。

## MCP 注意事项

MCP server 注册在用户级 `$KIMI_CODE_HOME/mcp.json`，启动参数固定携带 `--host=kimi-code`（V2 中 `mcp` 命令的 `--host` 必填，TUI/Web 统一该 host 值）：宿主以当前会话的 `workspace.cwd` 作为用户级 stdio MCP 的默认工作目录（插件 manifest 内注册的 MCP 则以插件托管目录为 cwd，会导致 workspace 错配，故不可用）。`toolTimeoutMs` 为 520000ms，覆盖 Codex `codex_wait` 的 500 秒上限。Kimi MCP 工具名称形如 `mcp__codex-as-subagent__codex_spawn`。MCP 不显式设置 cwd，保持 Kimi 当前 workspace 与 Codex As Subagent 的 fail-closed workspace 约束一致。
