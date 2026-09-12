# V2 Host/Session 隔离与 Kimi 适配 — 实施计划（2026-09-12）

权威规格为三份 V2 文稿（2026-09-12 修订版）与 V1 基线；本计划只固定**文件边界、接口、测试与完成判据**，不复述规格。执行方式：subagent 仅做实现与探索，复核/集成/验收全部由主会话承担；使用 ZCode 原生子代理。

## 全局约束

- 禁止修改：三份 V2 规格文档、`docs/Codex As Subagent — 详细设计与编码规格.md`、彼此的写入范围。
- 禁止出现：`--host` 默认值、plain fallback、workspace-only claim、`kimi-code-web`、常驻轮询 worker、V1 数据迁移。
- 公共协议字段/错误码用规格英文拼写：`thread_held`（`data.holderHost`）、`thread_locked`、`session_not_established`、`multiple_active_host_servers`、`host/workspace/sessionId/deliveryId`。
- SQLite 事务必须短（BEGIN IMMEDIATE，compare-and-set）；WAL/FULL/busy_timeout/foreign_keys 保持。
- 10 个 MCP 工具的 names/schema/语义零改动；`error.data` 必须在 MCP 错误投影中保留（否则 `holderHost` 丢失）。
- 测试禁止真实等待：Presence/lease 全部支持 clock/interval/lease 注入。

## 顺序与依赖

```
T1 Store/Schema ──▶ T2 Runtime core ──▶ ┬─ T3 Host Adapter + CLI ─┐
                                        ├─ T4 Web delivery + legacy 移除 ─┤─▶ T6 主会话集成
                                        └─ T5 Kimi 插件 + 安装器 ─┘
```

T3/T4/T5 相互文件不重叠，可在 T2 完成后并行。

---

## T1 — SQLite V2 Schema 与 Host-scope Store

**写入范围**：`src/adapters/sqlite/sqlite-store.mjs`、`src/core/completion-store.mjs`、`src/core/execution-store.mjs`、`src/shared/constants.mjs`（新常量）、`tests/unit/sqlite-store.test.mjs`（重构+新增）。

**Schema（open 时检测旧 schema/meta schema_version<2 → DROP 全部 CAS 表并按 V2 重建；meta.schema_version='2'）**：

- `executions`：+`host TEXT NOT NULL`、`session_id TEXT NOT NULL`；索引 `executions_scope_idx(host, workspace, session_id, last_activity_at)`。
- `completions`：+`host TEXT NOT NULL`、`session_id TEXT NOT NULL`；索引 `completions_pending_scope_idx(host, workspace, session_id, delivery_state, created_at)`（替换 V1 workspace-only 索引）。
- `thread_holds(thread_id PK, workspace, holder_host, hold_id, acquired_at, updated_at)`；索引 `(holder_host, workspace)`。
- `host_presence(host, workspace, instance_id, heartbeat_at, expires_at, PK(host,workspace,instance_id))`；索引 `(host, workspace, expires_at)`。
- `current_sessions(host, workspace, session_id, updated_at, PK(host,workspace))`。
- 常量：`HEARTBEAT_INTERVAL_MS = 20_000`、`PRESENCE_LEASE_MS = 60_000`、`DEFAULT_DELIVERY_LEASE_MS` 沿用。

**Store API（Host-sensitive 谓词必须在 SQL WHERE 实际包含 `host = ?`，禁止查出后 JS 过滤）**：

- `createExecution({host, workspace, sessionId, threadId, turnId, ownerInstanceId, model, effort, now})`；`listExecutions({host?, workspace?, sessionId?})`（普通查询必须带 host）；`getExecutionByPhysicalThreadId(threadId)` 仅限 trusted supervisor event path（方法名保持可识别）。
- `reserveDirect({host, workspace, sessionId, threadId, deliveryId, now})`：execution 归属校验（host/session 不符拒绝）；pending completion 抢占谓词含 host+workspace+session。
- `insertCompletionFirst`：同一事务内 INSERT completion（host/workspace/session 从 execution 行继承）+ DELETE execution；无 execution 的 trusted/recovery 路径显式传入 provenance。
- `releaseReservation({host, threadId, deliveryId})`；`claimPendingHook({host, workspace, sessionId, limit, deliveryId, now})` 完整谓词；`ackDelivery({host, deliveryId, now})` 与**新增** `nackDelivery({host, deliveryId, now})`（claimed_* → pending），均 `WHERE host = ? AND delivery_id = ?`；`requeueExpiredLeases` 保留全局。
- Presence：`attachHostPresence / heartbeatHostPresence / detachHostPresence / isHostAlive({host, workspace, now})`（`EXISTS ... expires_at > now`；过期行可 lazy delete）。
- Holds：`getThreadHold(threadId)`；`acquireOrTakeoverThreadHold({threadId, workspace, holderHost, holdId, now, isHostAlive})` 单事务：有 active execution → 以 execution.host 为准自动修复 Hold（execution.host ≠ caller → 拒绝）；无 active execution → Hold 存在且 holder presence alive → 拒绝；否则原子 acquire/takeover（两个并发只有一个成功）。`releaseThreadHold(threadId, holdId)` 精确按 hold_id。
- current_sessions：`getCurrentSession({host, workspace})`；`sessionGateTransition({host, workspace, sessionId, now})` 单事务实现 §3.1 四分支 + 多 active session fail closed（veto，派生自 activeSessionSet，不落 flag）；`fixCurrentSessionFromExecutions({host, workspace})`（唯一 active → 修复；0 active → 保留现状；>1 → 返回 conflict 标记）；`activeSessionSet({host, workspace})`。

**完成判据**：重构后 `tests/unit/sqlite-store.test.mjs` 全绿，新增用例覆盖：跨 host/session claim/ack/nack 互不可见、gate 四分支与原子切换（并发 CAS 只一个成功）、多 active session veto、presence attach/heartbeat/过期、hold acquire/takeover 竞争/按 hold_id 释放、旧 V1 库打开时废弃重建。

---

## T2 — Runtime Core 隔离逻辑

**写入范围**：`src/core/runtime-manager.mjs`、`src/core/errors.mjs`、`src/core/completion-router.mjs`（provenance 透传）、`src/server/recovery.mjs`、`src/server/request-router.mjs`、`src/shared/errors.mjs`（如错误码集中在此）、`tests/unit/runtime-manager.test.mjs`、`tests/unit/completion-router.test.mjs`、`tests/integration/{runtime-manager,lifecycle-recovery}.integration.test.mjs`。

**要点**：

- `ERROR_CODES.SESSION_NOT_ESTABLISHED`、`ERROR_CODES.THREAD_HELD`、`ERROR_CODES.MULTIPLE_ACTIVE_HOST_SERVERS`；`ThreadHeldError(holderHost)` 固定 message `"Thread is currently held by another host."` + `data.holderHost`；错误投影保留 `data`。
- 请求 ctx：router 从 bootstrap 接收 `{host, workspace}`，经 store 解析 `current_session` 得 SessionContext；缺失 → `session_not_established`（所有 CAS 工具统一）。
- spawn：thread/turn 创建成功后 `createExecution`(provenance) + acquire Hold；startTurn 失败按本次 hold_id 精确释放（含 spawn）。
- send：per-thread lock 内 A–F 算法（busy → `thread_busy` 不变；他 Host active Execution → `thread_held`；idle+无 Hold → acquire；自有 Hold → 继续；他人 Hold + presence alive → `thread_held`；stale → 原子 lazy takeover）。新取得 Hold 后 startTurn 失败只删本次 hold_id。
- steer/interrupt：不 takeover；他 Host active Execution → `thread_held`；无 active turn → `no_active_turn` 不变。
- wait/wait_many：他 Host active Execution → `thread_held`；reserveDirect/claim 走 session 谓词；waiter/lease 机制不变。
- status/read_thread：他人有效持有（presence alive 或其 active Execution）→ `thread_held`；stale Hold + idle → 放行。list_threads：排除他人有效持有，含 free/stale-held idle；排序与 25 条上限不变。
- completion-router：onTerminal 的 provenance（host/workspace/session）从 execution 行取得并透传到 insertCompletionFirst；trusted/recovery 合成路径显式携带 provenance。
- recovery：对账逻辑不变；追加 `fixCurrentSessionFromExecutions`（每 HostScope）；presence/holds 不删除不重置。

**完成判据**：A–F 全分支、hold 修复、session_not_established、recovery 修复/保留矩阵行均有确定性测试；全量单测/integration 绿。

---

## T3 — Host Protocol Registry 与 CLI 协议

**写入范围**：`src/hosts/{registry,kimi-code,zcode}.mjs`（新建）、`src/cli/{hook,drain,mcp}.mjs`、`src/mcp/{stdio-bootstrap,workspace-context}.mjs`、`src/hook/drain.mjs`、`src/hook/hosts/kimi-code.mjs`（envelope 文案）、`tests/unit/`（新增 hosts/adapter、hook-gate、drain-cli、mcp-presence 用例）+ 受影响既有测试更新。

**要点**：

- `getHostAdapter(hostId)`：未知 host 抛 `UnknownHostError`，任何 CAS 状态读写之前失败。Adapter `parseHookInvocation({payload, env})` → `{sessionId, cwd, event, toolName?, toolInput?, toolCallId?}`；kimi-code 读 stdin 字段（`session_id/cwd/hook_event_name/tool_name/tool_input/tool_call_id`）；zcode 读 stdin（`hook_event_name/cwd/tool_name/...`）+ env `ZCODE_SESSION_ID`。不做字段猜测。
- `cli/hook.mjs`：`--host` 必填（无默认）；流程 read stdin → adapter.parse → `WorkspaceGuard.resolve(parsed.cwd)` → HookContext → 核心：① Mailbox 回流（`claimPendingHook` 完整谓词；缺 sessionId 拒绝 claim）② kimi-code 且 event=PreToolUse 且未注入 completion 且 toolName ∈ CAS 工具集 → `sessionGateTransition`：allow 放行 / veto 输出 block 文案 exit 2。gate 求值异常 → veto（fail closed，文案提示重试）。Stop/UserPromptSubmit 只做 delivery。整体异常仍 fail-open exit 0（不破坏宿主），gate 除外。
- `cli/drain.mjs`：`--host/--workspace/--session` 三项必填（缺失打印用法退出非零）；构造 DeliveryContext 调统一 drain 核心；不读 stdin。
- `cli/mcp.mjs` + `stdio-bootstrap.mjs`：`--host` 必填；workspace 解析（保留 KIMI_PLUGIN_ROOT fail-closed）成功后 `instanceId=UUID` attach Presence，定时器（默认 20s，参数可注入）直写 SQLite heartbeat，进程退出 best-effort detach；Presence 注册失败不处理 MCP 调用。请求 context 升级为 `{host, workspace}`；`delivery.ack` 带 host，新增 `delivery.nack` 路由。
- `src/hook/drain.mjs`：签名升级为接收 DeliveryContext（host/workspace/sessionId）；渲染 envelope 逻辑不变。

**完成判据**：kimi/zcode payload 解析、未知 host 拒绝、hook 双职责顺序（先回流后门禁、回流时 veto 工具并注入、无 pending 才门禁）、drain 三参校验、mcp presence attach/heartbeat/detach（注入时钟）、`{host, workspace}` 端到端透传均有测试。

---

## T4 — Kimi Web 事件驱动投递与 legacy 移除

**写入范围**：`src/core/kimi-web-client.mjs`（自 `src/hook/kimi-web.mjs` 迁移 discovery+client，删除 worker 循环）、`src/core/web-delivery.mjs`（新建）、`src/core/completion-router.mjs`（terminal 后挂 delivery 钩子）、`src/cli/main.mjs`（移除 kimi-web 命令）、`src/cli/kimi-web.mjs` 与 `src/hook/kimi-web.mjs`（删除，内容移 `.archive/v2-removed/` 且 .gitignore）、`tests/unit/kimi-web*.test.mjs`、`tests/integration/kimi-web-delivery.integration.test.mjs`（重写为事件驱动）。

**要点**：

- terminal COMMIT 后：completion `delivery_state === 'pending'` 且 `host === 'kimi-code'` → fire-and-forget `attemptWebDelivery`（不得阻塞响应、不得改变 idle 语义；失败记 server.log）。
- Server 判定：枚举 `$KIMI_CODE_HOME/server/instances`（+`server.token`）：0 → 保持 pending；>1 → `multiple_active_host_servers` 记日志不发送；==1 → 该 Server。Session 归属校验（GET session 的 workspace 匹配 completion.workspace，不匹配 → NACK）。
- 投递：原子 claim（pending→claimed_hook，deliveryId `web-<uuid>`）→ `submitCompletion`（POST prompts + active 时 steer，幂等码沿用）→ 成功 ACK / 确定失败 NACK（→ pending）/ 进程异常靠 lease 过期回退。`claimed_direct` 永不 web 发送。
- 不引入定时器/轮询；恢复仅靠： nack、lease 过期 + 下次事件、同 session 的 TUI hook claim。
- legacy：`kimi-web` CLI 与 worker/registry 全部移除；`kimi-code-web` host 值不留存。

**完成判据**：0/1/多 Server 三分支、claim→push→ACK/NACK/lease 路径、`claimed_direct` 排除、COMMIT 先于外部副作用（构造 push 失败验证 completion 仍在）、kimi-web CLI 消失（`--help`/dispatch 无此命令）均有测试；`src/cli/main.mjs` 无 kimi-web 分发。

---

## T5 — Kimi 插件资源与安装器

**写入范围**：`plugins/kimi-code/kimi.plugin.json`、`plugins/kimi-code/README.md`、`plugins/kimi-code/SYSTEM.md`（如提及 attach/worker 需更新）、`src/install/kimi-code-plugin.mjs`、`tests/unit/install-kimi-code-plugin.test.mjs`、`tests/unit/plugin-layout.test.mjs`。

**要点**：

- plugin.json：移除 SessionStart/TurnStarted/SessionEnd 的 `kimi-web --attach/--detach`；保留 PreToolUse/Stop/UserPromptSubmit → `codex-as-subagent hook --host=kimi-code`（裸命令形态不变）。
- 安装器：用户级 `$KIMI_CODE_HOME/mcp.json` 的 CAS server args 追加 `--host=kimi-code`；其余（备份/幂等/dry-run/原子写）不变。
- 文档：README/SYSTEM 描述与 V2 一致（Web 回流为 Runtime 事件驱动，无 sidecar）。

**完成判据**：真实 `install --host=kimi-code --dry-run` 与落盘产物核对（hooks 集合、mcp.json args）通过；安装器测试全绿。

---

## T6 — 主会话集成、回归与验收

- 集成复核所有 subagent 变更；小型边界补丁主会话直接修，其余重组任务。
- `npm test` / `npm run lint` / `npm run smoke` 全绿；`node src/cli/main.mjs doctor --json` 正常。
- 验收：实施规格 §3.13 全部场景逐条映射到确定性测试并在验收记录标注证据；架构设计 §十矩阵可测行覆盖；真实 Kimi TUI/Web E2E 与 ZCode 插件集成按看板留给用户/下一轮。
- 验收记录：`docs/autonomous-runs/20260912-HHmm-v2-host-session-isolation.md`；更新 CLAUDE.md 看板；Conventional Commit 分批提交。

## 验收快照（本轮完成定义）

V2 schema 重建 + Host-scope Store + Session Gate + Thread Hold/Presence + 新错误面 + hook/drain/mcp 新协议 + Kimi TUI 双职责 + Runtime 事件驱动 Web delivery + legacy kimi-web 移除 + Kimi 插件/安装器更新全部落地；全量测试/lint/smoke 绿；验收记录完整；旧 ZCode 插件不可用为已接受状态。
