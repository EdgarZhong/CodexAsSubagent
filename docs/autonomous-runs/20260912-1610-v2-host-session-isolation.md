# V2 Host/Session 隔离与 Kimi 适配 — 实施与验收记录（2026-09-12 16:10）

本轮按三份 V2 规格（2026-09-12 修订版）完成 T1–T6 全部实现。规格：`docs/CodexAsSubagent V2 Session 隔离与 Mailbox 架构设计.md`、`docs/CodexAsSubagent V2 串投修复与 Kimi Code 集成适配说明.md`、`docs/CodexAsSubagent V2 Host 隔离、Thread Hold 与 CLI-Adapter 实施规格.md`；实施计划：`docs/superpowers/plans/2026-09-12-v2-host-session-isolation.md`。执行方式：subagent 分任务实现（T1 Store / T2 Runtime core / T3 Host Adapter+CLI / T4 Web delivery / T5 Kimi 插件），主会话承担全部复核、集成与验收（用户 2026-09-12 指令，无独立 Review Agent）。

## 一、交付范围

- **T1 Store/Schema**：V2 schema 破坏性重建（executions/completions + host/session_id，新增 thread_holds、host_presence、current_sessions，schema_version='2'）；全部 claim/ack/nack/reserve 谓词 host 化（SQL WHERE 实际包含 `host = ?`）；sessionGateTransition 单事务 Gate；acquireOrTakeoverThreadHold（CAS + 冲突重读）；presence attach/heartbeat/detach/isHostAlive；fixCurrentSessionFromExecutions。常量 heartbeat 20s / lease 60s 可注入。
- **T2 Runtime core**：SessionContext 解析（`{host, workspace}` → current_session → `{host, workspace, sessionId}`，缺失 `session_not_established`）；send A–F 判定算法；spawn/send 新 Hold 后 startTurn 失败按 hold_id 精确释放；steer/interrupt/wait/status/read_thread/list_threads 的 `thread_held` 语义（`data.holderHost`）；completion provenance 继承/显式透传（冲突 fail closed）；recovery 按 HostScope 修复 current_session、不删 Hold、不重置 Presence。
- **T3 Host Adapter + CLI**：`src/hosts/{registry,kimi-code,zcode}.mjs`（未知 host 在任何 CAS 访问前 `UnknownHostError`）；`hook --host` 必填、无 plain fallback、无 `--workspace` 覆盖；kimi-code PreToolUse 双职责固定顺序（先 Mailbox 回流、注入即 veto 工具且不触门禁；无 pending 才对 CAS 工具做 Gate；gate 异常 fail closed veto）；`drain --host/--workspace/--session` 三参必填；`mcp --host` 必填 + Presence 注册成功后才处理调用、20s 直写 SQLite heartbeat、退出 best-effort detach；bootstrap ctx `{host, workspace}`；stdout 写失败发 `delivery.nack`。
- **T4 Web delivery + legacy 移除**：terminal durable COMMIT 后对仍 pending 的 kimi-code completion 事件驱动投递（0 active Server 保持 pending；>1 记 `multiple_active_host_servers` 不发送；恰 1 → 原子 claim `claimed_hook` → session 归属校验 → Kimi Server API prompt/steer → ACK/NACK/lease）；`claimed_direct` 永不 web 发送；COMMIT 先于外部副作用；零定时器、零 current_session/Hold 触碰；`kimi-web` CLI/worker/registry 全部移除（原文件归档 `.archive/v2-removed/`，不追踪）。
- **T5 Kimi 插件/安装器**：plugin.json 仅保留 PreToolUse/Stop/UserPromptSubmit 三回流 hook；安装器 MCP 注册 args `["mcp", "--host=kimi-code"]`；README/SYSTEM 与 V2 口径一致。
- **T6 主会话集成补丁**：`src/cli/serve.mjs` 接入 webDelivery 与 recovery logger；`src/cli/install.mjs` 安装提示文案去除 V1 K2.7 sidecar 口径。

## 二、确定性验证证据

- `npm test`：**233/233 全绿，0 失败**（unit + integration，Node 内置 test runner）。
- `npm run lint`：通过（全部 `src/**/*.mjs` 语法检查）。
- `npm run smoke`：exit 0（CLI/stdio/socket 基础回归）。
- `node src/cli/main.mjs doctor --json`：exit 0，`ok: true`。
- `node src/cli/main.mjs kimi-web …`：未知命令（legacy 入口已消失）。
- `install --host=kimi-code --dry-run`（默认 home 与临时 home）：正常，托管 manifest hooks 恰为三个回流事件、无 mcpServers；mcp.json args 含 `--host=kimi-code`。
- 主会话端到端探针（真实 SQLite + 真实 hook 进程，/tmp/cas-v2-probe.mjs，11/12 符合预期、1 条为探针预期口径错误已现场澄清）：
  1. Gate 建立 session A → allow ✓
  2. createExecution 固化 provenance ✓
  3. session B PreToolUse(codex_spawn) 在 A active 时 → **veto exit 2** ✓
  4. terminal 事务：completion pending 且继承 session A ✓
  5. B 的 UserPromptSubmit 先触发 → **claim 不到 A 的 completion**（跨 session 隔离），A 的 completion 保持 pending ✓
  6. A 的 UserPromptSubmit → claim → 渲染注入 → delivered ✓（且发生在 current_session 已切到 B 之后，验证回流与 Runtime 状态解耦）
  7. A idle 后 B PreToolUse → **原子接管**（current_session A→B）→ allow exit 0 ✓

## 三、实施规格 §3.13 验收场景 → 证据映射

| 场景 | 证据 |
|---|---|
| Kimi /repo/A active + ZCode /repo/B active 可同时使用 | tests/integration/runtime-manager.integration（同 workspace 双 host 并发） |
| Kimi Completion / ZCode Hook 先触发不可 claim | hook-delivery.integration（跨 session 不可见用例）+ 探针 5 |
| Kimi A Completion / Kimi B Hook 不可 claim | sqlite-store.test（跨 session claim）+ 探针 5 |
| T1 holder=Kimi、presence alive、ZCode send → thread_held + holderHost | runtime-manager.test A–F 分支（presence alive 两态） |
| presence expired + 无 active → lazy takeover | runtime-manager.test（stale takeover）+ sqlite-store.test（并发 takeover 单赢家） |
| presence expired + 有 Kimi active Execution → thread_held | runtime-manager.test（B 分支优先于 presence） |
| takeover 后旧 Kimi Completion 仍只回原 session | 探针 6（current_session=B 后 A 仍收自己的 completion） |
| CAS Hold 不冲突但 Codex writer lock → thread_locked | thread-locked-error.test（归一逻辑未改） |
| 同一 stale Thread 双 Host 同时 send 只一个 acquire | sqlite-store.test（真实 Worker 进程竞争） |
| 新 acquire 后 startTurn 失败只释放本次 hold_id | runtime-manager.test（两次 acquire 模拟并发替换） |
| status/read_thread 访问他人持有 Thread → thread_held | runtime-manager.test |
| list_threads 不显示他人有效持有 Thread | runtime-manager.test |
| Hook 缺 Session ID → 不做 workspace-only claim | hosts-adapter/hook-gate.test + 探针（无 payload → 不 claim） |
| 未知 --host 在状态访问前失败 | hosts-adapter.test（UnknownHostError 先于 openStore） |
| 错误 Host + 正确 deliveryId ACK 不生效 | sqlite-store.test（ack host 隔离） |
| idle shutdown 不被 Presence heartbeat 唤醒 | mcp-presence.test（heartbeat 直写 SQLite，不经 Server）+ lifecycle-recovery.integration |

Recovery Matrix（架构设计 §十）可测行：无 current_session（session_not_established，self-recovering 路径在 runtime-manager.test）、Hook 缺 session（拒绝 claim）、多 active session（gate veto + fix 派生 conflict）、current_session 与唯一 active 不一致（自动修复）、stale Hold 非错误（lazy takeover）、Hold 与 execution.host 不一致（事务内修复）、claim 进程消失（lease 过期 requeue，kimi-web-delivery.integration）均已覆盖。

## 四、遗留与推后（明确记录，非缺陷）

- **真实 Kimi TUI/Web E2E**：需本机 live Kimi session，留给用户执行（同 V1 惯例）。建议路径：重装插件（`npm run install:kimi-code`）→ 重启宿主 → TUI 会话 spawn 探针观察 PreToolUse 回流；Web 会话验证 MCP 进程带 `--host=kimi-code`、completion 事件驱动投递回原 session、SQLite 中 `delivery_state='delivered'`。
- **ZCode 插件升级与真实 E2E**：单独一轮（用户拍板推后）；现有 ZCode 安装在 V2 协议下暂时不可用（`mcp` 现要求 `--host`），为已接受的阶段性状态。
- **真实 `status=failed` turn 路径**：仍未单独构造验证（继承 V1 backlog）。
- **旧数据目录**：本机 `~/.codex-as-subagent/state.sqlite` 仍是 V1 schema；下次 V2 Runtime 打开时将按规格自动废弃重建（旧 delivered history 不保留，用户已知悉 breaking-upgrade contract）。
- 升级前需确认无旧 CAS 实例在跑（规格 §2.11 前置条件）。

## 五、边界裁决账本（主会话复核确认）

1. `acquireOrTakeoverThreadHold` 因注入的 `isHostAlive` 可 async，采用"快照读 → 事务外 presence 判定 → CAS 写 + 冲突重读循环（≤5 次）"；并发单赢家由 CAS 保证（真实进程竞争测试覆盖）。
2. Gate 的"两个 session 对空 HostScope 竞争"按懒切换语义建模（先后 allow，后到覆盖）；单 allow 仅在存在 active execution 时成立——与规格 §六一致。
3. `heartbeat` 为 UPDATE-only（`refreshed:false` 不自动重挂）；T3 在 `refreshed:false` 时重新 attach 自愈。
4. `reserveDirect`/send 错误路径允许按物理 thread_id 读取归属字段（host/workspace/session）以产出 `holderHost` 诊断——仅限 Runtime trusted 上下文，不向模型泄漏业务数据。
5. `resumeThread` 失败同样释放本次新 Hold（规格 §1.6"失败创建流程不得留下新有效 Hold"的推论）。
6. `thread_held` 在无法确定唯一 holder（conflicting_executions/contention）时使用专用 message 且不带 `data.holderHost`——不做猜测。
7. provenance：事件显式值优先透传，由 store 与 execution 行做一致性校验（冲突 fail closed）。
8. Gate/门禁求值失败 → veto（fail closed）；回流渲染失败 → fail-open（不破坏宿主）且不跳过门禁。
9. `kimi-web` CLI 文件移入 `.archive/v2-removed/`（遵守"不删除文件"仓库规则，git 不追踪）。
10. 门面（execution-store/completion-store）未透传全部新 Store 方法，RuntimeManager 经 `.store` 直取并构造时 fail-fast 校验——如需纯门面调用方可后续补齐（非阻塞）。
