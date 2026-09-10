# Task 3：SQLite durable state 与 completion-first router 报告

## 结果

- 状态：已完成。
- 实现 commit SHA：`5b7b533`。
- 分支：`codex/autonomous-v1`。
- 未创建子 Agent。
- 未修改 package、README、AGENTS、CLAUDE、Task 2 文件或后续 Runtime/Server/MCP/Hook 文件。

## 变更文件

### 实现

- `src/adapters/sqlite/sqlite-store.mjs`
  - 基于 Node.js 24 内置 `node:sqlite` 的 `DatabaseSync` durable store。
  - 创建 schema、设置 SQLite PRAGMA、短事务、execution reservation、completion 插入和 delivery 状态 CAS。
  - 默认数据目录为 `~/.codex-as-subagent/`，`SqliteStore.open(dataDir)` 可注入临时目录。
- `src/core/execution-store.mjs`
  - 对 execution 创建、direct reservation、reservation release 和读取提供薄领域包装。
- `src/core/completion-store.mjs`
  - 对 TerminalResult canonicalization、completion-first 插入、Hook claim、delivery ACK 和 lease requeue 提供薄领域包装。
- `src/core/completion-router.mjs`
  - 识别 terminal event，使用 Task 2 的 `TerminalResult`，并把结果交给持久 completion store。
  - 支持 raw terminal event、Task 2 normalized terminal event 和已构造 canonical TerminalResult。

### 测试

- `tests/unit/sqlite-store.test.mjs`
  - schema/PRAGMA、terminal-first、重复 `(thread_id, turn_id)` 幂等、direct CAS、ACK、lease、pending→direct→pending、独立连接 Hook race 和 dirty-file fixture。
- `tests/unit/completion-router.test.mjs`
  - 非 terminal 忽略、pending terminal、normalized event 的安全 changes、canonical result、direct delivery 和 ACK。

## Schema 与 SQLite 设置

创建以下三张表：

```sql
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE executions (
  thread_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  workspace TEXT NOT NULL,
  owner_instance_id TEXT NOT NULL,
  model TEXT,
  effort TEXT,
  started_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  reservation_id TEXT,
  reservation_kind TEXT,
  reservation_created_at TEXT,
  PRIMARY KEY (thread_id, turn_id)
);

CREATE TABLE completions (
  completion_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  workspace TEXT NOT NULL,
  terminal_status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  delivery_state TEXT NOT NULL,
  delivery_id TEXT,
  delivery_started_at TEXT,
  delivered_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (thread_id, turn_id)
);

CREATE INDEX completions_pending_workspace_idx
  ON completions(workspace, delivery_state, created_at);
```

实现还对 `executions.reservation_kind`、`completions.terminal_status` 和 `completions.delivery_state` 加了 CHECK 约束；delivery state 只允许：

```text
pending
claimed_direct
claimed_hook
delivered
```

打开数据库时设置：

```text
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;
```

所有写入方法使用同步 `BEGIN IMMEDIATE` → 读/写 CAS → `COMMIT`；事务回调内没有 `await`，不会等待 500 秒，也不会执行 stdout 交付。delivery claim、ACK 和 lease requeue 都在事务外返回已提交记录。

## 接口与状态语义

### `SqliteStore`

- `SqliteStore.open(dataDir)`：创建/打开 `dataDir/state.sqlite`，初始化 schema 和 PRAGMA。
- `createExecution(input)`：以 `(threadId, turnId)` 幂等创建 execution，保存 workspace、owner instance、model、effort 和 activity 时间。
- `reserveDirect(input)`：
  - active execution 存在时，通过 `reservation_id IS NULL` compare-and-set 建立 direct reservation；
  - 已有 pending completion 且没有 active execution 时，在同一短事务内将其转为 `claimed_direct`；
  - 生成或使用指定 reservation/delivery id，事务成功后才返回。
- `releaseReservation(input)`：释放匹配的 execution reservation；若对应 completion 已为 `claimed_direct`，同时恢复为 `pending`。
- `insertCompletionFirst(input)`：
  - 先在短事务内解析已有 execution reservation；
  - 插入 canonical payload；有 direct reservation 时写入 `claimed_direct`，否则写入 `pending`；
  - 用 `UNIQUE(thread_id, turn_id)` 抵御重复 terminal event；
  - 删除对应 execution；
  - 只有事务 commit 后返回 completion。
- `claimPendingHook(input)`：按 workspace、created_at 顺序在短事务内把 pending rows CAS 为 `claimed_hook`，返回 claim 后记录。
- `ackDelivery(input)`：只允许 `claimed_direct`/`claimed_hook` 通过匹配 `delivery_id` 转为 `delivered`；错误 id 或已完成状态不改变状态。
- `requeueExpiredLeases(input)`：默认 30,000 ms；把过期 `claimed_direct`/`claimed_hook` 恢复为 `pending` 并清除 delivery lease 字段。

### `ExecutionStore`、`CompletionStore`、`CompletionRouter`

- `ExecutionStore` 转发 execution 相关接口，并提供 `getExecution`、`listExecutions` 供 Runtime 使用。
- `CompletionStore` 在 adapter 前使用 `TerminalResult.fromTerminal()` 或现有 `.toJSON()` 生成安全 payload，再转发持久化接口。
- `CompletionRouter.onTerminal(event)`：
  - 非 terminal event 返回 `null`，不创建 completion；
  - 从 event 或 active execution 获取 thread/turn identity；
  - terminal 事件构造 `TerminalResult`；
  - normalized event 中已由 Task 2 验证的 changes 会恢复到匹配的内部 turn 记录，避免安全 projection 后丢失当前 turn changes；
  - 调用 `insertCompletionFirst`，不查询 Git，不写 stdout。

## 关键裁决

1. `reserveDirect` 同时处理“wait 先于 terminal”和“terminal 先于 wait”两条路径：前者预留 execution，后者原子领取 pending completion。这样 wait 与 Hook 共用一个 durable completion store。
2. `insertCompletionFirst` 的 workspace 优先使用 active execution 的 workspace；显式 workspace 不匹配时 fail closed。重复 `(thread_id, turn_id)` 在查到既有 completion 后直接返回既有状态，即使重复事件已经看不到 execution，也不会误报必填 workspace。
3. direct completion 只在 ACK 的 CAS 成功后进入 `delivered`；进程中断或 Hook/direct lease 超时都会恢复到 `pending`，允许至少一次交付。
4. `CompletionRouter` 不依赖 repository-level `git diff`/`git status`。dirty-file fixture 只验证预存脏文件不会进入 payload；changes 来自匹配的 current-turn structured record 或已由 Task 2 normalizer 生成的安全 projection。
5. 两个独立 SQLite 连接分别执行 Hook claim；每个 claim 都使用 `BEGIN IMMEDIATE` 和 `delivery_state = 'pending'` CAS，因此同一 completion 只能被一个 consumer claim。

## 测试命令与完整输出

### `node --test tests/unit/sqlite-store.test.mjs tests/unit/completion-router.test.mjs`

```text
✔ CompletionRouter persists terminal result first and ignores non-terminal events (6.691375ms)
✔ CompletionRouter accepts normalized terminal events and preserves their safe turn changes (3.341584ms)
✔ CompletionRouter accepts an already-built canonical TerminalResult (9.165ms)
✔ CompletionRouter routes a reserved direct terminal result without holding a delivery lock (8.629458ms)
✔ SqliteStore creates the durable schema and required SQLite pragmas (5.665ms)
✔ terminal completion commits before delivery and duplicate thread/turn is idempotent (15.819083ms)
✔ direct reservation uses compare-and-set, ACK is required, and expired leases requeue (8.34775ms)
✔ two racing hooks can claim a pending completion only once (3.246ms)
ℹ tests 8
ℹ suites 0
ℹ pass 8
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 97.785834
```

退出码：`0`。

### `npm test`

```text
> codex-as-subagent@0.1.0 test
> node --test 'tests/**/*.test.mjs'

✔ CompletionRouter persists terminal result first and ignores non-terminal events (6.713541ms)
✔ CompletionRouter accepts normalized terminal events and preserves their safe turn changes (2.744666ms)
✔ CompletionRouter accepts an already-built canonical TerminalResult (2.79475ms)
✔ CompletionRouter routes a reserved direct terminal result without holding a delivery lock (3.251667ms)
✔ project layout exposes the V1 foundation (2.371167ms)
✔ normalizeEvent returns a bounded public projection without internal ids (1.133375ms)
✔ normalizeEvent supports vendor EventStore params.turn, params.item and params.diff (0.212042ms)
✔ ordinary error and item completion are not terminal events (0.215125ms)
✔ changed files come only from the current turn structured record (0.287708ms)
✔ history adapter exposes turn-scoped history and never queries repository git state (0.302958ms)
✔ publicProjection recursively removes internal protocol fields (0.097084ms)
✔ supervisor adapter defines the complete fake contract and maps operations (0.459125ms)
✔ supervisor adapter bridges events from an injected EventStore (0.1095ms)
✔ supervisor adapter emits one thread-scoped terminal event per active process failure (1.043791ms)
✔ fake adapter rejects invalid or unknown injected implementations (0.386625ms)
✔ SqliteStore creates the durable schema and required SQLite pragmas (5.042833ms)
✔ terminal completion commits before delivery and duplicate thread/turn is idempotent (5.207042ms)
✔ direct reservation uses compare-and-set, ACK is required, and expired leases requeue (4.039416ms)
✔ two racing hooks can claim a pending completion only once (1.831917ms)
✔ TerminalResult completed payload is bounded and strips internal fields (1.119333ms)
✔ TerminalResult failed and interrupted payloads preserve safe terminal details (0.580583ms)
✔ TerminalResult omits invalid duration values (0.174625ms)
✔ TerminalResult rejects non-terminal status (0.2ms)
✔ TerminalResult requires verified turn provenance and a non-empty thread id (0.125541ms)
✔ ModelService resolves default and explicit model/effort pairs (0.329542ms)
✔ WorkspaceGuard.resolve returns the canonical realpath (2.189167ms)
✔ WorkspaceGuard.resolve rejects a missing workspace (0.530458ms)
✔ WorkspaceGuard.assertThreadWorkspace fails closed for missing metadata and cross-workspace threads (1.008458ms)
ℹ tests 28
ℹ suites 0
ℹ pass 28
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 68.436667
```

退出码：`0`。

### `npm run lint`

```text
> codex-as-subagent@0.1.0 lint
> node --check src/cli/main.mjs
```

退出码：`0`。

### `npm run smoke`

```text
> codex-as-subagent@0.1.0 smoke
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

### 目标源码 `node --check`

命令：

```text
node --check src/adapters/sqlite/sqlite-store.mjs
node --check src/core/execution-store.mjs
node --check src/core/completion-store.mjs
node --check src/core/completion-router.mjs
```

完整输出：无；四个命令均退出码 `0`。

### `git diff --check HEAD^ HEAD`

完整输出：无；退出码 `0`。

### 提交范围

```text
src/adapters/sqlite/sqlite-store.mjs
src/core/completion-router.mjs
src/core/completion-store.mjs
src/core/execution-store.mjs
tests/unit/completion-router.test.mjs
tests/unit/sqlite-store.test.mjs
```

实现 commit `5b7b533` 只包含上述 6 个文件。

## Concerns

- 本轮验证覆盖 Node 内置 SQLite、两个独立 SQLite 连接的 claim race 和所有 Task 3 unit；没有启动真实 Codex app-server，也没有跨进程 Host Hook E2E。后续 Runtime/Hook 任务需要继续验证真实进程生命周期和 ACK/NACK transport。
- `npm run lint` 当前仓库脚本只检查 `src/cli/main.mjs`；本轮另行对 4 个 Task 3 源码运行了 `node --check`。
- `DatabaseSync` 是同步 API；本轮实现的事务均是同步短事务。后续调用方不能在事务边界内加入等待、网络操作或 stdout 写入。
- 报告提交是实现 commit 之后的独立文档提交；实现 commit SHA 为 `5b7b533`。

## 暂停前最终复核

- 已完成测试：此前最终 `npm test` 为 28/28，Task 3 focused unit 为 8/8。
- 最小语法检查：

  ```text
  node --check src/adapters/sqlite/sqlite-store.mjs
  node --check src/core/execution-store.mjs
  node --check src/core/completion-store.mjs
  node --check src/core/completion-router.mjs
  ```

  四个命令均退出码 `0`，无输出。
- `git diff --check 3a19f07 HEAD`：退出码 `0`，无输出。
- 当前工作区干净；未回退任何已写文件，暂停后续扩展实现。
