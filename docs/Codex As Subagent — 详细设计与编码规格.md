# Codex As Subagent
## 详细设计与编码规格

**状态：V1 基线规格（已交付）。V2 增量以三份 V2 文稿为唯一权威：《CodexAsSubagent V2 Session 隔离与 Mailbox 架构设计》《CodexAsSubagent V2 串投修复与 Kimi Code 集成适配说明》《CodexAsSubagent V2 Host 隔离、Thread Hold 与 CLI-Adapter 实施规格》；与本文冲突之处一律以 V2 为准。被取代或失效的小节已就地移除。**

---

# 1. 项目定义与设计边界

## 1.1 项目目标

**Codex As Subagent** 将本机已经登录的 OpenAI Codex 作为通用 Subagent Runtime，提供给 ZCode、Kimi Code、Claude Code、Grok Build、Pi 等 Coding Agent 使用。

主 Agent 应能够：

- 异步启动一个或多个 Codex Subagent；
- 继续已有 Codex thread；
- 对正在运行的 Codex Subagent追加指导；
- 查看运行状态；
- 显式等待一个或多个 Subagent；
- 中断任务；
- 查看当前工作区历史 thread；
- 查询 Codex 当前可用模型；
- 在没有显式 `wait` 的情况下，自动收到后台完成的 Codex 结果。

系统不重新实现 Codex Agent 本身。

Codex 继续负责：

```text
模型推理
工具调用
文件读取与修改
shell / web / MCP 等能力
thread / turn
Codex conversation persistence
ChatGPT / Codex authentication
provider
Codex configuration
```

Codex As Subagent 只负责：

```text
Subagent supervision
runtime lifecycle
workspace isolation
MCP façade
completion routing
persistent delivery
host integration
```

---

## 1.2 对外抽象

对于主 Agent：

> **一个 Codex thread 就是一个 Subagent。**

Codex thread 可以经历多个 turn：

```text
Thread A
 ├── Turn 1
 ├── Turn 2
 └── Turn 3
```

因此：

```text
Subagent identity = threadId
Single execution = internal turn
```

主 Agent 只认识：

```text
threadId
```

以下内容全部属于 Codex As Subagent 内部实现：

```text
turnId
eventCursor
reservationId
deliveryId
raw app-server event
approval request id
```

任何底层协议变化都应由内部 Adapter 消化，不能重新泄漏到 MCP public API。

---

## 1.3 V1 不可变契约

以下规则视为 V1 固定产品语义：

- `codex_spawn` 永远异步；
- 不提供 `sync` / `async` 开关；
- `codex_wait` 固定最多等待 **500 秒**；
- `codex_wait_many` 固定最多等待 **500 秒**；
- wait timeout 只结束本次等待，不 interrupt Codex；
- 模型不能指定 cwd/workspace；
- 工作区边界为 Host 静态指定的 canonical workspace；V2 起隔离命名空间升级为 `host → (host, workspace) → (host, workspace, session_id)`，见 V2 实施规格 §2；
- 一个 thread 同一时刻最多一个 active turn；
- 不暴露 turnId；
- 不暴露 event cursor；
- 不暴露 approval 工具；
- 不暴露 generic Codex config 编辑能力；
- 不返回 raw event dump；
- 不使用 repository-level Git diff 判断当前 Codex turn 修改了哪些文件；
- completion 优先保证不丢；
- 极端 crash 边界宁可重复投递一次，也不能静默丢结果；
- Codex As Subagent Server 不做永久 daemon；
- Host 退出不得终止仍在执行的 Codex turn。

---

# 2. 总体架构与项目结构

## 2.1 运行时架构

系统物理上包含 Host Bootstrap、Codex As Subagent Server 和 Codex app-server 三层，但只有中间一层是真正的业务 Runtime。

```text
┌────────────────────────────────┐
│ Coding Agent Host              │
│ ZCode / Kimi / Claude / Pi ... │
└───────────────┬────────────────┘
                │
                │ MCP stdio
                ▼
┌────────────────────────────────┐
│ MCP Bootstrap                  │
│ codex-as-subagent mcp          │
│                                │
│ • MCP façade                   │
│ • 获取当前 workspace           │
│ • lazy-start Server            │
│ • 转发 request / response      │
│ • direct-delivery ACK          │
│                                │
│ 无持久业务状态                  │
└───────────────┬────────────────┘
                │
                │ HTTP over Unix Domain Socket
                ▼
┌────────────────────────────────┐
│ Codex As Subagent Server       │
│                                │
│ RuntimeManager                 │
│ CompletionRouter               │
│ StateStore                     │
│ WorkspaceGuard                 │
│ HistoryAdapter                 │
│ LifecycleManager               │
└───────────┬─────────┬──────────┘
            │         │
            │         └──── state.sqlite
            │
            │ owns
            ▼
    ┌──────────────────┐
    │ codex app-server │
    └────────┬─────────┘
             │
             ▼
       Codex persisted state
```

另外有一条专门用于异步结果回流的路径：

```text
Host Hook
    │
    ▼
codex-as-subagent hook
    │
    ▼
CompletionStore
    │
    ▼
state.sqlite
```

Hook 不需要 Runtime Server 当前处于运行状态。

---

## 2.2 为什么使用 stdio Bootstrap，而不是让业务 Server 直接作为 HTTP MCP

真正的 Codex As Subagent Server 完全可以实现 HTTP MCP。

保留极薄 Bootstrap 的原因是本项目同时要求：

```text
需要时自动启动
+
无 active turn 时自动退出
+
Host 退出又不能结束仍在执行的任务
```

主流 Coding Agent 对 MCP transport 普遍采用：

```text
stdio
→ Host负责启动本地进程

HTTP
→ Host连接已经存在的服务
```

如果直接：

```text
Host
  ↓ HTTP
Codex As Subagent Server
```

Server 在空闲时自动退出以后，下一次调用只能得到 endpoint unavailable，Host 通常不会替我们执行：

```text
codex-as-subagent serve
```

反过来，如果真正 Runtime Server 本身就是 Host 启动的 stdio MCP：

```text
Host
  ↓
Runtime Server
```

Host 退出又会自然结束 stdio child，破坏后台任务独立生命周期。

因此 Bootstrap 的作用是：

> **利用 stdio 获得通用的本地 Process Activation，同时把真正 Runtime Server detached 出 Host 生命周期。**

Bootstrap 本身不能持有：

```text
Codex thread runtime
waiter state
completion queue
SQLite state
Codex app-server process
```

它只是 Host Adapter。

另一个附带收益是 workspace 获取。stdio MCP 通常天然运行在 Host 当前项目环境内，也更容易获得 Host roots/current CWD。

---

## 2.3 上游 Codex Supervisor

上游仓库：

[redmikarimo/codex-supervisor-mcp](https://github.com/redmikarimo/codex-supervisor-mcp?utm_source=chatgpt.com)

本项目采用该仓库作为 **Git Submodule**：

```text
vendor/codex-supervisor-mcp/
```

原项目本身是 MIT License，可以修改和再分发。

原项目已经包含：

```text
codex app-server child process management
JSON-RPC transport
thread/start
thread/resume
turn/start
turn/steer
turn/interrupt
thread/list
persisted thread processing
process failure handling
```

但它原始 MCP façade 同时暴露 cwd、sandbox、approval、event cursor、raw events 等本项目不需要的控制面。

因此不能直接把其 MCP Server 当成最终产品依赖。

主项目必须增加隔离层：

```text
vendor/codex-supervisor-mcp
          │
          ▼
src/adapters/supervisor/
          │
          ▼
Codex As Subagent Core
```

只有：

```text
src/adapters/supervisor/
```

允许 import Submodule 内部模块。

核心业务代码禁止直接引用：

```text
vendor/codex-supervisor-mcp/src/...
```

Adapter 对核心层提供稳定接口，例如：

```text
startAppServer()
stopAppServer()

startThread()
resumeThread()

startTurn()
steerTurn()
interruptTurn()

listThreads()
readThreadMetadata()
listTurns()
listTurnItems()

listModels()
readEffectiveConfig()

subscribeRuntimeEvents()
```

如果上游内部接口发生变化，只修改 Adapter。

如果未来必须修改 Supervisor 源码，则维护一个自己的 Supervisor fork，并让 Git Submodule 指向该 fork 的固定 commit；不要在 Codex As Subagent 安装阶段动态 patch vendor 文件。

---

## 2.4 项目目录

主仓库建议：

```text
codex-as-subagent/
│
├── src/
│   ├── adapters/
│   ├── core/
│   ├── server/
│   ├── mcp/
│   ├── hook/
│   ├── cli/
│   └── shared/
│
├── plugins/
│   ├── zcode/
│   ├── kimi-code/
│   ├── claude-code/
│   ├── grok-build/
│   └── pi/
│
├── vendor/
│   └── codex-supervisor-mcp/
│
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── e2e/
│   └── fixtures/
│
├── scripts/
├── docs/
│
├── package.json
├── config.example.toml
├── .gitmodules
├── LICENSE
└── README.md
```

核心源码二级结构：

```text
src/adapters/
├── supervisor/
│   ├── app-server-adapter.mjs
│   ├── history-adapter.mjs
│   └── protocol-normalizer.mjs
└── sqlite/
    └── sqlite-store.mjs

src/core/
├── runtime-manager.mjs
├── execution-store.mjs
├── completion-store.mjs
├── completion-router.mjs
├── terminal-result.mjs
├── workspace-guard.mjs
├── model-service.mjs
└── errors.mjs

src/server/
├── server.mjs
├── request-router.mjs
├── lifecycle-manager.mjs
├── startup-lock.mjs
└── recovery.mjs

src/mcp/
├── stdio-bootstrap.mjs
├── tool-registry.mjs
├── tool-handlers.mjs
├── response-projector.mjs
└── workspace-context.mjs

src/hook/
├── drain.mjs
├── render-completions.mjs
└── hosts/
    ├── plain.mjs
    ├── zcode.mjs
    ├── kimi-code.mjs
    ├── claude-code.mjs
    ├── grok-build.mjs
    └── pi.mjs

src/cli/
├── main.mjs
├── serve.mjs
├── mcp.mjs
├── hook.mjs
└── drain.mjs
```

所有 Host 集成放在：

```text
plugins/
```

例如：

```text
plugins/zcode/
├── .zcode-plugin/
│   └── plugin.json
├── .mcp.json
├── hooks/
│   └── hooks.json
└── README.md
```

Host plugin 只负责：

```text
注册 MCP
配置 workspace
注册 Hook
Host-specific stdout wrapper
```

不得复制 Runtime、SQLite 或 completion routing 逻辑。

---

# 3. 异步完成交付：为什么需要 Hook

## 3.1 十个 MCP 工具解决不了的事情

Codex As Subagent 对模型公开的十个 MCP 工具属于**主动控制面**。

它们都要求：

> 当前必须存在一次主 Agent 推理，并由主 Agent 主动决定调用某个 MCP tool。

例如：

```text
spawn
send
steer
status
wait
wait_many
interrupt
list
read
models
```

这足够完成所有主动操作，却不足以完成真正的后台异步 Subagent。

典型流程：

```text
Main Agent
    │
    ├── codex_spawn(A)
    │        ↓
    │   立即得到 threadId
    │
    ├── Main Agent继续自己的工作
    │
    └── 没有调用 codex_wait(A)

             ↓

       Codex A 后台工作

             ↓

       Codex A 完成
```

A 的 TerminalResult 此时已经存在。

但如果系统只有十个 MCP tools：

```text
没有任何正在等待的 MCP call
```

因此结果无法主动重新进入主会话。

唯一办法就是让模型不断：

```text
status
status
status
wait
```

轮询。

这会造成：

```text
额外模型回合
额外 token
额外工具调用
复杂 orchestration
```

也会让：

```text
codex_spawn = async
```

失去真正意义。

因此本项目在模型可见的十个 MCP 工具之外，额外提供一个**非模型工具、非 MCP control-plane tool 的本地 Hook 接口**。

---

## 3.2 Hook 的设计目标

Hook 唯一负责：

> **将已经完成、且没有通过显式 wait 成功交付的 Codex TerminalResult，在 Host 下一次合适的生命周期触发点自动重新注入主会话。**

两条通道职责明确分离：

```text
MCP Tools
Main Agent → Codex As Subagent

用途：
主动创建
主动控制
主动查询
主动同步等待
```

```text
Completion Hook
Codex As Subagent → Main Agent

用途：
异步完成结果回流
```

因此 Hook：

- 不是第十一个 MCP tool；
- 不暴露给模型；
- 不由模型决定是否调用；
- 不负责 Codex runtime；
- 不参与 live execution；
- 只负责已经持久化的 completion delivery。

如果把它改成：

```text
codex_drain_completions
```

并作为第十一个 MCP tool 暴露给模型，那么模型还是必须主动调用它，本质仍然是轮询，无法解决异步回流问题。

---

## 3.3 Completion Buffer 是 Hook 和 Wait 的共同交付基础

整个系统只产生一种最终结果：

```text
Canonical TerminalResult
```

Codex turn terminal 后，TerminalResult **永远先写入持久化 completion store**。

之后才决定由谁消费。

核心数据流：

```text
                   Codex turn terminal
                           │
                           ▼
                  Build TerminalResult
                           │
                           ▼
                    SQLite COMMIT
                           │
                 ┌─────────┴─────────┐
                 │                   │
          当前存在 direct waiter     │ 没有 waiter
                 │                   │
                 ▼                   ▼
          claimed_direct           pending
                 │                   │
                 ▼                   ▼
          wait / wait_many          Hook
                 │                   │
                 ▼                   ▼
              delivered           delivered
```

因此“completion buffer”并不是只有 async Hook 才使用。

更准确地说，它是：

> **所有 TerminalResult 的持久化交付存储。**

区别只是状态不同。

---

## 3.4 TerminalResult 写入时如何分流

当 Codex terminal 时：

```text
turn/completed
      ↓
CompletionRouter
      ↓
构造 Canonical TerminalResult
```

然后必须进行一个短 SQLite transaction：

```text
BEGIN IMMEDIATE

INSERT completion
UNIQUE(thread_id, turn_id)

如果 active execution 当前有 direct reservation：
    delivery_state = claimed_direct
    delivery_id = reservation_id
否则：
    delivery_state = pending

DELETE active_execution

COMMIT
```

之后：

### 有 waiter

```text
claimed_direct
↓
通知内存 waiter
↓
wait / wait_many 准备 MCP response
```

### 没有 waiter

```text
pending
↓
Server无需继续处理
↓
等待未来 Hook 或显式 wait 消费
```

因此一个 TerminalResult 在 Codex terminal 后立即拥有可靠持久状态。

不能采用：

```text
有waiter
→ 不写SQLite
→ 直接return
```

因为 Server 如果恰好在 terminal 后、response 发出前 crash，结果会永久丢失。

---

## 3.5 Completion 的两种消费方式

同一条 completion 有两种消费者。

### Direct Consumer：`wait` / `wait_many`

如果模型明确：

```text
codex_wait(threadId)
```

说明当前主 Agent 正在主动等待结果。

这时：

```text
pending completion
```

如果已经存在，可以通过 transaction：

```text
pending
→ claimed_direct
```

立即归当前 wait 消费。

如果 turn 还在运行，则先在 execution 上建立 reservation；未来 terminal 时直接以：

```text
claimed_direct
```

写入。

Direct delivery 成功后：

```text
claimed_direct
→ delivered
```

---

### Async Consumer：Hook

没有 direct waiter 时：

```text
completion.delivery_state = pending
```

Host 下一次触发 Hook：

```text
codex-as-subagent hook
```

Hook 使用 CompletionStore 原子 claim：

```text
pending
→ claimed_hook
```

然后把 TerminalResult 注入 Host 主会话。

成功后：

```text
claimed_hook
→ delivered
```

因此：

```text
wait
```

与：

```text
Hook
```

不是两套结果系统。

它们只是同一个 persistent completion store 的两种消费方式。

---

## 3.6 Hook 本身必须很薄

统一提供：

```text
codex-as-subagent hook --host=<host>
```

以及宿主无关底层接口：

```text
codex-as-subagent drain
```

Host Hook 最理想的配置只有一条 shell command。

Hook 进程逻辑：

```text
读取 Host stdin
↓
解析当前 workspace
↓
canonicalize workspace
↓
CompletionStore.claimPending()
↓
render TerminalResult[]
↓
Host-specific stdout wrapper
```

Hook 不允许：

```text
启动 Codex thread
resume thread
interrupt thread
处理 app-server event
reconcile active turn
管理 Runtime Server
```

这些都属于 Server。

Hook 和 Server 唯一共享的是：

```text
CompletionStore
StateStore
```

因此：

```text
Runtime Server ───────┐
                      ├── CompletionStore ── SQLite
Hook Process ─────────┘
```

不是：

```text
Hook
↓
Runtime Server
↓
SQLite
```

这保证最后一个 Codex turn 完成后 Server 可以正常退出，而未来 Hook 仍然能够读取结果。

---

## 3.7 Hook 的可靠性交付

Hook 对 pending completion 进行短事务 claim：

```text
BEGIN IMMEDIATE

SELECT pending completions
WHERE workspace = currentWorkspace
ORDER BY created_at ASC

UPDATE selected rows
pending → claimed_hook
delivery_id = ...
delivery_started_at = ...

COMMIT
```

> **V2 修订**：claim 谓词升级为完整 `host + workspace + session_id + delivery_state='pending'`（Hook 按自身 Session Identity、Direct Wait 按 current_session、Web 按静态归属），禁止 workspace-only claim，见 V2 架构设计 §八。

然后才生成 stdout。

成功：

```text
claimed_hook
→ delivered
```

Hook crash：

```text
claimed_hook
↓
delivery lease expired
↓
pending
```

由于绝大多数 Host Hook 协议不会在“模型已经真正消费 additionalContext”之后再给本地程序一个事务 ACK，因此严格的：

```text
exactly-once
```

无法可靠保证。

本项目采用：

```text
at-least-once biased delivery
```

即：

> 极端 crash 边界允许重复一次，但绝不能静默丢掉 completion。

每一条 completion 都应拥有稳定：

```text
completionId
```

即使极端情况下重复注入，也能够识别为同一个结果。

---

# 4. MCP 公共接口规格

Codex As Subagent 对模型固定公开十个工具。

## 表一：原 Supervisor MCP → Codex As Subagent MCP 改造

| 原 Supervisor MCP | 原接口特征 | Codex As Subagent | 改造要求 |
|---|---|---|---|
| `codex_start` | `cwd`, `prompt`, `model`, `effort`, `sandboxMode`, `networkAccess`, `approvalPolicy`；返回 thread/turn/cursor | **`codex_spawn`** | 改名；永远 async；删除 cwd/sandbox/network/approval；删除 turnId/eventCursor |
| `codex_send` | `threadId`, `prompt`，允许 cwd/model/effort/sandbox 等 override | **`codex_send`** | 只保留 `threadId`, `prompt`, `model?`, `effort?` |
| `codex_steer` | `threadId`, `prompt`, `expectedTurnId?` | **`codex_steer`** | 删除 `expectedTurnId`；Server 内部确定 active turn |
| `codex_status` | 可带 cursor/maxEvents/includeTurns；返回 events、diff、approval 等 | **`codex_status`** | 改为 compact liveness/status snapshot；不返回 raw events |
| `codex_wait` | cursor-based long poll；调用方传 timeout | **`codex_wait`** | 固定 500 秒；无 timeout/cursor 参数；返回 TerminalResult 或 running timeout snapshot |
| 无 | 无 | **`codex_wait_many`** | 新增；等待一组 active thread 或 `"all"`；固定 500 秒 |
| `codex_interrupt` | `threadId`, `turnId?` | **`codex_interrupt`** | 删除 turnId；内部解析 |
| `codex_list_threads` | `limit`, `cursor`, `searchTerm`, `cwd` | **`codex_list_threads`** | 无参数；当前 workspace；最近最多 25 条；无分页 |
| `codex_read_thread` | `threadId`, `includeTurns` | **`codex_read_thread`** | 固定 compact recent-history projection |
| `codex_list_approvals` | 暴露 approval queue | **删除** | 不进入模型控制面 |
| `codex_resolve_approval` | approve/decline/cancel | **删除** | 不进入模型控制面 |
| 无对应 public tool | Codex `model/list + config/read` | **`codex_models`** | 新增稳定简化模型目录 |

最终工具集合：

```text
codex_spawn
codex_send
codex_steer
codex_status
codex_wait
codex_wait_many
codex_interrupt
codex_list_threads
codex_read_thread
codex_models
```

---

## 表二：十个 MCP 工具的详细输入、返回和语义

| Tool | 模型输入 | 正常返回 | 边界结果 / 错误 | 必须遵守的语义 |
|---|---|---|---|---|
| **`codex_spawn`** | `prompt`, `model?`, `effort?` | `{threadId,status:"running",model,effort,startedAt}` | `invalid_model`, `invalid_effort`, `default_model_unavailable` | 当前 workspace 新建 thread 并启动第一 turn；必须立即返回 |
| **`codex_send`** | `threadId`, `prompt`, `model?`, `effort?` | 与 spawn 相同 | `thread_busy`, `thread_not_found`, `thread_workspace_mismatch` | 必要时内部 resume；不能在 active thread 上并行创建第二 turn |
| **`codex_steer`** | `threadId`, `prompt` | `{threadId,accepted:true,status:"running"}` | `no_active_turn`, workspace mismatch | 向当前 internal turn 追加 guidance；turnId 永不暴露 |
| **`codex_status`** | `threadId` | `{threadId,status,model,effort,startedAt?,lastActivityAt,idleForSec,latestAction?,latestAssistantPreview?,filesChanged}` | 标准 thread/workspace error | 只回答是否活跃、是否卡住、当前大致做什么 |
| **`codex_wait`** | `threadId` | Terminal 时返回 Canonical TerminalResult | 500s 后 `{status:"running",timedOut:true,...statusSnapshot}`；没有 active/pending completion → `no_active_turn` | timeout 只结束 wait，不 interrupt |
| **`codex_wait_many`** | `threads:string[] \| "all"` | `{completed:[TerminalResult...],pending:[StatusSnapshot...],timedOut}` | 显式输入含非法/跨 workspace thread 时整体失败 | `"all"` 是调用瞬间 active threads 快照；新 spawn 不加入 |
| **`codex_interrupt`** | `threadId` | `{threadId,interruptRequested:true,requestedAt}` | `no_active_turn` | ACK 不是 terminal；真实 interrupted result 后续正常路由 |
| **`codex_list_threads`** | 无 | `{threads:[...],total,truncated}` | 无 | 当前 workspace；按最近活动倒序；最多 25 个 |
| **`codex_read_thread`** | `threadId` | `{threadId,status,assistantMessages,recentActivity,changes,truncated}` | `history_unavailable` | 主要返回 assistant 消息；tool activity 只做高层摘要 |
| **`codex_models`** | 无 | `{default:{model,effort},models:[{id,supportedEfforts}]}` | 默认 profile 配置无效时明确报错 | 不提供 generic config 编辑 |

---

## 4.1 Spawn / Send ACK

统一：

```json
{
  "threadId": "thr_...",
  "status": "running",
  "model": "gpt-5.6-luna",
  "effort": "xhigh",
  "startedAt": "2026-09-10T15:00:00.000Z"
}
```

不得增加：

```text
turnId
eventCursor
resumed
cwd
deliveryId
```

`codex_send` 对 model/effort 的规则：

```text
model omitted + effort omitted
→ 使用该 thread 持久化设置

only model supplied
→ 新 model + 原 effort

only effort supplied
→ 原 model + 新 effort

both supplied
→ 显式 pair
```

---

## 4.2 StatusSnapshot

Running：

```json
{
  "threadId": "thr_...",
  "status": "running",
  "model": "gpt-5.6-luna",
  "effort": "xhigh",
  "startedAt": "...",
  "lastActivityAt": "...",
  "idleForSec": 47,
  "latestAction": "bash: running pytest tests/auth",
  "latestAssistantPreview": "修改已经完成，目前正在运行测试……",
  "filesChanged": 3
}
```

建议固定：

```text
latestAction <= 200 chars
latestAssistantPreview <= 600 chars
```

以下行为均更新 `lastActivityAt`：

```text
assistant delta
command start/progress/end
file changes
tool activity
web search
MCP activity
turn item completion
```

因此 `lastActivityAt + idleForSec` 可用于识别网络不稳定情况下 Codex 是否仍在持续工作。

---

## 4.3 Canonical TerminalResult

成功：

```json
{
  "threadId": "thr_...",
  "status": "completed",
  "durationSec": 184,
  "finalAssistantMessage": "已经完成认证逻辑修改，并通过测试。",
  "changes": {
    "filesChanged": 3,
    "files": [
      {"path": "src/auth.ts", "kind": "modified"},
      {"path": "src/token.ts", "kind": "added"},
      {"path": "tests/auth.test.ts", "kind": "modified"}
    ],
    "filesTruncated": false
  }
}
```

失败：

```json
{
  "threadId": "thr_...",
  "status": "failed",
  "durationSec": 91,
  "lastAssistantMessage": "已经完成前两步，但连接中断。",
  "error": {
    "type": "connection_error",
    "message": "Response stream disconnected."
  },
  "changes": {
    "filesChanged": 1,
    "files": [
      {"path": "src/auth.ts", "kind": "modified"}
    ],
    "filesTruncated": false
  }
}
```

中断同样保留部分修改：

```text
status = interrupted
```

文件列表最多 20 项，但：

```text
filesChanged
```

始终保存真实总数。

超过 20：

```text
filesTruncated = true
```

最终 assistant message 默认完整返回，但设置灾难性 hard cap：

```text
约 16,000 chars
```

---

## 4.4 `codex_wait_many`

例如：

```text
A 40 秒完成
B 120 秒失败
C 500 秒仍在运行
```

返回：

```json
{
  "completed": [
    {
      "threadId": "A",
      "status": "completed",
      "durationSec": 40,
      "finalAssistantMessage": "...",
      "changes": {}
    },
    {
      "threadId": "B",
      "status": "failed",
      "durationSec": 120,
      "lastAssistantMessage": "...",
      "error": {},
      "changes": {}
    }
  ],
  "pending": [
    {
      "threadId": "C",
      "status": "running",
      "lastActivityAt": "...",
      "idleForSec": 14,
      "latestAction": "...",
      "latestAssistantPreview": "...",
      "filesChanged": 2
    }
  ],
  "timedOut": true
}
```

A/B terminal 后虽然已经形成 completion，但在整个 `wait_many` 返回成功之前保持：

```text
claimed_direct
```

不能提前变成 `delivered`。

C 在 500 秒 timeout 后释放 reservation。

如果整个 MCP response 失败，A/B 必须重新回到：

```text
pending
```

从而能够被未来 Hook 消费。

---

# 5. Runtime 状态、SQLite 与并发模型

## 5.1 工作目录与持久目录

Codex As Subagent 自己的数据统一放：

```text
~/.codex-as-subagent/
├── config.toml
├── state.sqlite
├── state.sqlite-wal
├── state.sqlite-shm
├── server.sock
├── server.lock
└── logs/
```

Codex 本身仍使用：

```text
~/.codex/
```

职责严格分开：

```text
~/.codex/
→ Codex auth
→ provider
→ profile
→ Codex thread/history

~/.codex-as-subagent/
→ runtime ownership
→ completion state
→ delivery state
→ recovery metadata
```

Codex transcript 不复制到我们的 SQLite。

---

## 5.2 为什么用 SQLite

系统中会同时存在：

```text
Runtime Server
多个 MCP Bootstrap
Hook process
recovery process
```

并发事件包括：

```text
wait reservation
wait_many reservation
terminal arrival
Hook claim
Host disconnect
delivery ACK
process crash
```

这些本质都是：

> **小型状态机上的原子状态转移。**

SQLite 提供：

```text
transaction
unique constraint
atomic compare-and-set
multi-process locking
crash consistency
```

从而避免自行实现：

```text
JSON temp file
fsync
rename
lock file arbitration
partial write recovery
concurrent writer merge
```

推荐：

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;
```

数据库 transaction 必须短。

禁止：

```text
BEGIN
wait 500 seconds
COMMIT
```

正确方式：

```text
BEGIN
reserve
COMMIT

... asynchronous work ...

BEGIN
state transition
COMMIT
```

---

## 5.3 数据模型

> **V2 起本节数据模型已被取代**：`executions` / `completions` 增加 `host`、`session_id` 列，新增 `thread_holds`、`host_presence`、`current_sessions` 表，索引与建表语句以《CodexAsSubagent V2 Host 隔离、Thread Hold 与 CLI-Adapter 实施规格》§2.3–2.7 为准。V2 不做数据迁移：部署 V2 前停止旧实例，旧数据库直接废弃重建（见该规格 §2.11）。

本节以下并发模型与 PRAGMA 约束继续有效。

建议 meta 表：

```sql
CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
```

---

## 5.4 Delivery State

内部 completion delivery 状态固定为：

```text
pending
claimed_direct
claimed_hook
delivered
```

Wait 的“坑位”则记录在 execution：

```text
reservation_id
reservation_kind
```

reservation 不是长期数据库锁。

例如：

```text
BEGIN IMMEDIATE

UPDATE executions
SET reservation_id = ?
WHERE thread_id = ?
  AND reservation_id IS NULL

COMMIT
```

谁成功 compare-and-set，谁获得 direct delivery reservation。

---

## 5.5 Direct Delivery ACK

最危险的边界：

```text
Codex terminal
↓
Server已经产生TerminalResult
↓
Server发给Bootstrap
↓
Bootstrap正在写MCP stdout
↓
Host突然退出
```

此时不能因为结果已经离开 Server 就认为 delivered。

流程：

```text
completion = claimed_direct
↓
Server response 带 hidden deliveryId
↓
Bootstrap写Host MCP stdout
↓
write成功
↓
Bootstrap向Server ACK deliveryId
↓
claimed_direct → delivered
```

如果 write 失败：

```text
claimed_direct → pending
```

如果 Bootstrap 被直接 kill，没有机会 NACK：

```text
claimed_direct
↓
delivery lease timeout
↓
pending
```

推荐 lease：

```text
30 seconds
```

因此 direct delivery 同样采用：

```text
不丢优先
```

---

# 6. Workspace、模型与历史读取

## 6.1 Workspace

唯一规则：

> **Host 当前 canonical CWD = Codex As Subagent workspace。**

模型工具没有：

```text
cwd
workspace
root
```

参数。

Bootstrap 获取 workspace 后：

```text
realpath()
```

并作为隐藏 request context 传给 Server。

Server 对所有 thread 操作验证：

```text
realpath(thread.cwd)
==
request.workspace
```

否则：

```text
thread_workspace_mismatch
```

禁止 fallback：

```text
$HOME
Server process.cwd()
last workspace
自动猜 repository root
```

无法可靠获取：

```text
workspace_unavailable
```

---

## 6.2 `codex_list_threads`

只显示当前 workspace 中的 thread。

例如当前：

```text
~/project-a
```

则：

```text
project-b 的 thread
```

必须：

```text
list_threads 看不到
read_thread 拒绝
send 拒绝
status 拒绝
interrupt 拒绝
```

即使模型偶然知道另一个 threadId，也不能跨 workspace 使用。

> **V2 补充**：session 级隔离已在 V2 落地（`current_session`、Thread Hold、按 `(host, workspace, session_id)` 的 claim 谓词），`list_threads` 只列出 caller Host 当前持有的 Thread、free Thread 与 holder 已 stale 的 idle Thread，不显示其他 active Host 有效持有的 Thread；Thread 读写控制语义以《CodexAsSubagent V2 Host 隔离、Thread Hold 与 CLI-Adapter 实施规格》§1 为准。本节原有的"V1 局限与 V2 方向"提案（Bootstrap 持有 session、`owner_session_id` 等）已被该设计取代，予以移除。

---

## 6.3 Dedicated Codex Profile

Codex As Subagent 使用专门的 Codex Profile。

增量覆写内容来自本项目持久目录下、与 Codex 配置同名的：

```text
~/.codex-as-subagent/config.toml
```

**该文件是可选的**：

- 不存在：不注入任何覆写，app-server 直接使用其 `$CODEX_HOME` 下用户常规的 `~/.codex/config.toml`。
- 存在：Server 启动 app-server 时把其中的键翻译为 `-c key=value` 启动参数注入（经 vendor `CODEX_APP_SERVER_ARGS` 传递），不修改用户 `~/.codex/config.toml`。

推荐使用该文件解耦"日常使用 Codex"与"Codex As Subagent 使用 Codex"两份配置，例如：

```toml
model = "gpt-5.6-luna"
model_reasoning_effort = "xhigh"
```

Codex 原生 `-p <name>` profile 机制（叠加 `$CODEX_HOME/<name>.config.toml`）**不采用**：调研证实其在 app-server 路径下不可靠（`thread/start` 可能忽略 profile 字段，见 docs/research/2026-09-11-codex-runtime-discovery.md 第 5 节）。覆写只走 `-c key=value`。

这样用户平常在 Codex App 中临时改变默认 model/effort，不影响 Subagent 默认。

Codex 原有：

```text
auth
subscription
provider
permission configuration
global capabilities
```

仍由 Codex 自己管理。

---

## 6.4 配置分层：Codex 覆写 vs Server 自身

两层配置必须分开，不得混写（用户 2026-09-11 拍板）：

**第一层：`~/.codex-as-subagent/config.toml` 是对 Codex 配置的增量覆写**（用法见 6.3）。只放 Codex 认识的键（如 `model`、`model_reasoning_effort`），不配置 Server 自身行为。

**第二层：Server 自身运行参数不进入该文件**：

- Codex 二进制路径：不写入任何 config.toml。走 `CODEX_BIN` 环境变量；缺省时由 Server 启动时的自动发现解析为绝对路径（GUI Host 拉起的进程 PATH 不可信，不得只依赖 PATH 查找）。
- 其余 Server 参数属于协议和实现常量，不暴露为用户配置：

```text
wait = 500s
delivery lease
status preview cap
files cap
DB filename
socket filename
idle shutdown
```

### Codex Runtime 自动发现与协议探测

发现目标不是"机器上有没有叫 codex 的文件"，而是"哪些 Codex runtime 满足本项目所需的 stable app-server contract"（依据：docs/research/2026-09-11-codex-runtime-discovery.md）。

解析顺序（候选 realpath 去重后逐个探测，选中即止）：

```text
0. CODEX_BIN 环境变量（显式覆盖，仍需通过探测）
1. PATH 中的 codex（尊重用户主动安装；GUI Host 环境可能无用户 PATH）
2. standalone managed：~/.codex/packages/standalone/current/bin/codex
3. standalone 入口：~/.local/bin/codex
4. Homebrew：/opt/homebrew/bin/codex（Apple Silicon）、/usr/local/bin/codex（Intel）
5. /Applications/ChatGPT.app/Contents/Resources/codex（随 App 自动更新、常为 alpha，降级 fallback）
6. /Applications/Codex.app/Contents/Resources/codex（legacy fallback）
```

不扫描 IDE extension 私有 runtime（无稳定路径与 ABI）。不按版本号大小排序（alpha 版本号可能高于 stable）。

每个候选的协议探测：

```text
1. codex --version
2. codex app-server generate-json-schema --out <tmp>（stable surface），检查必需 method/type
3. 拉起 ephemeral app-server 子进程，完成 initialize/initialized 冒烟后终止
```

选中后记录 `{binary 绝对路径, version, schema hash}`；Server 单次生命周期内绝不切换 binary；每次冷启动重新执行发现与探测（App 自动更新可能在同一路径下替换实现）。全部候选失败时 fail-closed，`doctor` 输出各候选诊断，并建议官方 standalone 安装（`curl -fsSL https://chatgpt.com/codex/install.sh | sh`，支持 `--release X.Y.Z` pin）。

> **实现状态（2026-09-11）**：`doctor` 命令已实现为只读诊断入口（`codex-as-subagent doctor`），输出数据目录、config.toml 覆写、startup lock/socket 与 runtime probe 结果；不会清理锁或终止进程。探测失败仍写入 `server.log` 的 `codex.discovery.failed` 事件。

> **实现状态（2026-09-11）**：已落地于 `src/shared/codex-runtime.mjs` 与 `src/cli/serve.mjs`。
> - `codexBinaryCandidates()` 按上述顺序生成候选取并集（去重）。
> - `probeCodexRuntime()` 逐候选执行完整三段探测；`REQUIRED_APP_SERVER_METHODS` 列出 adapter 依赖的九个 wire method（thread/start、thread/resume、turn/start、turn/steer、turn/interrupt、thread/list、thread/read、model/list、config/read），schema 文本缺任一即拒绝该候选。
> - `serve` 冷启动时调用，选中后把 `{binary, args}` 显式传给 adapter 并在生命周期内固定；失败则记录 `codex.discovery.failed` 并 fail-closed（不启动 Server）。
> - `resolveAppServerArgs()` 保证缺省为干净的 `["app-server"]`，不受 vendor 默认参数影响（见决策 12）。
> - 实测：本机跳过 30 个不存在候选，命中 ChatGPT.app 内嵌 0.153.4，全流程 107ms；serve 在无 `CODEX_BIN` 时自主发现并正常启动。
>
> **与安装脚本的关系**：安装脚本（方式 B）可选择把 `CODEX_BIN` 作为显式配置写进插件 env（优先级 0 的提前命中，属优化而非必需）；**真正的发现与探测始终由 Server 启动时执行**，因此不依赖安装期环境。

第三方永远自起 `codex app-server` 子进程，不 attach Desktop 或 managed daemon 的已有实例（daemon 官方仍标记 experimental；一个 active thread 只能有一个 runtime owner）。

---

## 6.5 Model Resolution

新 thread：

```text
caller model/effort supplied
→ 使用显式值

caller omitted
→ 使用 dedicated profile effective default
```

Server 应通过 Codex：

```text
model/list
config/read
```

验证有效模型。

默认 profile 指向的模型不可用时：

```text
default_model_unavailable
```

禁止静默换模型。

已有 thread：

```text
send without overrides
→ preserve persisted model + effort
```

---

## 6.6 History Adapter

Codex history wire protocol 可能随 app-server 演进。

业务层只能调用：

```text
readThreadMetadata()
readRecentTurns()
readTurnItems()
findPersistedTurn()
readRecentAssistantMessages()
readTurnChanges()
```

由：

```text
src/adapters/supervisor/history-adapter.mjs
```

统一实现。

优先使用当前分页 history API；旧 Codex 可以 fallback 到旧 thread read。

不要在 MCP handler 内散落 app-server wire parsing。

---

## 6.7 Changed Files

当前 TerminalResult 的 changes 只能来自当前 internal turn 自身：

```text
structured FileChange items
persisted patch/file-change records
turn-scoped history
turn/diff notifications
```

禁止：

```text
git diff
git status
git diff HEAD
```

作为 attribution 来源。

必须测试：

```text
用户此前已经修改 A.ts，但未提交
Codex 本 turn 只修改 B.ts
```

最终：

```text
TerminalResult.changes.files
→ 只能有 B.ts
```

---

# 7. Server 生命周期与恢复

## 7.1 Lazy Start

Bootstrap 收到 MCP request：

```text
probe ~/.codex-as-subagent/server.sock
```

健康：

```text
直接 forward
```

不存在：

```text
atomic startup lock
↓
winner detached spawn:
codex-as-subagent serve
↓
其他 Bootstrap 等待 socket ready
↓
forward request
```

多个 Host/窗口同时启动只能得到一个 Runtime Server。

`server.lock` 文件存在本身不能证明 Server 活着。

必须结合：

```text
socket health
PID
instanceId
```

检测 stale state。

---

## 7.2 Runtime Ownership

只有：

```text
Codex As Subagent Server
```

拥有：

```text
codex app-server
active execution
live runtime event state
```

因此：

```text
Host退出
↓
Bootstrap退出
↓
Server仍有active turn
↓
Codex继续
```

---

## 7.3 自动退出

Server 只有同时满足：

```text
activeExecutionCount == 0
inFlightRequestCount == 0
unackedDirectDeliveryCount == 0
terminalRouterIdle == true
persistentStateCommitted == true
```

才进入：

```text
idle_shutdown_ms
```

默认：

```text
3000ms
```

期间有新请求：

```text
cancel shutdown
```

仍 idle：

```text
stop accepting requests
↓
flush state
↓
gracefully stop owned app-server
↓
close socket
↓
remove runtime files
↓
exit
```

特别注意：

```text
pending completion
```

不阻止 Server 退出。

因为 completion 已经持久化，未来 Hook 可独立消费。

---

## 7.4 Host 在 wait 中退出

Codex 尚未完成：

```text
Host disconnect
↓
release reservation
↓
Codex继续
```

以后 terminal：

```text
pending completion
```

Codex 已 terminal、response 正在交付：

```text
claimed_direct
↓
ACK未完成
↓
pending
```

因此结果不会丢失。

---

## 7.5 app-server Crash

如果 owned Codex app-server 确认异常退出：

```text
查找当前 owner_instance_id 的 active executions
↓
每个生成 synthetic TerminalResult
status = failed
error.type = app_server_crash
↓
commit SQLite
↓
wake active waiters
```

普通 Codex runtime：

```text
error notification
```

不能直接视为 terminal。

真正 turn terminal 应优先依据：

```text
turn/completed
```

或对应持久终止状态。

---

## 7.6 Codex As Subagent Server Crash

Server 有 active execution 时不会主动退出。

因此 startup recovery 只处理：

```text
crash
kill -9
OS reboot
power loss
```

启动后读取旧：

```text
executions
```

并从 Codex persisted history reconcile。

能够证明 turn 已 terminal：

```text
重建真实 TerminalResult
↓
INSERT completion if absent
↓
删除 execution
```

无法证明 terminal，而且原 runtime 已不存在：

```text
status = failed
error.type = supervisor_crash
```

禁止长期保留虚假：

```text
running
```

---

## 7.7 Orphan app-server

操作系统不能保证父进程异常死亡后 child 一定死亡。

运行状态应记录：

```text
owner_instance_id
app_server_pid
app_server_started_at
codex_binary
```

恢复时只有能够高置信确认 PID 对应上一实例创建的 app-server，才允许清理。

不能只根据：

```text
PID == oldPid
```

直接 kill，避免 PID reuse 误杀。

---

# 8. Plugin 与 Hook Host Adapter

所有 Host-specific 内容放：

```text
plugins/
```

核心 Runtime 不允许散落：

```text
if (host === "zcode")
```

之类逻辑。

每个插件只负责两个问题：

```text
如何注册 codex-as-subagent mcp
如何触发 codex-as-subagent hook
```

例如 ZCode：

```text
plugins/zcode/
├── .zcode-plugin/
│   └── plugin.json
├── .mcp.json
├── hooks/
│   └── hooks.json
└── README.md
```

其 Hook 可以在合适事件调用：

```text
codex-as-subagent hook --host=zcode
```

不同 Host 的 Hook 协议如果不同，只在：

```text
src/hook/hosts/
```

做薄封装。

> **V2 修订**：Host native payload 的解析统一收敛到 `src/hosts/<host>.mjs`（Host Protocol Registry + `parseHookInvocation`），`cli/hook.mjs` 不再直接读取任何 Host-native 字段；`src/hook/hosts/` 仅保留输出文本 envelope。见 V2 实施规格 §3。

核心：

```text
CompletionStore
claim
lease
delivery
rendered TerminalResult
```

完全共用。

没有 Hook 能力的 Host 仍可正常使用：

```text
wait
wait_many
status
read_thread
```

只是失去后台 completion 自动注入体验。

因此：

> **Hook 是异步 Subagent 体验的重要组成部分，但不是 Runtime 正确性的前提。**

---

# 9. 实施计划与验收

## 9.1 推荐编码顺序

> 本节为 V1 实施顺序的历史记录，已执行完毕（见 git 历史与 docs/autonomous-runs/ 验收记录），不再作为现行规范。V2 的实施计划见 docs/superpowers/plans/。

---

## 9.2 必须覆盖的关键测试

测试至少必须覆盖以下行为：

```text
spawn 永远 async

send idle thread
send busy thread
steer active
steer idle

workspace realpath normalization
cross-workspace thread rejection

terminal before wait
wait before terminal
wait timeout
timeout does not interrupt

pending completion later claimed by wait
pending completion later claimed by Hook

wait response delivery succeeds
wait response transport breaks
direct ACK missing
delivery lease restores pending

wait_many:
A completed
B failed
C timeout

A/B are not marked delivered before whole response succeeds

two Hooks race
only one can claim the same pending completion

Hook crashes after claim
lease restores completion

duplicate terminal event
UNIQUE(thread_id,turn_id)

Host exits while turn running
Codex continues

last turn finishes
completion commits
Server exits

pending completion exists
Server still exits

Hook runs while Server is already dead
completion still delivered

app-server crash
active execution becomes failed

Server crash
startup reconciliation

multiple Bootstrap processes
single Server activation

stale socket
stale lock

pre-existing dirty Git files
must not contaminate current-turn changedFiles
```

---

## 9.3 核心不变量

以下内容应直接进入关键源码注释和 regression tests：

```text
I1  Thread 是唯一公共 Subagent identity。

I2  turnId 永远不暴露给模型。

I3  模型永远不能指定 workspace。

I4  一个 thread 同时最多一个 active turn。

I5  一个 internal turn 最多一个 canonical TerminalResult。

I6  TerminalResult 必须先 commit SQLite，再尝试任何交付。

I7  direct delivery 没有 ACK 前不能标 delivered。

I8  wait timeout 永远不能 interrupt Codex。

I9  Hook failure不能导致 completion 永久丢失。

I10 pending completion 不阻止 Server 自动退出。

I11 active turn 存在时 Server 不得 idle shutdown。

I12 changed-files 绝不能由 repository-level Git diff 归因。

I13 普通 runtime error notification 不自动等于 terminal。

I14 workspace mismatch 必须 fail closed。

I15 无法可靠确认身份的 orphan PID 不得被杀。

I16 Codex transcript/config/auth 仍由 Codex 自己作为 authoritative source。

I17 Bootstrap 不持有业务状态。

I18 Hook 不参与 live execution management。

I19 Wait 与 Hook 只能消费同一个 persistent completion store，不能维护两套结果系统。
```

---

# 10. 最终职责边界与 V1 完成条件

整个项目最终必须保持如下边界：

```text
Codex
  = Agent Runtime

codex-supervisor-mcp Submodule
  = Codex app-server integration building block

Supervisor Adapter
  = 上游协议隔离层

Codex As Subagent Core
  = thread supervision
  = execution state
  = workspace guard
  = TerminalResult
  = completion routing

SQLite StateStore
  = durable execution/delivery state

Runtime Server
  = live Codex ownership
  = wait
  = lifecycle
  = recovery

MCP Bootstrap
  = Host process activation
  = workspace context
  = transport forwarding

Completion Hook
  = persistent async completion delivery

plugins/*
  = Host-specific MCP/Hook registration
```

> V1 的完成条件清单（十工具 schema、spawn 异步、workspace 强隔离、completion-first、双消费者、crash 恢复、changed-files attribution、ZCode E2E 等）已于 2026-09-11 全部达成并经用户级验收，历史清单不再保留，证据见 docs/autonomous-runs/。V2 的验收条件以《CodexAsSubagent V2 Host 隔离、Thread Hold 与 CLI-Adapter 实施规格》§3.13 为准。

本规格中的：

```text
10-tool public MCP API
Thread-as-Subagent abstraction
Canonical TerminalResult
persistent completion-first invariant
Wait/Hook dual-consumer model
workspace boundary
Runtime ownership
Bootstrap activation model
```

均视为 V1 固定架构。

底层 Codex app-server 如果发生协议变化，应优先修改 Adapter；不能因为底层实现方便而扩大主 Agent 的控制面或破坏上述抽象。
