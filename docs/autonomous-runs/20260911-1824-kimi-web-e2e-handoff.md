# Kimi Web E2E 验收交接 — MCP workspace 错配根因与修复方案（2026-09-11 18:24）

> 性质：进行中验收的交接文档。读者是下一个会话的 Agent。已实证与未实证严格区分。

## 1. 会话与已完成工作

本会话（Kimi Web session `session_d48bdbd0-63f8-4119-a9af-e7d3130ad248`，workspace `/Users/edgar/programs/CodexAsSubagent`，Kimi Server `127.0.0.1:58627` pid 67636，instance `01M27YNH2X73BW5QRD8VXM5GVQ`，host 0.42.0）完成了两件事：

**A. 工具暴露缺陷（上一会话定位并修复，本会话实证通过）**
- 根因：kimi 二进制 `normalizePluginMcpServer()` 对插件 manifest 的 MCP `command` 硬校验——只允许裸 PATH 命令或 `./` 开头（相对插件根）；旧安装器写入 node 绝对路径 → 整个 server 被静默丢弃。
- 修复：`src/install/kimi-code-plugin.mjs` 生成插件内 launcher `bin/cas-run`（`#!/bin/sh` + `exec <node> <repo>/src/cli/main.mjs "$@"`），manifest command 写 `./bin/cas-run`。已真实重装，幂等，`.bak-cas` 备份。
- 本会话确认：10 个 `mcp__plugin-codex-as-subagent_codex-as-subagent__codex_*` 工具全部出现在工具列表。

**B. 十工具逐一实测（全部走通真实 gpt-5.6-luna）**

| 工具 | 结果 | 证据 |
|---|---|---|
| codex_spawn | ✅ | thread `01a08ff0`/`01a08ff1`/`01a08ff3` |
| codex_status | ✅ | running/interrupted 状态正确 |
| codex_wait | ✅ | 拿到 `E2E-OK-2`；也正确返回 interrupted 终态（completion `6a752254`） |
| codex_steer | ✅ | accepted:true，turn 运行中接受引导 |
| codex_interrupt | ✅ | 状态即时转 interrupted，SQLite 落 interrupted completion |
| codex_send | ✅ | 空闲线程接受后续任务并完成（`SEND-FOLLOWUP-OK`） |
| codex_wait_many | ⚠️ | 对「已被 wait 消费、无 active turn」的线程整体报 `no_active_turn`；单活跃线程正常。待对照规格确认是否预期 |
| codex_read_thread | ✅ | 返回 assistantMessages；`status:"unknown"` 待对照规格 |
| codex_list_threads | ✅ | 列出当前 runtime 实例的 2 个线程（跨重启为空，符合实例边界） |
| codex_models | ✅ | 默认 gpt-5.6-luna/xhigh |

## 2. 当前阻塞缺陷：MCP workspace 错配（根因已定位，未修复）

**现象**：spawn 的 subagent 完成后，Web 主动回流不到主会话；SQLite 中两条 completion（`77a2284d`、`5992c796`）永久 pending，worker（pid 48074，1s 轮询，存活）从不领取。

**根因链**（每一环均有实证）：
1. Kimi 插件 MCP server 以 **cwd=插件托管目录** 启动。二进制源码：`normalizePluginMcpServer` 末尾 `cwd: config.cwd ?? pluginRoot`；且 manifest 的 `cwd` 字段经 `resolvePluginPathField` 限制必须落在插件根内，无法指向 workspace。实证：本会话 MCP 进程 pid 67700 的 cwd=`/Users/edgar/.kimi-code/plugins/managed/codex-as-subagent`。
2. CAS stdio bootstrap 以 `process.cwd()` 作为 workspace（`src/mcp/workspace-context.mjs:3`）→ completion 落盘时 workspace=插件目录（SQLite 已证实）。
3. kimi-web worker 用 hook 上报的真实 workspace（`/Users/edgar/programs/CodexAsSubagent`）执行 `claimPendingHook` → workspace 不匹配 → 永不领取。
4. **附带伤害（比回流更严重）**：Codex subagent 实际运行在插件目录而非用户项目目录。即使回流修好，工作目录也是错的。

**对照组**：上一会话手工 stdio MCP（cwd=仓库根）的 completion 0.6s 内经 kimi-web 投递成功（delivery_id `kimi-web-11938f6a…`）——链路其余环节完好。

**已排除的方案**（均为二进制/进程取证，非猜测）：
- MCP `roots/list`：三种 transport（stdio/http/sse）的 `Client` 构造均只有 `{name, version}`，无 `capabilities.roots`——宿主不应答 roots/list。
- manifest `cwd` 字段：被限制在插件根内（`resolvePluginPathField` + `isWithin` 检查）。
- 环境变量：插件 MCP 进程 env 全量 dump 仅有 `KIMI_PLUGIN_ROOT`/`KIMI_CODE_HOME`/`KIMI_API_KEY`/`KIMI_CODE_BASE_URL`，无 session/workspace 变量。
- 父进程 cwd：父进程（pid 67636）是全局 Kimi Web Server（单实例服务多 workspace，instances 目录仅此一个），其 cwd 只是宿主的启动目录，对其它 workspace 的会话不可靠。
- initialize 参数：**未知**——已部署探针待捕获（见 §3）。

## 3. 已部署的诊断探针（已提交）

- `src/mcp/stdio-bootstrap.mjs`：`initialize` 到达时，若 `<dataDir>/mcp-debug` 标志文件存在，把 initialize 原文 + pid/cwd/KIMI_PLUGIN_ROOT 追加写入 `<dataDir>/mcp-debug.log`。调试通道，任何失败静默，不影响协议。
- 测试 `tests/unit/stdio-bootstrap-debug-log.test.mjs` 3/3 通过；lint 通过。
- 注意：launcher exec 的是**仓库源码**的 `src/cli/main.mjs`，所以 src 改动对新会话（新 MCP 进程）即时生效，**无需重新 install**；只有 `plugins/` 资源改动才需要 install + 重启。

## 4. 修复方案候选（按推荐排序）

**方案 A（推荐，回归知识库 §18 的原始设计）**：把 MCP 注册从插件 manifest 移到 Kimi 用户级 MCP 配置（`kimi mcp add` 或 config.toml mcpServers）。知识库 §18 记载「Kimi 的 workspace MCP service 会把 `workspace.cwd` 作为 stdio MCP 默认工作目录」——该路径下宿主以 workspace 为 cwd 拉起 MCP，`process.cwd()` 方案天然成立，也不受插件 command 校验约束（裸命令允许）。插件 manifest 保留 hooks/skills/system prompt；安装器负责写入/卸载该 MCP 配置。**首要验证点**：用户级 MCP 是否确实每 session 以 workspace 为 cwd 拉起（`lsof -p <pid> | grep cwd`）。

**方案 B**：若 §3 探针捕获到 initialize 携带 workspace 信息（rootUri/workspaceFolders/自定义字段）→ bootstrap 优先取 initialize 中的值，canonicalize 后使用，仍 fail-closed。

**方案 C**：initialize 无携带且方案 A 不成立 → 向 Kimi Code 上游报缺陷（插件 MCP 无法获得 session workspace）；本侧短期只能 fail-closed + doctor 报警。

**无论哪个方案都要补的硬伤**：bootstrap 检测到 `cwd` 落在 `KIMI_PLUGIN_ROOT` 内且无法确定真实 workspace 时，必须 fail-closed 报错，而不是静默用错 workspace（当前行为违反 AGENTS.md「无法获得或 realpath 不一致时 fail closed」）。

## 5. 下一步测试 SOP（新会话按序执行）

1. `touch ~/.codex-as-subagent/mcp-debug`（启用探针）。
2. 新开 Kimi 会话（新 MCP 进程自动加载仓库最新 src）。
3. 读 `~/.codex-as-subagent/mcp-debug.log`，确认 initialize 是否携带 workspace 信息 → 定方案 A/B/C。
4. 若方案 A：改 `src/install/kimi-code-plugin.mjs` 增加 MCP 配置注册 → `node src/cli/main.mjs install --host=kimi-code` → 新会话 → `lsof` 验证 MCP 进程 cwd=workspace。
5. 端到端复验：`codex_spawn` 探针后**不要调 wait**，观察 `<codex-completion>` 是否插队注入（含 turn 运行中注入）；SQLite 查 `delivery_state='delivered'` 且 `delivery_id` 带 `kimi-web-` 前缀。
6. 清理开发态垃圾（需用户确认）：`~/.codex-as-subagent/mcp-debug`、`mcp-debug.log`；SQLite 中 4 条永不投递的 pending completion（两条 workspace=插件目录、两条 workspace=`/private/tmp/cas-e2e-ws`）。

## 6. 系统状态快照（勿破坏）

- 本会话 worker pid 48074 正常存活轮询（session_d48bdbd0 ↔ 本仓库）。
- 另有 5 个其它 workspace 的 kimi-web worker（ReseachOS、Ebbinghaus、pi-web、xiaoe-m3u8-extract、论文/0816）和 ZCode 的 MCP 进程（pid 42284/93671）——**不要动**。
- `~/.codex-as-subagent/state.sqlite` 正常；server.log 的 serve 启停是懒启动正常行为。
