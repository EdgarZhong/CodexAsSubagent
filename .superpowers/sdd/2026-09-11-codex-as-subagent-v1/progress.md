# SDD ledger — plan: docs/superpowers/plans/2026-09-11-codex-as-subagent-v1.md

## Preflight scan

| 关联任务/任务 | 共享文件或接口 | 检查结果 | 裁决 |
|---|---|---|---|
| Task 1 → Task 2 | Task 1 提供 package/module mode、目录和 DEFAULT_MODEL/DEFAULT_EFFORT；Task 2 消费共享常量与目录 | 接口一致，无共享实现文件冲突 | 按计划执行 |
| Task 2 → Task 3 | Task 2 提供 TerminalResult、错误类型和 protocol normalizer；Task 3 提供 SQLite/completion 实现 | Task 3 可通过公共领域接口接入，无 vendor 泄漏 | 按计划执行 |
| Task 3 → Task 4 | 两者共享 execution-store.mjs、completion-router.mjs；Task 3 建立持久原子转移，Task 4 仅添加 Runtime integration hooks | 文件有明确先后修改边界；Task 4 不重写事务语义 | 按计划执行 |
| Task 4 → Task 5 | Task 4 提供 RuntimeManager 的控制接口；Task 5 的 request-router/server 只调用接口 | 依赖方向单向，Server 不进入 core 内部 | 按计划执行 |
| Task 5 → Task 6 | 两者共享 stdio-bootstrap.mjs；Task 5 建立 transport/context，Task 6 仅注册 tool façade | 共享文件修改范围已拆开，需集成后复验 MCP framing | 按计划执行 |
| Task 6 → Task 7 | Task 6 创建 mcp/cli 入口；Task 7 创建 hook/drain 入口并消费 StateStore | 无同名文件冲突，Hook 不进入 public tool registry | 按计划执行 |
| Task 7 → Task 8 | Task 7 产出 Hook/plugin；Task 8 修改 tests/scripts/CLAUDE 和验收记录 | Task 8 的宽测试范围只用于验证，不改变 runtime 契约 | 按计划执行 |
| Task 1 | package、CLI、git、submodule、layout test | 任务内部依赖顺序明确：测试 → scaffold → test → commit；没有引用未定义接口 | 一次性初始化 Git 后允许提交 |
| Task 2 | adapter、domain、unit tests | 测试先于实现；接口签名在任务中完整声明；无未定义占位 | 真实上游不作为单元测试前置条件 |
| Task 3 | SQLite、stores、router、unit tests | schema、状态、lease 和测试一一对应；事务不跨等待 | 以 completion-first 为绑定原则 |
| Task 4 | RuntimeManager、execution/completion integration、unit/integration tests | 所有 public control paths 有测试目标；wait_many 语义与 completion store 一致 | 继续使用 fake adapter 保证确定性 |
| Task 5 | server/bootstrap/lifecycle/recovery、integration tests | transport、lock、shutdown、crash recovery 文件职责清楚 | 采用 newline-delimited JSON-RPC 作为内部协议 |
| Task 6 | tools/projectors/CLI、schema/integration tests | 十个工具名单与任务接口完全一致；内部字段不进 projector | 不能通过增加 tool 解决 Hook 回流 |
| Task 7 | drain/hosts/plugins、Hook/plugin tests | claim/lease 与 host wrapper 分离；无 live execution 操作 | plain wrapper 作为保底 Host |
| Task 8 | full tests/scripts/acceptance record | 验收路径覆盖规格关键测试；最终 Review 之后才宣称完成 | 外部 E2E 受限时记录为风险，不伪造通过 |

## Rulings

- Ruling: 使用 codex/autonomous-v1 作为新仓库首个开发分支，而不是假定已有 main/master — 当前仓库没有提交和默认分支；代价是后续用户若要求特定默认分支需要再调整分支命名。
- Ruling: 固定当前可访问的 upstream HEAD 63d45d034ed7a88c5c0caa387a9f5409836bcd27 作为 Submodule 起点 — 详细设计要求固定 commit 但未指定 SHA；代价是若该版本 wire API 不兼容，需要后续更换 pinned commit 或 fork。
- Ruling: 使用 Node.js 24 的内置 node:sqlite，并将最低版本写为 >=24.0.0 — 当前环境为 v24.15.0，减少 native dependency；代价是 Node 20/22 环境不能直接运行。
- Ruling: V1 内部 transport 先实现最小 newline-delimited JSON-RPC，再通过 MCP façade 暴露工具 — 设计未固定 MCP SDK 版本，优先确保可测和可替换；代价是需要额外验证 Host 的具体 MCP framing 兼容性。

## Task status

- Task 1: complete
- Task 2: complete
- Task 3: complete (commits 5b7b533..b5b62a3, review clean)
- Task 4: complete (commit 955d810, main-agent self-review and tests passed)
- Task 5: complete (commit 1d875d8, main-agent self-review and tests passed)
- Task 6: complete (focused 8/8, full 71/71, CLI JSON-RPC smoke passed; report task-6-report.md)
- Task 6: complete (direct implementation; no subagent handoff)
- Task 7: pending
- Task 8: pending

## Review ledger

- Task 1: initial review found one Important CLI executable-bit/smoke-entry issue and one Minor CLAUDE progress issue.
- Task 1: fix round 1/5 (2 addressed, 0 open; commits f73cffc..3a19f07)
- Task 1: complete (commits ae3554e..3a19f07, review clean)
- Task 2: initial review found seven Important issues in upstream event normalization, terminal classification, provenance, canonical result, model validation and history projection.
- Task 2: fix round 1/5 (7 addressed, 3 new open; commits 2ab2409..cc0c5c6)
- Task 2: fix round 2/5 (3 addressed, 0 open; commits dc28ca3..cc0c5c6)
- Task 2: complete (commits 3a19f07..cc0c5c6, review clean)
- Task 3: initial review found one Critical and four Important/Minor issues in Router terminal validation, identity binding, truncated changes preservation and race/lease evidence.
- Task 3: Ruling: allow the Task 3 fix to extend src/adapters/supervisor/protocol-normalizer.mjs with a hidden internal turn identity field and its regression tests — the Core Router must prove turn ownership, while the field remains outside all MCP/public projections; cost if wrong is a small cross-task Adapter diff that must be checked in final review.
- Task 3: fix round 1/5 (4 addressed, 3 open; commits 9c7e20d..20a7559)
- Task 3: fix round 2/5 (2 addressed, 1 open; commits 20a7559..9ae8dbd)
- Task 3: fix round 3/5 (0 addressed, 2 open; commits 9ae8dbd..89da143)
- Task 3: fix round 4/5 (0 addressed, 2 open; commits 89da143..85045ac)
- Task 3: Ruling: round 5 may modify src/shared/protocol.mjs in addition to the prior Adapter/Router files, because status normalization is the shared source of the remaining fail-open behavior; cost if wrong is a broader internal protocol diff that must be checked in final whole-branch review.
- Task 3: fix round 5/5 implementation and report committed as 23863ec..b5b62a3; scoped re-review verdict: all findings addressed, no new Critical/Important breakage.
- Autonomous round 2 scope: implement Task 4 RuntimeManager and Task 5 Server/Bootstrap foundations sequentially; use lightweight task reviews, then continue to Task 6/7 in the next round.
- Task 4: complete (commit 955d810, focused 12/12 and full 59/59; implementation self-review found and fixed fast terminal-event race and batch ACK binding).
- Task 5: complete (commit 1d875d8, focused 6/6 and full 65/65; Unix socket, Bootstrap ACK, startup lock, lifecycle and recovery tests passed).
