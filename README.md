# Codex As Subagent

Codex As Subagent 将本机已登录的 OpenAI Codex 作为通用 Subagent Runtime，向 ZCode、Kimi Code、Claude Code、Grok Build、Pi 等 Coding Agent 提供受控的 MCP 工具与后台完成结果回流能力。

## 项目定位

本项目不重新实现 Codex Agent。Codex 负责模型推理、工具调用、文件修改、thread/turn、认证、配置与会话持久化；本项目负责 Subagent supervision、runtime lifecycle、workspace isolation、completion routing、MCP façade、Hook 和 Host integration。

公共抽象固定为：一个 Codex thread 就是一个 Subagent，threadId 是唯一对外身份，单次执行是内部 turn。turnId、event cursor、reservation、delivery 和上游 raw event 均为内部实现细节。

## 架构

    Coding Agent Host
            │ MCP stdio
            ▼
    MCP Bootstrap ──HTTP over Unix Domain Socket──▶ Runtime Server
                                                       │
                                                       ├─ RuntimeManager
                                                       ├─ CompletionRouter
                                                       ├─ StateStore (SQLite)
                                                       ├─ WorkspaceGuard
                                                       └─ Codex Supervisor Adapter
                                                            │
                                                            ▼
                                                       Codex app-server

    Host Hook ──▶ CompletionStore (SQLite)

Bootstrap 只负责取得当前 workspace、lazy-start Server、转发请求和 direct-delivery ACK；不持有业务状态。Runtime Server 持有 live Codex runtime 和 active execution。Hook 只 claim 已持久化 completion，不参与 live execution。

## 稳定接口与实现入口

| 内容 | 入口 |
|---|---|
| 详细设计与编码规格 | docs/Codex As Subagent — 详细设计与编码规格.md |
| 当前阶段与任务看板 | CLAUDE.md |
| 通用协作与开发规则 | AGENTS.md |
| 实施计划 | docs/superpowers/plans/2026-09-11-codex-as-subagent-v1.md |
| Host 插件 | plugins/ |
| Runtime 源码 | src/ |
| 测试 | tests/ |

## 目录骨架

    src/
    ├── adapters/supervisor/  # 上游 codex-supervisor-mcp 的唯一隔离层
    ├── adapters/sqlite/      # SQLite StateStore
    ├── core/                 # Runtime、execution、completion、workspace、model
    ├── server/               # Unix socket Server、请求路由、生命周期、恢复
    ├── mcp/                  # stdio Bootstrap、工具注册、响应投影
    ├── hook/                 # completion drain 与 Host 薄封装（hosts/ 放各 Host 封装）
    ├── install/              # Host 插件安装器（拷贝资源、本地化命令、注册 marketplace）
    ├── cli/                  # serve、mcp、hook、drain、install 命令
    └── shared/               # 常量、错误、协议工具、argv、Codex runtime 发现、日志
    plugins/                  # Host 资源源文件（MCP/Hook 注册、manifest），唯一真源
    vendor/                   # Git Submodule
    tests/                    # unit、integration、e2e、fixtures
    docs/                     # 规格、计划、验收记录

## 运行环境与命令

- Node.js >=24.0.0，使用 ESM。
- 持久目录默认为 ~/.codex-as-subagent/，包含 state.sqlite、Unix socket、锁和 server.log。`config.toml`（可选，对 Codex 配置的增量覆写，只含 Codex 键，见详细设计 6.3/6.4）**当前尚未实现读取**，属规划项。
- Codex 自有认证、profile、transcript 仍位于 ~/.codex/，不复制到本项目数据库。
- 默认 dedicated Codex profile：gpt-5.6-luna + xhigh。Server 冷启动时按设计 6.4 自动发现 Codex app-server 运行时（`CODEX_BIN` env 优先），无需手工配置路径。

    npm install
    npm test
    npm run lint
    npm run smoke
    node src/cli/main.mjs --help

运行前需要本机已登录 Codex，并具备可用的 Codex app-server。没有 Hook 能力的 Host 仍可使用 wait、wait_many、status 和 read_thread。

使用前提：V1 的隔离边界是 workspace，同一 workspace 同时只运行一个启用本插件的 Host 主会话；并行分工由 subagent 承担。session 级隔离为 V2 方向，详见详细设计 6.2 节末尾。

## MCP 公共工具

V1 固定公开以下十个工具：codex_spawn、codex_send、codex_steer、codex_status、codex_wait、codex_wait_many、codex_interrupt、codex_list_threads、codex_read_thread、codex_models。

codex_spawn 永远异步；codex_wait 与 codex_wait_many 固定最多等待 500 秒；工具不接受 cwd/workspace/sandbox/approval/event cursor/turnId 参数。当前 Host 的 canonical CWD 是唯一 workspace 边界。

## Hook 与 ZCode 插件

`codex-as-subagent hook --host=<host>` 从当前 canonical workspace 的 SQLite completion buffer 原子 claim pending completion，渲染后 ACK；`codex-as-subagent drain` 提供宿主无关的 plain 输出。Hook 不启动、恢复或中断 Codex thread。`--host` 同时接受 `--host=zcode` 与 `--host zcode` 两种写法。

`plugins/zcode/` 注册 ZCode 插件：`.mcp.json` 提供十个 MCP 工具，`hooks/hooks.json` 在 `UserPromptSubmit`、`PostToolUse`（匹配所有工具）与 `Stop` 触发 `codex-as-subagent hook --host=zcode`——PostToolUse 负责 turn 进行中即时回流，UserPromptSubmit 负责跨 turn 兜底，Stop 负责 turn 结束窗口。该插件已按标准 marketplace 方式装入本机 ZCode 并完成真实路径验证，见 docs/autonomous-runs/20260911-1250-zcode-plugin-real-path.md。

安装提供两种并存方式：

- **方式 A（ZCode GUI 标准路径）**：确保 `codex-as-subagent` 落在 GUI 子进程 PATH 中（如 `npm install -g .`），再用 ZCode 的 Discover 标签页添加本仓库为 marketplace 并 Install。详见 [plugins/zcode/README.md](plugins/zcode/README.md)。
- **方式 B（CLI 一键）**：`codex-as-subagent install --host=zcode`（或 `npm run install:zcode`），把插件拷贝进 ZCode 缓存、本地化为绝对路径命令、注册 marketplace 并启用；支持 `--dry-run`。

Host 插件的本机开发闭环见 AGENTS.md「Host 插件开发与安装 SOP」：改 `plugins/<host>/` 源码 → `install --host=<host>` → 重启宿主 → 验证。

## 已知限制与未完成项（V1）

**使用前提与限制**

- **共享 `~/.codex` 的跨客户端线程锁**：Codex app-server 对每个 thread 持有 flock 型写锁（`~/.codex/thread-writer-locks/<threadId>.lock`）。若同一账号下另有 Codex 客户端（如 ChatGPT 桌面版）同时运行并占用某线程，本项目的 `codex_send`/`codex_steer`/`codex_interrupt` 对该线程会失败；只读操作（`codex_status`/`codex_read_thread`）不受影响。本 Runtime Server 自己创建的线程由自己的 app-server 持锁，正常可用。该情况返回稳定错误码 `thread_locked`（文案提示关闭另一客户端或改用新线程）。这是共享 Codex 存储的固有限制，V1 接受其为使用前提（同机、同 `~/.codex` 时避免多客户端并用）。
- **单 workspace 单主会话**：V1 隔离边界是 workspace，同一 workspace 同时只运行一个启用本插件的主会话；session 级隔离为 V2（详细设计 6.2 末尾）。
- **仅 `thread_locked` 一个上游错误被规范化**，其余上游错误保持原样透传（code/message 均不改）。

**尚未完成（V1 Backlog，权威清单见 CLAUDE.md 任务看板）**

- **`config.toml` 增量覆写未实现**（无代码读取），属设计 6.3/6.4 已承诺但未落地项。
- **`npm run lint` 只做单文件语法检查**（`node --check src/cli/main.mjs`），不覆盖全量源码，也无 ESLint 规则。
- **`tests/e2e/` 与 `tests/fixtures/` 为空占位**；真实端到端目前靠 `docs/autonomous-runs/` 的手工验收路径，缺可重复执行的自动化 E2E。
- **`doctor` 命令未实现**（设计 6.4 提及）。
- **开源一键安装在 Host 子进程 PATH 中的发现方案未定**：ZCode 插件 update 会从源目录重同步覆盖命令本地化。
- **真实 `status=failed` 的 turn 路径**未单独构造验证（仅经 recovery 合成 failed 验证过）。
- **真实 ZCode `UserPromptSubmit` 事件的端到端注入未验证**（Stop/PostToolUse 已真机验证）。

**明确不做（V1 决定）**

- **不做线程锁探测**（不实现按 `thread-writer-locks/` 判定并在 `thread/list` 标记占用）：协议层无锁字段，本地 flock 探测无法区分"自己 vs 他人"（会误标自家可用线程）。仅将锁争用错误规范化为 `thread_locked`。
- **不新增 Hook 事件**，固定 `UserPromptSubmit` + `PostToolUse` + `Stop`。
- **MCP public API 不增加** cwd/workspace/sandbox/approval/event cursor/raw event/generic Codex config 编辑能力。

## 开发测试闭环

1. 先阅读详细设计、AGENTS.md 和 CLAUDE.md。
2. 在 tests/unit 先覆盖状态机、workspace、协议投影和 changed-files attribution，再补 integration/e2e。
3. 每次改变 TerminalResult、delivery、lifecycle 或公共 schema，都运行相关测试和完整 npm test。
4. 使用独立 Review 检查规格覆盖、跨 workspace fail-closed、completion-first、无丢失交付和用户路径。
5. 完成前按 docs/autonomous-runs/ 中的验收记录逐条执行真实用户级验收。

## 重要文档索引

| 文档 | 内容 |
|---|---|
| README.md | 稳定项目事实、架构、目录、命令和入口 |
| AGENTS.md | 项目通用规则、流程、边界和验收要求 |
| CLAUDE.md | 当前阶段进度、任务看板、决策和风险 |
| docs/Codex As Subagent — 详细设计与编码规格.md | V1 权威设计与编码规格 |
| docs/superpowers/plans/2026-09-11-codex-as-subagent-v1.md | 本轮实现计划、接口和测试任务 |
| docs/autonomous-runs/ | 用户级验收快照与结果 |
| docs/autonomous-runs/20260911-1340-ten-tool-e2e-and-interrupt.md | 十工具真实 ZCode 会话 E2E、PostToolUse 中途回流与中断协议修复（2026-09-11） |
| docs/autonomous-runs/20260911-1250-zcode-plugin-real-path.md | ZCode 插件真实路径验收：4 处缺陷修复与 Hook 回流打通（2026-09-11） |
| docs/research/2026-09-11-codex-runtime-discovery.md | Codex 安装形态、认证共享与 app-server 协议外部调研（2026-09-11） |
| docs/research/2026-09-11-zcode-hook-protocol.md | ZCode Hook/MCP/插件协议逆向取证调研（2026-09-11） |
| plugins/zcode/README.md | ZCode MCP/Hook 插件安装说明 |

## 许可证

主项目按 MIT License 发布；vendor/codex-supervisor-mcp 保留其上游 MIT License 与版权声明。
