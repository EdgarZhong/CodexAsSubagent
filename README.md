# Codex As Subagent

Codex As Subagent 将本机已登录的 OpenAI Codex 作为通用 Subagent Runtime，向 ZCode、Kimi Code、Claude Code、Grok Build、Pi 等 Coding Agent 提供受控的 MCP 工具与后台完成结果回流能力。

## 项目定位

本项目不重新实现 Codex Agent。Codex 负责模型推理、工具调用、文件修改、thread/turn、认证、配置与会话持久化；本项目负责 Subagent supervision、runtime lifecycle、Host/Workspace/Session 三层隔离、completion routing、MCP façade、Hook 和 Host integration。

公共抽象固定为：一个 Codex thread 就是一个 Subagent，threadId 是唯一对外身份，单次执行是内部 turn。turnId、event cursor、reservation、delivery 和上游 raw event 均为内部实现细节。

## 架构

    Coding Agent Host
            │ MCP stdio
            ▼
    MCP Bootstrap ──HTTP over Unix Domain Socket──▶ Runtime Server
                                                       │
                                                       ├─ RuntimeManager（Thread Hold / Session Gate）
                                                       ├─ CompletionRouter（含 Web 事件驱动 delivery）
                                                       ├─ StateStore (SQLite)
                                                       ├─ WorkspaceGuard
                                                       └─ Codex Supervisor Adapter
                                                            │
                                                            ▼
                                                       Codex app-server

    Host Hook ──▶ Host Adapter (src/hosts/<host>) ──▶ CompletionStore (SQLite)

Bootstrap 只负责 Host 身份（`--host`）、workspace canonicalization、Presence lease、lazy-start Server、转发请求和 direct-delivery ACK；不持有业务状态。Runtime Server 持有 live Codex runtime 和 active execution。Hook 进程经 Host Adapter 解析 native payload（含 session identity）后直读 SQLite claim，不经 Runtime Server。

### 隔离模型（V2）

- **Host 是产品类型**（`kimi-code`、`zcode`、…），由 Host integration 静态指定，不从 cwd/session/进程名/工具参数推断；同一产品的多个 CLI 进程 = 同一 Host 的多个 Session。
- 隔离命名空间：`Execution/Completion` 在创建时固化不可变 provenance `(host, workspace, session_id)`；Thread 只有临时 Host Hold（`thread_holds` + `host_presence` lease，spawn/send 取得，stale 可 lazy takeover）。
- Weak Host 的 MCP 请求 session-blind：session 身份由 `PreToolUse` Session Gate 写入持久化 `current_sessions(host, workspace)`，MCP 请求按其归属；无 `current_session` 时 fail closed `session_not_established`（下一次合法 PreToolUse 后自恢复）。
- 所有 completion claim（Hook / waiter）使用完整 `(host, workspace, session_id, delivery_state='pending')` 谓词，workspace-only 盲领被结构性排除；claim 以 `delivery_state + claim_id` 定界，每次重新 claim 生成新 claim 代际。
- Kimi TUI 与 Web 统一 `host = kimi-code`；当前 V2 的唯一主动 Mailbox delivery transport 是 Hook，Terminal Initiate 按 waiter reservation 选择两个 Initial Transaction 分支（出生即 `claimed_waiter` 或 `pending`）。

## 稳定接口与实现入口

| 内容 | 入口 |
|---|---|
| V2 权威规格（三份） | docs/CodexAsSubagent V2 Session 隔离与 Mailbox 架构设计.md、docs/CodexAsSubagent V2 串投修复与 Kimi Code 集成适配说明.md、docs/CodexAsSubagent V2 Host 隔离、Thread Hold 与 CLI-Adapter 实施规格.md |
| V1 基线规格 | docs/Codex As Subagent — 详细设计与编码规格.md |
| 当前阶段与任务看板 | CLAUDE.md |
| 通用协作与开发规则 | AGENTS.md |
| 实施计划 | docs/superpowers/plans/ |
| Host 插件 | plugins/ |
| Runtime 源码 | src/ |
| 测试 | tests/ |

## 目录骨架

    src/
    ├── adapters/supervisor/  # 上游 codex-supervisor-mcp 的唯一隔离层
    ├── adapters/sqlite/      # SQLite StateStore（V2 schema：executions/completions/thread_holds/host_presence/current_sessions）
    ├── core/                 # Runtime、execution、completion、workspace、model、Thread Hold
    ├── hosts/                # Host Protocol Registry 与各 Host native payload 解析（kimi-code、zcode）
    ├── server/               # Unix socket Server、请求路由、生命周期、恢复
    ├── mcp/                  # stdio Bootstrap、工具注册、响应投影
    ├── hook/                 # completion drain 与 Host 输出 envelope（hosts/）
    ├── install/              # Host 插件安装器（拷贝资源、本地化命令、注册 marketplace）
    ├── cli/                  # serve、mcp、hook、drain、install、doctor 命令
    └── shared/               # 常量、错误、协议工具、argv、Codex runtime 发现、日志
    plugins/                  # Host 资源源文件（MCP/Hook 注册、manifest），唯一真源
    vendor/                   # Git Submodule
    tests/                    # unit、integration、e2e、fixtures
    docs/                     # 规格、计划、验收记录

## 运行环境与命令

- Node.js >=24.0.0，使用 ESM。
- 持久目录默认为 ~/.codex-as-subagent/，包含 state.sqlite、Unix socket、锁和 server.log。`config.toml`（可选，对 Codex 配置的增量覆写，只含 Codex 键）会在 Server 冷启动时翻译为 `-c key=value` 并插入 `app-server` 参数之前；文件不存在不覆写，格式错误 fail-closed。参考 [config.example.toml](config.example.toml)。
- Codex 自有认证、profile、transcript 仍位于 ~/.codex/，不复制到本项目数据库。
- 默认 dedicated Codex profile：gpt-5.6-luna + xhigh。Server 冷启动时自动发现 Codex app-server 运行时（`CODEX_BIN` env 优先），无需手工配置路径。
- **升级须知（V2 breaking）**：V2 不做数据迁移。升级前停止旧 CAS Runtime/MCP 实例与依赖旧 runtime state 的 Subagent Turn；旧 CAS SQLite 状态（含 delivered history）不保证保留，启动时按 V2 schema 废弃重建。

    npm install
    npm test
    npm run lint
    npm run smoke
    npm run install:kimi-code:dry
    node src/cli/main.mjs doctor --json
    node src/cli/main.mjs --help

运行前需要本机已登录 Codex，并具备可用的 Codex app-server。

## CLI 协议（V2）

- `serve [--data-dir] [--socket] [--lock] [--idle-shutdown-ms]`：全局共享 Runtime，不接受 `--host/--workspace/--session`。
- `mcp --host <HOST> [--data-dir] [--socket] [--lock]`：`--host` 必填；workspace 取 MCP 进程 cwd 经 WorkspaceGuard canonicalize；启动即注册 Presence（heartbeat 20s / lease 60s，直写 SQLite），注册成功后才处理 MCP 调用，退出 best-effort detach。
- `hook --host <HOST>`：`--host` 必填，无 plain fallback；Host 原始 payload 经 stdin 原样进入，由 `src/hosts/<host>` 解析 session identity/cwd/event/tool 字段；正式集成不得用 `--workspace` 覆盖。
- `drain --host <HOST> --workspace <PATH> --session <SESSION_ID>`：三项全部必填的低层投递接口，不做 workspace-only drain。

## MCP 公共工具

固定公开十个工具：codex_spawn、codex_send、codex_steer、codex_status、codex_wait、codex_wait_many、codex_interrupt、codex_list_threads、codex_read_thread、codex_models。

codex_spawn 永远异步；codex_wait 与 codex_wait_many 固定最多等待 500 秒；工具不接受 cwd/workspace/sandbox/approval/event cursor/turnId 参数。当前 Host 的 canonical CWD 是唯一 workspace 边界；session 身份不进入工具参数。

线程操作与 Hold 的关系（详见 V2 实施规格 §1.10）：spawn 创建 Hold；send 检查/acquire/lazy takeover（他人有效持有时返回 `thread_held` 与 `data.holderHost`）；steer/interrupt 不 takeover；wait/status/read_thread 不取 Hold；list_threads 不显示其他 active Host 有效持有的 Thread。Codex 自身 writer lock 错误仍规范化为 `thread_locked`，与 CAS 层 `thread_held` 严格分离。

## Hook 与 Host 插件

`codex-as-subagent hook --host=<host>` 经 Host Adapter 解析 native session identity 后，按完整 `(host, workspace, session_id)` 原子 claim pending completion，渲染后 ACK；Hook 缺必要 session 字段时拒绝 claim（不 fallback）。Kimi TUI 的 `PreToolUse` 承担双重职责且顺序固定：先 Mailbox 回流（claim 自己 session 的 pending → veto 工具 → 注入），无 pending 时才对 CAS MCP 工具执行 Session Gate（他人 active Execution → veto；空闲 → 原子接管）。`Stop`/`UserPromptSubmit` 只承担 Mailbox delivery。Hook 不启动、恢复或中断 Codex thread。

`plugins/kimi-code/` 服务 Kimi TUI 与 Web（统一 `--host=kimi-code`）：主动回流经 Host Hook（`PreToolUse`/`Stop`/`UserPromptSubmit`）注入；Hook 静态安装，是否投递由 Mailbox 数据决定，不动态装卸 Hook。CLI 安装命令为 `codex-as-subagent install --host=kimi-code`，支持 `--dry-run --kimi-code-home <path>`；MCP server 由安装器注册到用户级 `$KIMI_CODE_HOME/mcp.json`（宿主以 workspace cwd 拉起用户级 stdio MCP；插件 manifest 携带 MCP 会以插件目录为 cwd，禁止使用）。安装后执行 `/reload` 或新开 Kimi session。

`plugins/zcode/` 注册 ZCode 插件：`.mcp.json` 提供十个 MCP 工具，`hooks/hooks.json` 在 `UserPromptSubmit`、`PostToolUse`（匹配所有工具）与 `Stop` 触发 `codex-as-subagent hook --host=zcode`。**注意（2026-09-12）**：V2 核心已合入，但 ZCode 插件资源升级与真实 E2E 推后到单独一轮，现有 ZCode 安装在 V2 协议下暂不可用（`mcp` 现要求 `--host`）。

Host 插件的本机开发闭环见 AGENTS.md「Host 插件开发与安装 SOP」：改 `plugins/<host>/` 源码 → `install --host=<host>` → 重启宿主 → 验证。

## 已知限制与未完成项

**使用前提与限制**

- **共享 `~/.codex` 的跨客户端线程锁**：Codex app-server 对每个 thread 持有 flock 型写锁。若同一账号下另有 Codex 客户端同时占用某线程，本项目的 `codex_send`/`codex_steer`/`codex_interrupt` 对该线程会失败；只读操作不受影响。该情况返回 `thread_locked`（关闭另一客户端或改用新线程）。这是共享 Codex 存储的固有限制，作为使用前提接受。
- **仅 `thread_locked` 一个上游错误被规范化**为该文案，其余上游错误保持原样透传；`thread_held`/`session_not_established` 为 CAS 自身错误码。
- **Kimi Web Server API 属于 experimental**：投递以实例 API 的 session/workspace 校验为准；Server 缺失时 completion 保持 pending，不丢数据。
- **弱 Host 固有边界**：同一 `(host, workspace)` 在 idle 交接边界并发的 session-blind MCP 调用无法归因（设计明确不支持，见 V2 架构设计 §五）。

**尚未完成（权威清单见 CLAUDE.md 任务看板）**

- `tests/e2e/`、`tests/fixtures/` 空占位，缺自动化 E2E。
- 开源一键安装在 Host 子进程 PATH 的发现方案未定。
- 真实 Kimi TUI/Web E2E 与 ZCode 插件升级待用户/下一轮执行。
- 真实 `status=failed` turn 路径未单独构造验证。

**明确不做**

- 不做多 Server 路由，也不保留 Web transport 错误面（Server 型 Host 单 active Server 为环境假设；同一 `(host, workspace, session_id)` 单活跃 interactive instance 为产品约束）。
- 不做 V1→V2 数据迁移与旧状态保留（破坏性重建是完整升级契约）。
- 不做线程锁探测；不新增 Hook 事件；MCP public API 不增加 cwd/workspace/sandbox/approval/event cursor/raw event/generic Codex config 编辑能力。

## 开发测试闭环

1. 先阅读三份 V2 规格、AGENTS.md 和 CLAUDE.md（V1 基线规格用于未被 V2 修改的语义）。
2. 在 tests/unit 先覆盖状态机、Host/Session 隔离、Thread Hold、协议投影和 changed-files attribution，再补 integration/e2e。
3. 每次改变 TerminalResult、delivery、lifecycle 或公共 schema，都运行相关测试和完整 npm test。
4. 复核由主会话承担：规格覆盖、隔离 fail-closed、completion-first、无丢失交付和用户路径。
5. 完成前按 docs/autonomous-runs/ 中的验收记录逐条执行真实用户级验收。

## 重要文档索引

| 文档 | 内容 |
|---|---|
| README.md | 稳定项目事实、架构、目录、命令和入口 |
| AGENTS.md | 项目通用规则、流程、边界和验收要求 |
| CLAUDE.md | 当前阶段进度、任务看板、决策和风险 |
| docs/CodexAsSubagent V2 Session 隔离与 Mailbox 架构设计.md | V2 权威规格：Session Identity、弱 Host 状态机、Mailbox、Fail-Closed/Recovery Matrix、环境假设 |
| docs/CodexAsSubagent V2 串投修复与 Kimi Code 集成适配说明.md | V2 权威规格：claim 谓词修复、Kimi TUI 双职责、Web 事件驱动 delivery |
| docs/CodexAsSubagent V2 Host 隔离、Thread Hold 与 CLI-Adapter 实施规格.md | V2 权威规格：Thread Hold/Presence、Host Namespace、CLI 协议、验收场景 |
| docs/Codex As Subagent — 详细设计与编码规格.md | V1 基线规格（已交付；被取代小节已移除） |
| docs/Codex As Subagent × Kimi Code — 主动回流设计定稿与集成参考知识库.md | Kimi 协议事实参考（Hook payload、Server API、registry；worker 设计部分已废除） |
| docs/superpowers/plans/ | 各轮实现计划、接口和测试任务 |
| docs/autonomous-runs/ | 用户级验收快照与结果 |
| docs/autonomous-runs/20260911-2320-session-routing-and-isolation-findings.md | V1 串投取证（Kimi Web + ZCode 复现；V2 已结构性修复） |
| docs/autonomous-runs/20260911-1340-ten-tool-e2e-and-interrupt.md | 十工具真实 ZCode 会话 E2E、中断协议修复（V1） |
| docs/autonomous-runs/20260911-1701-kimi-code-integration.md | Kimi Code TUI/Web 插件、安装器与 completion 回流验收（V1） |
| docs/research/2026-09-11-codex-runtime-discovery.md | Codex 安装形态、认证共享与 app-server 协议外部调研 |
| docs/research/2026-09-11-zcode-hook-protocol.md | ZCode Hook/MCP/插件协议逆向取证调研 |
| plugins/zcode/README.md | ZCode MCP/Hook 插件安装说明 |
| plugins/kimi-code/README.md | Kimi Code TUI/Web MCP、Hook 与安装说明 |

## 许可证

主项目按 MIT License 发布；vendor/codex-supervisor-mcp 保留其上游 MIT License 与版权声明。
