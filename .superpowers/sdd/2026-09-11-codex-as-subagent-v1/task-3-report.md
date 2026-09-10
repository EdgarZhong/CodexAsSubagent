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

## Fix round 1：review findings 修复

- 修复 commit：`8f457a8`。
- 本轮未创建子 Agent。
- 只修改了以下四个 Task 3 文件：
  - `src/adapters/sqlite/sqlite-store.mjs`
  - `src/core/completion-router.mjs`
  - `tests/unit/sqlite-store.test.mjs`
  - `tests/unit/completion-router.test.mjs`
- `src/core/execution-store.mjs` 与 `src/core/completion-store.mjs` 本轮无需改动，保留原实现。

### Findings 对应修复

1. Critical：`CompletionRouter` 现在只接受明确的 Adapter-verified terminal type：`turn.completed`、`turn.failed`、`turn.interrupted`、`supervisor.process.failed`；不再仅凭 `status`/`reason` 推断。已构造的 `TerminalResult` 只能通过明确 `provenance = canonical|recovery` 的严格 canonical/recovery 路径进入。普通 `error` 与 `item.completed`（即使附带 completed/failed status）均不创建 completion、不删除 active execution。
2. Important 1：Router 拒绝 event threadId 与 supplied TerminalResult threadId 不一致，拒绝 event/result status 冲突；SQLite canonical payload 现在强制 payload threadId/turnId 与 completion 行身份一致，并校验外部 status 与 payload status 一致。
3. Important 2：active execution 存在时，event turnId 必须匹配当前 execution；无 active execution 时，只有严格 canonical/recovery provenance 才允许插入，普通 terminal event fail closed。
4. Important 3：normalized changes 通过安全的匹配 turn 传递时，Router 会再次使用已经验证的 `filesChanged`/`filesTruncated` 元数据构造 canonical result，不会把 25 个总变更错误重算成 20 个且 false。
5. Minor：新增 `claimed_direct` 恰好 30 秒 lease expiry 测试；新增普通 error、item.completed、turn mismatch、event/result status conflict、thread identity mismatch 和 payload identity 负向测试。
6. Hook race 测试改为两个 `node:worker_threads` Worker；通过 `SharedArrayBuffer`/`Atomics` barrier 同步起跑，各自打开独立 SQLite 连接并竞争同一 pending completion，最终只允许一个 claim。

### Fix round 1 覆盖测试命令与完整输出

#### `node --test tests/unit/sqlite-store.test.mjs tests/unit/completion-router.test.mjs`

```text
✔ CompletionRouter persists terminal result first and ignores non-terminal events (5.826458ms)
✔ CompletionRouter accepts normalized terminal events and preserves their safe turn changes (2.569875ms)
✔ CompletionRouter accepts an already-built canonical TerminalResult (2.372209ms)
✔ CompletionRouter only accepts verified terminal types and matching identities (3.04425ms)
✔ CompletionRouter preserves truncated normalized change metadata (2.978375ms)
✔ CompletionRouter routes a reserved direct terminal result without holding a delivery lock (3.162125ms)
✔ SqliteStore creates the durable schema and required SQLite pragmas (4.631084ms)
✔ terminal completion commits before delivery and duplicate thread/turn is idempotent (4.737417ms)
✔ direct reservation uses compare-and-set, ACK is required, and expired leases requeue (5.669583ms)
✔ two racing Hook Workers can claim a pending completion only once (29.20075ms)
✔ SqliteStore rejects payload identity and status conflicts (2.44175ms)
ℹ tests 11
ℹ suites 0
ℹ pass 11
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 92.353125
```

退出码：`0`。

#### `npm test`

```text
> codex-as-subagent@0.1.0 test
> node --test 'tests/**/*.test.mjs'

✔ CompletionRouter persists terminal result first and ignores non-terminal events (7.824583ms)
✔ CompletionRouter accepts normalized terminal events and preserves their safe turn changes (3.003875ms)
✔ CompletionRouter accepts an already-built canonical TerminalResult (2.502167ms)
✔ CompletionRouter only accepts verified terminal types and matching identities (2.32825ms)
✔ CompletionRouter preserves truncated normalized change metadata (2.078083ms)
✔ CompletionRouter routes a reserved direct terminal result without holding a delivery lock (2.454875ms)
✔ project layout exposes the V1 foundation (2.495833ms)
✔ normalizeEvent returns a bounded public projection without internal ids (0.898ms)
✔ normalizeEvent supports vendor EventStore params.turn, params.item and params.diff (0.214959ms)
✔ ordinary error and item completion are not terminal events (0.295041ms)
✔ changed files come only from the current turn structured record (0.292917ms)
✔ history adapter exposes turn-scoped history and never queries repository git state (0.414042ms)
✔ publicProjection recursively removes internal protocol fields (0.107791ms)
✔ supervisor adapter defines the complete fake contract and maps operations (0.590917ms)
✔ supervisor adapter bridges events from an injected EventStore (0.095ms)
✔ supervisor adapter emits one thread-scoped terminal event per active process failure (0.815166ms)
✔ fake adapter rejects invalid or unknown injected implementations (0.283583ms)
✔ SqliteStore creates the durable schema and required SQLite pragmas (4.895833ms)
✔ terminal completion commits before delivery and duplicate thread/turn is idempotent (4.672083ms)
✔ direct reservation uses compare-and-set, ACK is required, and expired leases requeue (3.884375ms)
✔ two racing Hook Workers can claim a pending completion only once (25.824042ms)
✔ SqliteStore rejects payload identity and status conflicts (1.845125ms)
✔ TerminalResult completed payload is bounded and strips internal fields (1.026708ms)
✔ TerminalResult failed and interrupted payloads preserve safe terminal details (0.436208ms)
✔ TerminalResult omits invalid duration values (0.074875ms)
✔ TerminalResult rejects non-terminal status (0.15925ms)
✔ TerminalResult requires verified turn provenance and a non-empty thread id (0.10975ms)
✔ ModelService resolves default and explicit model/effort pairs (0.305208ms)
✔ WorkspaceGuard.resolve returns the canonical realpath (2.028458ms)
✔ WorkspaceGuard.resolve rejects a missing workspace (0.872083ms)
✔ WorkspaceGuard.assertThreadWorkspace fails closed for missing metadata and cross-workspace threads (1.284625ms)
ℹ tests 31
ℹ suites 0
ℹ pass 31
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 94.24775
```

退出码：`0`。

#### 目标源码 `node --check`

```text
node --check src/adapters/sqlite/sqlite-store.mjs
node --check src/core/execution-store.mjs
node --check src/core/completion-store.mjs
node --check src/core/completion-router.mjs
```

完整输出：无；四个命令均退出码 `0`。

#### `git diff --check HEAD^ HEAD`

完整输出：无；退出码 `0`。

#### Fix round 1 最终状态

- `git status --short --branch`：`## codex/autonomous-v1`，工作区干净。
- 本轮无测试失败；一次 patch 工具的多段同文件格式错误未产生文件改动，随后拆分 patch 成功完成。
- 实现 commit 为 `8f457a8`；报告将在本节之后作为独立文档 commit 提交。

## Fix round 2：review findings 修复

- 修复 commit：`ac54c2b`。
- 本轮未创建子 Agent；严格限制在 Task 3 Router 测试与 Task 2 protocol normalizer 的必要联动范围。
- 修改文件：
  - `src/core/completion-router.mjs`
  - `src/adapters/supervisor/protocol-normalizer.mjs`
  - `tests/unit/completion-router.test.mjs`
  - `tests/unit/protocol-normalizer.test.mjs`

### Findings 对应修复

1. Critical：Router 只接受四类明确 terminal type：`turn.completed`、`turn.failed`、`turn.interrupted`、`supervisor.process.failed`。带 `TerminalResult` 的 canonical 路径还必须使用合法 terminal type、`provenance = canonical` 和 verified marker；recovery 路径必须是 `recovery.terminal`、`provenance = recovery`、verified marker 和 `TerminalResult`。因此 `item.completed + canonical/recovery result`、缺 marker 的 recovery 和错误 type 的 recovery 都 fail closed，不会创建 completion 或删除 active execution。
2. Important 2：Router 汇总 event 与所有 supplied result 的 thread/turn identity，拒绝组内或跨组冲突；汇总 event status、reason、terminalStatus、嵌套 turn status/reason 及 result status，拒绝未知 running 或不一致状态。存在 active execution 时必须存在且匹配 event turn identity，并校验 workspace；没有 active execution 时只接受上述明确 verified canonical/recovery 路径。SQLite 既有 payload identity/status 校验保持不变。
3. Important 3：protocol normalizer 不再取第一个 identity，而是收集并一致性校验 event、thread、turn、params、item 和 diff 中的候选 identity；`event.turn.id` 等结构化来源也会参与 turn identity。已验证的 normalized event 只以不可枚举的 `internalTurnId` 与 `verifiedTurnIdentity = true` 供 Core/Router 使用；`Object.keys`、`JSON.stringify` 和 `publicProjection` 均不会输出它们。Router 不再用 active execution 的 turnId 回填缺失 event identity。
4. 保留上一轮已验证的 completion-first、真实 Worker Hook race、恰好 30 秒 direct lease expiry、changed-files 总数/截断元数据和 SQLite payload 冲突负向覆盖。

### Fix round 2 测试命令与完整输出

#### `node --test tests/unit/sqlite-store.test.mjs tests/unit/completion-router.test.mjs`

```text
✔ CompletionRouter persists terminal result first and ignores non-terminal events (7.440333ms)
✔ CompletionRouter accepts normalized terminal events and preserves their safe turn changes (2.860084ms)
✔ CompletionRouter accepts an already-built verified recovery TerminalResult (2.517ms)
✔ CompletionRouter only accepts verified terminal types and matching identities (2.701167ms)
✔ CompletionRouter preserves truncated normalized change metadata (2.286541ms)
✔ CompletionRouter routes a reserved direct terminal result without holding a delivery lock (1.985292ms)
✔ SqliteStore creates the durable schema and required SQLite pragmas (5.346ms)
✔ terminal completion commits before delivery and duplicate thread/turn is idempotent (4.755834ms)
✔ direct reservation uses compare-and-set, ACK is required, and expired leases requeue (5.726083ms)
✔ two racing Hook Workers can claim a pending completion only once (24.399458ms)
✔ SqliteStore rejects payload identity and status conflicts (2.0235ms)
ℹ tests 11
ℹ suites 0
ℹ pass 11
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 79.786042
```

退出码：`0`。

#### `npm test`

```text
> codex-as-subagent@0.1.0 test
> node --test 'tests/**/*.test.mjs'

✔ CompletionRouter persists terminal result first and ignores non-terminal events (6.440208ms)
✔ CompletionRouter accepts normalized terminal events and preserves their safe turn changes (2.84625ms)
✔ CompletionRouter accepts an already-built verified recovery TerminalResult (2.485292ms)
✔ CompletionRouter only accepts verified terminal types and matching identities (2.062375ms)
✔ CompletionRouter preserves truncated normalized change metadata (2.230583ms)
✔ CompletionRouter routes a reserved direct terminal result without holding a delivery lock (2.249375ms)
✔ project layout exposes the V1 foundation (2.436125ms)
✔ normalizeEvent returns a bounded public projection without internal ids (0.950459ms)
✔ normalizeEvent rejects conflicting thread and turn identities (0.128625ms)
✔ normalizeEvent supports vendor EventStore params.turn, params.item and params.diff (0.152834ms)
✔ ordinary error and item completion are not terminal events (0.136083ms)
✔ changed files come only from the current turn structured record (0.116959ms)
✔ history adapter exposes turn-scoped history and never queries repository git state (0.2065ms)
✔ publicProjection recursively removes internal protocol fields (0.056209ms)
✔ supervisor adapter defines the complete fake contract and maps operations (0.413ms)
✔ supervisor adapter bridges events from an injected EventStore (0.095ms)
✔ supervisor adapter emits one thread-scoped terminal event per active process failure (0.989333ms)
✔ fake adapter rejects invalid or unknown injected implementations (0.467167ms)
✔ SqliteStore creates the durable schema and required SQLite pragmas (5.6025ms)
✔ terminal completion commits before delivery and duplicate thread/turn is idempotent (5.304792ms)
✔ direct reservation uses compare-and-set, ACK is required, and expired leases requeue (4.549291ms)
✔ two racing Hook Workers can claim a pending completion only once (26.403958ms)
✔ SqliteStore rejects payload identity and status conflicts (2.071708ms)
✔ TerminalResult completed payload is bounded and strips internal fields (0.779833ms)
✔ TerminalResult failed and interrupted payloads preserve safe terminal details (0.622167ms)
✔ TerminalResult omits invalid duration values (0.0705ms)
✔ TerminalResult rejects non-terminal status (0.21125ms)
✔ TerminalResult requires verified turn provenance and a non-empty thread id (0.136667ms)
✔ ModelService resolves default and explicit model/effort pairs (0.323333ms)
✔ WorkspaceGuard.resolve returns the canonical realpath (2.178959ms)
✔ WorkspaceGuard.resolve rejects a missing workspace (0.770292ms)
✔ WorkspaceGuard.assertThreadWorkspace fails closed for missing metadata and cross-workspace threads (1.300708ms)
ℹ tests 32
ℹ suites 0
ℹ pass 32
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 97.154375
```

退出码：`0`。

#### 其他最终检查

```text
命令：npm run lint
结果：退出码 0；node --check src/cli/main.mjs 无错误。

命令：npm run smoke
结果：退出码 0；CLI --help 正常输出 serve、mcp、hook、drain 入口。

命令：node --check src/adapters/sqlite/sqlite-store.mjs
命令：node --check src/core/completion-router.mjs
命令：node --check src/adapters/supervisor/protocol-normalizer.mjs
命令：node --check src/adapters/supervisor/app-server-adapter.mjs
命令：node --check src/core/execution-store.mjs
命令：node --check src/core/completion-store.mjs
结果：六个命令均退出码 0，无输出。

命令：git diff --check
结果：退出码 0，无输出。
```

### Fix round 2 最终状态与 concerns

- 实现 commit：`ac54c2b`；本报告随后作为独立文档 commit 提交。
- 工作范围未扩展到其他任务；未修改 SQLite 实现、Runtime、Server、MCP、Hook、package 或核心项目文档。
- 仍未启动真实 Codex app-server，也未执行跨进程 Host Hook E2E；真实进程生命周期和 Host transport 由后续 Runtime/Hook 任务验证。
- `internalTurnId` 与 `verifiedTurnIdentity` 依赖 adapter 归一化对象的不可枚举属性；任何绕过 Adapter 直接构造 Core event 的调用方仍必须显式提供合法 terminal type、身份和 verified recovery/canonical provenance，缺失时 fail closed。

## Fix round 3：status/identity provenance review finding 修复

- 修复 commit：`adfb1fd`。
- 本轮未创建子 Agent；仅修改 Task 2 protocol normalizer、Task 3 CompletionRouter 及两组对应 unit tests。
- 未修改其他任务或文件。

### Finding 对应修复

1. normalizer 现在收集 `event.type`、event/params/turn/turnRecord/currentTurn/item/diff 中的 status、reason 和 terminalStatus 来源，并把来源名及归一化结果保存到不可枚举 `internalStatusSources`。只有明确 terminal type 且所有 status 来源均与 type 期望值一致时才输出 public terminal status；`running`、unknown、冲突 status 和 identity 未验证时不输出 status，并设置 `verifiedTerminalStatus = false`。
2. normalizer 收集 event、params.turn、turnRecord、currentTurn、turn.thread 以及 item.turn 等 thread/turn identity；一致时提供不可枚举 identity source 与 verified marker，冲突时 identity marker 为 false，terminal status 同时被抑制。`internalTurnId` 仅在 turn identity 验证成功时存在，不进入 `Object.keys`、`JSON.stringify` 或 `publicProjection`。
3. Router 重新汇总 public event、hidden identity/status sources、嵌套 event/params records、supplied TerminalResult payload 和 active execution identity；任何 source 冲突、未知 status、active execution identity/status 异常、缺失 active event turn identity 都返回 null，不插入 completion、不删除 execution。合法 completed/failed/interrupted、verified canonical 和 recovery 路径保持可用；process failure 继续按 thread-scoped adapter event 路径处理。
4. 新增回归覆盖：`turn.completed + turn.status=failed`、`turn.failed + nested completed`、unknown `running`、`event.threadId` 与 `turn.thread.id` 冲突、`turnRecord.id` 与 `internalTurnId` 冲突、canonical `item.completed` bypass，以及合法 failed/interrupted terminal。

### Fix round 3 测试命令与完整输出

#### Task 3 focused：`node --test tests/unit/sqlite-store.test.mjs tests/unit/completion-router.test.mjs`

```text
✔ CompletionRouter persists terminal result first and ignores non-terminal events (5.959458ms)
✔ CompletionRouter accepts normalized terminal events and preserves their safe turn changes (2.603416ms)
✔ CompletionRouter accepts valid failed and interrupted terminal events (2.731334ms)
✔ CompletionRouter accepts an already-built verified recovery TerminalResult (2.181083ms)
✔ CompletionRouter only accepts verified terminal types and matching identities (2.098375ms)
✔ CompletionRouter rejects nested status and identity conflicts (1.89225ms)
✔ CompletionRouter preserves truncated normalized change metadata (2.775875ms)
✔ CompletionRouter routes a reserved direct terminal result without holding a delivery lock (2.406125ms)
✔ SqliteStore creates the durable schema and required SQLite pragmas (4.177084ms)
✔ terminal completion commits before delivery and duplicate thread/turn is idempotent (4.123625ms)
✔ direct reservation uses compare-and-set, ACK is required, and expired leases requeue (4.682333ms)
✔ two racing Hook Workers can claim a pending completion only once (26.367417ms)
✔ SqliteStore rejects payload identity and status conflicts (2.253375ms)
ℹ tests 13
ℹ suites 0
ℹ pass 13
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 82.646042
```

退出码：`0`。

#### Task 2 normalizer focused：`node --test tests/unit/protocol-normalizer.test.mjs`

```text
✔ normalizeEvent returns a bounded public projection without internal ids (0.9655ms)
✔ normalizeEvent rejects conflicting thread and turn identities (0.125416ms)
✔ normalizeEvent preserves terminal status provenance and rejects status conflicts (0.291916ms)
✔ normalizeEvent rejects nested thread and turn identity conflicts as non-terminal (0.105208ms)
✔ normalizeEvent supports vendor EventStore params.turn, params.item and params.diff (0.168667ms)
✔ ordinary error and item completion are not terminal events (0.153625ms)
✔ changed files come only from the current turn structured record (0.343542ms)
✔ history adapter exposes turn-scoped history and never queries repository git state (0.194084ms)
✔ publicProjection recursively removes internal protocol fields (0.056ms)
✔ supervisor adapter defines the complete fake contract and maps operations (0.405542ms)
✔ supervisor adapter bridges events from an injected EventStore (0.104958ms)
✔ supervisor adapter emits one thread-scoped terminal event per active process failure (0.717917ms)
✔ fake adapter rejects invalid or unknown injected implementations (0.183625ms)
ℹ tests 13
ℹ suites 0
ℹ pass 13
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 44.989208
```

退出码：`0`。

#### 全量回归：`npm test`

```text
> codex-as-subagent@0.1.0 test
> node --test 'tests/**/*.test.mjs'

✔ CompletionRouter persists terminal result first and ignores non-terminal events (7.364917ms)
✔ CompletionRouter accepts normalized terminal events and preserves their safe turn changes (4.077167ms)
✔ CompletionRouter accepts valid failed and interrupted terminal events (3.196458ms)
✔ CompletionRouter accepts an already-built verified recovery TerminalResult (1.973084ms)
✔ CompletionRouter only accepts verified terminal types and matching identities (2.252042ms)
✔ CompletionRouter rejects nested status and identity conflicts (1.944792ms)
✔ CompletionRouter preserves truncated normalized change metadata (2.65725ms)
✔ CompletionRouter routes a reserved direct terminal result without holding a delivery lock (2.166792ms)
✔ project layout exposes the V1 foundation (2.687417ms)
✔ normalizeEvent returns a bounded public projection without internal ids (1.042959ms)
✔ normalizeEvent rejects conflicting thread and turn identities (0.174125ms)
✔ normalizeEvent preserves terminal status provenance and rejects status conflicts (0.583417ms)
✔ normalizeEvent rejects nested thread and turn identity conflicts as non-terminal (0.142583ms)
✔ normalizeEvent supports vendor EventStore params.turn, params.item and params.diff (0.207792ms)
✔ ordinary error and item completion are not terminal events (0.61175ms)
✔ changed files come only from the current turn structured record (0.149166ms)
✔ history adapter exposes turn-scoped history and never queries repository git state (0.241333ms)
✔ publicProjection recursively removes internal protocol fields (0.071667ms)
✔ supervisor adapter defines the complete fake contract and maps operations (0.455541ms)
✔ supervisor adapter bridges events from an injected EventStore (0.10725ms)
✔ supervisor adapter emits one thread-scoped terminal event per active process failure (0.841917ms)
✔ fake adapter rejects invalid or unknown injected implementations (0.238542ms)
✔ SqliteStore creates the durable schema and required SQLite pragmas (4.363292ms)
✔ terminal completion commits before delivery and duplicate thread/turn is idempotent (6.301625ms)
✔ direct reservation uses compare-and-set, ACK is required, and expired leases requeue (5.072375ms)
✔ two racing Hook Workers can claim a pending completion only once (26.748834ms)
✔ SqliteStore rejects payload identity and status conflicts (2.169417ms)
✔ TerminalResult completed payload is bounded and strips internal fields (1.60375ms)
✔ TerminalResult failed and interrupted payloads preserve safe terminal details (0.882666ms)
✔ TerminalResult omits invalid duration values (0.149292ms)
✔ TerminalResult rejects non-terminal status (0.363417ms)
✔ TerminalResult requires verified turn provenance and a non-empty thread id (0.224834ms)
✔ ModelService resolves default and explicit model/effort pairs (0.712666ms)
✔ WorkspaceGuard.resolve returns the canonical realpath (2.8455ms)
✔ WorkspaceGuard.resolve rejects a missing workspace (0.689291ms)
✔ WorkspaceGuard.assertThreadWorkspace fails closed for missing metadata and cross-workspace threads (1.3455ms)
ℹ tests 36
ℹ suites 0
ℹ pass 36
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 120.716375
```

退出码：`0`。

#### 其他检查

```text
命令：npm run lint
结果：退出码 0；node --check src/cli/main.mjs 无错误。

命令：npm run smoke
结果：退出码 0；CLI --help 正常输出 serve、mcp、hook、drain 入口。

命令：node --check src/adapters/supervisor/protocol-normalizer.mjs
命令：node --check src/core/completion-router.mjs
结果：两个命令均退出码 0，无输出。

命令：git diff --check
结果：退出码 0，无输出。
```

### Fix round 3 最终状态与 concerns

- 实现 commit：`adfb1fd`；本节报告随后作为独立文档 commit 提交。
- 仍未启动真实 Codex app-server，未执行跨进程 Host Hook E2E；这属于后续 Runtime/Hook 验收范围。
- status provenance hidden fields 只在 Adapter normalized object 内部使用；绕过 Adapter 的调用仍必须提供完整、互相一致的 terminal type、identity、status 和可信 provenance，否则 Router fail closed。
