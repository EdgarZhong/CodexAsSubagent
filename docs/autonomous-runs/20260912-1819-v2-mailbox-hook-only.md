# T4 收口验收记录：Hook-only Mailbox 与 Web 旁路清除

- 日期：2026-09-12 18:19
- 范围：T4 收口轮（用户逐条确认六项裁决后执行；实施计划 docs/superpowers/plans/2026-09-12-v2-mailbox-hook-only.md）
- 结论：**完成**。回归 212/212、lint、smoke、真实 SQLite 探针 16/16 全绿；全库无旧 Web/Push 残留。等待用户代码审查。

## 一、删除的旧 Web / Kimi Web / Push 相关代码与入口

| 项 | 处置 |
|---|---|
| `src/core/web-delivery.mjs`（上轮按旧裁决实现的事件驱动 Web delivery） | 内容归档 `.archive/v2-removed/web-delivery.mjs` 后 `git rm` |
| `src/core/kimi-web-client.mjs`（Kimi Server HTTP client，仅为 web delivery 存在） | 归档 `.archive/v2-removed/kimi-web-client.mjs` 后 `git rm` |
| `tests/unit/kimi-web.test.mjs`、`tests/integration/kimi-web-delivery.integration.test.mjs` | 归档后 `git rm` |
| `src/cli/serve.mjs` webDelivery 接线（import + createWebDelivery + router 参数） | 删除 |
| `src/core/completion-router.mjs` 的 `webDelivery/logger` extras、`#attemptWebDelivery`、`#logWebDeliveryFailure` | 删除 |
| `src/shared/errors.mjs` 的 `MULTIPLE_ACTIVE_HOST_SERVERS` 错误码（裁决 3，无独立错误类） | 删除 |
| `src/cli/install.mjs` "Web 回流由 Runtime 事件驱动投递" 文案 | 改为 "主动回流经 Host Hook 注入" |
| `requeueExpiredLeases` / `reserveDirect` / `claimed_direct` / `delivery_id` / `delivery_started_at` / `deliveryId` | 全库改名/替换（见 §二/§四） |

文档同步：Doc B §四 改写为"当前 V2 不实现（废除清单含上轮事件驱动实现）"、§五 Web 小节改为未来原则；Doc C §3.11 废除清单扩充；Doc A §九 重写 + Recovery Matrix 删 Server 两行；知识库 banner、README、AGENTS、CLAUDE 同步。

## 二、最终 Completion schema（实施位置 src/adapters/sqlite/sqlite-store.mjs）

```text
completions(
  completion_id TEXT PK,
  thread_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  host TEXT NOT NULL,
  workspace TEXT NOT NULL,
  session_id TEXT NOT NULL,
  terminal_status TEXT NOT NULL,   -- completed|failed|interrupted
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivery_state TEXT NOT NULL,    -- pending|claimed_waiter|claimed_hook|delivered
  claim_id TEXT,
  claimed_at TEXT,
  delivered_at TEXT,
  UNIQUE (thread_id, turn_id)
)
```

与指令 §4 的 13 列完全一致，无 `delivery_profile`/push/lease 等多余列。`executions.reservation_kind` CHECK 改为 `'waiter'`。`requiresV2Rebuild` 增加 `completions.claim_id` 列检查，使收口前的中间 V2 dev 库自动触发破坏性重建（保持无迁移契约）。

## 三、Terminal Initiate 两个 Initial Transaction 的实际实现位置

统一入口：`SqliteStore.insertCompletionFirst`（src/adapters/sqlite/sqlite-store.mjs，CompletionRouter.onTerminal 唯一调用）。事务内读取 execution 行后分支：

- **Waiter Initial Transaction**：`execution.reservationKind === 'waiter'` 且有 reservation id → INSERT `delivery_state='claimed_waiter'`、`claim_id = reservation id`（首个 claim 代际）、`claimed_at = now`，同事务 terminalize（DELETE execution 行，即 consume reservation）。guardrail 注释 "Terminal Initiate 分支选择（裁决 4）"。
- **Normal Initial Transaction**：否则 INSERT `delivery_state='pending'`，同事务 terminalize。

waiter return / Hook injection 均在事务外（durable truth first, external delivery second）。无 Web Push 分支；扩展点即此分支选择。

## 四、claim / ACK / release 的实际实现位置

- **waiter claim（terminal 前 reservation 登记）**：`SqliteStore.reserveWaiter`（原 reserveDirect）路径 (a)：execution 行上 CAS 写 `reservation_id/reservation_kind='waiter'`。
- **waiter claim（terminal 后迟到）**：同函数路径 (b)：对 pending completion CAS `pending → claimed_waiter`（`WHERE completion_id=? AND host=? AND delivery_state='pending'`），claim_id 为本次 reservation id。
- **Hook claim**：`SqliteStore.claimPendingHook`：事务内先 session 有界回收过期 claim，再按完整 `(host, workspace, session_id, delivery_state='pending')` SELECT + 逐行 CAS UPDATE（`claimed_hook` + 新 claimId + claimed_at）。
- **ACK**：`SqliteStore.ackDelivery`：`WHERE host=? AND claim_id=? AND delivery_state IN ('claimed_waiter','claimed_hook')` → `delivered` + delivered_at。
- **NACK**：`SqliteStore.nackDelivery`：同谓词 → 回 `pending` 并清空 claim 三元组。
- **release（waiter 失败/超时/写失败）**：`SqliteStore.releaseReservation`：completion 分支 `WHERE host=? AND claim_id=? [AND thread_id=?] AND delivery_state='claimed_waiter'`；execution 分支按 `reservation_id + reservation_kind='waiter'`。调用链：runtime-manager `wait/waitMany` 超时释放、`releaseClaim`（内部 RPC `delivery.nack`，stdio-bootstrap 响应写失败时触发）。
- **claim 层过期恢复（裁决 2）**：`SqliteStore.#recoverExpiredClaims`（私有）+ `recoverExpiredClaims`（独立入口，可选 host/workspace/sessionId/threadId 有界过滤）；挂载点：`claimPendingHook`（session 级）与 `reserveWaiter`（thread 级）事务内、CAS 之前；基准 `claimed_at`，默认 lease 30s（`DEFAULT_CLAIM_LEASE_MS`）；`drainPending`（src/hook/drain.mjs）以 session 范围调用独立入口。无 Runtime 启动 sweep。

## 五、Session ID 全链路 opaque 取证

- **Adapter → Core**：`src/hosts/kimi-code.mjs`（stdin `session_id` 字段经 `optionalString` 无损透传）；`src/hosts/zcode.mjs`（`env.ZCODE_SESSION_ID`，缺失为 undefined、不 fallback、不伪造）。无解析、无截断、无标准化。
- **Core**：`requiredString` / `length > 0` 仅做非空校验（runtime-manager.mjs:230-233、hook/drain.mjs:45）；全库扫描 `uuid|match(|regex|parseInt|prefix|startsWith` 于 sessionId 零命中——不存在 UUID、长度、格式、前缀假设。
- **SQLite**：`executions/completions/current_sessions` 三表 `session_id TEXT NOT NULL`，无 CHECK/长度约束；全部 session 范围查询（6 处）使用 `session_id = ?` 精确等值，且均与 host/workspace 组成完整三元组谓词。

## 六、三段 Hook 的实际职责（src/cli/hook.mjs，顺序固定）

- **PreToolUse**：① Mailbox 主动回流优先——有 sessionId 才 claim（缺 sessionId 拒绝，不 fallback），注入即 veto（exit 2）并结束，不运行 Gate；② 无注入且工具 ∈ CAS MCP 工具集（来自 tool-registry，非硬编码）→ Session Gate（allow exit 0 / veto exit 2 / gate 异常 veto fail closed）。
- **Stop**：fallback 回流窗口（最后 Tool Hook 之后、主 Turn 真正结束之前）；仅 Mailbox delivery，无 Gate。
- **UserPromptSubmit**：冷恢复窗口（Turn 已结束后用户重新进入 Session）；仅 Mailbox delivery，无 Gate。

三段共用同一 Hook View（完整三元组 + pending 谓词），是同一 Mailbox 的不同生命周期消费机会，不是三个独立 Mailbox。Hook 静态安装（plugins/kimi-code 恰好三事件），是否投递由数据库决定；Hook 直连共享 SQLite，主动回流不依赖 Runtime Server 存活。

## 七、旧旁路残留检查

`grep -rn -iE 'kimi-web|kimiWeb|webDelivery|web_delivery|claimed_direct|claimed_web|delivery_profile|kimi-code-web|multiple_active_host_servers|requeueExpiredLeases|reserveDirect|delivery_started_at|deliveryId' src/ plugins/` → **零命中**。tests/ 命中仅为负向断言（plugin-layout / install-kimi-code-plugin 断言 manifest 不含 kimi-web|attach|detach；hosts-adapter / drain-cli 以 `kimi-code-web` 等作未知 Host 拒绝用例），属有意保留的回归防护。

## 八、测试结果与新增竞态测试

- `npm test`：**212/212 通过**（原 233 − 删除的 kimi-web 24 例 + 新增 3 例）。
- `npm run lint`、`npm run smoke` 通过；`node /tmp/cas-v2-probe.mjs` 16/16 PASS（新增 claim 痕迹、waiter 出生态、waiter ACK→delivered 三项）。
- 新增竞态用例（tests/unit/sqlite-store.test.mjs）：
  1. `late ACK/NACK from a stale claimant never clobbers a newer claim (hook and waiter paths)`——claim A → nack/release → claim B → A 迟到 ACK/NACK 双路径均 no-op，B 状态不受影响（裁决 6 的直接证明）。
  2. `claim-layer recovery requeues expired claims before consumer CAS claims`——过期 `claimed_hook` 在迟到 waiter 认领前被回收；**未过期 claim 不被回收**（负例：`not_found`）；过期 `claimed_waiter` 在 Hook 认领前被回收（含弃置 late-waiter claim 一并回收的批量断言）。
  3. `session-bounded claim recovery never touches other sessions or hosts`——有界回收跨 session/host 零误伤。
- 既有 worker 并发竞速用例（双 Hook Worker 仅一方 claim 成功、并发 stale-hold takeover 单赢家）保留并通过。

## 九、实现期裁决（主会话记录，均已体现在代码注释）

1. `runtime-manager` 原 `ackDelivery(value, host)`（WeakMap 便捷桥）除测试外无生产调用方，按"不留无调用方机制"删除；测试改用 `ackClaim(claimIdFor(result), host)` 真实桥。
2. 内部 RPC 方法名保留 `delivery.ack`/`delivery.nack`（裁决 6 只改参数 `deliveryId→claimId`）；响应附加字段同步 `claimId`，response-projector 剥离名单同步。
3. 探针预期修正沿用上轮已定案裁决：A 的 execution 在 insertCompletionFirst 事务内 terminalize 后，B 的 PreToolUse 属懒接管 allow（exit 0）而非 veto。
