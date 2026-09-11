# ZCode Hook / MCP / 插件协议调研（2026-09-11）

**调研方法**：本机 `zcode` 未装入 PATH，但桌面版 `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`（12MB 打包 bundle）包含完整 CLI 实现。核心结论来自对该 bundle 的源码级取证（Zod schema、hook runner、stdin 构造函数），辅以 zcode-guide 官方 skill 文档与 mimosa、nowledge-mem-zcode 两个真实插件实例。未做运行态实证。主 Agent 已抽查验证关键字符串与结论属实。

## 1. Hook 配置格式

- 配置文件：用户级 `~/.zcode/cli/config.json` 顶层 `hooks` 键；工作区级 `<repo>/.zcode/config.json` 或 `<repo>/zcode.json`。
- 配置文件 schema：`hooks.enabled`（必须显式 true）、`hooks.timeoutMs`（默认 60000）、`hooks.maxOutputBytes`（默认 32768）、`hooks.events.<Event>[] = { matcher, hooks: [{type:"process",command,args,timeoutMs}] }`。
- 插件 hooks：`<pluginRoot>/hooks/hooks.json`（固定路径自动加载，外层 `hooks` 包裹直接挂事件名），或 manifest 的 `hooks` 字段。插件 hooks 存在即自动启用。
- 工作区 hooks 有信任门禁（`workspace_hooks_blocked_untrusted`）；插件与用户级 hooks 无此门禁。

## 2. 事件清单（恰好 7 个，枚举实证）

`SessionStart, UserPromptSubmit, PreToolUse, PermissionRequest, PostToolUse, PostToolUseFailure, Stop`。无 SubagentStop/SessionEnd/Notification/PreCompact。

- `Stop`：assistant 一轮回复结束时；可通过 `decision:"block"` + additionalContext 请求续轮，最多 3 次，且仅有 additionalContext 才续。
- `UserPromptSubmit` / `Stop` 的 matcher 恒匹配（调用点不传 matchValue）。
- 全部内联同步执行；`async:true` 仅影响展示。

## 3. stdin 输入格式

JSON 对象 + 尾部换行；camelCase 原始字段 + snake_case Claude 兼容别名叠加。关键字段：

- `session_id` / `sessionId`：主会话 ID，形如 `sess_<uuid>`（**会话隔离所需字段，已确认存在**）。
- `hook_event_name`、`cwd`、`permission_mode`、`agent_type`、`timestamp`、`traceId`、`turnId`。
- `transcript_path`：**临时文件**，只含一行 JSONL（当前 prompt 或最后一条 assistant 消息），hook 退出即删，不可用于读历史。
- 事件特有字段：`prompt`（UserPromptSubmit）、`source`（SessionStart）、`tool_name`/`tool_input`/`tool_response`（工具事件）、`last_assistant_message`/`stop_hook_active`（Stop）等。

## 4. stdout 回传协议

- stdout trim 后**以 `{` 开头才 JSON.parse**，否则完全忽略（纯文本不注入）。
- 严格 schema，顶层只允许：`additionalContext`（或 `additional_context`）、`continue`、`decision`（approve/block）、`hookSpecificOutput`（hookEventName 必须与当前事件一致）、`reason`、`stopReason`、`suppressOutput`、`systemMessage`。多键/错键即本次输出作废并记 hook failed。
- additionalContext 注入：生命周期事件包装为 `hook_context` 合成消息进入 messageHistory，**仅当前 turn 可见**（保留策略 `current_turn`），截断 24000 字符；工具事件拼接到工具结果尾部。
- **无 ACK 机制**：exit 0 + 合法 JSON 即完成。exit 2 = 阻断；其他非零 = hook 失败。

## 5. Hook 进程执行环境

- cwd = 会话工作目录。
- env：继承 ZCode 进程环境 + `ZCODE_SESSION_ID`、`ZCODE_PROJECT_DIR`（及 `CLAUDE_SESSION_ID` 等兼容别名）；插件 hook 另有 `ZCODE_PLUGIN_ROOT`/`ZCODE_PLUGIN_DATA` 等。
- 模板变量 `${ZCODE_PROJECT_DIR}`、`${ZCODE_SESSION_ID}` 在 hook command/args 中展开（配置文件中的 MCP server 不展开模板）。
- 超时默认 60000ms；输出上限 32768 字节；stderr 仅作诊断不进会话。
- `type:"process"`（argv 直起，无 shell，推荐）与 `type:"command"`（shell 字符串）。

## 6. MCP server 注册

- 配置文件 `mcp.servers`：stdio 型 `{type:"stdio",command,args,cwd,env,enabled,timeoutMs}`；schema 严格，未知键整个 server 被丢弃；配置文件不展开模板（用绝对路径）；支持 env 注入。
- 插件：`<pluginRoot>/.mcp.json`（顶层 `mcpServers` 键）或 manifest `mcpServers` 字段；插件 server 支持模板展开；工具名按 `plugin:<pluginName>:<serverName>` 命名空间注册。
- 生命周期：会话启动时自动连接；默认 **per-session 隔离**（每会话独立 stdio server 进程，会话结束回收）。
- **MCP server 进程是否注入 `ZCODE_SESSION_ID`：未确认**（bundle 未见 MCP spawn 注入 session env）。

## 7. 插件分发

- manifest：`.zcode-plugin/plugin.json`（兼容 `.claude-plugin/` 等目录名），最小只需 `name`。
- 可执行组件白名单：`skills, commands, hooks, mcpServers, userConfig`；`agents, lspServers, outputStyles, channels, settings` 仅记录不执行。
- 标准位置自动探测：`hooks/hooks.json` 与 `.mcp.json` 放对位置即可，manifest 字段可省。
- Marketplace：GitHub repo / Git URL / 本地目录 / zip（带 sha256）；缓存在 `~/.zcode/cli/plugins/cache/<marketplace>/<name>/<version>/`。

## 8. 对本项目的影响（当前实现的问题）

1. `plugins/zcode/.zcode-plugin/plugin.json` 的 `mcpConfig`/`hooksConfig` 字段名不存在于 ZCode，插件不会被识别。改为标准位置自动探测，或用 `hooks`/`mcpServers` 字段。
2. `plugins/zcode/hooks/hooks.json` schema 全错（`after_turn` 非合法事件）。应挂 `Stop` + `UserPromptSubmit`，`type:"process"`。
3. `src/hook/hosts/zcode.mjs` 输出纯文本包装，会被 ZCode 忽略。必须输出严格 JSON（顶层 `additionalContext` 或 `hookSpecificOutput`）；无 completion 时不输出任何内容、exit 0。
4. 会话隔离：Hook 侧用 `ZCODE_SESSION_ID` env；MCP 侧 session 注入未确认，V2 设计应以 hook 侧 session_id 为准、MCP 侧用 cwd 匹配。
5. 备选通道（逆向发现，无文档背书，仅作 fallback）：`~/.zcode/mailbox/<session_id>/unread/*.json` 信箱，信封 `{version:1, messageId, fromSessionId, toSessionId, content, createdAt}`，由内置 `builtin.sessionMailbox.drain` 在 UserPromptSubmit/PostToolUse/Stop 时注入；不触发 Stop 续轮，语义弱于自有 Stop hook。
6. 诊断：hook 执行记录 `hook.run.*` 事件在 `~/.zcode/cli/log/zcode-*.jsonl` 与 Settings → Plugin Management。

## 未实证声明

基于 bundle 源码取证与官方 skill 文档，未在运行中的 ZCode 会话实际触发 hook；首次集成时建议用 dump-stdin 临时插件做一次运行态验证。
