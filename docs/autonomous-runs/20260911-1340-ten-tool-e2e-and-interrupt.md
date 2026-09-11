# 十工具真实 ZCode 会话 E2E 与中断协议裁决

- 日期：2026-09-11 13:34–13:41（本地）
- 执行：主 Agent 在已重启的 ZCode 会话内，直接调用 10 个 MCP 工具，不使用脚本模拟
- 模型：`gpt-5.5` + `effort=medium`（按用户要求用最便宜模型、降低思考，不用 xhigh）
- 环境：ZCode GUI 会话；MCP server 由 Host 拉起；Runtime Server 冷启动自动发现 `/Applications/ChatGPT.app/Contents/Resources/codex` 0.153.4
- 结果：**10/10 工具通过**；注入为 PostToolUse **turn 中途自动回流**（非人工 `drain`）；发现并修复第 5 处缺陷；回归 112/112

## 1. 十工具逐项

| 工具 | 输入要点 | 返回结构（实测） | 判定 |
| --- | --- | --- | --- |
| `codex_models` | 无参 | `{default:{model:"gpt-5.6-luna",effort:"xhigh"},models:[{id,supportedEfforts}×5]}` | 通过 |
| `codex_list_threads` | 无参 | `{threads:[{threadId}],total,truncated}` | 通过 |
| `codex_spawn` | prompt/model/effort | `{threadId,status:"running",model,effort,startedAt}` | 通过 |
| `codex_status` | threadId | `{threadId,status,model,effort,startedAt,lastActivityAt,idleForSec,latestAction,latestAssistantPreview,filesChanged}` | 通过 |
| `codex_read_thread` | threadId | `{threadId,status,assistantMessages:[...],recentActivity:[{status}],changes:{files,filesChanged,filesTruncated},truncated}` | 通过 |
| `codex_wait` | threadId | 活跃期等待返回 terminal result；已被 hook 消费时返回 `{code:"no_active_turn"}` | 通过（含互斥语义） |
| `codex_wait_many` | threads:["...","..."] | `{completed:[{threadId,status,finalAssistantMessage,changes,error}],pending:[],timedOut:false}` | 通过 |
| `codex_send` | threadId/prompt | `{threadId,status:"running",model,effort,startedAt}` | 通过 |
| `codex_steer` | threadId/prompt | `{threadId,accepted:true,status:"running"}` | 通过（ACK 语义） |
| `codex_interrupt` | threadId | `{threadId,interruptRequested:true,requestedAt}` | 通过（修复后落 interrupted） |

## 2. Hook 自动注入实证（PostToolUse 中途回流）

用户在 GUI 中看不到工具结果，故把注入原文贴回。实测抓到两次 turn 中途注入（均由 `PostToolUse` 触发，非本轮结束）：

第一次（线程 A `POSTTOOLUSE-PROBE-A` 完成后，我在同一 turn 内继续调别的工具时被注入）：

```
[Hook additional context]
#1
Codex subagent 01a08ef5-969a-7fd0-9b8a-a076362c2fd4 completed (ed4c640d-6a62-48d1-94e1-7cbd1ba274da)
POSTTOOLUSE-PROBE-A
```

第二次（线程 A 经 `codex_send` 的第二 turn 完成后）：

```
[Hook additional context]
#1
Codex subagent 01a08ef5-969a-7fd0-9b8a-a076362c2fd4 completed (6bbf0b7e-baf1-449c-8205-d9a79ff5175b)
SEND-PROBE-OK
```

- 机制：Hook stdout 为严格 JSON `{"additionalContext":"..."}`；PostToolUse 事件**不带** `decision`（工具事件不接受 decision/continue），只把完成结果拼接到刚返回的工具结果尾部；`Stop` 事件才带 `decision:block` 续轮。
- 关键结论：**不必等我这一轮结束**，子 agent 一完成，只要我下一步还有任何工具调用，结果就会在 turn 中途回流。

## 3. 发现并修复的第 5 处缺陷（协议层，最隐蔽）

### 现象

`codex_interrupt` 返回 `accepted` 后，被中断线程永久停留 `running`：`codex_status` 一直 `running`、SQLite 无 terminal completion、Server 也不再 idle 退出（实测僵死 5 分钟）。

### 根因

裸 JSON-RPC 探针（直接对 codex app-server 发 `turn/interrupt`）抓到真实通知：

```
NOTIF: {"method":"turn/completed","params":{"threadId":"...","turn":{"id":"...","status":"interrupted","...":...}}}
```

`generate-json-schema` 佐证：**全 schema 只有 `TurnCompletedNotification`**，没有 `TurnFailedNotification` / `TurnInterruptedNotification`；终止状态在 `params.turn.status`（`TurnStatus = completed|interrupted|failed|inProgress`）。即上游把三种终止**复用一个通知**（这是设计预期，用户确认）。

我们 `protocol-normalizer.mjs` 的 `terminalStatus()` 用**方法名**推期望状态（`turn.completed → completed`），于是 `turn/completed` + `status=interrupted` 被判为"状态冲突"→ `verifiedTerminalStatus=false` → 该事件不被认作 terminal。同样地 `status=failed` 的 turn 也永不落 terminal。

### 修复

`refineTerminalType(type, event)`：当方法名为 `turn.completed` 时，按 **canonical turn record** 的 `status` 细分为 `turn.interrupted` / `turn.failed`；deep/nested 记录不参与，保留既有 fail-closed 冲突检测。该细分同时接入 `collectStatusSources` 的顶层判别器，避免 `event.method` 与细分结果互相误判为冲突。

### 验证

修复后停掉加载旧代码的 Server（同时验证 SIGTERM 干净退出、无残留 app-server 子进程），冷启动加载新代码：

- 冷启动 recovery 将僵死 execution 对账为 `failed` 并经 Hook 回流：`Codex subagent 01a08ef6-181b-... failed (89b86a83)`
- 起长任务线程后 `codex_interrupt`：线程落到 `interrupted` 并自动回流 `Codex subagent 01a08efb-0820-... interrupted (77ee1658)`
- DB 校验：`terminal_status=interrupted, delivery_state=delivered`；`executions` 表无残留
- `codex_status` 返回 `{"status":"interrupted"}`

## 4. 附带改进：注入文本中的 completionId 截断

`completionId` 是 Runtime 内部交付主键，对模型控制面无用（10 个工具无一接受它），完整 UUID 出现在注入文本属内部字段外泄。`render-completions.mjs` 现对 UUID 形态 id 只渲染前 8 位（`(77ee1658)`），非 UUID 自定义 id 原样保留。新增单测锁定该行为。

## 5. 回归与证据

- `npm test`：112/112 通过（新增 multiplexed terminal、UUID 截断等用例；修正 2 处编码了"方法名决定状态"错误前提的旧断言）
- `npm run lint`：通过
- `npm run smoke`：通过
- 真实路径证据：server.log `codex.selected`、SQLite completion 行、Hook 注入原文（见上）

## 6. 遗留

- 未验证 `status=failed` 的真实 turn 路径（仅经 recovery 合成 failed 验证）。
- `codex_wait` 与 Hook 双通道互斥已观察到两种结果：Hook 抢先时为 `no_active_turn`，本 turn 无后续工具调用时为 `codex_wait` 直接送达；两条路径均置 `delivered`，无重复消费。

## 7. 补充验证：codex_steer 真实生效（13:41）

起一个"从 1 数到 100000"的长输出线程，中途 `codex_steer` 要求改为只输出 `STEER-TOOK-EFFECT`：

- `codex_steer` 返回 `{"threadId":"...","accepted":true,"status":"running"}`
- `codex_wait` 返回 `{"status":"completed","finalAssistantMessage":"STEER-TOOK-EFFECT"}`
- DB：`terminal_status=completed, delivery_state=delivered`，该结果由 `codex_wait` 直接送达（direct 通道）

结论：steer 内容**真实改变**了在途 turn 的输出，而非仅受理 ACK。

## 8. 补充发现：跨客户端线程锁（V1 已知限制，未修复）

向"上一 Server 实例创建、当前实例未持有"的线程调 `codex_send` 时报错：`{"code":"internal_error","message":"thread 01a08efb-da24-... already has an active writer"}`。

取证：

- `~/.codex/thread-writer-locks/<threadId>.lock` 是 **flock 型**锁（二进制含 `writer_lock.rs`、`failed to acquire thread writer lock`）。用 `fcntl.flock(LOCK_EX|LOCK_NB)` 探测该文件返回 `BlockingIOError`，证实锁确实被持有。
- `lsof` 显示持有者是 **ChatGPT 桌面版的 app-server**（PID 63149，父进程 `/Applications/ChatGPT.app/Contents/MacOS/ChatGPT`），它同时持有 9 个历史线程的锁。
- 对照：本 Server 自己新建的线程（`01a08f02-0109`）由本 Server 的 app-server 持有，`codex_send` 成功；Server idle 退出后该锁释放（`lsof` 无持有），而桌面版仍持有旧线程锁。

结论：`~/.codex` 跨 Codex 客户端共享，线程写锁是跨客户端互斥的。V1 隔离边界是 workspace，不含"Codex 客户端独占"维度，故对旧线程的 send/steer/interrupt 在桌面版同时运行时可能失败。这是共享存储的固有限制。

附带问题：`asDomainError` 只要有 `error.code` 就原样透传，导致上游 raw message 漏给模型、code 落为 `internal_error`。已在 CLAUDE.md 决策 18 记录修复计划。


