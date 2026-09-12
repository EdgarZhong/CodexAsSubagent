# CodexAsSubagent V2 Session 隔离与 Mailbox 架构设计

## 一、核心对象模型

### Host

Host 指承载 CodexAsSubagent 的 Coding Agent，例如 Kimi Code、ZCode、OpenCode、Claude Code。

CAS 使用一个全局 Runtime Server 和共享 SQLite，因此 Host 必须成为第一层隔离命名空间。来自不同 Host 的状态不能仅凭 Workspace 或 Session ID 混在一起解释。

Host 表示**产品类型**，不是进程或实例：

```text
Host ≠ process
Host ≠ CLI instance
Host ≠ Server instance
Host ≠ GUI window
```

同时开启多个 Kimi Code（Kimi A / B / C）仍然都是 `host = kimi-code`，它们是同一个 Host 的多个 Session，统一映射为 `(host, workspace, A/B/C)`。CAS 不增加 process_id / cli_instance_id 层级。

### CLI 型 Host 与 Server 型 Host

```text
CLI 型 Host
→ 1 CLI process = 1 Session
→ 允许 N 实例 / N Session 并存

Server 型 Host
→ 1 Server 承载 N Session
```

Server 型 Host 采用明确的 V2 环境假设：

> **同一 Host 产品在当前 CAS 用户环境中，同时最多只有一个 CAS-active Server Instance。**

即支持：

```text
Host
└─ one active Server
   ├─ Session A
   ├─ Session B
   └─ Session C
```

多 Server 并存（`Host → Server 1/2 → Sessions`）**明确超出 V2 范围**：不设计 server_instance_id、Session→Server mapping、Server namespace、Server ownership、Server takeover 与 multi-server route resolution。若能确认某 Server 型 Host 存在 >1 active Server，报 `multiple_active_host_servers` 并 fail closed，不得选第一个/最新/最后发现、不得"谁能 GET 到 Session 就选谁"、不得依次尝试；恢复到 exactly 1 active Server 后自动恢复。未来确有需要时，才把 `Host → Session` 正式扩展为 `Host → Server Instance → Session`，不在 V2 提前做半套。

内部涉及 Host 隔离的状态均以：

```text
(host, workspace)
```

作为基本作用域。

### Workspace

Workspace 是规范化后的项目工作区标识。

同一个物理 Workspace 可以同时被不同 Host 使用：

```text
(kimi, /repo)
(zcode, /repo)
```

这是两个独立的 CAS 使用域。

### Session

Session 是 Host 原生的主会话。

完整的 Session Identity 为：

```text
(host, workspace, session_id)
```

Session ID 只在对应 Host 的命名空间内解释。

V2 与未来 V3 的核心区别，是 CAS 如何得到一次 MCP 调用对应的 `session_id`。

### Thread

Thread 是 Codex 的长期会话对象，也是 CAS 对 MCP 暴露的主要控制面对象。

模型主要通过 `threadId` 操作它：

```text
spawn
send(threadId)
wait(threadId)
interrupt(threadId)
...
```

一个 Thread 可以经历多次 Turn：

```text
Thread T1

Turn U1
Turn U2
Turn U3
...
```

V2 不为 Thread 建立永久的 Session 所有权。

Thread 在回到 idle 状态后，可以被之后取得 CAS 使用权的另一个 Session 继续使用。

### Turn 与 Execution

Turn 是 Thread 内的一次具体 Codex 执行。

Execution 是 CAS 对一次正在运行的 Subagent Turn 的内部管理记录，由：

```text
(thread_id, turn_id)
```

唯一标识。

例如：

```text
Execution {
    thread_id: T1
    turn_id: U3
    host: kimi
    workspace: /repo
    session_id: A
}
```

表示：

> Thread T1 上的 Turn U3 这一次 Subagent 执行属于 Session A。

Execution 是运行期进行 per-session 隔离的基本单位。

Execution 创建时写入 Session Identity，此后直到 terminal 都不可改变。

### Completion 与 Mailbox

Execution terminal 后形成 Completion：

```text
Execution(T1,U3)
        ↓ terminal
Completion(T1,U3)
```

Completion 随即作为一条记录进入统一 Mailbox。

因此同一个 Thread 可以呈现：

```text
Thread T1

Turn U1
  Execution(T1,U1)
       ↓ terminal
  Mailbox(T1,U1)

Turn U2
  Execution(T1,U2)
       ↓ terminal
  Mailbox(T1,U2)

Turn U3
  Execution(T1,U3)   ← running
```

其中：

```text
Thread
→ 长期 Codex 会话

Execution
→ 一次正在运行的 Subagent Turn

Mailbox row
→ 一次已经 terminal 的 Subagent Turn 的结果及投递状态
```

---

## 二、隔离层级

CAS V2 的隔离首先按照 Host 和 Workspace 划分：

```text
Host
  +
Workspace
```

每个 `(host, workspace)` 独立维护自己的弱 Host Session 状态、active Executions 和 Mailbox 查询范围。

在这个作用域内部，再根据 Session Identity 区分不同 Host Session：

```text
(host, workspace, session_id)
```

Session 隔离主要作用于两个生命周期阶段：

```text
Execution
→ 当前正在运行的 Subagent 属于哪个 Session

Mailbox
→ 已完成结果应该回流到哪个 Session
```

Execution 上的 Session 标签在创建时确定。

Mailbox 上的 Session 标签从对应 Execution 继承。

两者一旦写入均不可修改。

Thread 本身不携带永久 Session owner。

在 V2 弱 Host 中，Thread 的访问服从整个 `(host, workspace)` 的 CAS Session 门禁。

在 V3 强 Host 中，某个 Thread 处于 executing 状态时，再根据其 active Execution 实施临时的 per-session 控制面隔离；Thread 回到 idle 后，该临时隔离解除。

---

## 三、Session Identity 的来源

CAS Core 内部统一使用：

```text
SessionContext {
    host,
    workspace,
    session_id
}
```

Core 不需要知道这个 SessionContext 是通过哪一种 Host 能力得到的。

### 强 Host

强 Host 可以在每一次 MCP 调用中提供可信的 Session Identity：

```text
MCP tools/call
    session_id = A
        ↓
SessionContext(A)
        ↓
CAS Core
```

每一次工具调用都可以独立知道自己来自哪个 Session。

因此同一个 `(host, workspace)` 中可以同时存在多个 Session 的调用和 Execution：

```text
Session A → Execution E1
Session B → Execution E2
Session C → Execution E3
```

这属于 V3 的完整 per-session isolation。

### 弱 Host

弱 Host 的 MCP request 本身不携带 Session Identity，但 `PreToolUse` Hook 可以得到 Host 原生的 `session_id`。

V2 因此通过：

```text
PreToolUse
+
Runtime 内部唯一 Session 状态机
```

为 session-blind MCP request 建立 SessionContext。

基本流程为：

```text
Host Session A
      ↓
PreToolUse(CAS tool)
      ↓
CAS Session 门禁
      ↓
Runtime current_session = A
      ↓
MCP request
      ↓
SessionContext(A)
```

Runtime 后续不需要每个 MCP request 再显式携带 `session_id`。

对于弱 Host，`PreToolUse` 是唯一能够看到真实 Host Session ID 的准入点。

因此这套模式的信任边界是明确的：

> 如果 Host 的 Hook 机制本身异常并 fail-open，那么一个已经抵达 Runtime 的 session-blind MCP request 无法再由 Server 侧重新证明其真实 Session 来源。

Runtime 内部状态机不是 Server-side authentication，而是建立在 Host `PreToolUse` 正常工作的前提之上的兼容机制。

---

## 四、弱 Host 的 Session 状态机

每个：

```text
(host, workspace)
```

维护一个 `current_session`。

它表示当前拥有这个 CAS 使用域的 Host Session。

`current_session` 是 **persisted routing state**，持久化在共享 SQLite 的 `current_sessions` 表（主键 `(host, workspace)`），由 `PreToolUse` Session Gate 在同一事务边界内读取与切换——Hook 进程与 Runtime Server 是不同进程，只有落库才能让双方看到一致裁决。必须区分两类状态：

```text
current_session
→ persisted routing state（可 stale）

active Execution
→ lifecycle truth（权威事实，优先级高于 current_session）
```

stale `current_session` 不等于 Session 正在占用 CAS；占用与否只由 `active_execution_count(session)` 决定。

假设 Session B 的 `PreToolUse` 到来。

如果当前没有 Session：

```text
current_session = null

→ current_session = B
→ 放行
```

如果本来就是 B：

```text
current_session = B

→ 放行
```

如果当前是 A：

```text
current_session = A
```

则检查 A 是否仍然存在 active Execution。

只要还存在：

```text
Execution(...).session_id = A
status = active
```

B 就不能接管。

只有 A 的 active Execution 数量已经降为零：

```text
active_execution_count(A) = 0
```

才允许完成：

```text
current_session: A → B
```

并放行 B。

这里：

```text
检查旧 Session 是否仍有 active Execution
+
切换 current_session
```

必须作为一个原子状态转移完成。

不能允许两个不同 Session 在同一个空闲边界同时判断“旧 Session 已经空闲”，然后都认为自己成功接管。

### 无 current_session 时的正式行为

如果 Weak Host 的 session-sensitive MCP request 到达，而该 `(host, workspace)` 还没有可信的 `current_session`：

```text
→ fail closed
→ session_not_established
```

不得：

```text
从 Workspace 猜 Session
从最近 Execution 猜
取最近使用的 Session
任选 active Session
workspace-only fallback
```

这不是永久错误，而是 **self-recovering admission failure**。正常恢复路径：

```text
MCP request
→ session_not_established

Host 正常重新发起 Tool
↓
PreToolUse(CAS tool, session=A)
↓
Session Gate 建立 current_session = A
↓
MCP request 重试
↓
成功
```

因此不需要任何人工数据库维修状态。

---

## 五、弱 Host 的完整 CAS 工具门禁

弱 Host 的互斥边界覆盖 CAS 暴露的整个 MCP 工具面。

它不仅限制会创建新 Execution 的调度操作，也覆盖读状态、等待结果、控制执行以及其他所有 CAS MCP 工具。

只要当前 Session A 仍然拥有任意 active Execution：

```text
current_session = A

E1 → session A → active
```

那么其他 Session B 对 CAS 任意 MCP 工具的调用都必须在 `PreToolUse` 阶段被拒绝。

包括：

```text
创建新的 Subagent
继续已有 Thread
wait
interrupt
查询状态
读取结果
列举状态
以及其他所有 CAS MCP 工具
```

无论该工具本身是否只读，规则都相同：

```text
A 仍有 active Execution
+
B PreToolUse(any CAS tool)

→ veto
```

这样，当 A 的 Subagent 仍在工作时，B 既不能创建新的工作，也不能通过 CAS 控制面观察、claim、等待或操作当前运行期状态。

### 同一个 Session 内不受限制

当前 Session A 可以正常使用全部 CAS 工具，并可以调度多个并行 Subagent：

```text
current_session = A

E1 → A → active
E2 → A → active
E3 → A → active
```

A 仍然可以继续使用 CAS：

```text
spawn
send
wait
status
interrupt
...
```

新的 Execution 继续被标记为 A。

因此弱 Host 的限制是：

> 不同 Session 之间不能共享同一个正在进行中的 CAS 使用周期。

### Session 占用周期

Session A 一旦产生 active Execution，其 CAS 占用持续到 A 的所有 active Execution 全部 terminal。

例如：

```text
Session A

E1 ──────────────────┐
E2 ─────────────┐     │
E3 ────────┐    │     │
           └────┴─────┘
                  ↓
       active_execution_count(A) = 0
```

在这一时间点以前，其他 Session 的全部 CAS 工具均被门禁阻止。

之后 Session B 下一次调用任意 CAS 工具时，可以完成：

```text
A → B
```

的 Session 接管。

### 弱 Host 的产品约束

PreToolUse 能解决的核心场景，是旧 Session 仍有 active Execution 时阻止其他 Session 进入 CAS。

但由于实际 MCP request 仍然不携带 Session Identity，V2 对弱 Host 还规定：

> 同一 `(host, workspace)` 下，不支持不同 Host Session 在 idle 交接边界并发发起 CAS MCP 调用。

例如在 Workspace 完全 idle 时，A 和 B 若恰好同时发起两个 session-blind CAS MCP 调用，Runtime 本身无法在请求抵达后重新区分它们。

V2 不为这一极端情况增加 Host-specific `toolCallId` correlation。

这是弱 Host 模式明确的能力边界。

---

## 六、运行时 Session 与 Execution 归属的时间解耦

弱 Host 中存在两个不同性质的 Session 状态。

一个是：

```text
Runtime current_session
```

它描述当前哪个 Host Session 拥有这个 `(host, workspace)` 的 CAS 使用权。

另一个是：

```text
Execution.session_id
```

它描述某一次已经创建的 Subagent Execution 属于谁。

两者只在 Execution 创建的一刻发生联系。

例如：

```text
current_session = A
```

此时创建：

```text
Execution(T1,U1)
```

则立即固化：

```text
Execution(T1,U1).session_id = A
```

此后这条 Execution 的 Session Identity 与 Runtime 的 `current_session` 解耦。

未来即使 Runtime 已经进入：

```text
current_session = B
```

历史上的：

```text
Execution(T1,U1).session_id = A
```

也绝不会变化。

Execution terminal 时，Mailbox 继续继承这个已经固化的标签：

```text
Execution(T1,U1).session_id = A
              ↓ terminal
Mailbox(T1,U1).session_id = A
```

terminal 时不重新读取 `current_session`。

因此：

```text
current_session
→ 决定未来新进入 CAS 的调用属于谁

Execution.session_id
→ 记录已经创建的 Subagent Execution 属于谁
```

前者是运行时状态，可以切换；

后者是历史事实，一经写入不再变化。

### Idle Thread 的跨 Session 复用

由于 Thread 本身没有永久 Session 所有权，因此一个 Thread 在回到 idle 状态后，可以被之后取得 CAS 使用权的其他 Session 继续使用。

例如：

```text
Session A

T1 / U1
→ Execution(T1,U1).session_id = A
→ terminal
→ Mailbox(T1,U1).session_id = A
```

此时 T1 已经 idle。

随后：

```text
current_session = B
```

Session B 可以：

```text
send(T1)
```

产生新的：

```text
Execution(T1,U2).session_id = B
```

于是同一个 Thread 上可以合法出现：

```text
T1/U1 Mailbox → session A → pending

T1/U2 Execution → session B → active
```

这不会造成串线，因为 Session 归属附着在具体 Execution 及其 Completion 上，而不是附着在整个 Thread 生命周期上。

### 懒切换

A 的最后一个 Execution terminal 后，不要求 Runtime 主动执行：

```text
current_session = null
```

可以继续保留：

```text
current_session = A
```

真正决定 A 是否仍占用 CAS 的，是：

```text
active_execution_count(A)
```

当另一个 Session B 下一次进入 `PreToolUse`：

```text
current_session = A
active_execution_count(A) = 0

→ current_session = B
```

因此 Session 切换由下一次实际竞争触发，而不依赖一个必须可靠执行的 release 事件。

### Runtime 崩溃恢复

`current_session` 是 persisted routing state，不是持久历史事实；重启时**不得先清空再重建**，而是按以下规则校验/修复：

如果 Runtime 在 A 仍有 active Execution 时重启，持久化 Execution 是权威事实：

```text
Execution E1 → host H / workspace W / session A / active
Execution E2 → host H / workspace W / session A / active
```

该 HostScope 只有唯一 active Session：

```text
→ 校验 / 修复 current_session 为 A
```

`current_session` 与唯一 active Execution 不一致时，以 active Execution 为准自动修复。

如果该 `(host, workspace)` 已经没有 active Execution：

```text
→ 保留已有 current_session
```

它只是 stale routing state，不构成占用；下一次合法 `PreToolUse` 按正常 lazy handoff 规则切换。保留而非清空，是为了避免"PreToolUse 刚建立 Session A → Server idle shutdown / restart → 随后 MCP request 到达 → Session Identity 被错误丢失"。

在弱 Host 正常不变量下，同一个 `(host, workspace)` 的所有 active Execution 应属于同一个 Session。

如果恢复时发现：

```text
Execution E1 → session A → active
Execution E2 → session B → active
```

说明弱 Host 的唯一 Session 不变量已经被破坏，该 HostScope control plane fail closed。conflict 是派生状态（由 activeSessionSet 实时计算，不落永久 flag）：active Session 集合随 Execution terminal 重新收敛到 ≤1 后自动恢复；收敛为空集时，下一次合法 `PreToolUse` 再建立/切换 Session。

---

## 七、Mailbox：统一的 Completion 事实源

所有 terminal Completion 都进入同一个逻辑 Mailbox。

不存在 Direct Queue、Hook Queue、Web Queue 或按 Session 拆开的多份结果队列。

Mailbox row 与一次 terminal Execution 对应：

```text
(thread_id, turn_id)
```

核心数据结构可以表示为：

```text
completion_id

thread_id
turn_id

host
workspace
session_id

terminal_status
payload

delivery_state
delivery_id
delivery_started_at
delivered_at
created_at
```

Mailbox 同时记录两个完全正交的维度：

```text
session_id
→ 静态归属维度

delivery_state
→ 动态投递维度
```

前者回答：

> 这个结果属于哪个 Session？

后者回答：

> 这个结果现在处于哪一种投递状态？

两个维度互不决定，也不互相修改。

### Terminal 持久化事务

Execution terminal 后，Mailbox 建立和 Execution 从 active 集合退出必须形成同一个原子事务。

逻辑为：

```text
Execution terminal
      ↓
BEGIN TRANSACTION
      ↓
INSERT Mailbox row
并继承 Execution.session_id

同时

删除 / 终结对应 active Execution
      ↓
COMMIT
```

只有事务成功提交以后，系统才同时认为：

```text
该 Completion 已 durable 存在
AND
该 Execution 已退出 active 集合
```

随后该 Session 的：

```text
active_execution_count
```

才真正减少。

如果这恰好是旧 Session 的最后一个 active Execution，也只有在该事务成功提交以后，另一个 Session 才允许接管。

因此不会出现：

```text
旧 Session 已被认为空闲
新 Session 已经接管
但旧 Session 最后一条 Completion 尚未持久化
```

这样的中间状态。

---

## 八、Mailbox 的静态维度：Session 归属与回流隔离

Mailbox 的：

```text
(host, workspace, session_id)
```

是 Completion 的静态目标 Session。

这个标签来自对应 Execution：

```text
Execution(T1,U1)
host = H
workspace = W
session_id = A

        ↓ terminal

Mailbox(T1,U1)
host = H
workspace = W
session_id = A
```

一旦 Mailbox row 创建，这组归属字段不再改变。

因此可以出现：

```text
current_session = B

Mailbox:
C1 → session A → pending
C2 → session A → pending

Execution:
E3 → session B → active
```

这完全合法。

A 的历史 Completion 不会因为 B 接管 CAS 而改成 B，也不会继续占用 CAS 使用权。

### 主动回流

Host Hook 自身能够得到真实的 Host Session ID，因此主动回流直接按照 Mailbox 的静态归属查询：

```text
Hook {
    host = H
    workspace = W
    session_id = A
}
        ↓
Mailbox
WHERE
    host = H
    workspace = W
    session_id = A
    delivery_state = pending
```

因此：

```text
Hook A
→ 只能领取 A 的 Completion

Hook B
→ 只能领取 B 的 Completion
```

Runtime 当前正在服务哪个 Session 与此无关。

即使：

```text
current_session = B
```

A 仍可以通过自己的 Hook 收到之前留下的 pending Completion。

### Direct Wait

弱 Host 的 MCP request 不携带 Session ID，因此 Direct Wait 使用 Runtime 当前已经建立的 SessionContext。

若：

```text
current_session = B
```

则 `wait` 只能 claim：

```text
host = H
workspace = W
session_id = B
```

对应的 Mailbox record。

因此 B 不会把 A 留下的 pending Completion claim 成自己的 direct result。

### Runtime-independent 回流

TerminalResult durable COMMIT 到 Mailbox 后：

```text
Execution terminal
↓
Mailbox(session=A) COMMIT
```

主动回流已经不再依赖 Runtime 内存。

即使随后 Runtime Server 退出：

```text
Runtime crash
```

Hook 仍然可以使用：

```text
Host 自身的 session_id
+
SQLite Mailbox
```

完成：

```text
查找
→ claim
→ delivery
→ ACK
```

因此 Mailbox 的静态 Session 标签使主动回流继续保持完整的旁路独立性。

---

## 九、Mailbox 的动态维度：Delivery 状态与投递竞争

Mailbox 的 `delivery_state` 独立描述一条 Completion 当前由哪种投递路径占用。

状态保持现有模型：

```text
pending
claimed_direct
claimed_hook
delivered
```

其基本竞争关系为：

```text
                 wait claim
             ┌──────────────→ claimed_direct
             │
pending ─────┤
             │
             └──────────────→ claimed_hook
                 Hook/Web claim
```

成功投递并 ACK：

```text
claimed_direct ─┐
                ├→ delivered
claimed_hook ───┘
```

claim 失效或投递未完成时，可以重新回到：

```text
pending
```

整个过程中：

```text
session_id
```

保持不变。

因此：

```text
session_id
= Completion 的静态目标 Session

delivery_state
= Completion 当前的动态投递占用状态
```

这两个字段在数据模型上完全正交。

### 单 Completion 的唯一投递权

每一条：

```text
(thread_id, turn_id)
```

对应的 Completion，在任意时刻只能存在一个有效 Delivery Claim。

因此：

```text
pending → claimed_direct
```

和：

```text
pending → claimed_hook
```

必须通过原子 claim 竞争。

如果 Direct Wait 已经成功 claim：

```text
claimed_direct
```

Hook/Web 就不能同时获得同一 Completion。

反之亦然。

只有当前 claim 失败、过期或被明确释放以后，记录才允许重新进入：

```text
pending
```

并参加下一次投递竞争。

### ACK

Claim 只代表某条 Delivery Path 暂时取得投递权，不代表结果已经成功交付。

真正完成需要 ACK：

```text
claim
↓
delivery
↓
ACK
↓
delivered
```

如果没有收到可靠 ACK，则不能永久认为该 Completion 已经完成投递。

这保证一个 Turn 的最终结果只有一个有效投递槽位，同时仍然允许投递失败后的恢复。

### Wait 在 terminal 之后到达

Execution 已经 terminal：

```text
Mailbox {
    session_id = A
    delivery_state = pending
}
```

之后 Session A 的 `wait` 可以原子完成：

```text
pending → claimed_direct
```

所以 `pending` 并不表示“这个结果已经决定走主动回流”。

它只表示：

> 当前还没有任何投递路径 claim 这条 Completion。

### Wait 在 terminal 之前到达

如果 Execution 仍在运行时已经有 Direct Wait 建立 reservation：

```text
Execution(T1,U1)
reservation = direct
```

那么 terminal 时仍然产生同一条 Mailbox record，只是初始状态直接成为：

```text
Mailbox(T1,U1) {
    session_id = A
    delivery_state = claimed_direct
}
```

因此无论 Direct Wait 什么时候出现，所有 terminal result 始终进入同一个 Mailbox。

不存在“入 Mailbox 之前按投递方式分流”的第二套路径。

---

## 十、Fail-Closed 与自动恢复

所有设计文稿中的 `fail closed` 统一遵循：

> **Fail closed 只阻止当前无法安全裁决的操作。只要 durable lifecycle facts 再次形成唯一可信答案，CAS 必须自动恢复。**

正常运行时不得要求用户手工修改 SQLite、手工删除 conflict flag、手工清理 ownership row。只有真正的 SQLite physical corruption / unrecoverable schema corruption 才属于人工维修路径。

### Recovery Matrix

| 状态 | 当前行为 | 权威事实 | 自动恢复 |
|---|---|---|---|
| Weak Host 无 `current_session` | `session_not_established` | 下一次合法 Host Session Identity | 下一次 `PreToolUse(CAS tool)` 建立 Session |
| Hook 缺必要 `session_id` | 本次拒绝 claim / admission | 下一次合法 Hook payload | 下一次调用自然恢复 |
| 同一 Weak `(host,workspace)` 出现多个 active Session | HostScope control plane fail closed | active Executions | active Session 集合重新收敛到 ≤1 |
| `current_session` 与唯一 active Execution 不一致 | 自动修复 | active Execution | 校验时修正 |
| stale Thread Hold 且无 active Execution | **不是错误** | Presence + Execution | `send` lazy takeover |
| Thread Hold 与唯一 active Execution.host 不一致 | 自动修复 Hold | active Execution | 当次事务修正 |
| 同一 Thread 出现不同 Host 的冲突 active Execution | Thread fail closed | active Executions | Execution 集合重新收敛 |
| Server 型 Host 没有 active Server | 不执行 Web push | Server availability | 唯一 Server 出现后恢复 |
| Server 型 Host 出现多个 active Server | `multiple_active_host_servers` | Server availability | 恢复到唯一 Server |
| 未知 Host | 拒绝调用 | Host Registry | 使用合法 Host ID |
| delivery claim 进程异常消失 | 暂时不可重新领取 | delivery lease | lease expiry 后 requeue |

### Conflict 尽量是派生状态

不要为了方便增加永久 `conflicted = true` 标记然后依赖额外清理路径。例如 Weak Host Session conflict 应根据 `activeSessionSet(host, workspace)` 实时派生：

```text
size = 0
→ no active owner

size = 1
→ unique active owner

size > 1
→ invariant conflict
```

Execution terminal 后：

```text
{A, B}
→ {B}
```

则自然恢复为唯一 Session。如果：

```text
{A, B}
→ {}
```

则 conflict 自然消失，下一次合法 PreToolUse 再建立/切换 Session。

### Thread 状态异常时的权威顺序

Thread Hold 是 control state，Active Execution 是 lifecycle truth。若 `thread_holds(T1).holder_host = zcode` 但唯一 active Execution 为 `T1/U1 host = kimi-code`，则 Execution.host 优先，允许在事务中自动修复 Hold 为 `holder_host = kimi-code`。同一 Thread 出现不同 Host 的冲突 active Execution 时，Thread fail closed，直到 durable Execution facts 重新收敛。stale Thread Hold + 无 active Execution 是正常 takeover 条件，不是异常。

---

## 十一、V3 的升级边界

V2 弱 Host 的特殊逻辑集中在 SessionContext 的来源：

```text
PreToolUse
+
current_session 状态机
+
单 Session CAS 使用约束
```

强 Host 在 V3 中改为：

```text
MCP request
直接携带可信 session_id
        ↓
SessionContext
```

因此强 Host 不再需要唯一 `current_session`，可以同时存在：

```text
E1 → session A → active
E2 → session B → active
E3 → session C → active
```

Execution 与 Mailbox 已经具备这种 per-session 数据表达能力，因此 Mailbox 数据结构和投递状态机不需要重做。

Thread 本身仍不建立永久 Session owner。

但强 Host 一旦允许多个 Session 并发，需要增加一条运行期控制面规则：

> 某个 Thread 当前存在 active Execution 时，该 Thread 的 CAS 控制面只对该 Execution 所属 Session 可见、可操作。

例如：

```text
Thread T1

Execution(T1,U3)
session=A
active
```

此时 Session B 对 T1 的控制面应完全不可见或不可操作。

当 U3 terminal、T1 回到 idle 后，这个临时限制解除。

因此 V3 新增的是：

```text
active Execution
→ 临时决定 Thread 的控制面可见 Session
```

而不是：

```text
Thread
→ 永久绑定某个 Session
```

这与 V2 的 idle Thread 跨 Session 复用语义保持一致。