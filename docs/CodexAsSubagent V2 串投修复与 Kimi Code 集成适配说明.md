# CodexAsSubagent V2 串投修复与 Kimi Code 集成适配说明

## 一、上一轮串投 Bug 与 V2 修复

上一轮已经分别在 Kimi Web 和 ZCode 中确认了同 Workspace 跨 Session 的 Completion 串投问题。

两种现象的直接触发方式不同，但底层缺陷一致：

```text
V1 Completion
只有 workspace 归属

主动消费者 claim 时：
workspace = W
AND delivery_state = pending
```

Completion 没有 Host 和 Session 级的不可变目标身份，因此同一 Workspace 下的其他消费者可以抢到并不属于自己的结果。

### Kimi Web

旧实现中，每个 Web Session 会启动一个独立 worker。

worker 自己知道目标 Kimi Session：

```text
worker.session_id = B
```

并且最终向 Kimi Server API 投递时，也确实会使用这个 Session ID：

```text
/api/v1/sessions/B/...
```

真正的问题发生在此之前。

旧 worker 从 SQLite 领取 Completion 时，仅按照 Workspace 查询：

```text
workspace = W
delivery_state = pending
```

因此可能发生：

```text
Execution 属于 Session A
        ↓
Completion A → pending
        ↓
旧 Session B 的 worker 先轮询到
        ↓
B worker claim Completion A
        ↓
B worker 再正确调用 /sessions/B/...
        ↓
A 的结果被精确定向发送进 B
```

所以 Kimi Server API 的 Session 定向本身没有错误。

错误发生在：

> **Completion 被哪个消费者领取。**

上一轮还发现 detached Web worker 会在 Host Session 消失以后继续存活，形成孤儿 worker，并持续按照 Workspace 抢 Completion。这进一步放大了该问题。

### ZCode

ZCode 没有 Kimi Web 那条 detached worker 路径，但同样存在 Mailbox claim 缺少 Session 条件的问题。

已经在干净 Workspace 中复现：

```text
Session A
→ 启动 Subagent
→ Completion A pending

Session B
→ 触发自己的 Hook
→ B Hook 先执行 claim
→ Completion A 被注入 B
```

即使 A 自身仍然存活，结果依然可以被 B 领取。

因此旧行为实际是：

> 同一 Workspace 下，哪个 Hook 先触发，哪个 Hook 就可能领走 pending Completion。

---

## 二、V2 如何结构性消除这两个 Bug

V2 中，每次 Execution 创建时都会固化完整 Session Identity：

```text
host
workspace
session_id
```

Execution terminal 后，Mailbox 直接继承：

```text
Execution.session_id
        ↓
Mailbox.session_id
```

因此一条 Completion 从进入 Mailbox 开始，就已经拥有不可变的目标身份：

```text
Mailbox {
    host
    workspace
    session_id
    ...
}
```

所有主动回流消费者都必须按照完整身份 claim：

```text
host = H
workspace = W
session_id = S
delivery_state = pending
```

于是 Kimi Web 中：

```text
Completion A
→ session_id = A
```

Session B 的 Web 投递器只能查询：

```text
session_id = B
```

因此 B 根本无法 claim A 的结果。

ZCode 同理：

```text
B Hook
→ Hook 原生 session_id = B
→ 只能 claim Mailbox(session=B)
```

A 的 Completion 对 B 不可见。

所以两个旧 Bug 都在：

```text
claim
```

这一层被直接阻断，而不是等到最终投递阶段再纠正。

这也同时解决跨 Host 干扰：

```text
Kimi / Workspace W / Session A
ZCode / Workspace W / Session A
```

即使 Workspace 和 Session 字符串碰巧相同，只要 Host 不同，就是完全不同的 Mailbox 路由域。

因此 V2 的修复属于数据模型和 claim predicate 的结构性修复，而不是 Kimi/ZCode 各自增加特殊判断。

---

# 三、Kimi Code TUI 模式集成

Kimi TUI 已经使用 `PreToolUse` 承担主动 Completion 回流。

V2 又需要利用 `PreToolUse` 获得真实 Kimi `session_id`，并实施弱 Host CAS Session 门禁。

两个职责应复用同一个 CAS `PreToolUse` 入口，并固定执行顺序：

```text
PreToolUse
    ↓
① Mailbox 主动回流
    ↓
② CAS Session 门禁
```

## 1. Mailbox 主动回流优先

Hook 首先使用自己携带的：

```text
host
workspace
session_id
```

查询 Mailbox。

如果存在：

```text
delivery_state = pending
```

的当前 Session Completion，则：

```text
claim → claimed_hook
↓
veto 当前 Host 工具
↓
注入 Completion
```

本次 `PreToolUse` 到此结束，不执行 Session 门禁。

这样可以保证历史 Completion 回流与当前 CAS 使用权完全解耦。

例如：

```text
current_session = A
A 仍有 active Execution

B 有历史 pending Completion
```

B 此时触发一次 `PreToolUse`：

```text
先查 Mailbox(B)
→ 找到自己的历史结果
→ 注入 B
```

不会因为 A 当前仍占用 CAS 而阻止 B 收到属于自己的历史 Completion。

同时，由于原工具已经被 veto，这次事件也不会错误触发：

```text
current_session A → B
```

的接管。

---

## 2. 没有待回流结果时再执行 CAS 门禁

如果当前 Session 没有 pending Completion，再判断本次 Host 工具是否属于 CAS MCP 工具。

普通 Host 工具：

```text
Bash
Read
Write
其他 MCP
```

直接放行。

CAS MCP 工具则进入弱 Host Session Gate：

```text
当前 Session == Hook Session
→ allow

当前为其他 Session
且旧 Session 仍有 active Execution
→ veto

当前为其他 Session
但旧 Session 已无 active Execution
→ 原子切换 current_session
→ allow
```

因此完整结构为：

```text
PreToolUse

Mailbox(current hook session) 有 pending？
├─ YES
│   → claim
│   → inject
│   → veto
│
└─ NO
    ↓
    当前工具是 CAS MCP？
    ├─ NO → allow
    │
    └─ YES
        → Session Gate
        → allow / veto
```

主动回流优先于 CAS 门禁。

---

## 3. Stop 与 UserPromptSubmit

原有 TUI fallback 链继续保留：

```text
PreToolUse
→ 主要主动回流机会

Stop
→ 当前 Turn 没有 PreToolUse 机会时 fallback

UserPromptSubmit
→ Completion 在 Turn 结束后到达时最终 fallback
```

其中：

```text
Stop
UserPromptSubmit
```

只承担 Mailbox Delivery。

Session Gate 只存在于：

```text
PreToolUse(CAS MCP tool)
```

因为只有真正准备执行 CAS 工具时，才需要决定当前 Session 是否拥有 CAS 使用权。

---

# 四、Kimi Web模式集成

Kimi Server API 本身已经提供 Session-addressed API。

Prompt 和 steer 都直接通过：

```text
/api/v1/sessions/{session_id}/...
```

寻址具体 Kimi Session。

因此 Mailbox 中固化的：

```text
session_id
```

可以直接作为 Kimi Server API 的目标 Session ID。

无需 CAS 维护第二套 Web Session mapping。

整体链路为：

```text
Execution A terminal
        ↓
Mailbox {
    session_id = A
    delivery_state = pending
}
        ↓
主动投递器 claim session=A
        ↓
Kimi Server API
/sessions/A/...
        ↓
Session A
```

这一链路不读取 Runtime 的：

```text
current_session
```

因此即使当前 CAS 使用权已经切换给 B：

```text
current_session = B
```

A 的历史 Completion 仍然会根据 Mailbox 的静态 `session_id=A` 被送回 A。

---

## 1. Prompt + Steer

Kimi 的 `steer` 操作针对已经进入目标 Session 队列的 Prompt。

因此主动回流可以采用：

```text
Completion(session=A)
        ↓
POST /sessions/A/prompts
        ↓
得到 prompt_id
        ↓
若 A 当前存在 active turn
        ↓
POST /sessions/A/prompts/{prompt_id}:steer
```

从而将 Completion 插入 A 当前正在进行的会话。

如果当前 Session 没有 active turn，则 Prompt 留在该 Session 自身的队列中，由 Kimi 正常处理。

无论是哪种情况，目标都由：

```text
Mailbox.session_id
```

唯一决定。

---

## 2. 不再使用 Workspace 盲领

Web 主动投递器必须使用完整 claim 条件：

```text
host = kimi-code
workspace = W
session_id = A
delivery_state = pending
```

不能再出现：

```text
workspace = W
delivery_state = pending
```

这样的 V1 查询。

因此即使某个旧 Session 的投递进程错误残留，它也只能尝试领取自己的：

```text
session_id
```

对应 Completion，无法再消费新 Session 的结果。

---

## 3. 回归事件驱动：Runtime 内部 Delivery

上一版 Kimi Web 实现采用：

```text
detached worker
+
周期轮询 Mailbox
```

并因此出现孤儿 worker 和 Host 生命周期脱节。`kimi-web --attach/--detach/--worker`、worker registry、`kimi-code-web` host 值与轮询架构全部废除，不得恢复或以任何变体重新引入；也不得把 Web 回流暴露为新的公开 CLI 控制面——正式入口固定为 `serve` / `mcp` / `hook` / `drain`。

V2 的 Web 主动回流是 **Runtime 内部事件驱动 delivery**：

```text
Codex terminal
↓
Runtime Server
↓
BEGIN
    INSERT Completion / Mailbox
    remove / terminalize Execution
COMMIT
↓
Completion 若仍为 pending
↓
原子 claim（pending → claimed_hook）
↓
Kimi Server API /sessions/{completion.session_id}/...
↓
成功：ACK → delivered
确定失败：NACK → pending
进程异常：delivery lease expiry → pending
```

两条硬性约束：

```text
Mailbox durable COMMIT
BEFORE
任何外部 Web API side effect
```

以及：terminal 时 Completion 已因 Direct Wait reservation 成为 `claimed_direct` 的，Web proactive path 不得再次发送。

主动投递失败不会丢失 Completion；记录仍保留在 Mailbox，按 Delivery Lease / ACK 机制恢复。除异常恢复外不得引入常驻轮询。

### Kimi Server 路由与单 active Server 假设

本轮不建立 Session → ServerInstance 映射。对 Server 型 `kimi-code`：

```text
0 active Server
→ 不执行 Web proactive delivery
→ Completion 保持 / 恢复 pending
→ 仍可通过 Direct Wait 与 TUI Hook delivery 消费

exactly 1 active Server
→ 允许通过该唯一 Server 按
  /sessions/{completion.session_id}/...
  向 Completion 自己的 Session 投递

>1 active Server
→ multiple_active_host_servers
→ 不发送，fail closed
```

尤其不能把"某 Server 能读取这个 Session"当作多 Server 环境中的目标选择算法。V2 不是解决 Multi-Server Routing，而是通过产品环境假设明确不支持它。

---

# 五、最终 Kimi 适配结构

Kimi TUI 与 Web 使用相同的 Mailbox Session Identity，但采用不同的消费入口。

### TUI

```text
Host Hook(session=A)
        ↓
Mailbox(session=A)
        ↓
claimed_hook
        ↓
Hook context injection
```

`PreToolUse` 同时承担：

```text
Mailbox 回流
→ 优先

CAS Session Gate
→ 次级
```

### Web

```text
Mailbox(session=A)
        ↓
claimed_hook
        ↓
Kimi Server API
/sessions/A/...
        ↓
Session A
```

Web 投递不经过 Runtime `current_session`，并且与控制面状态完全解耦——任何 Web routing / delivery 逻辑：

```text
不得建立 current_session
不得切换 current_session
不得清除 current_session
不得 acquire Thread Hold
不得 release Thread Hold
```

TUI 与 Web 统一为同一个 Host 产品：

```text
host = kimi-code
```

禁止 `kimi-code-web`、`kimi-code-tui` 作为 Host Namespace；TUI/Web 只是同一个 Host 的不同运行 / delivery 形态。

因此两个模式共享同一个核心不变量：

> **Execution 决定 Completion 的 Session 标签；Mailbox 保存该标签；消费者只能领取与自己 Session Identity 匹配的 Completion。**

V1 中 Kimi Web 和 ZCode 已复现的 Session 串投都因此在 claim 层被结构性排除。

Kimi TUI 的 PreToolUse 双重职责，也通过：

```text
Mailbox Delivery
→ CAS Session Gate
```

的固定顺序保持了主动回流与运行时 Session 准入之间的解耦。
