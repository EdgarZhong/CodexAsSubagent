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

## 安装方式（两种并存）

### 方式 A：ZCode GUI 标准路径（官方机制，社区分发推荐）

ZCode 的插件生命周期由 GUI 管理，**没有可脚本化的 install 命令**（CLI 的 `zcode plugins` 仅有 `list|enable|disable|uninstall`）。标准流程：

1. 确保 `codex-as-subagent` 命令可被 GUI 子进程解析——即落在 GUI 传给子进程的 PATH 之一（实测包含 `/Users/<user>/.local/bin`、`/opt/homebrew/bin`、`/usr/local/bin`、npm 全局 bin 等）。例如 `npm install -g .`，或把 `src/cli/main.mjs` 软链到 `/usr/local/bin/codex-as-subagent`。
2. 打开 ZCode **Settings → Plugin Management → Discover**，用 `+` 添加 marketplace：本地目录（本仓库根）或 GitHub 仓库。
3. 在 Discover 中 Install `codex-as-subagent`，再到 Installed 标签页启用。
4. 重启 ZCode 或新开会话生效。

> 注意：此路径下插件注册的是**裸命令** `codex-as-subagent`，因此第 1 步不可省略，否则 MCP server 起不来。

### 方式 B：CLI 一键安装（本仓库提供）

```bash
codex-as-subagent install --host=zcode
```

该命令等价于一次完整安装，直接写入 ZCode 插件缓存与状态文件：

- 把 `plugins/zcode/` 拷贝到 `~/.zcode/cli/plugins/cache/codex-as-subagent-local/codex-as-subagent/<version>/`；
- 把 `.mcp.json`/`hooks/hooks.json` 里的命令**本地化**为 `node`（`process.execPath` 的绝对路径）+ 本仓库 CLI 绝对路径，因此**不依赖 PATH**；
- 自动探测 Codex 运行时并写入 `CODEX_BIN`；写入 `CODEX_APP_SERVER_ARGS=["app-server"]`；
- 注册 marketplace（`known_marketplaces.json`）、写安装记录（`installed_plugins.json`）、在 `config.json` 启用插件；
- 覆盖状态文件前各保留一份 `.bak-cas` 备份。

参数：

| 参数 | 说明 |
| --- | --- |
| `--dry-run` | 只打印将执行的动作与目标路径，不写任何文件 |
| `--portable` | 保留裸命令，适用已把 `codex-as-subagent` 装进 PATH 的场景 |
| `--zcode-root <path>` | 覆盖 ZCode 根目录（默认 `~/.zcode/cli`，或 `ZCODE_HOME`） |

该路径依赖 ZCode 内部状态文件格式，属便捷通道；若 ZCode 改版导致格式变化，请回退到方式 A。

两种方式安装的是同一个插件；重复执行方式 B 幂等，不会产生重复记录，也不影响其它插件状态。
