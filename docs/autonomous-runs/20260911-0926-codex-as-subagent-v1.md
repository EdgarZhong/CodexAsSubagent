# Codex As Subagent V1 用户级验收记录

## 基本信息

- 验收时间：2026-09-11 09:26（Asia/Singapore）
- 分支：`codex/autonomous-v1`
- 任务范围：Task 1-7 实现、Task 8 最终回归与验收记录
- 代码提交：`693881c`、`38a02a1`
- 文档提交：`f1c747e`、`2d51e37`
- 审查方式：主 Agent 按需求逐项自审；遵循用户“停止使用子 Agent”的明确约束，未派发独立 reviewer。

## 验收路径

| 用户行为路径 | 预期结果 | 实际命令/输入与证据 | 结果 |
|---|---|---|---|
| 启动项目并运行回归 | 所有单元/集成测试通过 | `npm test`；Node test runner 报告 `79` tests、`79` pass、`0` fail | 通过 |
| CLI 基础入口 | help 可列出 serve/mcp/hook/drain | `npm run smoke`；输出四个命令和默认模型/effort | 通过 |
| MCP 初始化 | 返回 JSON-RPC initialize、tools capability 和 serverInfo | `printf` 输入 `initialize` 到 `node src/cli/main.mjs mcp --data-dir <临时目录>` | 通过 |
| MCP 工具发现 | 精确公开十个工具、闭合 schema | 同一真实 CLI 输入 `tools/list`；输出十个固定工具且 `additionalProperties:false` | 通过 |
| MCP 工具错误 | 未知方法使用协议级错误，业务错误使用 isError content | 同一 CLI 输入 `unknown/method` 得到 `-32601`；集成测试覆盖 workspace mismatch | 通过 |
| 异步 spawn/并行 thread | spawn 立即返回；多个 thread 可并行 | `npm test` 中 `RuntimeManager.spawn returns an immediate public ACK`、`waitMany all snapshots active threads` | 通过 |
| send/steer/interrupt | 只能控制当前 workspace/thread，busy/no-active 状态 fail-closed | `npm test` 中 send、steer、interrupt 和错误状态测试 | 通过 |
| workspace 隔离 | canonical CWD 是唯一边界，跨 workspace 拒绝 | `npm test` 中 WorkspaceGuard 与 waitMany workspace mismatch 测试 | 通过 |
| wait/wait_many/timeout | completion-first、超时不 interrupt、批量 ACK 绑定正确 | `npm test` 中 wait、waitMany、timeout 和 delivery 测试 | 通过 |
| Hook claim/render/ACK | claim 先于 render，stdout 成功后 ACK | `node --test tests/unit/hook-drain.test.mjs tests/integration/hook-delivery.integration.test.mjs`；8/8 focused tests | 通过 |
| Hook lease 恢复 | render crash 不 ACK，过期 claimed_hook 回到 pending | `hook-delivery.integration.test.mjs` 的 expired lease 场景；真实 SQLite 状态最终 delivered | 通过 |
| Hook workspace 过滤 | 只交付当前 canonical workspace | 同一 integration test 插入 current/foreign workspace，foreign 保持 pending | 通过 |
| Host wrapper 与 completionId | Host 输出互相隔离，completionId 可见且不静默去重 | `hook-drain.test.mjs`、`render-completions` 测试 | 通过 |
| Hook/Drain CLI | 无 pending 时正常退出，不启动 Runtime | `node src/cli/main.mjs hook --data-dir <临时目录>` 与 `drain --data-dir <临时目录>`；均 exit 0 | 通过 |
| Server lifecycle/recovery | active execution 阻止 idle shutdown；未协调 execution 变为 supervisor_crash | `npm test` 中 lifecycle/recovery integration tests | 通过 |
| lazy activation/startup lock | 单赢家、陈旧 lock 恢复、socket health wait | `npm test` 中 startup-lock tests；真实 MCP initialize/tools/list CLI smoke 不需启动 Runtime | 通过（基础路径） |
| completion race/lease | direct/Hook CAS claim，重复 terminal 不丢失 | `npm test` 中 SQLite direct reservation、Hook worker race、completion-router 测试 | 通过 |
| changed-files attribution | 只取当前 turn 结构化记录，不查 repository-level Git diff/status | `rg` 扫描 `src tests` 无 Git diff/status 依赖；protocol-normalizer/history tests 通过 | 通过 |
| 模型解析 | 默认模型/effort 与显式模型校验稳定 | `npm test` 中 ModelService 与 Runtime models tests | 通过 |
| ZCode 插件检查 | MCP、Hook 配置存在且不复制 Runtime 逻辑 | `node --test tests/unit/plugin-layout.test.mjs`；插件 JSON 和 README 断言通过 | 通过 |

## 静态检查证据

- `npm run lint`：通过。
- `npm run smoke`：通过。
- `find src -type f -name '*.mjs' -exec node --check {} \;`：通过。
- `git diff --check`：通过。
- 当前提交前工作区无未提交代码改动；验收记录本身将在本次提交中加入。

## 外部限制与遗留风险

> 本节为**当时快照**（2026-09-11 上午）。同日晚已完成下列第 1、3 项的真实外部验证，第 2 项部分验证；最新状态以 CLAUDE.md 任务看板与后续三份验收记录（1206 / 1250 / 1340）为准。

以下路径未在本机真实外部环境中执行，因此不宣称 E2E 通过：

1. 真实 Codex app-server 登录、真实模型 spawn/send/steer/interrupt 和上游 wire event。**后续：已于 1206 与 1340 验证。**
2. 真实 Host 断开后仍保持 Codex turn、跨进程 Server crash/app-server crash 恢复。**后续：crash recovery 已于 1340 验证（冷启动 recovery 对账落 failed 并回流）；Host 断开场景见 1250。**
3. 真实 ZCode 安装、其具体 Hook stdin/additionalContext 协议和 Host 消费后的端到端回流。**后续：已于 1250 与 1340 验证（Stop/PostToolUse 真机回流；UserPromptSubmit 仍未验证）。**

原因是本轮环境没有可验证的真实 Codex/ZCode 外部会话，且详细规格未锁定上游 wire schema 与 Host Hook schema。代码已用 fake adapter、Unix socket、SQLite 和明确的失败边界覆盖可确定部分；`src/hook/hosts/` 的 wrapper 保持可替换，后续应在具备真实 Host 协议后做一次外部验收。
