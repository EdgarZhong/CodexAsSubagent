# Task 2：Supervisor Adapter 和领域基础报告

## 结果

- 实现提交：`2ab24095fc5a91fa0211b512c01e9e3cc6a4d8c0`
- 状态：已完成；测试和语法检查通过。
- 本报告按用户要求写入 `.superpowers/sdd/2026-09-11-codex-as-subagent-v1/task-2-report.md`。

## 变更文件

### Supervisor Adapter

- `src/adapters/supervisor/app-server-adapter.mjs`
- `src/adapters/supervisor/history-adapter.mjs`
- `src/adapters/supervisor/protocol-normalizer.mjs`

### Shared / domain foundation

- `src/shared/constants.mjs`：保留 Task 1 的 `DEFAULT_MODEL = gpt-5.6-luna` 和 `DEFAULT_EFFORT = xhigh`，新增终端结果限制常量。
- `src/shared/errors.mjs`
- `src/shared/protocol.mjs`
- `src/core/workspace-guard.mjs`
- `src/core/model-service.mjs`
- `src/core/terminal-result.mjs`

### Unit tests

- `tests/unit/protocol-normalizer.test.mjs`
- `tests/unit/workspace-guard.test.mjs`
- `tests/unit/terminal-result.test.mjs`

没有修改 package、README、AGENTS、详细设计、后续 server/mcp/hook 文件；除本报告外没有越过 Task 2 授权边界。只有 `src/adapters/supervisor/` 直接 import `vendor/codex-supervisor-mcp` 内部模块。

## 接口

- `createSupervisorAdapter(options)`：封装 upstream `thread/start`、`thread/resume`、`turn/start`、`turn/steer`、`turn/interrupt`、`thread/list`、`thread/read`、`model/list` 和 `config/read`，并提供运行时事件订阅。
- `SUPERVISOR_ADAPTER_METHODS`：固定 fake/real adapter contract：
  `startThread`、`resumeThread`、`startTurn`、`steerTurn`、`interruptTurn`、`listThreads`、`readThreadMetadata`、`readRecentTurns`、`listModels`、`readEffectiveConfig`、`subscribeRuntimeEvents`。
- `createFakeSupervisorAdapter(implementation)` 和 `assertSupervisorAdapter(adapter)`：供后续 Runtime 单元测试注入确定性 fake adapter。
- `normalizeEvent(event)`：返回不含 `turnId`、`eventCursor`、cursor 或 raw event 的受限 projection。
- `createHistoryAdapter(adapter)`：提供 `readThreadMetadata`、`readRecentTurns`、`readTurnChanges` 和 `getChangedFiles`；changed-files 只从当前 turn 结构化记录读取，不查询 repository-level Git 状态。
- `WorkspaceGuard.resolve(cwd)`：realpath 规范化并确认目录存在；缺失或非目录抛出 `workspace_unavailable`。
- `WorkspaceGuard.assertThreadWorkspace(thread, workspace)`：对 thread workspace 和当前 workspace 分别 canonicalize；缺失 metadata、路径不存在或跨 workspace 均抛出 `thread_workspace_mismatch`。
- `TerminalResult.fromTerminal(input)` / `TerminalResult.toJSON()`：生成三种 terminal 状态 `completed`、`failed`、`interrupted` 的安全 payload，assistant message 最多 16,000 字符，changed files 最多 20 项。
- `ModelService.resolveSpawn(model?, effort?)`：解析默认/显式 model-effort pair，区分 `default_model_unavailable`、`invalid_model` 和 `invalid_effort`。

## 设计决定

1. upstream 内部 wire 形状只在 Supervisor Adapter 隔离；核心代码不 import vendor。
2. Adapter 支持注入 fake client/EventStore；注入的 upstream EventStore 会在 Adapter 边界桥接 `record`，确保 `subscribeRuntimeEvents` 可用。
3. event/history normalizer 只复制公共安全字段。当前 turn 的结构化 `turn.fileChanges` 或 `turn.changes.files` 是 changed-files 唯一来源；脏工作树 diff、repository diff 和 raw params 会被忽略。
4. WorkspaceGuard 使用 Node `realpath`，所以 macOS `/private` 等别名会归一到同一真实路径；无法 canonicalize 时 fail-closed。
5. TerminalResult 只构造白名单字段，不把 `turnId`、event cursor 或上游错误对象原样输出；失败状态保留 bounded `{code, message}`。
6. ModelService 在有模型目录时严格校验；显式模型缺失为 `invalid_model`，默认模型缺失为 `default_model_unavailable`，effort 不在选定模型支持列表中为 `invalid_effort`。

## 测试命令与完整输出

### `npm test`

```text
> node --test 'tests/**/*.test.mjs'
✔ project layout exposes the V1 foundation (2.456583ms)
✔ normalizeEvent returns a bounded public projection without internal ids (0.657917ms)
✔ changed files come only from the current turn structured record (0.073917ms)
✔ history adapter exposes turn-scoped history and never queries repository git state (0.182833ms)
✔ supervisor adapter defines the complete fake contract and maps operations (0.374542ms)
✔ supervisor adapter bridges events from an injected EventStore (0.073417ms)
✔ TerminalResult completed payload is bounded and strips internal fields (0.509083ms)
✔ TerminalResult failed and interrupted payloads preserve safe terminal details (0.372583ms)
✔ TerminalResult rejects non-terminal status (0.156917ms)
✔ ModelService resolves default and explicit model/effort pairs (0.302834ms)
✔ WorkspaceGuard.resolve returns the canonical realpath (1.80375ms)
✔ WorkspaceGuard.resolve rejects a missing workspace (0.515667ms)
✔ WorkspaceGuard.assertThreadWorkspace fails closed for missing metadata and cross-workspace threads (1.060542ms)
ℹ tests 13
ℹ suites 0
ℹ pass 13
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 46.450708
```

### `npm run lint`

```text
> node --check src/cli/main.mjs
```

退出码：`0`。

### `npm run smoke`

```text
> ./src/cli/main.mjs --help
Codex As Subagent
用法:
  codex-as-subagent [command] [--help]
命令:
  serve    启动 Runtime Server
  mcp      启动 MCP stdio Bootstrap
  hook     运行 Host Hook wrapper
  drain    读取并交付待处理 completion
默认模型: gpt-5.6-luna
默认 effort: xhigh
```

退出码：`0`。

### brief 要求的三份 unit 测试

命令：

```text
node --test tests/unit/protocol-normalizer.test.mjs tests/unit/workspace-guard.test.mjs tests/unit/terminal-result.test.mjs
```

完整输出：

```text
✔ normalizeEvent returns a bounded public projection without internal ids (0.680958ms)
✔ changed files come only from the current turn structured record (0.075791ms)
✔ history adapter exposes turn-scoped history and never queries repository git state (0.175791ms)
✔ supervisor adapter defines the complete fake contract and maps operations (0.374792ms)
✔ supervisor adapter bridges events from an injected EventStore (0.072834ms)
✔ TerminalResult completed payload is bounded and strips internal fields (0.507791ms)
✔ TerminalResult failed and interrupted payloads preserve safe terminal details (0.360375ms)
✔ TerminalResult rejects non-terminal status (0.151167ms)
✔ ModelService resolves default and explicit model/effort pairs (0.263667ms)
✔ WorkspaceGuard.resolve returns the canonical realpath (1.559708ms)
✔ WorkspaceGuard.resolve rejects a missing workspace (0.656458ms)
✔ WorkspaceGuard.assertThreadWorkspace fails closed for missing metadata and cross-workspace threads (1.153708ms)
ℹ tests 12
ℹ suites 0
ℹ pass 12
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 41.269167
```

### 新增源码 `node --check`

命令：

```text
node --check src/shared/constants.mjs
node --check src/shared/errors.mjs
node --check src/shared/protocol.mjs
node --check src/adapters/supervisor/app-server-adapter.mjs
node --check src/adapters/supervisor/history-adapter.mjs
node --check src/adapters/supervisor/protocol-normalizer.mjs
node --check src/core/terminal-result.mjs
node --check src/core/workspace-guard.mjs
node --check src/core/model-service.mjs
```

完整输出：无；上述 9 个命令全部退出码 `0`。

## Concerns

- 本轮只验证 fake/injected client 和本地领域行为，没有启动真实 Codex app-server；真实环境的 `model/list`、`config/read` wire response 需在后续 Runtime integration/E2E 中继续验证。
- upstream `AppServerClient` 的进程生命周期和真实 terminal event 到 `TerminalResult` 的组装由后续 Runtime/Completion 任务消费本 Adapter contract，本轮未提前实现 server 或 SQLite。
- 未运行真实模型请求、ZCode Hook 或跨进程 recovery；这些属于后续任务范围，不构成本轮测试阻塞。
