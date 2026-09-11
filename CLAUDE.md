# CLAUDE.md

## 当前阶段

- 目标：按 docs/Codex As Subagent — 详细设计与编码规格.md 自主交付尽可能完整的 V1，并形成可运行、可测试、可继续演进的 Git 仓库。
- 阶段：Task 1-8 已完成；V1 验收完成；ZCode 插件协议已按真实 bundle 取证修复；真实 Codex app-server E2E（spawn/wait/status，gpt-5.6-luna 真实模型调用）已于 2026-09-11 通过，见 docs/autonomous-runs/20260911-1206-real-codex-e2e.md。插件已用标准 ZCode marketplace 方式装入本机并启用，MCP bootstrap 由 ZCode GUI 会话拉起（进程链 `node src/cli/main.mjs mcp` ← `zcode-cli` ← `zcode-host-local-1`）。2026-09-11 真实插件路径实测暴露并修复 4 处缺陷，Hook 回流端到端打通，见 docs/autonomous-runs/20260911-1250-zcode-plugin-real-path.md。
- 下一步候选：Runtime 自动发现/probe 模块实现（设计 6.4 已定稿）；真实 send/steer/interrupt 与 crash recovery 路径；config.toml 增量覆写实现（当前零代码读取）；插件命令在 GUI 子进程 PATH 中的可行性（开源一键安装需保证 `codex-as-subagent` 可被 Host 发现，或改用 `node` + 解析后的绝对路径，且 ZCode 插件 update 会从源目录重同步覆盖本地化 patch）；session 级隔离（V2，设计 6.2 末尾）。
- 基线：2026-09-11，已完成 Git 分支、package manifest、CLI/共享常量、源码与测试目录骨架及 pinned Submodule。
- 默认裁决：使用 Node.js ESM 与内置 node:sqlite；以 fake/in-memory Supervisor Adapter 支撑确定性单元测试，同时保留真实上游 Adapter 接口。

## 任务看板

- [x] 通读详细设计，提取 V1 固定契约、目录结构、关键测试和核心不变量。
- [x] 创建 README.md、AGENTS.md、CLAUDE.md，明确三者职责。
- [x] 初始化 Git 分支与 .gitignore，固定上游 codex-supervisor-mcp Submodule。
- [x] 建立 package/CLI/源码目录和共享协议常量。
- [x] 实现 Supervisor Adapter、WorkspaceGuard、SQLite StateStore。
- [x] 实现 TerminalResult、CompletionRouter、双消费者 delivery 与 RuntimeManager 控制路径。
- [x] 实现 Unix Socket Runtime Server、stdio Bootstrap、lazy start、startup lock、idle shutdown 与 recovery。
- [x] 注册并实现十个 MCP 工具的稳定 schema 与 compact response projection，并接通 MCP JSON-RPC stdio façade。
- [x] 实现 Hook drain、lease 恢复和 Host wrapper；补齐 ZCode 插件配置。
- [x] 完成 unit/integration/smoke 回归、主 Agent 需求审查和用户级验收记录；真实外部 E2E 限制已明确记录。
- [x] 自主执行 git commit；不执行 push、发布或跨工作区合并。
- [x] 以标准 marketplace 方式把 ZCode 插件装入本机、启用，并确认 GUI 会话拉起 MCP bootstrap。
- [x] 真实插件路径实测并修复 4 处缺陷（--data-dir 透传、adapter 未终止 app-server、idle shutdown 未触发、Hook 参数解析导致输出非 JSON）；Hook 回流端到端打通。

## 当前动态决策

1. Runtime 技术栈：选用 Node.js 24 ESM + node:sqlite，避免 V1 为数据库引入额外 native 依赖；代价是 Node 版本要求提升到 24+。
2. 上游接入：主仓库通过 vendor/codex-supervisor-mcp 固定 Submodule；业务代码只依赖 Adapter 的稳定接口，测试默认使用 fake adapter，避免依赖本机 Codex session 才能跑通回归。
3. MCP transport：V1 保持 stdio Bootstrap 与 Unix socket Runtime 的分层；若 MCP SDK 引入量过大，先用最小 JSON-RPC/MCP 兼容实现，接口行为与工具 schema 优先。
4. 不确定项处理：详细设计没有锁定上游具体 commit、Host Hook stdin/additionalContext 协议细节、Codex app-server 当前 wire schema 和 dedicated profile 安装方式；本轮先提供可替换 Adapter、Host wrapper 配置和明确错误边界，并在最终报告列出待确认项。
5. MCP façade：使用最小 JSON-lines JSON-RPC 实现 `initialize`、`tools/list`、`tools/call`、`ping` 和通知；业务错误以 `isError` content 返回，协议级未知方法保持 JSON-RPC 错误；Bootstrap 不持有 Runtime/SQLite 业务状态。
6. Hook wrapper：各 Host 只在 `src/hook/hosts/` 做可替换文本 envelope；由于规格没有锁定外部 Host wire schema，真实 ZCode 协议兼容性列入 Task 8 外部验收风险，不伪称已完成。
7. 最终验收：本地确定性路径以 79/79 全量测试、lint、smoke、源码语法和 diff check 为证据；真实 Codex app-server、Host 断开和 ZCode E2E 未在缺少可验证外部会话时伪造通过，详情见 `docs/autonomous-runs/20260911-0926-codex-as-subagent-v1.md`。
8. 多主会话隔离（用户 2026-09-11 拍板）：V1 隔离边界只到 workspace，无 session 维度；V1 使用前提为同一 workspace 同时只运行一个启用本插件的主会话。session 级隔离（Bootstrap 持有会话身份、`owner_session_id`、Hook 按会话领取）列入 V2，三个待拍板点（孤儿 completion 降级、跨 session 读、隐藏 vs 标注占用）已写入详细设计 6.2 节末尾。
9. Codex CLI 来源（2026-09-11 核实）：本机无需另装 CLI，ChatGPT.app 内嵌完整 codex-cli 0.153.4，路径 `/Applications/ChatGPT.app/Contents/Resources/codex`，含 `app-server` 子命令；通过 vendor `AppServerClient` 的 `CODEX_BIN` 环境变量指向该路径即可，无需软链进 PATH。该 CLI 提供 `codex app-server generate-json-schema`，可导出当前版本官方 wire schema 用于核对 adapter 假设。
10. 配置分层（用户 2026-09-11 拍板，同日晚澄清）：`~/.codex-as-subagent/config.toml` 是对 app-server 所用 Codex 配置的**可选增量覆写**（与 Codex 配置同名、只含 Codex 键）——文件不存在则不覆写，直接用 Codex 常规 `~/.codex/config.toml`（本机该文件已可用，故可不配）；文件存在则在启动 app-server 时翻译为 `-c key=value` 参数注入（vendor 已支持 `CODEX_APP_SERVER_ARGS` 传参）。用途是解耦日常 Codex 与 Subagent 所用 Codex 的配置；它不配置 Server 自身行为。Codex 二进制路径不写入任何 config.toml，走 `CODEX_BIN` env，缺省时启动时自动发现为绝对路径（GUI Host 子进程 PATH 不可信；已实测本机 `launchctl getenv PATH` 为空）。已核实：config.toml 当前零实现（无任何代码读取）。运行时自动发现已于 2026-09-11 定稿，见决策 11。
11. Runtime 自动发现定稿（2026-09-11，依据调研 docs/research/2026-09-11-codex-runtime-discovery.md）：解析顺序 `CODEX_BIN` env > PATH > standalone managed（`~/.codex/packages/standalone/current/bin/codex`）> `~/.local/bin/codex` > Homebrew 已知路径 > ChatGPT.app 内嵌 > 旧 Codex.app 内嵌；不扫描 IDE 私有 runtime，不按版本号排序。发现目标是"满足 stable app-server contract 的 runtime"：realpath 去重 + `--version` + `generate-json-schema` 必需 method 检查 + ephemeral initialize 冒烟；记录 {binary, version, schema hash}；Server 单次生命周期不切换 binary，每次冷启动重新探测。永远自起 app-server 子进程，不 attach Desktop/managed daemon。调研推翻点：app-server 下 `-p` named profile 不可靠，覆写只走 `-c`；调研证实点：认证/配置经 `CODEX_HOME` 共享，App 登录后 CLI 无需再登录。
12. 真实 app-server 冒烟（2026-09-11 通过）：ChatGPT.app 内嵌 codex-cli 0.153.4 经 vendor AppServerClient 完成 initialize/model/list/config/read 全链路；`config/read` 返回本机真实配置（gpt-5.6-luna + xhigh + danger-full-access），证实认证共享。九个 adapter 方法（thread/start、thread/resume、turn/start、turn/steer、turn/interrupt、thread/list、thread/read、model/list、config/read）在 0.153.4 官方导出 schema 中全部存在且参数形状匹配。**发现的兼容性问题**：vendor 默认启动参数 `-c mcp_servers.codex-supervisor.enabled=false` 在 0.153.4 下导致 app-server 直接退出（"invalid transport"），我们接入时必须总是显式设置 `CODEX_APP_SERVER_ARGS`（至少 `["app-server"]`），不能依赖 vendor 默认值。冒烟脚本暂存 /tmp/cas-smoke.mjs，待固化为仓库 scripts/。
13. ZCode Hook 协议已查证（2026-09-11，harness 内嵌 subagent 逆向取证 + 主 Agent 抽查验证，全文 docs/research/2026-09-11-zcode-hook-protocol.md）：恰好 7 个事件（无 SubagentStop/SessionEnd）；stdout 必须以 `{` 开头的严格 JSON（`additionalContext`/`hookSpecificOutput`），纯文本被忽略；无 ACK，exit 0 即完成；Hook env 注入 `ZCODE_SESSION_ID`（session 隔离的关键字段已确认存在）；additionalContext 仅当前 turn 可见，Stop 事件可配 `decision:"block"` 续轮（最多 3 次）。**发现当前实现三处硬伤**：plugins/zcode/plugin.json 用了不存在的 `mcpConfig`/`hooksConfig` 字段；hooks.json 用了非法事件 `after_turn`；zcode.mjs 输出纯文本会被忽略。MCP server 是否注入 session env 未确认。待办：修正插件三处 + dump-stdin 临时插件做运行态实证。
14. 真实插件路径实测与 4 处缺陷修复（2026-09-11，记录 docs/autonomous-runs/20260911-1250-zcode-plugin-real-path.md）。安装方式：仓库根 `marketplace.json` 声明本地 directory marketplace，ZCode 以标准插件机制装入并启用；缓存插件对本机做了本地化 patch（`node` + 仓库绝对路径 + `CODEX_BIN`/`CODEX_APP_SERVER_ARGS` env），已实测 GUI 重启后 patch 保留（重启只读缓存、不从源目录重同步）。实测暴露的 4 处缺陷（fake-adapter 回归全部漏检）：
    - **① Hook 参数解析（最严重，直接使回流失效）**：插件传 `--host=zcode`，但旧 `option()` 只认 `--host zcode`，host 静默回退 `plain`，ZCode 收到纯文本被忽略。已抽 `src/shared/argv.mjs` 统一支持 `--k=v` 与 `--k v` 两种形式，并修 `drain.mjs` 覆盖用户显式 host 的问题。
    - **② `--data-dir` 未透传**：bootstrap spawn serve 时漏传，导致 SQLite 落默认目录、与 socket/lock 分叉。已在 `stdio-bootstrap`/`startup-lock`/`mcp` 全链路透传；未显式给定时按 socket 所在目录推导。
    - **③ idle shutdown 不生效**：execution 在异步 terminal 事件里被移除后，没有任何请求边界再触发 idle 判定。已给 RuntimeManager 加 `subscribeStateChanges`，terminal/spawn/send 时主动通知 RuntimeServer 重算 idle；Server listen 后先 arm 一次。
    - **④ server 无法真正退出（孤儿进程）**：旧 shutdown 只关 SQLite，未终止 app-server 子进程，其 stdio 句柄拖住事件循环，`SIGTERM` 打不掉（已在真机复现：旧进程 SIGTERM 后仍存活并挂着活 app-server）。已给 adapter 加 `close()` 并纳入 `SUPERVISOR_ADAPTER_METHODS` 契约（fake 缺省为 no-op），RuntimeManager.close 变 async 并 await 之，Server 经 `onClosed` 统一收口 store。新增 `src/shared/server-log.mjs`，serve 生命周期日志写 `<data-dir>/server.log`（诊断可观测性缺口）。验证：真实 turn spawn 后 SIGKILL 宿主，completion 落盘（completed/pending）且 Server 随后 idle 自动退出；`hook --host=zcode` 输出严格 JSON `{"additionalContext":...}` 且 completion 转 delivered。回归 90/90。
    - **生产路径全链路实证（2026-09-11 追加）**：默认数据目录 `~/.codex-as-subagent` 下冷启动干净 MCP 进程，`tools/list` 十工具齐全，真实 gpt-5.6-luna 子 agent spawn；**本 ZCode 会话自身的 Stop hook 自动执行了 `hook --host=zcode`**，将一条 pending completion 作为 additionalContext 注入并带 `decision:block` 续轮，completion 转 delivered——`spawn 异步 → 落盘 → Stop hook 自动回流 → 续轮`完整用户路径经 Host 真实驱动打通，非脚本模拟。

## 执行边界

- 主 Agent 负责需求收敛、任务排序、集成、独立 Review、最终验证与用户级验收。
- 子 Agent 按计划分配互不重叠的写入范围，不创建新的子 Agent，不修改 docs/Codex As Subagent — 详细设计与编码规格.md。
- 所有当前阶段更新写入本文件；稳定使用说明写入 README.md；通用规则写入 AGENTS.md。

## 完成定义

本轮至少应具备：可安装的 Node 项目；固定 Submodule；SQLite completion-first 状态机；workspace fail-closed；十个工具的 schema/handler；wait/wait_many 与 Hook 的同库双消费者；stdio/Unix socket 运行骨架；ZCode 插件配置；关键状态机和用户路径测试；完整验收记录。真实 Codex app-server 与 ZCode E2E 若受本机外部状态限制，必须明确记录证据和遗留风险。
