# ZCode 插件真实路径验收：4 处缺陷修复与 Hook 回流打通

- 日期：2026-09-11
- 执行者：主 Agent（无子 Agent；用户明确本轮不使用 autonomous-execution 流程）
- 环境：macOS；ZCode GUI（已重启）；ChatGPT.app 内嵌 codex-cli 0.153.4；Node v24.15.0
- 目标：在真实 ZCode 插件运行态下验证十个 MCP 工具与异步 completion 回流，并修复暴露的缺陷

## 安装与接入状态

| 项目 | 证据 |
| --- | --- |
| 插件安装 | `~/.zcode/cli/plugins/installed_plugins.json` 含 `codex-as-subagent@codex-as-subagent-local` |
| 插件启用 | `~/.zcode/cli/config.json` 的 `plugins.enabledPlugins` 中该插件为 `true` |
| marketplace | 仓库根 `marketplace.json`（directory 型本地市场，source=`plugins/zcode`） |
| MCP 进程 | 进程链 `node src/cli/main.mjs mcp` ← `zcode-cli` ← `zcode-host-local-1` ← ZCode GUI，证明 GUI 会话按 `.mcp.json` 拉起 |
| 缓存本地化 patch | 缓存 `.mcp.json`/`hooks.json` 用 `node` + 仓库绝对路径 + `CODEX_BIN`/`CODEX_APP_SERVER_ARGS`；系统重启 GUI 后 patch 仍在（重启只读缓存，不从源目录重同步） |

## 实测暴露并修复的 4 处缺陷

### ① Hook 参数解析（Critical，直接使回流功能失效）

- 现象：`hook --host=zcode` 输出纯文本而非严格 JSON。
- 根因：旧 `option()` 只匹配 `--host zcode`；插件传 `--host=zcode` 解析失败 → host 回退 `plain` → 用 plain wrapper 渲染。ZCode 丢弃纯文本，回流实际不可用。
- 修复：新增 `src/shared/argv.mjs`，`option()` 同时支持 `--k=v` 与 `--k v`，且不吞掉后随 flag；`hook`/`mcp`/`serve` 统一改用；`drain.mjs` 不再用前置 `--host plain` 覆盖用户显式 host。
- 证据：修复前 `hook stdout: "Codex subagent ... \nHOOK-OK\n"`（`strict JSON? false`）；修复后 `hook stdout: "{\"additionalContext\":\"...HOOK-OK\"}"（strict JSON? true`）。

### ② `--data-dir` 未透传（High）

- 现象：bootstrap 以自定义目录启动 serve 时，SQLite 落在默认 `~/.codex-as-subagent/`，与 socket/lock 目录分叉。
- 根因：`stdio-bootstrap.mjs` spawn serve 时的 argv 漏了 `--data-dir`。
- 修复：`stdio-bootstrap` 新增 `dataDir` 成员并透传；`ensureServer` 转发 `dataDir`；`mcp.mjs` 传入；未显式给定时按 socket 所在目录推导。
- 证据：`tests/unit/stdio-bootstrap-data-dir.test.mjs` 4 项通过（stub 捕获真实 spawn argv，确认 serve 收到 `--data-dir`）。

### ③ idle shutdown 不生效（High）

- 现象：Runtime Server 空闲后不退出，遗留孤儿进程（旧 pid 57549、83142）。
- 根因：execution 在异步 terminal 事件里被 `insertCompletionFirst` 从表中删除，但此后没有任何请求边界再触发 `maybeShutdown`。
- 修复：`RuntimeManager` 新增 `subscribeStateChanges`，在 terminal 处理与 spawn/send 落地后主动发通知；`RuntimeServer` 订阅并 `lifecycle.noteStateChange()`；Server `listen` 完成后先 arm 一次。
- 证据：真实 serve `--idle-shutdown-ms 1500` 空闲后自动退出，日志 `serve.shutdown {"reason":"idle"}`；session-B 复现脚本中 Server 于 turn 结束后自行退出。

### ④ Server 无法真正退出（High，孤儿进程根因）

- 现象：对旧版 serve 进程发 `SIGTERM` 无效，进程长期驻留并各自挂着一个活的 `codex app-server`。
- 根因：旧 shutdown 只关 SQLite，未终止 app-server 子进程；子进程 stdio 句柄持有事件循环，Node 无法自然退出。
- 修复：adapter 新增 `close()`（调用 vendor `AppServerClient.stop()`，SIGTERM→2s→SIGKILL）；`close` 纳入 `SUPERVISOR_ADAPTER_METHODS` 契约，fake adapter 缺省为 no-op；`RuntimeManager.close()` 改 async 并 await `adapter.close()`；`RuntimeServer.close()` await `runtime.close()`；新增 `onClosed` 回调统一收口 store，避免 idle 路径漏关。
- 证据：真机复现（旧进程 SIGTERM 后仍存活、挂着 app-server）；修复后清理干净，无孤儿 serve/app-server。

## 可观测性补充

新增 `src/shared/server-log.mjs`：serve 生命周期日志写 `<data-dir>/server.log`（start/listening/shutdown/closed/signal），等级经 `CODEX_AS_SUBAGENT_LOG_LEVEL` 控制，默认 info。此前 serve 零日志，是 session-B 丢结果无法诊断的直接原因。

## 端到端验证路径

1. **session-B 丢结果复现（修复后通过）**：MCP stdio 发起真实 `codex_spawn`（gpt-5.6-luna）→ 不 wait → SIGKILL 宿主 MCP 进程。结果：completion 落盘 `{status:"completed", delivery:"pending"}`，消息 `SESSION-B-OK`；Server 随即 idle 退出。
2. **Hook 回流注入（修复后通过）**：completion 处于 pending 时运行 `hook --host=zcode --data-dir <d> --workspace <ws>`，stdin 传 `{"hook_event_name":"UserPromptSubmit",...}`。结果：stdout 为严格 JSON `{"additionalContext":"Codex subagent <thread> completed (<id>)\nHOOK-OK"}`，completion 转 `delivered`。
3. **回归**：`npm test` 90/90、`npm run lint`、`npm run smoke` 全通过（基线 80/80 → 新增 10 项）。

## 生产路径实测（干净进程 + 本会话真实 Stop hook）

在用户要求下，本轮追加了一次不带任何沙箱的**生产路径**验证：使用默认数据目录 `~/.codex-as-subagent`、生产 workspace（仓库根）、全新 MCP 进程。

1. **干净生产进程启动**：`node src/cli/main.mjs mcp`（无 `--data-dir`）冷启动，`initialize` 返回 `serverInfo={name:"codex-as-subagent",version:"0.1.0"}`；`tools/list` 恰好 10 个工具。生命周期日志：`serve.start{dataDir:"~/.codex-as-subagent", idleShutdownMs:3000}` → `serve.listening` → turn 结束后 `serve.shutdown{reason:"idle"}` → `serve.closed`。
2. **真实 spawn + 脚本触发 Hook**：真实 gpt-5.6-luna 子 agent（不 wait）→ completion `pending` → `hook --host=zcode`（stdin 传 Stop payload）输出严格 JSON `{"additionalContext":"...PROD-HOOK-OK","decision":"block","reason":"..."}`，completion 转 `delivered`。
3. **本会话真实 Stop hook 端到端回流（最关键）**：留一条真实子 agent completion 处于 `pending`（消息 `LIVE-STOP-HOOK-OK`）后结束本轮。ZCode 会话**自身的 Stop hook 自动执行**了 `hook --host=zcode`，将 completion 作为 `additionalContext` 注入（并带 `decision:block` 触发续轮），completion 于 `2026-09-11T04:53:04Z` 转 `delivered`。这是不经任何脚本模拟、由 Host 真实驱动 `spawn 异步 → completion 落盘 → Stop hook 自动回流 → 续轮` 的完整用户路径实证。
4. **环境自清理**：验证后无残留 serve、无残留 app-server，executions 归零。

## 遗留风险与后续

- 缓存 patch 依赖手工本地化：ZCode **插件 update**（非 GUI 重启）会从源目录重同步，覆盖为裸命令 `codex-as-subagent`，而 GUI 子进程 PATH 不含它 → MCP 工具会消失。彻底解法是让 `plugins/zcode/.mcp.json` 走可发现的命令（如安装后软链进 PATH 或改用 `node`+相对解析）。
- 未在本轮验证：真实 ZCode 会话内 UserPromptSubmit 事件的端到端注入（Stop 事件已在本会话真实验证）；send/steer/interrupt 真实路径；崩溃恢复真实路径；MCP server 是否注入 session env。
- `ZCODE_SESSION_ID` 已确认由 ZCode 注入，但 Bootstrap/Runtime 尚未消费它（session 隔离属 V2）。
