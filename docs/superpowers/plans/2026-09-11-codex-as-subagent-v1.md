# Codex As Subagent V1 Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task with a task review after each task and a whole-branch review at the end.

Goal: 按详细设计实现可运行的 V1：以 Codex thread 作为 Subagent identity，提供十个公共 MCP 工具、持久 completion-first 交付、workspace 隔离、独立 Runtime 生命周期和 Host Hook。

Architecture: 使用 Node.js 24 ESM。Runtime Server 通过 Unix Domain Socket 持有 Supervisor Adapter、RuntimeManager 和 SQLite StateStore；stdio Bootstrap 只做 workspace context、lazy activation、转发和 direct-delivery ACK；Hook 直接读取 SQLite completion，不依赖 Runtime Server。上游 codex-supervisor-mcp 作为固定 Git Submodule，所有上游协议解析集中在 Supervisor Adapter。

Tech Stack: Node.js >=24.0.0、ESM .mjs、内置 node:sqlite、Node 内置 node:test、Unix Domain Socket、JSON-RPC/MCP-compatible stdio transport、Git Submodule。

Spec: docs/Codex As Subagent — 详细设计与编码规格.md

## Global Constraints

- codex_spawn 永远异步；不提供 sync / async 开关。
- codex_wait 与 codex_wait_many 固定最多等待 500 秒；timeout 只结束本次等待，不 interrupt Codex。
- 模型不能指定 cwd/workspace；当前 Host workspace 是唯一工作区边界。
- 一个 thread 同一时刻最多一个 active turn；不暴露 turnId、event cursor、approval 工具、generic Codex config 编辑能力或 raw event dump。
- completion 优先保证不丢；极端 crash 边界允许重复投递一次，但不能静默丢结果。
- Host 退出不得终止仍在执行的 Codex turn；Server 不做永久 daemon。
- ~/.codex-as-subagent/ 保存本项目 runtime state；Codex auth/provider/profile/thread/history 继续由 ~/.codex/ 管理。
- 只有 src/adapters/supervisor/ 允许 import vendor/codex-supervisor-mcp 内部模块。
- changed-files 只能来自当前 internal turn 的结构化记录或 turn-scoped history；禁止 repository-level Git diff/status 作为归因来源。
- TerminalResult 必须先写入 SQLite；delivery state 固定为 pending、claimed_direct、claimed_hook、delivered。
- pending completion 不阻止 Server 自动退出；active execution、in-flight request、未 ACK direct delivery 或未 flush 状态存在时不得退出。

## File Map

- package.json、config.example.toml、.gitignore、.gitmodules、LICENSE：安装、配置、忽略和许可证。
- src/shared/constants.mjs、errors.mjs、protocol.mjs：协议常量、错误类型、JSON-RPC 辅助。
- src/adapters/supervisor/app-server-adapter.mjs、history-adapter.mjs、protocol-normalizer.mjs：上游隔离层与归一化接口。
- src/adapters/sqlite/sqlite-store.mjs：WAL/FULL SQLite schema、execution/completion/delivery 原子状态转移。
- src/core/workspace-guard.mjs、runtime-manager.mjs、execution-store.mjs、completion-store.mjs、completion-router.mjs、terminal-result.mjs、model-service.mjs：领域逻辑。
- src/server/server.mjs、request-router.mjs、lifecycle-manager.mjs、startup-lock.mjs、recovery.mjs：独立 Server 与生命周期。
- src/mcp/stdio-bootstrap.mjs、tool-registry.mjs、tool-handlers.mjs、response-projector.mjs、workspace-context.mjs：MCP façade。
- src/hook/drain.mjs、render-completions.mjs、src/hook/hosts/*.mjs：薄 Hook 与 Host wrapper。
- src/cli/*.mjs：命令行入口。
- plugins/zcode/**：ZCode MCP/Hook 注册配置。
- tests/unit/**、tests/integration/**、tests/e2e/**、tests/fixtures/**：分层测试。
- docs/autonomous-runs/**、.superpowers/sdd/**：用户级验收与 SDD ledger。

## Task 1: Documentation, repository and upstream boundary

Files:
- Create/modify: README.md, AGENTS.md, CLAUDE.md, package.json, config.example.toml, .gitignore, LICENSE, .gitmodules.
- Create: src/ and tests/ directory markers where needed.
- Add: vendor/codex-supervisor-mcp as a pinned Git Submodule.
- Test: tests/unit/project-layout.test.mjs.

Interfaces: Produces package scripts test, lint, smoke; runtime constants DEFAULT_MODEL = gpt-5.6-luna and DEFAULT_EFFORT = xhigh; submodule path vendor/codex-supervisor-mcp.

- [ ] Write a layout test asserting package module mode, required scripts, required directories, submodule path and the three core documents.
- [ ] Run node --test tests/unit/project-layout.test.mjs; it must fail before scaffolding and pass after it.
- [ ] Initialize Git on branch codex/autonomous-v1, add the fixed submodule commit, add .gitignore entries for runtime state, .superpowers/sdd/ and .archive/, and make the initial repository commit.
- [ ] Add working CLI entrypoints that return help and wire npm test, npm run lint, npm run smoke to real commands.
- [ ] Run npm test, npm run lint and npm run smoke; record exact output in the task report and commit the task.

## Task 2: Supervisor adapter and domain foundation

Files:
- Create: src/adapters/supervisor/app-server-adapter.mjs, history-adapter.mjs, protocol-normalizer.mjs.
- Create: src/shared/constants.mjs, errors.mjs, protocol.mjs, src/core/terminal-result.mjs, workspace-guard.mjs, model-service.mjs.
- Test: tests/unit/protocol-normalizer.test.mjs, workspace-guard.test.mjs, terminal-result.test.mjs.

Interfaces: createSupervisorAdapter(options), normalizeEvent(event), createHistoryAdapter(adapter), WorkspaceGuard.resolve(cwd), WorkspaceGuard.assertThreadWorkspace(thread, workspace), TerminalResult.fromTerminal(input), TerminalResult.toJSON(), ModelService.resolveSpawn(model?, effort?).

- [ ] Define the fake adapter contract for startThread, resumeThread, startTurn, steerTurn, interruptTurn, listThreads, readThreadMetadata, readRecentTurns, listModels, readEffectiveConfig and subscribeRuntimeEvents.
- [ ] Test realpath normalization, missing workspace error, cross-workspace fail-closed, model/effort pair resolution, 20-file cap, 16,000-character assistant cap, and completed/failed/interrupted payloads.
- [ ] Implement normalizers that never expose turnId/event cursor in public projections and obtain changes only from turn-scoped structured records.
- [ ] Run the three unit test files and commit the domain foundation.

## Task 3: Durable SQLite state and completion router

Files:
- Create: src/adapters/sqlite/sqlite-store.mjs, src/core/execution-store.mjs, completion-store.mjs, completion-router.mjs.
- Test: tests/unit/sqlite-store.test.mjs, tests/unit/completion-router.test.mjs.

Interfaces: SqliteStore.open(dataDir), createExecution(), reserveDirect(), releaseReservation(), insertCompletionFirst(), claimPendingHook(), ackDelivery(), requeueExpiredLeases(), CompletionRouter.onTerminal(event).

- [ ] Create meta, executions and completions tables with the specified primary/unique keys and pending workspace index; set WAL, FULL synchronous, busy timeout 5000 and foreign keys.
- [ ] Test terminal-first transaction, duplicate thread_id/turn_id idempotency, pending/direct/hook/delivered transitions, 30-second lease requeue, direct compare-and-set and two racing Hooks where only one claims.
- [ ] Implement short transactions only; no transaction may wait for a 500-second operation or hold a delivery lock while writing stdout.
- [ ] Run unit tests including a pre-existing dirty-file fixture proving no Git diff is queried, then commit.

## Task 4: RuntimeManager and execution control

Files:
- Create: src/core/runtime-manager.mjs.
- Modify: src/core/execution-store.mjs and src/core/completion-router.mjs only for integration hooks.
- Test: tests/unit/runtime-manager.test.mjs, tests/integration/runtime-manager.integration.test.mjs.

Interfaces: RuntimeManager.spawn(ctx, input), send(ctx, input), steer(ctx, input), status(ctx, threadId), wait(ctx, threadId), waitMany(ctx, threads), interrupt(ctx, threadId), listThreads(ctx), readThread(ctx, threadId), models(ctx).

- [ ] Test spawn immediate ACK, idle send resume, busy send rejection, steer active/idle, interrupt ACK without terminal, terminal before wait, wait reservation before terminal, timeout without interrupt and current-workspace filtering.
- [ ] Implement one active execution per thread with model/effort persistence, status snapshots capped at 200/600 chars, in-memory waiter notification backed by SQLite completion state, and synthetic errors for unavailable history/model.
- [ ] Implement wait_many snapshot semantics: all captures active threads at call time; completed results remain claimed_direct until the whole response is acknowledged; timeout releases unfinished reservations.
- [ ] Run unit and integration tests and commit.

## Task 5: Runtime Server, Bootstrap, lifecycle and recovery

Files:
- Create: src/server/server.mjs, request-router.mjs, lifecycle-manager.mjs, startup-lock.mjs, recovery.mjs.
- Create: src/mcp/stdio-bootstrap.mjs, workspace-context.mjs.
- Test: tests/unit/startup-lock.test.mjs, tests/integration/server-bootstrap.integration.test.mjs, lifecycle-recovery.integration.test.mjs.

Interfaces: RuntimeServer.listen(socketPath), RuntimeServer.handle(request), RuntimeServer.close(), ensureServer(options), StdioBootstrap.run(), LifecycleManager.noteRequestStart(), LifecycleManager.noteRequestEnd(), LifecycleManager.maybeShutdown(), recoverState().

- [ ] Test multiple Bootstrap activations yielding one Server, stale socket/lock handling, Host disconnect during wait leaving Codex active, pending completion allowing shutdown, active execution preventing shutdown and idle shutdown after 3000ms.
- [ ] Implement newline-delimited JSON-RPC over Unix socket with request correlation, hidden direct delivery id kept internal, ACK/NACK transitions, startup lock with PID/instance health check, detached Server activation and workspace context extraction from canonical CWD only.
- [ ] Implement app-server crash synthetic app_server_crash, Server crash reconciliation to real terminal or supervisor_crash and conservative orphan PID identity checks.
- [ ] Run integration tests and CLI smoke, then commit.

## Task 6: MCP public façade and ten tools

Files:
- Create: src/mcp/tool-registry.mjs, tool-handlers.mjs, response-projector.mjs.
- Modify: src/mcp/stdio-bootstrap.mjs only to register the façade.
- Create: src/cli/main.mjs, mcp.mjs, serve.mjs.
- Test: tests/unit/tool-schema.test.mjs, tests/integration/mcp-tools.integration.test.mjs.

Interfaces: TOOL_DEFINITIONS containing exactly ten tools, handleToolCall(name, args, ctx), projectSpawnAck, projectStatus, projectTerminalResult, projectWaitMany.

- [ ] Test exact input schemas and output projections for all ten tools; reject cwd, sandbox, approval, cursor and turnId arguments.
- [ ] Implement compact public responses matching the design, preserving error types invalid_model, invalid_effort, default_model_unavailable, thread_busy, thread_not_found, thread_workspace_mismatch, no_active_turn, history_unavailable and workspace_unavailable.
- [ ] Ensure no public response contains internal deliveryId, turnId, event cursor, raw events, approval data or arbitrary Codex config.
- [ ] Run schema and integration tests plus npm run smoke, then commit.

## Task 7: Hook delivery and Host adapters

Files:
- Create: src/hook/drain.mjs, render-completions.mjs, src/hook/hosts/plain.mjs, zcode.mjs, kimi-code.mjs, claude-code.mjs, grok-build.mjs, pi.mjs.
- Create: src/cli/hook.mjs, drain.mjs.
- Create: plugins/zcode/.zcode-plugin/plugin.json, .mcp.json, hooks/hooks.json, README.md.
- Test: tests/unit/hook-drain.test.mjs, tests/integration/hook-delivery.integration.test.mjs, tests/unit/plugin-layout.test.mjs.

Interfaces: drainPending({workspace, host, store}), renderCompletions(completions, host), each Host wrapper wrap(text, completions).

- [ ] Test claim-before-render, successful delivery ACK, crash after claim with expired lease restoring pending, duplicate completionId visibility, workspace filtering and host-specific wrapper isolation.
- [ ] Implement codex-as-subagent hook --host=host and codex-as-subagent drain; Hook only canonicalizes workspace, claims pending rows, renders results and ACKs/NACKs delivery. It never starts/resumes/interrupts Codex.
- [ ] Keep all Host registration under plugins/; provide complete ZCode config and readable install notes without duplicating Runtime logic.
- [ ] Run Hook/plugin tests and commit.

## Task 8: Full regression, independent review and user acceptance

Files:
- Modify: tests/**, scripts/**, CLAUDE.md only for verified progress.
- Create: docs/autonomous-runs/YYYYMMDD-HHmm-codex-as-subagent-v1.md using the actual execution timestamp.

Interfaces: npm test, npm run lint, npm run smoke and the documented user acceptance commands.

- [ ] Run all tests and static checks; fix failures within existing task boundaries and record evidence.
- [ ] Execute every required user path: spawn async; parallel threads; send/steer/interrupt; workspace normalization/rejection; wait and wait_many including timeout; completion-first; Hook claim/race/lease; Host exit; Server/app-server crash recovery; lazy activation/stale lock; pre-existing dirty Git files; model resolution; ZCode plugin inspection.
- [ ] Record expected result, actual result, command/input and evidence for each path in the autonomous-run record.
- [ ] Dispatch the most capable independent whole-branch reviewer against the review package; address findings in one reviewed fix wave or record bounded rulings.
- [ ] Run final verification and commit the acceptance record.

## Completion Criteria

V1 is complete only when the ten tools match the public schema, spawn returns immediately, threads can run in parallel, send resumes existing threads, workspace isolation is fail-closed, wait/wait_many and Hook consume one persistent completion store, Host exit does not lose or stop work, Server lifecycle/recovery resolves active state, current-turn changed files are accurate, the dedicated profile has stable defaults, and the ZCode plugin has complete registration configuration. Any real Codex/ZCode E2E blocked by unavailable local authentication or upstream wire details must be listed explicitly in the final report with evidence rather than presented as passing.
