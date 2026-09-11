# Codex As Subagent Kimi Code 插件

本插件只注册 Kimi Code 的 MCP、Hook 和 Web session 回流入口，不复制 Codex Runtime、SQLite 或 completion routing 逻辑。

## 回流方式

- TUI：`PreToolUse` 在下一次工具边界注入 completion；命中时会 block 当前工具一次，并明确提示原工具尚未执行。`Stop` 是 turn-end 兜底，`UserPromptSubmit` 是跨 turn 兜底。
- Web：`SessionStart`/`TurnStarted` 启动轻量 sidecar。sidecar 根据 `KIMI_CODE_HOME/server/instances`、`server.token`、Hook stdin 的 `session_id` 和 workspace 识别当前 Server，将每条 completion 作为独立 prompt 提交；检测到 active turn 时只 steer 这一条 prompt。提交请求固定指定 K2.7 `kimi-code/kimi-for-coding`。
- 两种方式共用同一 SQLite completion buffer；Web 只有在 Server 接受 prompt/steer 后才 ACK，失败会按 lease 重试。没有可用 Web Server 时仍可用 TUI Hook 或 `codex_wait`。

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

1. 把干净的 `plugins/kimi-code/` 拷贝到 `$KIMI_CODE_HOME/plugins/managed/codex-as-subagent/`（默认 `~/.kimi-code`）；
2. 只在安装副本中写入 launcher 脚本 `bin/cas-run`（内部 exec 当前 Node + 当前安装包的绝对 CLI 路径），并把 MCP `command` 本地化为 `./bin/cas-run`——Kimi 对插件 MCP command 只接受裸 PATH 命令或 `./` 相对插件根目录，绝对路径会被静默丢弃；Hook 命令走 shell，仍本地化为绝对路径；
3. 原子更新 `$KIMI_CODE_HOME/plugins/installed.json`，保留其它插件与首次覆盖前的 `.bak-cas` 备份；
4. 启用插件。重复执行幂等。

支持 `--dry-run` 查看动作而不写入文件，支持 `--kimi-code-home <path>` 做隔离安装测试。安装后在 Kimi 中执行 `/reload` 或新开 session。

## Kimi 官方插件路径

也可以在 Kimi Code 中执行：

```text
/plugins install <本仓库路径>
```

或从包含本目录的 GitHub 仓库/压缩包安装，再执行 `/reload` 或 `/new`。官方路径会从 `plugins/managed/<id>/` 运行托管副本；不要手工编辑 Kimi 缓存。

## MCP 注意事项

插件的 `toolTimeoutMs` 为 520000ms，覆盖 Codex `codex_wait` 的 500 秒上限。Kimi MCP 工具名称形如 `mcp__codex-as-subagent__codex_spawn`。MCP 不显式设置 cwd，保持 Kimi 当前 workspace 与 Codex As Subagent 的 fail-closed workspace 约束一致。
