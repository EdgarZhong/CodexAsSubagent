# Task 5：Runtime Server、Bootstrap、生命周期与恢复

## 状态

DONE（进程内 Runtime Server、Unix socket transport、stdio Bootstrap、startup lock、idle lifecycle 和 conservative recovery 骨架已实现）。实现 commit：1d875d888322db68542c8390afe36af6020116c1。本任务由主 Agent 直接完成，没有继续使用子 Agent 或 reviewer。

## 实现内容

- src/server/server.mjs：实现 newline-delimited JSON over Unix Domain Socket、request correlation、socket connection handling、request lifecycle accounting、关闭时 socket cleanup。
- src/server/request-router.mjs：将 runtime/codex method alias 路由到 RuntimeManager；对 TerminalResult/批量结果做 public projection；delivery id 只存在于内部 response envelope，错误统一为 code/message。
- src/server/lifecycle-manager.mjs：跟踪 in-flight request、active execution 和 claimed_direct；pending completion 不参与阻塞条件；空闲 3000ms 后调用 shutdown，新的 request/state change 会取消 timer。
- src/server/startup-lock.mjs：使用 wx 原子创建 lock，记录 pid/instanceId/socketPath/startedAt；支持 healthy owner 复用、陈旧 lock 重取、socket health wait 及 ensureServer winner/loser 竞争。
- src/mcp/workspace-context.mjs：只从当前 canonical CWD 建立隐藏 workspace context，缺失或 realpath 失败时沿用 workspace_unavailable。
- src/mcp/stdio-bootstrap.mjs：把 stdin JSON lines 转发到 Runtime Server，输出时移除隐藏 deliveryId；stdout 写成功后发 delivery.ack，失败路径发 delivery.nack；socket 不存在时默认 detached spawn CLI 的 serve 子命令，且可注入测试启动器。
- src/server/recovery.mjs：按 ownerInstanceId 扫描旧 execution；历史可证明 terminal 时重建结果，否则生成 supervisor_crash failed TerminalResult，通过 recovery.terminal/provenance=recovery/verified=true 交给 CompletionRouter；提供保守的 PID+instanceId+startedAt+command orphan 判断函数，不执行低置信 kill。
- src/core/runtime-manager.mjs：增加 Server 使用的内部 deliveryId 读取、ACK、release bridge，未进入 MCP public projection。

## 关键裁决

1. Ruling：内部 transport 采用 {id, method, params, context} 的 newline-delimited JSON envelope，Bootstrap 才负责把 context 注入，原因是 Runtime Server 必须脱离 Host 生命周期并保持 Bootstrap 无业务状态；代价是 Task 6 MCP façade 仍需把其 public JSON-RPC 映射到该内部 envelope。
2. Ruling：Bootstrap 默认 detached spawn process.execPath [CLI, serve, --socket, --lock]，同时允许注入 startServer，原因是 Task 5 需要 lazy activation 而 Task 6 才补 CLI serve 入口；代价是 Task 5 独立测试使用注入启动器，真实首次启动路径要在 Task 6 接通后再做 smoke。
3. Ruling：Host 断开时不 interrupt live Codex；未完成 wait 的 direct lease 由 SQLite 的 30 秒 requeue 保护，原因是 completion 不丢优先级高于及时清理；代价是断开后到 lease 回收前可能保留一个 claimed_direct 行。
4. Ruling：恢复只处理能从持久历史证明 terminal 的 execution，否则统一 supervisor_crash；orphan 只暴露高置信判断而不执行 kill，原因是 PID reuse 风险；代价是真实 Codex wire/history 变化需后续 Adapter 扩展。

## 测试证据

### Task 5 focused

命令：

    node --test tests/unit/startup-lock.test.mjs tests/integration/server-bootstrap.integration.test.mjs tests/integration/lifecycle-recovery.integration.test.mjs

结果（退出码 0）：

    ℹ tests 6
    ℹ pass 6
    ℹ fail 0

覆盖：单赢家 startup lock、陈旧 lock、socket health wait、Unix socket request correlation、Bootstrap 隐藏 deliveryId 与 ACK 顺序、idle shutdown 条件、supervisor_crash recovery。

### Task 4 + Task 5 combined

命令：

    node --test tests/unit/startup-lock.test.mjs tests/integration/server-bootstrap.integration.test.mjs tests/integration/lifecycle-recovery.integration.test.mjs tests/unit/runtime-manager.test.mjs tests/integration/runtime-manager.integration.test.mjs

结果（退出码 0）：

    ℹ tests 18
    ℹ pass 18
    ℹ fail 0

### 全量回归

命令：

    npm test

结果（退出码 0）：

    ℹ tests 65
    ℹ pass 65
    ℹ fail 0
    ℹ cancelled 0
    ℹ skipped 0
    ℹ todo 0

### 静态检查和 smoke

相关 server/mcp/runtime/test 文件逐个执行 node --check，全部退出码 0；npm run lint、npm run smoke、git diff --check 全部退出码 0。smoke 仍输出既有 serve/mcp/hook/drain CLI help。

## Self-review / concerns

- pending completion 不阻止 LifecycleManager 自动退出；active execution、in-flight request、unacked direct delivery 会阻止退出。
- public response 不包含 deliveryId；Bootstrap 只在内部 envelope 处理 ACK/NACK。
- Task 6 仍需补齐真实 serve/mcp CLI 子命令、MCP stdio schema/ten tools；当前默认 detached spawn 已预留该入口但没有伪称真实 CLI 已通过。
- recovery 与 socket transport 使用 fake Runtime/SQLite 测试，尚未启动真实 Codex app-server，也未执行跨进程 Host 断开、真实 app-server crash 或 ZCode E2E。
