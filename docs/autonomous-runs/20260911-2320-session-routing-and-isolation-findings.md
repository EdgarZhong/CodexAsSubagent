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
6. **清理前快照证据表明这是系统性问题，不是个例**：本机同时存在 **7 个已脱离宿主（ppid=1）的常驻
   worker，横跨 6 个不同 workspace**，且其中一个 workspace 下有 2 个 worker 并行争抢；累计 5 条
   completion 因指向失效 workspace 而永久滞留 pending。精确清单见 §4.1（已于 2026-09-11 23:15 清理，
   原始快照备存于 `~/.codex-as-subagent/backup-20260911-2330/`）。

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

### 4.1 清理前系统状态快照（2026-09-11 23:15 清理，原始快照备存）

以下数据取自清理前对 `~/.codex-as-subagent/state.sqlite` 与 `kimi-web-workers.json` 的只读读取，
**清理后不可再生**，故在此留存。原始文件备份在 `~/.codex-as-subagent/backup-20260911-2330/`。

**（a）常驻 worker registry：7 个，全部 ppid=1，横跨 6 个 workspace**

| session_id | workspace | pid | 启动时刻 |
|---|---|---|---|
| session_75746fa9-… | /Users/edgar/code/Ebbinghaus | 45003 | 2026-09-11T09:35:29Z |
| session_08e13c70-… | /Users/edgar/code/pi-web | 46849 | 2026-09-11T09:37:52Z |
| session_f0bd28b5-… | /Users/edgar/scripts/xiaoe-m3u8-extract | 46991 | 2026-09-11T09:37:55Z |
| session_d48bdbd0-… | **/Users/edgar/programs/CodexAsSubagent** | 48074 | 2026-09-11T09:39:21Z |
| session_b4d1d29a-… | /Users/edgar/Documents/论文/0816 | 48313 | 2026-09-11T09:39:29Z |
| session_131df6cf-… | **/Users/edgar/programs/CodexAsSubagent** | 88454 | 2026-09-11T14:40:45Z |
| session_9010f852-… | /Users/edgar/code/intern/ReseachOS | 98031 | 2026-09-11T14:50:12Z |

关键观察：

- **7 个 worker 全部脱离宿主（ppid=1）**，且宿主早已退出——证明 `SessionEnd → --detach` 回收路径
  在宿主异常退出时不执行，是**系统性**而非偶发。
- **同 workspace（`CodexAsSubagent`）下有 2 个 worker 并行**（`d48bdbd0` 属已停止的旧会话、
  `131df6cf` 属当时活跃会话）——这正是 §2.1 串投的直接竞争结构。
- 最早一批 worker（09:35–09:39 启动）**存活超过 13 小时**，期间持续每秒轮询共享 SQLite。

**（b）化石 pending completion：5 条（此前记录为 4 条，遗漏了 ZCode E2E 新产生的一条）**

| completion_id | workspace | terminal_status | 滞留原因 |
|---|---|---|---|
| 0accef59-… | /private/tmp/cas-e2e-ws | failed | 临时 workspace 已消失 |
| 59648912-… | /private/tmp/cas-e2e-ws | completed | 临时 workspace 已消失 |
| 77a2284d-… | ~/.kimi-code/plugins/managed/codex-as-subagent | completed | 插件目录，已 fail-closed 不可领 |
| 5992c796-… | ~/.kimi-code/plugins/managed/codex-as-subagent | completed | 同上 |
| 70ec8d65-… | /private/tmp/cas-zcode-e2e/ws2 | failed | 临时 workspace 已消失 |

**（c）清理前投递分布**

- `completions` 共 30 行：`delivered` 25、`pending` 5、`claimed_*` 0。
- 25 条 `delivered` 中，**`delivery_id` 带 `kimi-web-` 前缀的仅 2 条**（其中一条即 §2.1 的错投），
  其余 23 条为普通 UUID。注意：普通 UUID 同时覆盖 ZCode/Kimi TUI 的 Hook 领取与 `codex_wait` 的
  direct 投递，**无法仅凭前缀区分**，故这里只作通道量级参考，不用于归因。
- 按 workspace 聚合的 completion 数：仓库根 17、`/private/tmp/cas-e2e-ws` 6、
  插件目录 4、`/private/tmp/cas-zcode-e2e/ws{,2,3}` 各 1。

**（d）清理动作与结果（2026-09-11 23:15）**

先备份后清理：备份 `~/.codex-as-subagent/backup-20260911-2330/`（含 `state.sqlite` + WAL/SHM 与
`kimi-web-workers.json` 原始副本）；对上述 7 个 PID 发 SIGTERM 并确认全部退出；按 `completion_id`
精确删除 5 条 pending（保留 25 条已投递历史）；`kimi-web-workers.json` 置为 `{}`；
`PRAGMA wal_checkpoint(TRUNCATE)` 回收膨胀至约 400KB 的 WAL。

校验结果：残留 worker 进程 0；registry `{}`；`PRAGMA integrity_check` = ok；
pending/claimed/delivered/executions = 0/0/25/0。

**（e）重要前提：清理是时点性的，非根治**

插件的 `SessionStart`/`TurnStarted` attach hook 仍然挂着，任何 Kimi 会话再次触发即会重新拉起
worker，垃圾会重新产生。真正的根治依赖第 6 节的隔离方案落地（替换常驻轮询为事件驱动，
并补齐 host / session 隔离）。

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
- 清理测试垃圾另经用户单独授权执行，不属本节范围（见 §4.1(d) 与 §8）。

## 8. 遗留清理项（已于 2026-09-11 23:15 清理）

清理前盘点出的三类测试垃圾**均已清理**（清单与校验见 §4.1(d)）：

- `~/.codex-as-subagent/state.sqlite` 中 5 条永不投递的历史 pending（2 条 `cas-e2e-ws`、
  2 条插件目录、1 条 `cas-zcode-e2e/ws2`）——已精确删除；25 条已投递历史保留。
- `~/.codex-as-subagent/kimi-web-workers.json` 中 7 条失效孤儿 worker 记录——已置为 `{}`。
- 7 个运行中的孤儿 worker 进程（含 `session_d48bdbd0` 的 PID 48074）——已 SIGTERM 并确认退出。

原始状态已在清理前完整备份于 `~/.codex-as-subagent/backup-20260911-2330/`，可回滚。

**未清理（有意保留）**：`mcp-debug` 标志文件与 `mcp-debug.log`（`stdio-bootstrap` 中标志文件门控的
调试探针，默认零开销，排查隔离问题时仍可能有用）。如需清理需单独确认。

**注意**：本次为时点清理，attach hook 未移除，worker 会随下一次 Kimi `TurnStarted` 重新产生
（见 §4.1(e)）。
