# CodexAsSubagent V2 Host 隔离、Thread Hold 与 CLI/Adapter 实施规格

## 1. 产品决策

本章定义本轮升级最终应呈现的产品行为。后续数据结构和接口协议均只用于实现这些行为，不得反向改变本章语义。

### 1.1 两类归属必须严格区分

CAS 中存在两种性质完全不同的 Host 归属。

#### Execution / Completion：永久历史归属

每次 Execution 创建时固化：

```text
host
workspace
session_id
```

Execution terminal 后，Completion / Mailbox 原样继承。

这些字段回答：

> 这一次具体执行是谁发起的，以及结果应该回到哪里？

因此属于 immutable provenance。

例如：

```text
T1/U1
Execution:
  host = kimi-code
  session = A

↓ terminal

Completion:
  host = kimi-code
  session = A
```

即使之后 T1 被 ZCode 接管，这条 U1 Completion 仍然永久属于 Kimi A。

---

#### Thread：临时 Host 控制权

Thread 不永久属于创建它的 Host。

Thread 只具有：

```text
Temporary Host Hold
```

它回答：

> 当前哪个 CAS Host 正在控制这个长期 Codex Thread？

例如：

```text
T1
holder = kimi-code
```

只表示当前 Kimi Code 对 T1 拥有 CAS 控制权。

当 Kimi 对当前 Workspace 不再活跃，而且 T1 没有 Kimi 的 active Execution 后，这个 Hold 失效。

之后：

```text
zcode
```

可以接管同一个 T1。

因此：

```text
Execution / Completion host
→ 永久

Thread holder
→ 临时，可失效，可接管
```

不得实现永久 Thread Host Ownership。

---

### 1.2 Thread Hold 的产品语义

Thread Hold 以：

```text
thread_id
→ holder_host
```

表达当前控制方。

但是数据库中存在 Hold row，并不代表 Hold 一定仍然有效。

Hold 是否有效取决于：

```text
holder Host 是否仍 active
```

以及：

```text
该 Thread 是否仍存在 holder Host 的 active Execution
```

有效性规则固定为：

```text
Thread 有 active Execution
→ Execution.host 拥有最高优先级控制权

Thread 无 active Execution
→ 检查 thread_holds

holder Host Presence alive
→ Hold 有效

holder Host Presence stale / missing
→ Hold 可被其他 Host lazy takeover
```

因此：

```text
active Execution
```

比 Presence 更强。

即使 Kimi MCP 进程异常退出，Presence lease 已经过期，只要：

```text
T1/U1 host = kimi-code
仍 active
```

ZCode 就绝不能接管 T1。

---

### 1.3 Host Presence

Host 是否 active，以：

```text
(host, workspace)
```

范围内是否存在至少一个有效 MCP instance lease 为准。

一个 MCP Bootstrap 进程对应一个 Presence instance。

固定数据模型：

```text
host_presence {
    host
    workspace
    instance_id
    heartbeat_at
    expires_at
}
```

主键：

```text
(host, workspace, instance_id)
```

默认参数固定为：

```text
heartbeat interval = 20 seconds
lease duration      = 60 seconds
```

MCP Bootstrap：

```text
启动并完成 workspace canonicalization
→ attach Presence

每 20 秒
→ heartbeat

正常退出
→ best-effort detach
```

异常退出不要求可靠执行 detach。

60 秒 lease 到期后自动视为 inactive。

同一个：

```text
(host, workspace)
```

可以存在多个 MCP instance。

只要其中任意一个：

```text
expires_at > now
```

该 Host Namespace 就仍然 active。

---

### 1.4 Presence 不通过 Runtime Server heartbeat

Presence heartbeat 必须由：

```text
codex-as-subagent mcp
```

Bootstrap 进程直接更新共享 SQLite。

不得每 20 秒向 Runtime Server 发 heartbeat RPC。

原因是 Runtime Server 本身支持 idle shutdown；Presence 不应因为 heartbeat 而强迫 Server 永久在线。

因此：

```text
MCP Bootstrap
→ SQLite host_presence

Runtime Server
→ 按需启动 / idle shutdown
```

两者生命周期解耦。

---

### 1.5 Thread Hold 不单独 heartbeat

Thread Hold 不拥有自己的 lease。

固定表结构：

```text
thread_holds {
    thread_id
    workspace
    holder_host
    hold_id
    acquired_at
    updated_at
}
```

其中：

```text
thread_id
```

为主键。

`hold_id` 为每次新 acquire / takeover 生成的随机唯一 ID，用于安全释放本次取得的 Hold。

Hold 是否仍有效统一通过：

```text
host_presence(holder_host, workspace)
```

判断。

因此一个 Kimi MCP heartbeat 可以维持该 Workspace 下 Kimi 当前持有的所有 idle Threads。

不得给每个 Thread 启动单独 heartbeat。

过期 Hold 不需要后台定时清理。

在其他 Host 实际访问 Thread 时 lazy 判断即可。

---

### 1.6 Thread Hold 的取得

Thread Hold 只有两个正式取得入口：

```text
spawn
send
```

#### spawn

`spawn` 成功创建新的 Codex Thread，并准备启动第一 Turn 时，当前 Host 成为 holder。

如果 Thread / Turn 创建最终失败，不得把一个失败创建流程留下的新有效 Host Hold。

---

#### send

`send(T1)` 是 idle Thread 的正式 takeover 入口。

进入 per-thread serialization 后执行：

```text
1. 检查 active Execution

2. 检查当前 Thread Hold

3. 判断旧 holder 是否仍 active

4. 必要时 acquire / lazy takeover

5. 调用 Codex startTurn
```

同一 Thread 的两个 `send` 必须串行执行。

现有 Runtime 中的 per-thread lock 继续作为这一流程的进程内串行化边界。

---

### 1.7 `send` 的精确判定算法

调用者：

```text
callerHost = H
thread = T
```

进入 T 的 per-thread lock 后：

#### 情况 A：存在 active Execution，且 Execution.host == H

返回现有：

```text
thread_busy
```

语义不变。

---

#### 情况 B：存在 active Execution，且 Execution.host != H

返回：

```text
thread_held
```

并携带：

```json
{
  "holderHost": "<Execution.host>"
}
```

绝不能 takeover。

---

#### 情况 C：无 active Execution，且没有 Thread Hold

当前 Host acquire：

```text
holder_host = H
hold_id = new UUID
```

然后尝试启动 Turn。

---

#### 情况 D：无 active Execution，Hold 属于 H

直接继续。

不重新生成 Hold。

---

#### 情况 E：无 active Execution，Hold 属于其他 Host，且 holder Presence alive

返回：

```text
thread_held
```

并携带：

```json
{
  "holderHost": "<holder>"
}
```

---

#### 情况 F：无 active Execution，Hold 属于其他 Host，但 Presence stale

执行 lazy takeover：

```text
holder_host = H
hold_id = new UUID
```

然后尝试启动 Turn。

takeover 必须是原子的。

两个 Host 同时竞争 stale Hold 时，只允许一个 acquire 成功。

---

### 1.8 新取得 Hold 后 `startTurn` 失败

如果本次 `send`：

```text
原本没有属于 caller 的有效 Hold
```

并且本次刚刚执行了：

```text
acquire
或
lazy takeover
```

但随后 Codex `startTurn` 失败，则：

```text
DELETE thread_holds
WHERE thread_id = T
AND hold_id = 本次新生成 hold_id
```

即只释放**本次调用新取得的 Hold**。

不得误删之后已经被其他逻辑替换的新 Hold。

如果 caller 在本次调用前本来就已经拥有有效 Hold，则 `startTurn` 失败不释放既有 Hold。

---

### 1.9 CAS Host Hold 与 Codex Writer Lock 分两层

这两个概念必须保持不同的产品角色。

#### `thread_held`

表示：

> Thread 当前由另一个 CAS Host 持有。

新增错误码：

```text
thread_held
```

标准结构：

```json
{
  "code": "thread_held",
  "message": "Thread is currently held by another host.",
  "data": {
    "holderHost": "kimi-code"
  }
}
```

适用于：

```text
kimi-code
zcode
opencode
claude-code
...
```

之间的 CAS 控制权冲突。

---

#### `thread_locked`

表示：

> Codex app-server 报告该 Thread 已被另一个 Codex writer 持有。

继续沿用现有：

```text
thread_locked
```

和现有 `"already has an active writer"` 归一逻辑。

不得把 Codex 自身伪装成：

```text
holderHost = codex
```

`thread_locked` 属于 Codex Supervisor 层。

`thread_held` 属于 CAS Host Ownership 层。

两层必须保持独立。

---

### 1.10 各 Thread 操作与 Hold 的关系

#### `spawn`

创建新 Hold。

#### `send`

检查 / acquire / takeover Hold。

#### `steer`

不发生 takeover。

只能控制当前 caller 有权访问的 active Execution。

其他 Host active Execution：

```text
thread_held
```

#### `interrupt`

同 `steer`。

不发生 takeover。

#### `wait`

不取得 Thread Hold。

继续按照 Execution / Completion 已确定的 Host + Session provenance 工作。

历史 Completion 不因为 Thread 后来被其他 Host takeover 而改变归属。

#### `status`

不取得 Hold。

如果：

```text
Thread 被其他 active Host 有效持有
```

则返回：

```text
thread_held
```

如果旧 Hold 已 stale 且 Thread idle，则允许读取。

#### `read_thread`

同 `status`。

读取 Thread 不会取得控制权。

#### `list_threads`

只列出：

```text
caller Host 当前持有的 Thread
+
没有有效 Host Hold 的 free Thread
+
holder 已 stale 的 idle Thread
```

不得列出当前被其他 active Host 有效持有的 Thread。

列举本身不取得 Hold。

真正 ownership 转移只发生在：

```text
send
```

---

## 2. Host Namespace 与内部数据隔离

### 2.1 Host 是最高层 Namespace

V2 保持：

```text
1 global Runtime Server
1 shared SQLite
N Host integrations
```

不按 Host 拆数据库。

所有内部状态首先属于：

```text
host
```

然后才解释 Workspace 和 Session。

定义：

```text
HostScope =
(host, workspace)
```

定义：

```text
SessionScope =
(host, workspace, session_id)
```

例如：

```text
(kimi-code, /repo, A)
```

和：

```text
(zcode, /repo, A)
```

即使 Workspace 与 Session ID 字符串完全一致，也属于完全不同的 Namespace。

任何 Host-sensitive 查询不得只使用：

```text
workspace
```

或：

```text
workspace + session_id
```

作为隔离边界。

---

### 2.2 Canonical Host ID

正式 Host ID：

```text
kimi-code
zcode
```

后续按相同规则增加：

```text
opencode
claude-code
...
```

Host ID：

```text
MUST 由 Host integration 静态指定
MUST NOT 从 cwd 推断
MUST NOT 从 session id 推断
MUST NOT 从进程名猜测
MUST NOT 由 MCP Tool arguments 指定
```

未知 Host 必须在任何 CAS 状态读取或修改前 fail closed。

正式 Host integration 不允许静默 fallback：

```text
plain
```

Host 表示**产品类型**，不是进程或实例：

```text
Host ≠ process
Host ≠ CLI instance
Host ≠ Server instance
Host ≠ GUI window
```

同时开启多个 Kimi Code（Kimi A / B / C）仍然都是 `host = kimi-code`，它们是同一个 Host 的多个 Session。CLI 型 Host 允许 N 个实例 / N 个 Session；Server 型 Host（一个 Server 承载多个 Session）在 V2 采用环境假设：**同一 Host 产品在当前 CAS 用户环境中同时最多只有一个 CAS-active Server Instance**——支持 1 Server / N Session，明确不支持多 Server 并存与路由（当前 V2 不为多 Server 场景定义错误面；该假设属环境约束，与 Session 级单活跃 interactive instance 的产品约束相区分）。详见《Session 隔离与 Mailbox 架构设计》的环境假设章节。

---

### 2.3 Execution

V2 `executions` 增加：

```text
host
session_id
```

形成：

```text
Execution {
    thread_id
    turn_id

    host
    workspace
    session_id

    ...
}
```

创建后：

```text
host
workspace
session_id
```

全部 immutable。

建议索引：

```sql
CREATE INDEX executions_scope_idx
ON executions(
    host,
    workspace,
    session_id,
    last_activity_at
);
```

---

### 2.4 Completion / Mailbox

`completions` 同样增加：

```text
host
session_id
```

Terminal transaction 中：

```text
Execution.host
Execution.workspace
Execution.session_id
        ↓
Completion
```

必须直接继承。

不得在 terminal 时读取：

```text
current_session
```

重新计算归属。

建议 pending 索引：

```sql
CREATE INDEX completions_pending_scope_idx
ON completions(
    host,
    workspace,
    session_id,
    delivery_state,
    created_at
);
```

所有 proactive claim 使用完整：

```text
host
workspace
session_id
```

谓词。

---

### 2.5 Weak Host `current_session`

Weak Host 的状态 key 固定为：

```text
(host, workspace)
```

`current_session` 是 **persisted routing state**，持久化在共享 SQLite：

```text
current_sessions {
    host
    workspace
    session_id
    updated_at
}
```

主键：

```text
(host, workspace)
```

其含义严格限定为：

> 当前 Weak HostScope 最近一次经过合法 Session Gate 建立的 MCP routing Session。

必须明确区分：

```text
current_session
→ persisted routing state

active Execution
→ lifecycle truth
```

权威优先级：

```text
active Execution
>
current_session
```

因此 `current_session` 可以 stale；stale `current_session` 不等于 Session 正在占用 CAS。例如：

```text
current_sessions["kimi-code"]["/repo"] = A
current_sessions["zcode"]["/repo"] = B
```

两者互不影响。

不得继续使用：

```text
current_session[workspace]
```

---

### 2.6 Thread Hold 与 Host Namespace

`thread_holds` 不属于永久 provenance。

它只是 CAS 控制状态：

```sql
CREATE TABLE thread_holds (
    thread_id    TEXT PRIMARY KEY,
    workspace    TEXT NOT NULL,
    holder_host  TEXT NOT NULL,
    hold_id      TEXT NOT NULL,
    acquired_at  TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);
```

建议索引：

```sql
CREATE INDEX thread_holds_holder_idx
ON thread_holds(holder_host, workspace);
```

Thread Workspace 仍以 Codex Thread metadata 为最终事实。

`thread_holds.workspace` 用于：

```text
Presence lookup
快速一致性检查
```

不得把它解释成永久 Host ownership。

---

### 2.7 Host Presence Schema

```sql
CREATE TABLE host_presence (
    host          TEXT NOT NULL,
    workspace     TEXT NOT NULL,
    instance_id   TEXT NOT NULL,
    heartbeat_at  TEXT NOT NULL,
    expires_at    TEXT NOT NULL,

    PRIMARY KEY(host, workspace, instance_id)
);
```

索引：

```sql
CREATE INDEX host_presence_expiry_idx
ON host_presence(host, workspace, expires_at);
```

判断：

```text
isHostAlive(host, workspace, now)
```

必须等价于：

```sql
EXISTS (
    SELECT 1
    FROM host_presence
    WHERE host = ?
      AND workspace = ?
      AND expires_at > ?
)
```

过期记录可以 lazy delete。

过期记录存在本身不得被解释为 Host alive。

---

### 2.8 Store API 必须 Host-scope 化

所有 Host-sensitive Store operation 必须强制接收 Host。

Execution：

```text
createExecution({
    host,
    workspace,
    sessionId,
    threadId,
    turnId,
    ...
})
```

```text
listExecutions({
    host?,
    workspace?,
    sessionId?
})
```

面向普通 Host request 的查询必须带 `host`。

Supervisor runtime event correlation 是唯一允许按物理 Thread ID 查询 Execution 的内部例外，例如：

```text
getExecutionByPhysicalThreadId(threadId)
```

该方法只允许 trusted Supervisor event path 使用。

不得被：

```text
MCP
Hook
drain
Host request
```

调用。

---

Completion：

```text
claimPendingHook({
    host,
    workspace,
    sessionId,
    ...
})
```

```text
reserveWaiter({
    host,
    workspace,
    sessionId,
    threadId,
    ...
})
```

```text
listCompletions({
    host,
    workspace?,
    sessionId?,
    deliveryState?
})
```

Host-sensitive SQL 必须在 `WHERE` 中实际包含：

```text
host = ?
```

不得先全局读出后再在 JavaScript 中过滤。

---

### 2.9 Delivery ACK/NACK

ACK/NACK 同样属于 Host Namespace。

内部协议：

```text
delivery.ack {
    host,
    claimId
}
```

```text
delivery.nack {
    host,
    claimId
}
```

SQL（合法性条件 = delivery_state + claim_id 双条件；每次重新 claim 生成新 claim 代际）：

```text
WHERE host = ?
AND claim_id = ?
AND delivery_state IN ('claimed_waiter', 'claimed_hook')
```

不得只依赖 claim id 的全局随机性作为授权边界；旧 claimant 的迟到 ACK/NACK 不得修改新 claimant 的状态。

---

### 2.10 Recovery

Runtime Server 重启时：

#### Execution / Session recovery

active Executions 按：

```text
(host, workspace)
```

分组。

不得采用"先清空 `current_sessions` 再重建"的方式。正确规则：

某组：

```text
0 active Execution
→ 保留已有 current_session
```

它只是 stale routing state；下一次合法 `PreToolUse(CAS tool)` 按正常 lazy handoff 规则切换。这样避免 `PreToolUse` 刚建立 Session、Server 随后 idle shutdown/restart、MCP request 到达时 Session Identity 被错误丢失。

只有一个唯一 `session_id`：

```text
→ 校验 / 修复 current_session 为该 session_id
```

`current_session` 与唯一 active Execution 不一致时，以 active Execution 为权威自动修复。

同一 Weak HostScope 中存在多个不同 active Session：

```text
→ invariant violation
→ 该 HostScope control plane fail closed
```

不得任选一个。conflict 是派生状态（由 activeSessionSet 实时计算），active Session 集合重新收敛到 ≤1 后自动恢复。

但：

```text
kimi-code /repo / A active
zcode     /repo / B active
```

完全合法。

---

#### Presence / Hold recovery

`host_presence` 与 `thread_holds` 均持久化。

Runtime Server 重启：

```text
不得删除 Hold
不得重置 Presence
```

Presence 是否仍有效只根据：

```text
expires_at
```

判断。

MCP Bootstrap 仍活着时会继续直接 heartbeat SQLite。

---

### 2.11 V1 → V2：不做 Migration，破坏性重建

V1 数据缺乏可靠的：

```text
host
session_id
```

禁止猜测，也不做任何形式的迁移。

本轮明确允许：

```text
breaking change
+
destructive reconstruction
```

因此 **V1 CAS SQLite 不迁移到 V2**。不存在"V1 rows 补 host/session 后转成 V2 rows"这样的路径，也不实现 `schema_v1_live_state_not_migratable`、live-state guard、`.bak-v1` 自动备份或旧 delivered history 保留。

升级操作语义固定为：

```text
执行 V2 升级前停止旧 CAS Runtime / MCP 实例
和正在依赖旧 runtime state 的 Subagent Turn
↓
发现旧 CAS schema
↓
废弃旧 CAS runtime database state
↓
建立全新的 V2 schema
↓
正常启动
```

可以丢弃旧 executions、completions、delivery state、runtime state 与 delivered history；旧 CAS 状态不保证保留。这就是完整的 breaking-upgrade contract。

V1 不存在 Thread Hold 与 Presence，无需迁移。旧 Codex Thread 默认视为：

```text
free / unheld
```

直到某个 Host 第一次成功 `send` 并取得 Hold。

---

## 3. CLI 参数协议与 Host Adapter 解析

### 3.1 总原则

外部 Host integration 只负责提供：

```text
host identity
+
Host 原生 payload
```

CAS 外层不得要求每个 Host 把自己的 native payload 预先转换成 CAS 格式。

流程固定：

```text
Host
  ↓
--host=<host-id>
+
raw native payload
  ↓
CAS Host Adapter
  ↓
normalized internal context
  ↓
Runtime / SQLite
```

不同 Host payload 长什么样，由对应 Host Adapter 负责解析。

---

### 3.2 Host Protocol Registry

新增统一内部目录：

```text
src/hosts/
    registry.mjs
    kimi-code.mjs
    zcode.mjs
```

Registry：

```text
getHostAdapter(hostId)
```

未知 Host：

```text
UnknownHostError
```

必须在读取 CAS 数据前失败。

每个 Adapter 至少实现：

```text
parseHookInvocation({
    payload,
    env
})
```

返回统一：

```text
{
    sessionId,
    cwd,
    event,

    toolName?,
    toolInput?,
    toolCallId?
}
```

Host Adapter 只负责 native 字段提取。

Workspace canonicalization 统一由：

```text
WorkspaceGuard
```

执行。

最终形成：

```text
HookContext {
    host,
    workspace,
    sessionId,
    event,

    toolName?,
    toolInput?,
    toolCallId?
}
```

---

### 3.3 Adapter 的代码归属

Host parser 属于 CAS Runtime package。

不得把 Session 解析逻辑复制到：

```text
plugins/kimi-code
plugins/zcode
```

插件只负责启动正确命令。

但是 Host Adapter 必须是无状态共享模块。

原因是 Hook proactive delivery 在 Runtime Server 不在线时仍然要：

```text
Hook process
→ 本地调用 Host Adapter
→ 得到 SessionContext
→ 直接读取 SQLite
```

所以：

```text
Host Adapter 属于 Runtime/Core 代码
```

不等于：

```text
必须由常驻 Runtime Server 进程执行
```

---

### 3.4 `serve`

接口：

```text
codex-as-subagent serve
    [--data-dir PATH]
    [--socket PATH]
    [--lock PATH]
    [--idle-shutdown-ms N]
```

不得接受：

```text
--host
--workspace
--session
```

`serve` 是全局共享 Runtime。

---

### 3.5 `mcp`

正式接口：

```text
codex-as-subagent mcp
    --host <HOST>
    [--data-dir PATH]
    [--socket PATH]
    [--lock PATH]
```

`--host` 必填。

Workspace 来源：

```text
MCP process cwd
→ WorkspaceGuard
→ canonical workspace
```

Workspace 成功解析后：

```text
instanceId = UUID
```

注册：

```text
host_presence(host, workspace, instanceId)
```

并启动 heartbeat。

只有 Presence 注册成功后才开始正式处理 MCP 调用。

退出时 best-effort detach。

MCP 向 Runtime 转发的 context 从现有：

```text
{
    workspace
}
```

升级为：

```text
{
    host,
    workspace
}
```

Weak Host Session Identity 不放进 CLI 参数。

由既有：

```text
current_session(host, workspace)
```

机制解析。

MCP 暴露给模型的 10 个 Tool schema不因本轮升级改变。

---

### 3.6 `hook`

正式接口：

```text
codex-as-subagent hook
    --host <HOST>
    [--data-dir PATH]
    [--socket PATH]
    [--lock PATH]
```

外层只显式提供：

```text
host
```

不得增加：

```text
--session
```

正式 Host integration 也不得通过：

```text
--workspace
```

覆盖 native payload。

Hook 原始 payload 通过 stdin 原样进入 CAS。

`cli/hook.mjs` 固定流程：

```text
read --host
↓
read raw stdin payload
↓
getHostAdapter(host)
↓
adapter.parseHookInvocation(rawPayload, env)
↓
WorkspaceGuard.resolve(parsed.cwd)
↓
HookContext
↓
Hook Core
```

`cli/hook.mjs` 自身不得再直接读取：

```text
payload.session_id
payload.hook_event_name
payload.tool_name
...
```

任何 Host-native 字段名只能出现在：

```text
src/hosts/<host>.mjs
```

中。

---

### 3.7 Kimi Adapter

Kimi Host Adapter 当前解析：

```text
payload.session_id
→ sessionId

payload.cwd
→ cwd

payload.hook_event_name
→ event

payload.tool_name
→ toolName

payload.tool_input
→ toolInput

payload.tool_call_id
→ toolCallId
```

缺失非当前 Hook 类型所需的 optional 字段可以忽略。

但是正式 Kimi Session-sensitive Hook 缺少：

```text
session_id
```

时：

```text
不得执行 Mailbox claim
不得 fallback workspace-only
不得从 current_session 伪造 Hook Session
```

---

### 3.8 ZCode Adapter

ZCode 使用自己的 native Hook payload / Hook environment。

外部仍然只调用：

```text
codex-as-subagent hook --host=zcode
```

ZCode Adapter 负责把：

```text
native session id
native cwd
native event
native call id
```

统一转换成内部 HookContext。

不得为了统一 Kimi 字段名而要求 ZCode plugin 改写 payload。

---

### 3.9 `drain`

`drain` 没有 Host native callback payload。

因此它作为显式低层接口，完整指定目标 Namespace：

```text
codex-as-subagent drain
    --host <HOST>
    --workspace <PATH>
    --session <SESSION_ID>
    [--data-dir PATH]
```

三项身份全部必填。

`drain` 直接构造：

```text
DeliveryContext {
    host,
    workspace,
    sessionId
}
```

然后调用统一 Mailbox Core。

V2 后 `drain` 不再只是：

```text
hook()
```

的简单 alias。

它不得执行 workspace-only drain。

---

### 3.10 `thread_held` 实现位置

新增：

```text
ERROR_CODES.THREAD_HELD = "thread_held"
```

并提供统一：

```text
ThreadHeldError(holderHost)
```

或等价 factory。

固定：

```json
{
  "code": "thread_held",
  "message": "Thread is currently held by another host.",
  "data": {
    "holderHost": "kimi-code"
  }
}
```

不得在各个 Runtime operation 中手工拼接不同 message。

现有：

```text
thread_locked
```

继续只由 Codex writer-lock 归一逻辑产生，不改变现有含义。

当前仓库已经将 `"already has an active writer"` 专门归一为 `thread_locked`，这一现有行为继续保留。

MCP/内部错误投影必须保留：

```text
error.data
```

否则 `holderHost` 会在公开结果中丢失。

---

### 3.11 废除的 legacy Kimi Web 接口

当前代码中的：

```text
kimi-web --attach
kimi-web --detach
kimi-web --worker

detached worker
worker registry
SQLite polling
kimi-code-web
Runtime 内部事件驱动 Web delivery
（2026-09-12 收口：连同 src/core/web-delivery.mjs /
  src/core/kimi-web-client.mjs 及其测试一并删除归档）
```

均属于未经本规格授权的 legacy implementation，只能作为 legacy code to remove / replace 处理。当前 V2 的唯一主动 Mailbox delivery transport 是 Hook；Web Push 不进入当前版本，未来重做时不以旧实现为地基。V2 正式入口固定为：

```text
serve
mcp
hook
drain
```

不得存在 `kimi-web` 作为第五套正式运行接口，不得保留常驻轮询 worker 架构，不得把任何 Web transport 能力暴露为公开 CLI 控制面。禁止根据现有 legacy 代码反推产品设计；当前代码与规范冲突时，修改代码以符合规范。

### 3.12 建议文件职责

```text
src/hosts/registry.mjs
→ Host registry
```

```text
src/hosts/kimi-code.mjs
→ Kimi native payload parser
```

```text
src/hosts/zcode.mjs
→ ZCode native payload parser
```

```text
src/cli/mcp.mjs
→ --host
→ Presence lifecycle
```

```text
src/cli/hook.mjs
→ --host + raw payload
→ Host Adapter
```

```text
src/cli/drain.mjs
→ explicit HostScope + Session
```

```text
src/mcp/stdio-bootstrap.mjs
→ context = {host, workspace}
→ Presence helper lifecycle
```

```text
src/core/runtime-manager.mjs
→ Thread Hold enforcement
→ lazy takeover
→ thread_held
```

```text
src/adapters/sqlite/sqlite-store.mjs
→ host_presence
→ thread_holds
→ Execution / Completion HostScope
```

```text
src/server/recovery.mjs
→ Host-scoped active Session recovery
```

---

### 3.13 必须通过的验收场景

```text
Kimi /repo/A active
ZCode /repo/B active
→ 可同时使用 CAS
```

```text
Kimi Completion
ZCode Hook 先触发
→ ZCode 不可 claim
```

```text
Kimi A Completion
Kimi B Hook 先触发
→ B 不可 claim
```

```text
T1 holder=Kimi
Kimi Presence alive
ZCode send(T1)
→ thread_held
→ data.holderHost = kimi-code
```

```text
T1 holder=Kimi
Kimi Presence expired
T1 无 active Execution
ZCode send(T1)
→ lazy takeover
→ 正常 send
```

```text
T1 holder=Kimi
Kimi Presence expired
但仍存在 Kimi active Execution
ZCode send(T1)
→ thread_held
```

```text
ZCode takeover 后
旧 Kimi Completion 仍 pending
→ Completion 仍只能返回原 Kimi Session
```

```text
CAS Hold 不冲突
但 Codex App 持有物理 Thread writer lock
→ thread_locked
→ 不变成 thread_held
```

```text
同一 stale Thread
Kimi 与 ZCode 同时 send
→ 只有一个成功 acquire
```

```text
新 acquire 后 startTurn 失败
→ 只释放本次 hold_id 对应的新 Hold
```

```text
status/read_thread
访问其他 active Host 当前持有的 Thread
→ thread_held
```

```text
list_threads
→ 不显示其他 active Host 当前持有的 Thread
→ 可显示 free / stale-held idle Thread
```

```text
Hook payload 缺 Session ID
→ 不进行 workspace-only Mailbox claim
```

```text
未知 --host
→ 在读取或修改 CAS 状态前失败
```

```text
错误 Host + 正确 claimId 执行 ACK
→ 不得 ACK

旧 claimant 的迟到 ACK/NACK（claim 已更换后代际）
→ 不得修改新 claimant 的状态
```

```text
Runtime Server idle shutdown
→ MCP Presence heartbeat 继续
→ 不因为 heartbeat 唤醒 Runtime Server
```

以上行为均属于本轮 V2 的验收条件，不作为实现建议或可选方案。