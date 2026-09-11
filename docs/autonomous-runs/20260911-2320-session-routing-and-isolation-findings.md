# Completion 回流串线排查记录与三层隔离意图（2026-09-11 23:20）

> 性质：**排查记录 + 下一步意图**。本轮**不做任何代码修改**，不锁定修复方案。
> 触发场景：Kimi Code Web 模式实测发现 completion 被投递到同 workspace 的另一个 session。

## 1. 结论摘要

1. **V1 的隔离只做到 workspace 一层**：`host` 与 `session` 两个维度都没有隔离。
2. Kimi Web 回流被实现成「**detached 常驻进程 + 每秒轮询 SQLite**」，这与回流设计定稿 §5.1 的
   「事件驱动、completion 一形成即主动 push」**不一致**；该实现选择由实现计划（提交 `f2a7aea`）引入，
   未回写设计定稿。
3. 串线的直接触发者是**孤儿 worker**：worker 脱离宿主生命周期、只在启动时校验一次 session，
   宿主异常退出后永久存活，继续按 workspace 盲领 completion。
4. 进一步的跨 Host 干扰已被观察到：**所有 Host 共用同一份 SQLite 数据目录与同一个单实例 Runtime Server**，
   因此一个 Host 的残留 worker 可以领走另一个 Host 产生的 completion。
5. 用户意图：**借此机会把隔离彻底做完整，至少三层——host、workspace、session**。
   具体方案待用户与更强模型讨论后定稿，本轮不实施。

## 2. 现象

### 2.1 Kimi Web：A 会话的 completion 被投进 B 会话（已实证）

- spawn 方：`session_131df6cf-7bf9-4f03-80b1-85ace218b096`（2026-09-11 22:40 启动的验收会话）。
- 实际投递目标：`session_d48bdbd0-63f8-4119-a9af-e7d3130ad248`——**当日 17:39 启动、已停止运作的旧会话**。
- 证据：`session_d48bdbd0` 的 `last_prompt` 原文即该探针 completion
  （`Codex subagent 01a090eb-… completed (6b01f85c) … 2+2 等于 4`），`updated_at = 22:42:18`，与投递时刻吻合。
- 该 completion 在 SQLite 中为 `delivery_state='delivered'`、`delivery_id='kimi-web-6a83b688-…'`。

### 2.2 ZCode 复验受 Kimi worker 干扰（另一会话观察）

另一会话在 ZCode 复验同款问题时发现结果受**当前正在运行的 Kimi worker** 影响。该观察与 2.1 的机制一致：
两个 Host 共享同一 SQLite 与同一 Runtime Server，Kimi 侧残留 worker 可在约 1 秒内领走任意 workspace 的
pending completion（`delivery_id` 形如 `kimi-web-<uuid>`），使 ZCode 路径的观测被污染。

## 3. 根因分析（三层）

### 3.1 Host 层：无隔离

- Runtime Server 的 socket / 锁 / SQLite 路径**全局固定**：
  `serve` 默认 `--socket <dataDir>/server.sock`、`--lock <dataDir>/server.lock`，`dataDir` 默认
  `~/.codex-as-subagent`（`src/cli/serve.mjs`）。`ensureServer` + `acquireStartupLock`
  （`src/server/startup-lock.mjs`）保证**每个 dataDir 只有一个 Server 实例**。
- 该单实例 Server 同时服务所有 Host、所有 workspace。
- `completions` 表无 host 维度；`claimPendingHook` 的入参虽含 `host`，但**实现从未使用它**
  （`src/adapters/sqlite/sqlite-store.mjs` 的 `claimPendingHook()` 仅按 `workspace` + `delivery_state` 过滤）。
- 结论：**一个 Host 的消费者可以领取另一个 Host 产生的 completion**。

### 3.2 Workspace 层：请求/执行层有隔离，投递层没有

- 有隔离：`WorkspaceGuard` 对 thread 与 workspace 做一致性校验；execution/completion 均记 `workspace`；
  跨 workspace 的 `send`/`steer`/`interrupt`/`read_thread` fail-closed。
- 无隔离：completion **投递**只按 `workspace` 领取，同一 workspace 内不做任何进一步区分。

### 3.3 Session 层：完全没有

- `executions` / `completions` 均无 `owner_session_id`；设计规格 §6.2 已明确：
  「V1 的隔离边界只到 workspace，没有 session 维度」，并把 session 隔离列为 V2。
- 因此同 workspace 的任意消费者都可能领走他会话的 completion。

### 3.4 直接触发者：孤儿 worker

- Web 回流由 `kimi-web --attach` 拉起的 **detached 常驻 worker**（`src/cli/kimi-web.mjs`、
  `src/hook/kimi-web.mjs` 的 `runKimiWebWorker`）每秒轮询 `claimPendingHook`。
- 回收路径只有 `SessionEnd → kimi-web --detach`；宿主异常退出 / 会话被 cancel 时**不执行**，
  worker 变为 `ppid=1` 的孤儿并永久存活。
- worker 内的 `discoverKimiServer` **只在启动时执行一次**，轮询循环中不再复查 session/Server 是否仍有效；
  且 Kimi 的 session 记录在服务端持久存在，旧 session 的 API 查询仍返回 200，孤儿 worker 因此
  **永远不会自愈退出**。
- 实测：workspace 为本仓库的孤儿 worker（`session_d48bdbd0`，PID 48074，17:39 启动、宿主早已消失）
  在 22:42 仍领走了新会话的 completion；同 workspace 同时并行着新会话 worker（PID 88454，22:40 启动）。

### 3.5 与设计定稿的偏差

- 回流设计定稿 §5.1 原文：Web 模式「**无需等待** PreToolUse/PostToolUse/Stop 发生。
  Codex completion **一形成即可主动 push**」——即**事件驱动**。
- 实际实现为**常驻轮询**。该选择由 Kimi 集成实现计划
  （`docs/superpowers/plans/2026-09-11-kimi-code-integration.md` Task 2：「starts an idempotent detached worker」）
  引入，**未回写设计定稿**，导致文档与实现脱节。

## 4. 关键取证（本机实测，2026-09-11）

| # | 事实 | 证据 |
|---|---|---|
| 1 | Kimi MCP 进程 env 无 session、无 KIMI_CODE_HOME | `ps eww -p <mcp-pid>` 仅见 `KIMI_API_KEY` |
| 2 | MCP `initialize` 明文不含 session/workspace | `~/.codex-as-subagent/mcp-debug.log` |
| 3 | `tools/call` 参数不含 session | Kimi 二进制 `CallToolRequestParamsSchema` 仅 name/arguments |
| 4 | 用户级 mcp.json 不注入 session env | `~/.kimi-code/mcp.json` 只有 command/args/timeout |
| 5 | MCP 连接按 server name 缓存在 workspace 作用域服务上，**一 workspace 一 MCP 进程、跨 session 共享** | 二进制 `McpConnectionManager.entries` + `WorkspaceMcpService` |
| 6 | Hook stdin 含 `session_id` 与 `cwd` | 知识库 §20；ZCode 侧为 `ZCODE_SESSION_ID`，**只注入 Hook、不在 MCP env** |
| 7 | Hook 对 MCP 工具调用也触发，且携带 sessionId | 二进制 `registerToolHooks` → `onBeforeExecuteTool` → `runPreToolUse`（`sessionId: this.sessionContext.sessionId`） |
| 8 | Kimi 仅 `UserPromptSubmit`/`PreToolUse`/`Stop` 能影响主流程，`PostToolUse` 等为 observation-only | 知识库 §21 |
| 9 | Server 在 completion 落地那一刻必定存活 | `LifecycleManager.isIdle()` 要求活跃 execution=0，而 execution 恰在 terminal 落库时删除；`server.log` 实证 |
| 10 | 孤儿 worker 真实存活并抢走新会话 completion | `ps` 显示 PID 48074（ppid=1，17:39 启动）仍在轮询 |

## 5. 各模式影响判定

| 模式 | 回流路径 | 是否已复现串投 | 判定 |
|---|---|---|---|
| Kimi Web | detached 常驻 worker 轮询 → Server API prompt/steer | **是（已实证）** | 因孤儿 worker，**必然发生** |
| Kimi TUI | 宿主按事件现起 `hook --host=kimi-code` | 未实测 | 结构缺陷相同；无常驻竞争，**仅当同 workspace 有 ≥2 并发活跃会话时**可能发生 |
| ZCode | 宿主按事件现起 `hook --host=zcode` | 复验中（受 Kimi worker 干扰） | 同上；**且会被 Kimi 残留 worker 跨 Host 抢占** |

## 6. 下一步意图（用户 2026-09-11 口述，方案待定稿）

V1 只完成了 workspace 一层隔离，**应补齐为至少三层**：

1. **Host 隔离**：单实例 Server 同时服务多个 harness；不同 Host 的 completion、claim、worker
   不得互相可见、互相领取。
2. **Workspace 隔离**：已有请求层隔离，需在**投递层**同样成立。
3. **Session 隔离**：同一 Host、同一 workspace 下的不同 session 必须各领各的 completion。

**修复方向不得由本轮拍板**。用户将先与更强的模型讨论整体隔离设计，再决定方案；
已知必须一并解决的具体问题：

- 取消/替换 Web 的 detached 常驻轮询 worker，使投递回到设计定稿 §5.1 的**事件驱动**语义；
- 确定 session 归属的取数通道（已排除 MCP 层，候选为 Hook 侧绑定，见 §4 #6/#7）；
- 确定孤儿 completion 的降级策略（滞留 pending vs 可达后由同 Host 同 workspace 代领）；
- 评估 Host 身份的引入方式（消费者必须能证明自己属于哪个 Host）。

## 7. 本轮明确不做

- 不修改任何源码。
- 不实现 session/host 隔离。
- 不删除或停止任何运行中的 worker 进程（需用户单独确认）。

## 8. 遗留清理项（待实施轮确认）

- `~/.codex-as-subagent/state.sqlite` 中 4 条永不投递的历史 pending：
  2 条 `workspace=/private/tmp/cas-e2e-ws`、2 条 `workspace=~/.kimi-code/plugins/managed/codex-as-subagent`。
- `~/.codex-as-subagent/kimi-web-workers.json` 中已失效的孤儿 worker 记录（含 `session_d48bdbd0` 等）。
- 运行中的孤儿 worker 进程（至少 PID 48074 已确认）。
