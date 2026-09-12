# Codex As Subagent × Kimi Code
## 主动回流设计定稿与集成参考知识库

**日期：2026-09-11**
**目标宿主：新版 Node.js Kimi Code**
**项目：Codex As Subagent**

> **V2 状态标注（2026-09-12 收口后）**：本文是 V1 Kimi 集成设计定稿与协议参考。其中与 Web 主动回流相关的**设计内容**（detached worker、`kimi-web --attach/--detach/--worker` CLI、worker registry、`kimi-code-web` host 值，以及 Runtime 内部事件驱动 Web delivery）已全部废除——**当前 V2 的唯一主动 Mailbox delivery transport 是 Hook**，Web Push 不进入当前版本，未来重做时按届时设计实现。TUI/Web 统一 `host = kimi-code`。本文的**协议事实部分**（Kimi Hook payload 形状、block 语义、Server instance registry、`server.token`、prompt/steer API、envelope 与幂等码）仍作为 Host Adapter 与未来 Web transport 的协议依据继续有效。

---

# 第一部分：Kimi Code 主动回流设计定稿

## 1. 设计目标

Codex As Subagent 已经具备持久化 completion buffer。Codex Subagent 完成后，TerminalResult 会首先进入 SQLite，然后由宿主适配层决定如何将结果重新送回主 Agent。

ZCode 已经通过实机验证形成了：

```text
UserPromptSubmit
PostToolUse
Stop
```

三个 Hook 的组合。

该方案是 **ZCode 专属的 Host Adapter 结论**，不构成其他 Host 的通用规范。

Kimi Code 应根据自己的 Runtime、Plugin、Hook 和 Server API 特性独立选择最佳 completion delivery 方法。

Kimi 的最终适配统一划分为两种运行模式：

```text
TUI mode
Web mode
```

其中：

- **TUI mode**：普通 `kimi` 交互式终端，Kimi Agent Runtime 直接运行在 TUI 进程内部。
- **Web mode**：由 `kimi web`、TUI `/web` 等方式启动的 Kimi Server Runtime，通过 REST/WebSocket 驱动 session。

两种模式共享同一个 Codex As Subagent MCP、CompletionStore 和 TerminalResult，仅主动回流 transport 不同。

---

## 2. 最终回流策略

以下内容为最终设计摘要，原样保留：

```text
TUI
─────────────────────────────
PreToolUse
  no pending → allow，工具正常执行
  pending    → veto 一次工具，注入 completion

Stop
  → PreToolUse 没机会触发时的 turn-end 兜底

UserPromptSubmit
  → completion 在 turn 结束后才到达时的最终兜底


Web
─────────────────────────────
Codex terminal
  ↓
submit dedicated CAS prompt
  ↓
如果 active turn 存在
  → immediately steer this prompt only
  → 跳过普通 pending queue

如果当前 idle
  → prompt 本身启动新的 turn

已发生的 user steer
  → 不重排，不越过
```

---

# 3. TUI 模式

## 3.1 为什么使用 PreToolUse

普通 Kimi TUI 目前没有向第三方 Plugin 开放一个可由外部进程直接调用的：

```text
session.steer()
context.append()
loop.notify()
```

接口。

因此，在不修改 Kimi Framework、不要求用户安装定制 Kimi 的前提下，要想让后台 Codex completion **在当前 turn 尚未结束时**进入主 Agent 上下文，`PreToolUse` 是现有公开 Plugin Hook 中最早、最稳定的可修改主流程节点。

Kimi 官方 Hook 规范明确规定：

- `PreToolUse` 在真正执行工具之前触发；
- 若 Hook block，则工具不会执行；
- 若 Hook 正常 allow，则原工具继续执行；
- Hook crash、timeout 或普通错误默认 fail-open，不阻塞工具。

因此正常情况下：

```text
PreToolUse
↓
CompletionStore 没有 pending
↓
allow
↓
原工具完全正常执行
```

不会出现“开启 PreToolUse 后每次工具都会被吞”的问题。

---

## 3.2 命中 completion 时的明确代价

当存在 pending Codex completion 时：

```text
Tool Call
   ↓
PreToolUse
   ↓
发现 pending completion
   ↓
veto 当前工具调用
   ↓
把 completion 写入 block reason
   ↓
Kimi 将 reason 返回主 Agent
```

此时当前原工具**确实不会执行一次**。

这是 TUI 模式主动回流设计接受的明确 trade-off：

> 为了在当前 turn 内及时插入后台 Subagent 结果，命中 completion 时牺牲一次即将执行的工具调用。

主 Agent 获得 completion 后，如果原工具仍有必要，需要重新发起该工具调用。

推荐注入语义明确写成：

```text
A background Codex subagent completed before this tool call was executed.

The original tool call has NOT been executed.

Process the Codex result below, then retry the same tool call if it is still needed.

<codex-completion>
...
</codex-completion>
```

避免模型误认为刚才的工具已经执行。

---

## 3.3 为什么这个代价可以接受

这种 veto 不发生在每次工具调用。

只有：

```text
CompletionStore 有 pending result
```

时才发生。

因此正常长期行为是：

```text
PreToolUse
→ no pending
→ allow
```

只有 Codex 恰好完成、而 Kimi 仍处于 active turn 中时：

```text
下一次 tool boundary
→ completion injection
```

这使 TUI 的回流延迟从：

```text
等待当前整个 turn 结束
```

降低为：

```text
等待下一次工具调用
```

对于 Coding Agent 的典型长 turn，这个差异非常明显。

---

# 4. TUI 的两个兜底层

## 4.1 Stop

如果 Codex completion 到达后，Kimi 不再调用任何工具：

```text
Codex 完成
↓
Kimi继续纯 reasoning
↓
准备结束 turn
```

则 `PreToolUse` 没有机会触发。

此时：

```text
Stop
```

承担当前 turn 的最终回流。

Kimi 官方 Hook 规范明确规定 `Stop` 是 blockable event；当模型即将结束 turn 时，如果 Stop Hook block，可以把 reason 追加给模型并让模型继续。

所以：

```text
PreToolUse 没命中
↓
Stop
↓
发现 pending
↓
注入 completion
↓
Kimi继续一次
```

---

## 4.2 UserPromptSubmit

还存在一个不可避免的 race：

```text
Stop Hook 检查
↓
此时没有 completion
↓
turn 正式结束
↓
100ms 后 Codex 才完成
```

此时已经没有 active turn。

completion 保持：

```text
pending
```

等用户下次提交消息：

```text
UserPromptSubmit
```

时注入。

Kimi 官方文档明确规定 UserPromptSubmit 的返回文本可以加入即将提交给模型的上下文。

因此 TUI 三层逻辑覆盖：

```text
Agent仍在调用工具
→ PreToolUse

Agent准备结束
→ Stop

Turn已经结束
→ UserPromptSubmit
```

---

# 5. Web 模式

## 5.1 Web 不使用 Hook 做主要 delivery

Web 模式的 Kimi Runtime 已经提供正式的 Session Server API。

由 `kimi web` 启动的本地 Server 提供：

```text
REST /api/v1
REST /api/v2
WebSocket /api/v1/ws
```

官方同时声明当前 Server API 仍为 experimental，因此集成方应优先参考运行实例提供的：

```text
/openapi.json
/asyncapi.json
```

作为当前版本 machine-readable contract。

Web 模式拥有真正的 session prompt / steer 能力，因此无需等待：

```text
PreToolUse
PostToolUse
Stop
```

发生。

Codex completion 一形成即可主动 push。

---

## 5.2 Dedicated CAS Prompt

每一个需要主动回流的 completion 应形成一个独立 Kimi prompt：

```text
CAS completion
↓
POST /api/v1/sessions/{session_id}/prompts
```

建议使用稳定的：

```text
completionId
```

派生 `prompt_id`，方便 crash/retry 情况下做幂等控制。

completion 必须独占 prompt，而不是与其他 queued user prompt 合并。

---

## 5.3 Active turn 时立即 steer

如果当前 Kimi session 正处于 active turn：

```text
CAS prompt
↓
queued
↓
POST /api/v1/sessions/{session_id}/prompts/{prompt_id}:steer
```

官方 API 将单个 queued prompt steer 到正在运行的 turn 中。

其效果是：

```text
当前 Kimi reasoning
       ↑
CAS completion
```

无需结束当前 turn。

---

# 6. Web steer 的优先级规则

## 6.1 可以越过尚未 steer 的普通 pending prompt

Kimi 内部 `AgentPromptService` 为 queued prompt 使用普通 pending queue。

调用：

```text
steer([specificPromptId])
```

时，会从 pending 中选择指定 prompt，将其移出普通队列并直接调用：

```text
loop.steer(...)
```

而没有被选择的 queued prompts 保持在 pending queue。

因此假设：

```text
Pending:
User U1
User U2
CAS C1
```

CAS 调：

```text
steer(C1)
```

之后：

```text
Active turn:
C1

Pending:
U1
U2
```

这正是我们需要的系统内部消息优先行为。

---

## 6.2 不重排已经 steer 的用户消息

如果时序已经是：

```text
t1 用户 steer U1
t2 CAS completion C1
t3 CAS steer C1
```

则 C1 不应试图倒插到 U1 前面。

Kimi 当前 `loop.steer()` 内部把 steer 形成的 nudge 按调用顺序加入 active loop；没有公开的：

```text
priority
prepend
systemPriority
steerPriority
```

机制。

因此最终规则是：

> CAS completion 优先于所有仍在普通 pending queue 中的 prompt，但不重新排序已经进入 active turn 的 steer。

这既能实现系统内部 completion 的及时性，也尊重已经发生的用户交互时序。

---

## 6.3 不使用批量 steer 强行排序

Kimi 批量 steer：

```text
POST /prompts:steer
```

支持传多个 `prompt_ids`。

但 CAS 不需要利用它处理用户 prompt。

正确策略始终是：

```text
submit CAS C1
↓
steer C1 only
```

这样 CAS completion 才具有明确且可预测的优先语义。

---

# 7. Web idle 状态

如果 session 当前没有 active turn：

```text
Codex completion
↓
submit CAS prompt
```

该 prompt 本身即可成为下一次 turn 的输入。

无需：

```text
:steer
```

因为 steer 的目标是正在运行的 active turn。

---

# 8. TUI 与 Web 的动态切换

Kimi TUI 内的：

```text
/web
```

不是“保留 TUI，再额外启动一个 Server”。

源码明确写明：

> TUI shuts down and this process becomes the server.

流程是：

```text
Kimi TUI
PID 123
Session ABC
↓
/web
↓
TUI shutdown
↓
同一个进程接管为 Kimi Server
PID 123
Session ABC
```



因此同一个 session 可以从：

```text
TUI delivery
```

动态切换成：

```text
Web active-push delivery
```

而无需改变 Codex As Subagent 的 completion data model。

---

# 9. Web 的其他启动方式

除了 TUI `/web`，Kimi 当前支持直接：

```text
kimi web
```

启动本地 Server。

也支持：

```text
kimi web --no-open
```

只运行 Server，不自动打开浏览器。

Web Server：

- 运行在当前进程；
- 默认监听 loopback；
- 可以设置 host / port；
- 多个 Server 实例可以共用同一 Kimi home；
- 端口占用时会使用后续端口。

旧：

```text
kimi server
```

命令树已经 deprecated，应使用 `kimi web`。

TUI 另外还有：

```text
/remote-control
```

其实现同样会关闭当前 TUI，然后启动本地 Server，再连接 Kimi Remote Control。

在 Codex As Subagent 的 Host Adapter 内，这些拥有本地 Kimi Server API 的运行形态统一称为：

> **Web mode**

不再另分“外部模式”。

---

# 10. 模式识别

Hook stdin 中存在：

```json
{
  "session_id": "session_abc",
  "client_type": "kimi_code_cli",
  "cwd": "/path/to/project"
}
```



但：

```text
client_type
```

不能可靠用来区分 TUI 和 Web。

External Hook runner 的 `clientType` 来自：

```text
bootstrap.clientIdentity.platform
```



而 Web Server 启动时仍沿用 Kimi Code CLI 的 host identity，仅在 Web outbound User-Agent 上增加额外 suffix。

因此：

```text
client_type == kimi_code_cli
```

不能推断：

```text
TUI
```

或：

```text
Web
```

---

## 10.1 Server instance registry

Kimi Server 会自注册：

```text
$KIMI_CODE_HOME/server/instances/<serverId>.json
```

统一 bearer token 保存：

```text
$KIMI_CODE_HOME/server.token
```

Kimi 自己的 `kimi-inspect` 使用的就是这套发现机制。

多个 Server 实例可以同时存在。

因此 CAS 可以通过：

```text
sessionId
KIMI_CODE_HOME
server instance registry
Server API
```

识别当前 session 是否属于一个 active Web Server。

mode 应视为：

```text
动态能力
```

而不是 session 创建时永久固定字段。

---

# 11. CompletionStore 与两种 delivery transport

两种模式下面仍然共享同一套 CAS completion state machine：

```text
Codex terminal
↓
Canonical TerminalResult
↓
SQLite COMMIT
↓
Host Adapter delivery
```

区别只是：

```text
TUI
→ Hook claim / block / inject

Web
→ Server API prompt / steer
```

因此不能为 Kimi Web 再维护一套独立 completion queue。

---

## 11.1 TUI delivery 成功定义

TUI：

```text
pending
↓
PreToolUse / Stop / UserPromptSubmit claim
↓
Host Hook 返回成功
↓
delivered
```

若 Hook crash 或 lease 过期：

```text
claimed_hook
→ pending
```

继续遵守 Codex As Subagent V1 的 at-least-once delivery 原则。

---

## 11.2 Web delivery 成功定义

Web：

```text
pending
↓
submit dedicated prompt
↓
如果 active：
  steer CAS prompt
↓
Kimi Server 接受
↓
delivered
```

任何网络失败、Server 切换、session owner 不确定等情况：

```text
不能 ACK delivered
```

completion 保持 pending 或恢复 pending。

如果 Web Server 在 completion delivery 前消失，而 session 后续重新以 TUI 打开，则结果仍可以由 TUI fallback Hooks 消费。

---

# 第二部分：Kimi Code 插件集成参考知识库

# 12. Kimi Code Runtime 形态

当前新版 Kimi Code 至少涉及四类与集成相关的 Runtime：

| 形态 | Runtime 在哪里 | 外部控制能力 |
|---|---|---|
| 普通 `kimi` TUI | TUI 当前进程内部 | Plugin、MCP、External Hook |
| `kimi web` | 本地 Kimi Server 进程 | REST + WebSocket + Plugin/MCP |
| TUI `/web` | TUI 结束后，同进程转成 Server | 同 Web |
| Node SDK | 调用 SDK 的第三方进程自己创建 Runtime | SDK 原生 Session API |

最重要的区别：

> Node SDK 不是一个“attach 当前 TUI”的客户端 SDK。

---

# 13. Node SDK 的真实定位

Kimi 官方 Node SDK 导出：

```text
KimiHarness
Session
createKimiHarness
SDKRpcClientV2
```



但 `createKimiHarness()` 内部创建：

```text
new SDKRpcClientV2(options)
```



而 SDKRpcClientV2 的源码明确说明：

> agent-core-v2 engine is bootstrapped in-process，并通过 memory transport 访问。



因此：

```text
Plugin child process
↓
createKimiHarness()
```

得到的是另一套 Kimi Runtime。

不是：

```text
Plugin
↓
attach 已经运行的 TUI Session
```

所以 Codex As Subagent 不应通过重新创建 KimiHarness 去控制当前 TUI session。

---

# 14. Kimi Plugin 的能力边界

Kimi Plugin 是可安装的声明式扩展包。

官方文档列出的主要贡献面包括：

```text
Skills
custom agents
session-start skill
system prompt
MCP servers
Hooks
commands
```

Plugin 可通过：

```text
/plugins
```

管理。

这不是 VS Code Extension 那种可以获得 Kimi 内部 JavaScript object graph 的 runtime extension。

因此 CAS 插件应通过：

```text
MCP
External Hooks
System Prompt
```

与 Kimi 交互，而不是依赖内部 DI services。

---

# 15. Plugin Manifest

Plugin manifest 支持两个位置：

```text
<plugin_root>/kimi.plugin.json
<plugin_root>/.kimi-plugin/plugin.json
```

同时存在时：

```text
kimi.plugin.json
```

优先。

CAS Kimi plugin 的核心内容只需要：

```text
systemPromptPath
mcpServers
hooks
interface metadata
```

无需定义 Kimi native subagent 去包裹 Codex。

---

# 16. Plugin 安装与更新

Kimi TUI 支持：

```text
/plugins install <path-or-url>
```

其中 source 可以是：

```text
local directory
zip URL
GitHub repository URL
```

还支持：

```text
/plugins enable
/plugins disable
/plugins remove
/plugins reload
/plugins info
```



本地 plugin 安装以后会复制到：

```text
$KIMI_CODE_HOME/plugins/managed/<id>/
```

之后 Kimi 从 managed copy 运行，而不是继续直接读取原始源目录。

因此源码目录更新后，已安装 Plugin 不会自动同步。

---

# 17. Kimi MCP

Kimi Code 是 MCP Client。

官方支持：

```text
stdio
HTTP
SSE
```

其中：

```text
stdio
```

会由 Kimi 启动 MCP Server 作为 child process。

这与 Codex As Subagent 当前：

```text
codex-as-subagent mcp
```

Bootstrap 架构天然匹配。

Kimi MCP tool 命名规则：

```text
mcp__<server>__<tool>
```

例如 CAS：

```text
mcp__codex-as-subagent__codex_spawn
mcp__codex-as-subagent__codex_wait
```

未命中 permission rule 的 MCP tool 默认需要用户审批。

---

# 18. MCP Workspace / CWD

Kimi 的 workspace MCP service 会把：

```text
workspace.cwd
```

作为 stdio MCP 默认工作目录：

```text
this.stdioCwd = workspace.cwd
```

然后创建 `McpConnectionManager`。

因此 CAS Plugin 的 MCP 配置中，如果不显式覆写 `cwd`：

```text
Kimi workspace
↓
codex-as-subagent mcp process.cwd()
↓
CAS canonical workspace
```

能够保持现有 workspace isolation 设计。

不应无必要把 Plugin 自己的 managed directory 设置成 MCP cwd。

---

# 19. MCP Timeout

Kimi MCP 支持 server-level：

```text
startupTimeoutMs
toolTimeoutMs
```

其中默认 startup timeout 为：

```text
30000 ms
```

并允许用 per-server 字段覆盖全局设置。

CAS 的：

```text
codex_wait
codex_wait_many
```

协议最长等待：

```text
500 seconds
```

因此 Kimi Plugin 的 MCP timeout 必须大于 CAS wait 上限。

合理值例如：

```text
toolTimeoutMs = 520000
```

为：

```text
500 秒 CAS wait
+
transport / serialization margin
```

留出空间。

---

# 20. Kimi Hook 基础协议

External Hook 本质是 Kimi 在生命周期事件发生时执行的本地命令。

Event 数据通过：

```text
stdin JSON
```

传给 Hook。

基础字段包括：

```json
{
  "hook_event_name": "PreToolUse",
  "session_id": "session_abc",
  "session_title": "...",
  "client_type": "kimi_code_cli",
  "cwd": "/path/to/project"
}
```



Hook 默认：

```text
exit 0
→ allow

exit 2
→ block

other nonzero / crash / timeout
→ fail-open
```



---

# 21. 哪些 Hook 真正能改变 Agent flow

Kimi 当前只有三个 blockable/context-affecting Hook：

```text
UserPromptSubmit
PreToolUse
Stop
```

其他全部属于 observation-only：

```text
UserPromptQueued
TurnStarted
PostToolUse
PostToolUseFailure
PermissionRequest
PermissionResult
SessionStart
SessionEnd
SessionHeartbeat
SubagentStart
SubagentStop
TaskStarted
StopFailure
Interrupt
PreCompact
PostCompact
Notification
...
```

官方文档明确说明：

> 只有 PreToolUse、Stop、UserPromptSubmit 的返回值影响主流程，其他事件 fire-and-forget。

这解释了为什么 ZCode 的：

```text
PostToolUse
```

设计不能直接搬到 Kimi。

---

# 22. PostToolUse 的真实定位

Kimi `PostToolUse`：

```text
Tool 已执行成功
↓
Hook触发
```

但属于 observation-only。

因此它适合：

```text
logging
telemetry
notification
side effects
external bookkeeping
```

不适合依赖 stdout 直接向当前 Kimi Agent 注入 completion。

如果在 PostToolUse 中直接运行一个会：

```text
claim completion
→ ACK delivered
```

的 CAS drain，而 Kimi 又忽略 Hook stdout，就可能导致：

```text
CompletionStore 认为已交付
但模型根本没看到
```

因此 Kimi TUI completion delivery 不使用 PostToolUse。

---

# 23. PreToolUse

官方事件定义：

```text
PreToolUse
→ before permission checks
→ before actual tool execution
```

如果 blocked：

```text
tool will not execute
```



如果没有 block：

```text
tool 正常继续
```

因此 CAS 使用方式为：

```text
no pending
→ allow

pending
→ block once
→ completion as reason
```

这属于 Kimi TUI 专用的 next-tool-boundary delivery。

---

# 24. Stop

`Stop` 发生在：

```text
模型准备结束 turn
```

如果 Hook block：

```text
可以把 message 加入 Agent context
→ Agent继续
```



因此它自然是 TUI 模式当前 turn 的兜底 delivery boundary。

---

# 25. UserPromptSubmit

UserPromptSubmit 发生在用户输入即将进入 Agent 之前。

Kimi 明确允许 Hook 返回内容追加至 context。

因此它适合作为：

```text
turn 已经结束后才到达 completion
```

的最终可靠兜底。

---

# 26. Kimi 内部其实有更强的能力，但未开放给普通 Plugin

Kimi 内部 Agent Loop 本身提供：

```text
steer()
notify()
```

`steer()` 会把新的 message 注入当前 active turn；内部实现会将 steer nudge push 进 Agent Loop，并中断当前 steer controller，让 Machine Engine 消费新的输入。

PromptService 甚至支持：

```text
inject(message)
```

逻辑为：

```text
loop.steer(request)
??
loop.submit(request)
```

也就是：

```text
有 active turn
→ steer

没有 active turn
→ submit
```



另外，Kimi 内部 Tool Executor 的 after-execution Hook 允许修改：

```text
ctx.result
```

PromptService 本身就在 tool result 中处理特殊 delivery，并可以调用 `inject()`。

因此从 Kimi Harness 本身来说：

```text
工具正常执行
+
后台消息附加
```

完全有能力实现。

当前限制只是：

> 普通第三方 Plugin 没有公开注册这个内部 runtime hook 的能力。

这也是为什么 TUI 需要 PreToolUse veto trade-off，而 Web 可以通过公开 Server API 获得更好的行为。

---

# 27. Web Server API

`kimi web` 暴露：

```text
REST
WebSocket
OpenAPI
AsyncAPI
```

当前官方明确把它标记为 experimental。

默认地址：

```text
http://127.0.0.1:58627
```

端口被占用时会继续尝试后续端口。

运行实例登记：

```text
~/.kimi-code/server/instances/
```

认证使用：

```text
Bearer token
```



---

# 28. Prompt Queue 与 Steer

Kimi PromptService 内部保存：

```text
active
pending[]
steered
```

提交 prompt 时：

```text
idle
→ immediately start

busy
→ pending queue
```



Steer 则：

```text
从 pending 中选择指定 prompt
↓
移出 pending
↓
loop.steer()
↓
进入 active turn
```

所以 CAS 可以绕过普通 pending queue。

---

# 29. Kimi `/web` 生命周期

TUI `/web` 源码明确写：

```text
hand the current session off to the browser
```

并且：

```text
Always starts a new server
TUI shuts down
this process becomes the server
```



因此它不是：

```text
TUI + 独立 Server
```

同时存在，而是：

```text
TUI
↓ handoff
Server
```

session 可以保持不变。

这一事实使 CAS 的 delivery mode 可以动态切换而无需迁移 completion state。

---

# 30. Server discovery

Kimi Server 当前会把实例写入：

```text
<KIMI_HOME>/server/instances/<serverId>.json
```

并将统一 token 写入：

```text
<KIMI_HOME>/server.token
```



多个 server 可以同时存在，并占用不同端口。

因此不能简单假设：

```text
127.0.0.1:58627
```

就是当前 session owner。

需要依据：

```text
instance registry
+
session_id
+
Server API lookup
```

定位真正拥有当前 session 的 Server。

---

# 31. Kimi Plugin 与当前 Codex As Subagent 仓库的关系

当前 Codex As Subagent 已经明确：

```text
Codex Runtime
MCP Bootstrap
Runtime Server
SQLite CompletionStore
Host Hook
Host Plugin
```

各自职责。

公共 API 固定为十个 MCP tools：

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

当前 ZCode 插件已经验证 MCP + Hook 路径；Kimi Code 是下一 Host Adapter。

Kimi integration 的职责仍然仅应属于：

```text
plugins/kimi-code/
src/hook/hosts/kimi-code.mjs
Kimi host delivery adapter
相关 tests / docs
```

Kimi 的 Host-specific delivery 设计不应反向修改：

```text
Canonical TerminalResult
Codex Runtime lifecycle
十个 MCP public API
Workspace isolation
SQLite completion-first invariant
```

---

# 32. 推荐的 Kimi Plugin 组成

基于 Kimi 当前 Plugin 系统，合理组成是：

```text
plugins/kimi-code/
├── kimi.plugin.json
├── SYSTEM.md
└── README.md
```

Plugin manifest 负责：

```text
MCP registration
Hook registration
system prompt contribution
metadata
```

无需使用：

```text
agents/
skills/
```

去再包裹一次 Codex Subagent。

---

# 33. MCP manifest 的核心事实

CAS MCP Server 使用：

```text
command: codex-as-subagent
args: ["mcp"]
```

即可接入 Kimi stdio MCP。

关键 timeout 需要覆盖 CAS 500 秒 wait：

```text
startupTimeoutMs ≈ 60000
toolTimeoutMs > 500000
```

例如：

```text
toolTimeoutMs = 520000
```

Kimi MCP 官方支持这些 per-server 字段。

---

# 34. Kimi Plugin 回流事件集合

按照最终设计，TUI delivery 使用：

```text
PreToolUse
Stop
UserPromptSubmit
```

其中：

```text
PreToolUse
→ 主路径

Stop
→ turn-end fallback

UserPromptSubmit
→ cross-turn fallback
```

Web delivery 不依赖上述 Hook timing，completion terminal 后通过 Server API 主动推送。

Hook 仍可用于：

```text
session binding
mode detection hints
fallback recovery
```

但不作为 Web 主 delivery transport。

---

# 35. 需要特别记住的几个 Kimi 特性

1. **Kimi Plugin 不是 in-process JS extension。**

2. **Node SDK 可以自己创建 Kimi Runtime，但不能当作 attach 当前 TUI 的公开接口。**

3. **PostToolUse 是 observation-only。**

4. **PreToolUse 没有 pending 时正常放行；命中 pending 时必须牺牲当前工具调用一次。**

5. **Stop 可以让即将结束的 turn 继续。**

6. **Web Server API 才是真正适合主动 completion push 的公开接口。**

7. **CAS dedicated prompt 可以 steer 越过普通 queued user prompt。**

8. **已经 steer 的用户消息不重新排序。**

9. **`/web` 是 TUI → Server handoff，不是两个 Runtime 并存。**

10. **Web Server API experimental，运行时应关注当前实例 `/openapi.json`。**

---

# 36. 官方资料索引

Kimi Plugin 官方文档：

[Kimi Code Plugins](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/plugins?utm_source=chatgpt.com)

Kimi Hook 官方文档：

[Kimi Code Hooks](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/hooks.html?utm_source=chatgpt.com)

Kimi MCP 官方文档：

[Kimi Code MCP](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/mcp.html?utm_source=chatgpt.com)

Kimi Server API：

[Kimi Code Server API](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/server-api.html?utm_source=chatgpt.com)

Kimi CLI command reference：

[Kimi Code command reference](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command.html?utm_source=chatgpt.com)

Kimi Code 官方开源仓库：

[MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code?utm_source=chatgpt.com)

Codex As Subagent：

[EdgarZhong/CodexAsSubagent](https://github.com/EdgarZhong/CodexAsSubagent?utm_source=chatgpt.com)

---

# 37. 最终架构摘要

Kimi Code Adapter 最终不复制 ZCode 的 Hook 方案，而根据宿主 Runtime 能力选择 delivery transport：

```text
                    Codex As Subagent
                           │
                    CompletionStore
                           │
               ┌───────────┴───────────┐
               │                       │
             TUI                     Web
               │                       │
         External Hooks           Server API
               │                       │
       PreToolUse                    Prompt
         ↓                              ↓
       Stop                           Steer
         ↓                              │
 UserPromptSubmit                       │
               │                       │
               └───────────┬───────────┘
                           ▼
                    Kimi Main Agent
```

其中核心原则是：

> **同一个 Codex completion，选择当前 Host 能提供的最强 delivery channel。**

TUI 没有公开 live-session push API，因此使用：

```text
PreToolUse → Stop → UserPromptSubmit
```

构成三层可靠回流。

Web 拥有正式 Session Server API，因此使用：

```text
completion terminal
→ dedicated prompt
→ steer immediately
```

实现真正的主动 push。

两种模式只改变 delivery adapter，不改变 Codex As Subagent 的 Runtime、MCP、TerminalResult 或 CompletionStore。
