# V2 T4 收口：Hook-only Mailbox 与 Web旁路清除 实施计划

日期：2026-09-12。目标：把已完成的 T4 收口到 Hook-only Mailbox 模型；删除全部新旧 Web/Push transport 代码；Completion 状态机收缩为四态并全面 claim_id 校验；Session ID 全链路 opaque 核查。完成后 T4 进入可审查、可定稿状态。

## 已确认裁决（用户逐条拍板）

1. Web delivery 新旧实现全部归档删除（`.archive/v2-removed/`），不区分"旧旁路"与上轮新实现；未来 Web Push 按届时设计重写，不以旧代码为地基。设计文档只保留通用原则。
2. 孤儿 claim 恢复：保留 lease recovery（`claimed_at` + timeout），**不**加 Runtime 启动 sweep；恢复下沉为 claim 层通用机制——Hook claim 与 waiter claim 在尝试消费前先回收过期 `claimed_waiter`/`claimed_hook`（可按 Session/Thread 有界），然后 CAS claim。
3. 删除 `multiple_active_host_servers` 错误码；Session 级单活跃 interactive instance 约束独立成立，不依赖该错误面。
4. `claimed_waiter` = waiter 持有消费权（不分 terminal 前后）；出生态仍只有两个（terminal 前有 reservation → claimed_waiter；否则 pending）；迟到 waiter 走 `pending → claimed_waiter` CAS。
5. waiter reservation 载体维持 `executions.reservation_id/reservation_kind`，不新增表；`reservation_kind` 值 `direct` → `waiter`。
6. 内部 RPC `delivery.ack`/`delivery.nack` 参数 `deliveryId → claimId`；ACK/NACK/release 一律以 `delivery_state + claim_id` 双条件校验；每次重新 claim 生成新 `claim_id`；补迟到 ACK/NACK 不影响新 claim 的竞态测试。

## 文件边界

### 修改
- `src/adapters/sqlite/sqlite-store.mjs`：四态改名；completions 列 `delivery_id/delivery_started_at → claim_id/claimed_at`（最终 13 列）；`reservation_kind='waiter'`；`requiresV2Rebuild` 增加 claim_id 列检查；`reserveDirect → reserveWaiter`（事务内先做 thread 级过期回收）；`claimPendingHook`（事务内先做 session 级过期回收，参数 `claimId`）；`ackDelivery/nackDelivery/releaseReservation` 按 `state + claim_id` 校验；`requeueExpiredLeases → recoverExpiredClaims`（可选 host/workspace/sessionId/threadId 范围过滤）。
- `src/core/completion-store.mjs` / `src/core/execution-store.mjs`：包装层方法同步改名。
- `src/core/runtime-manager.mjs`：wait/waitMany/reserve/release/ack 链路 `deliveryId → claimId`；`#completionFor` 状态判定改 `claimed_waiter`；`reserveDirect → reserveWaiter`；`ackDeliveryId/releaseDeliveryId → ackClaim/releaseClaim`；`deliveryIdFor → claimIdFor`。
- `src/server/request-router.mjs`：`delivery.ack/nack` 读 `params.claimId`。
- `src/server/server.mjs`：`unackedCount` 用 `claimed_waiter`；response 附加字段 `deliveryId → claimId`（若有）。
- `src/mcp/stdio-bootstrap.mjs`：`#reportDelivery` 与 ack/nack 调用点参数改 `claimId`。
- `src/core/completion-router.mjs`：删除 `webDelivery/logger` extras、`#attemptWebDelivery`、`#logWebDeliveryFailure`。
- `src/cli/serve.mjs`：删除 webDelivery 接线。
- `src/cli/install.mjs`：安装提示文案改 Hook-only 口径。
- `src/hook/drain.mjs`：`recoverExpiredClaims`（session 级）+ `claimId` 参数。
- `src/shared/errors.mjs`：删除 `MULTIPLE_ACTIVE_HOST_SERVERS`。
- 测试：`tests/unit/sqlite-store.test.mjs`、`runtime-manager.test.mjs`、`completion-router.test.mjs`、`hook-drain.test.mjs`、`hook-gate.test.mjs`、`drain-cli.test.mjs`、`mcp-presence.test.mjs`、`install-kimi-code-plugin.test.mjs`、`plugin-layout.test.mjs`、`tool-schema.test.mjs`、`tests/integration/{hook-delivery,mcp-tools,runtime-manager,server-bootstrap}.integration.test.mjs`——改名适配 + 新增竞态用例。

### 删除（内容先拷入 `.archive/v2-removed/` 再 git rm）
- `src/core/web-delivery.mjs`、`src/core/kimi-web-client.mjs`
- `tests/unit/kimi-web.test.mjs`、`tests/integration/kimi-web-delivery.integration.test.mjs`

### 文档
- Doc B §四.3 改写（Hook-only；Web Push 移除声明；未来原则）；Doc A 状态机/Terminal Initiate/claim 恢复机制与多 transport 原则条文；Doc C §3.11 清单追加与验收场景核对；知识库 banner 补充；README §隔离子段与 Kimi 插件段改写；AGENTS.md "direct 或 Hook" 改 "waiter 或 Hook"；CLAUDE.md 看板与裁决 ledger。全文关键词扫描：`claimed_direct/delivery_id/delivery_started_at/web delivery/Web 回流/kimi-web/multiple_active_host_servers/Direct Wait/requeueExpiredLeases`，并确认无"没有 Hook 就一定不能回流 / 没有 Hook MCP 一定正常"类全局承诺。

## 新增竞态测试（完成判据）

1. claim A → nack/release 回 pending → claim B（新 claim_id）→ A 的迟到 ACK 与 NACK 均 no-op，B 的 claim 状态不受影响（hook 与 waiter 两路径都测）。
2. waiter 出生态：terminal 前有 reservation → completion 出生即 `claimed_waiter` 且 `claim_id === reservation_id`；waiter ack → delivered。
3. waiter 失败 release → pending → Hook 可 claim（消费权移交）。
4. claim 层恢复：过期 `claimed_hook` 在 waiter claim 前被回收；过期 `claimed_waiter` 在 Hook claim 前被回收（各自有界范围）。
5. 并发双 Hook claim 仅有一方成功（保留现有 worker 竞速测试并适配命名）。

## 完成判据

- 全库无 `claimed_direct`/`delivery_id`/`delivery_started_at`/`requeueExpiredLeases`/`multiple_active_host_servers`/`kimi-web`/`webDelivery` 残留（src+tests+plugins）。
- `npm test` 全绿；`npm run lint`、`npm run smoke` 通过；`/tmp/cas-v2-probe.mjs` 适配后重跑通过。
- 交付八项清单（删除项、最终 schema、两个 Initial Transaction 位置、claim/ack/release 位置、session_id opaque 链路证明、三段 Hook 职责、残留检查、测试结果）写入验收记录 `docs/autonomous-runs/`。
- 全局约束：MCP 10 工具协议不变；`.archive/` 保持 git 不追踪；不 push（push 授权仍待用户确认前轮 commit）。
