# AGENTS.md

## 项目规则

- 所有面向用户和项目文档使用中文；代码中的公共协议字段、错误类型和上游名称保持设计规格中的英文拼写。
- 详细设计文件是 V1 的权威规格。发现歧义时先按最小、可恢复、fail-closed 的实现裁决，并将裁决记录到 CLAUDE.md 与本轮验收记录。
- 核心业务代码只能通过 src/adapters/supervisor/ 访问 vendor/codex-supervisor-mcp；禁止在 src/core/、src/server/、src/mcp/、src/hook/ 直接 import vendor 内部文件。
- Host-specific 行为只能放在 plugins/ 或 src/hook/hosts/；核心 Runtime 禁止散落 if (host === ...) 分支。
- **`plugins/<host>/` 是各 Host 资源文件（MCP 注册、Hook 注册、manifest、说明）的唯一真源**。禁止手工编辑宿主（ZCode 等）的插件缓存或状态文件；任何对宿主可见的改动，都必须先改仓库源，再通过安装命令落到宿主。
- threadId 是唯一公共 Subagent identity；turnId、event cursor、workspace、approval、raw events 和 delivery 内部字段不得泄漏到模型可见接口。
- 模型不能指定 workspace/cwd；请求 workspace 必须由 Host 当前 canonical CWD 提供，无法获得或 realpath 不一致时 fail closed。
- TerminalResult 必须先在 SQLite 中提交，再尝试 direct 或 Hook 交付；direct delivery 没有 ACK 不能标记 delivered。
- wait 超时只结束本次等待，不 interrupt Codex；pending completion 不阻止 Runtime Server 自动退出。
- changed-files attribution 只能来自当前 internal turn 的结构化记录、persisted patch/file-change、turn-scoped history 或 turn/diff notification，禁止用 repository-level Git diff/status。

## 目录与职责

- src/adapters/：上游协议和 SQLite 持久化适配层。
- src/core/：线程执行、completion、workspace、模型和领域错误。
- src/server/：Unix socket Runtime Server、路由、锁、生命周期和恢复。
- src/mcp/：stdio Bootstrap、10 个工具和公共响应投影。
- src/hook/：薄 completion drain 与 Host wrapper。
- src/cli/：唯一命令行入口。
- plugins/：各 Host 的资源源文件（MCP/Hook 注册、manifest、说明），是唯一真源；安装产物落到宿主缓存，不在本仓库。安装器实现在 src/install/。
- tests/：按 unit/integration/e2e/fixtures 分层；测试不得依赖真实 Git diff 推断本 turn 修改。
- docs/：规格、专项 SOP、计划和验收记录；不创建与现有文档职责重叠的文档。

## 开发流程

1. 开始工作先检查 AGENTS.md、CLAUDE.md、README.md 和近两次提交中的文档变更。
2. 多步骤实现先在 docs/superpowers/plans/ 固定文件边界、接口、测试和完成判据，再按任务执行。
3. 每项任务完成后运行覆盖其变更的最小测试；集成前运行完整测试、lint、smoke 和必要的真实用户路径。
4. 子 Agent 只能修改分配的文件范围，必须写报告和测试证据；主 Agent 负责审查、集成、必要补丁和最终验收。
5. Review 发现 Critical/Important 问题必须修复并重新 Review；Minor 问题必须记录到动态 ledger，不得静默丢弃。
6. 提交信息使用清晰的 Conventional Commit 风格；未经用户明确授权不得 push、发布、合并或改动工作区之外的状态。

## 测试与验收 SOP

- 单元测试使用 Node 内置 test runner，运行：npm test。
- 静态检查运行：npm run lint（覆盖 `src/**/*.mjs` 的 Node 语法检查；仍非全量类型/规则检查，改动后不得据此宣称"静态检查通过"涵盖类型或业务规则）。
- CLI/stdio/socket 基础回归运行：npm run smoke。
- SQLite 并发场景必须验证 transaction 短、WAL/FULL/busy_timeout/foreign_keys 配置和 compare-and-set 状态转移。
- 验收必须覆盖 spawn async、send/steer/interrupt、workspace 隔离、wait/wait_many、Hook claim/lease、crash recovery、lazy activation、idle shutdown、changed-files attribution 和 ZCode 插件骨架。
- 验收记录写入 docs/autonomous-runs/YYYYMMDD-HHmm-任务标题.md，每条用户行为路径记录预期结果、实际命令/输入和证据。

## Host 插件开发与安装 SOP

本机开发、测试 Host 插件（MCP/Hook 注册、wrapper、manifest）时，固定走以下闭环，不依赖 GUI，不手工编辑宿主缓存：

1. **只改仓库源码**：`plugins/<host>/` 下的资源文件，以及对应的 `src/` 实现（如 `src/hook/hosts/<host>.mjs`）。`plugins/<host>/` 中的资源保持**与宿主无关的干净形态**（如裸命令 `codex-as-subagent`），不要写入本机绝对路径。
2. **用本项目二进制安装到宿主**：`node src/cli/main.mjs install --host=<host>`（或 `npm run install:<host>`）。安装器负责拷贝资源到宿主插件缓存、本地化命令（Hook 走 shell，本地化为绝对路径；Kimi 的 MCP server 注册到用户级 `$KIMI_CODE_HOME/mcp.json`——插件 manifest 携带 MCP 会被宿主以插件目录 cwd 拉起，workspace 永远错配，禁止使用）、探测运行时（如 `CODEX_BIN`）、注册 marketplace 与安装记录、启用插件，并在覆盖前留备份。重复执行幂等。
3. **重启宿主**（或新开会话）使配置生效。Hook 配置在会话启动时加载，MCP server 每会话新建进程，因此均需重启/新会话后才生效。
4. **验证**：`<host> plugins list` 确认注册与 hooks 数量；再走一遍真实用户路径（spawn → completion 落盘 → Hook 回流）。

变更只涉及 `src/`（不含 `plugins/` 资源）时，通常无需重装：Hook 每次事件现起进程读源码；Runtime Server 懒启动且空闲自退，下次自动加载新代码；MCP server 在新会话重建。

**GUI 安装是另一条独立路线**，按各 Host 官方文档执行（例如 ZCode 的 Settings → Plugin Management → Discover → `+` 添加 marketplace → Install），该路线要求命令在 Host 子进程 PATH 中可解析。两条路线安装的是同一份 `plugins/` 源文件。

- 不删除文件；需要淘汰的文件移入仓库根 .archive/ 并保证 Git 不追踪该目录。
- 不在 MCP public API 增加 cwd、sandbox、approval、event cursor、raw event 或 generic Codex config 编辑能力。
- 不把 Hook 变成 MCP tool，不让 Hook 启动/恢复/中断 thread，不让 Bootstrap 持有 Runtime 或 SQLite 业务状态。
- 不通过 PID 相等就清理 orphan app-server；必须能高置信证明归属当前旧实例。
- 不以“测试通过”代替规格审查和用户级验收。
