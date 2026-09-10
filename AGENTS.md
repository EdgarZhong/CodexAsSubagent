# AGENTS.md

## 项目规则

- 所有面向用户和项目文档使用中文；代码中的公共协议字段、错误类型和上游名称保持设计规格中的英文拼写。
- 详细设计文件是 V1 的权威规格。发现歧义时先按最小、可恢复、fail-closed 的实现裁决，并将裁决记录到 CLAUDE.md 与本轮验收记录。
- 核心业务代码只能通过 src/adapters/supervisor/ 访问 vendor/codex-supervisor-mcp；禁止在 src/core/、src/server/、src/mcp/、src/hook/ 直接 import vendor 内部文件。
- Host-specific 行为只能放在 plugins/ 或 src/hook/hosts/；核心 Runtime 禁止散落 if (host === ...) 分支。
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
- plugins/：ZCode 等 Host 的注册配置和说明。
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
- 静态检查运行：npm run lint。
- CLI/stdio/socket 基础回归运行：npm run smoke。
- SQLite 并发场景必须验证 transaction 短、WAL/FULL/busy_timeout/foreign_keys 配置和 compare-and-set 状态转移。
- 验收必须覆盖 spawn async、send/steer/interrupt、workspace 隔离、wait/wait_many、Hook claim/lease、crash recovery、lazy activation、idle shutdown、changed-files attribution 和 ZCode 插件骨架。
- 验收记录写入 docs/autonomous-runs/YYYYMMDD-HHmm-任务标题.md，每条用户行为路径记录预期结果、实际命令/输入和证据。

## 禁止事项

- 不删除文件；需要淘汰的文件移入仓库根 .archive/ 并保证 Git 不追踪该目录。
- 不在 MCP public API 增加 cwd、sandbox、approval、event cursor、raw event 或 generic Codex config 编辑能力。
- 不把 Hook 变成 MCP tool，不让 Hook 启动/恢复/中断 thread，不让 Bootstrap 持有 Runtime 或 SQLite 业务状态。
- 不通过 PID 相等就清理 orphan app-server；必须能高置信证明归属当前旧实例。
- 不以“测试通过”代替规格审查和用户级验收。
