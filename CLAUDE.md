# CLAUDE.md

## 当前阶段

- 目标：按三份 V2 规格文档完成 V2 升级（Host/Session 隔离、Thread Hold、Runtime 内部事件驱动 Web delivery）与 Kimi Code 适配；ZCode 插件资源与真实 E2E 明确推后。
- 权威规格（冲突时以此为准，均为 2026-09-12 修订后的唯一自洽版本）：
  1. `docs/CodexAsSubagent V2 Session 隔离与 Mailbox 架构设计.md`
  2. `docs/CodexAsSubagent V2 串投修复与 Kimi Code 集成适配说明.md`
  3. `docs/CodexAsSubagent V2 Host 隔离、Thread Hold 与 CLI-Adapter 实施规格.md`
- V1 详细设计已降级为基线规格（`docs/Codex As Subagent — 详细设计与编码规格.md`，被取代小节已移除）；V1 已全部交付并通过用户级验收，证据见 docs/autonomous-runs/。
- 执行方式（用户 2026-09-12 指令）：自主实现流程中**独立 Review Agent 取消**，全部复核与验收由主会话承担；subagent 只负责必要的 explore 与实现；使用 ZCode 原生子代理，不使用 Codex。
- 环境事实：本机 Codex runtime 为 ChatGPT.app 内嵌 0.153.4；确定性回归基线为 V2 实现 233/233（2026-09-12）。

## V2 任务看板

- [x] 三份 V2 规格按最终修订指令合并为唯一自洽版本（含 `current_session` 持久化、破坏性重建、Runtime 内部 Web delivery、Fail-Closed/Recovery Matrix、Host 产品定义；Doc A 改名去 "(1)"）。
- [x] V1 详细设计精简为基线规格；Kimi 知识库加 V2 状态标注；三份核心文档同步。
- [x] T1 SQLite V2 schema 重建与 Host-scope Store（executions/completions + host/session_id，thread_holds、host_presence、current_sessions；claim/ack/nack/gate 全谓词 host 化；破坏性重建，schema_version='2'）。
- [x] T2 Runtime core 隔离逻辑（SessionContext 解析与 `session_not_established`、send A–F Hold 算法、新 Hold 后失败按 hold_id 释放、steer/interrupt/wait/status/read_thread/list_threads 的 `thread_held` 语义、provenance 继承/显式透传、recovery 修复 current_session 且不重置 Presence/Hold）。
- [x] T3 Host Protocol Registry + CLI 协议（src/hosts/{registry,kimi-code,zcode}；hook `--host` 必填 + PreToolUse 双职责固定顺序 + gate 异常 fail closed；drain 三参必填；mcp `--host` 必填 + Presence 注册后处理调用、20s 直写 heartbeat、退出 detach；`delivery.nack` 接线）。
- [x] T4 Kimi Web 事件驱动投递（terminal COMMIT → claim `claimed_hook` → 单 active Server 判定/`multiple_active_host_servers` → session 归属校验 → prompt/steer → ACK/NACK/lease；`claimed_direct` 排除；legacy kimi-web CLI/worker/registry 移除并归档 .archive/v2-removed/）。
- [x] T5 Kimi 插件资源与安装器（hooks 恰为 PreToolUse/Stop/UserPromptSubmit；MCP 注册 args `["mcp","--host=kimi-code"]`；README/SYSTEM 更新）。
- [x] T6 主会话集成与回归：serve 接入 webDelivery/recovery logger、install 文案修补；`npm test` 233/233、lint/smoke/doctor 通过；真实 SQLite 端到端探针（隔离/门禁/接管/回流/跨 session 不串投）通过；验收记录 docs/autonomous-runs/20260912-1610-v2-host-session-isolation.md。
- [ ] 用户级验收：真实 Kimi TUI/Web E2E 由用户执行（重装插件 → 重启宿主 → TUI PreToolUse 回流；Web 验证 `--host=kimi-code` MCP 与事件驱动投递回原 session）。
- [ ] ZCode 插件集成与真实 E2E（单独一轮；现有 ZCode 安装在 V2 下暂时不可用，为已接受状态）。

### Backlog（承接 V1 未完成项）

- [ ] `tests/e2e/`、`tests/fixtures/` 空占位：缺可重复执行的自动化 E2E。
- [ ] 开源一键安装在 Host 子进程 PATH 的发现方案（ZCode 插件 update 重同步覆盖命令本地化）。
- [ ] 真实 `status=failed` turn 路径未单独构造验证。

### 明确不做（V2 决定，非遗漏）

- **多 Server 路由**：Server 型 Host 假设同一产品至多一个 active Server；>1 报 `multiple_active_host_servers` fail closed。未来需要时才扩展 `Host → Server Instance → Session`。
- **V1→V2 数据迁移**：不做 migration，不保留旧 CAS runtime state（含 delivered history），不实现 `.bak-v1` 自动备份。
- **不做线程锁探测**；`thread_locked` 仅覆盖 "already has an active writer" 归一（V1 决定继续有效）。
- **不新增 Hook 事件**：仍固定 `UserPromptSubmit` + `PostToolUse` + `Stop`（ZCode）；Kimi 为 `PreToolUse` + `Stop` + `UserPromptSubmit`。
- **MCP public API 不增加**：V2 不改 10 个工具的 names、input schema、业务语义与调用方式；Host/Session 隔离属于内部 Runtime context，不进入模型可见 MCP 参数。
- **Hook 不做重活 / 不以 PID 相等清 orphan app-server**（AGENTS.md，继续有效）。

## 继承决策（V1 定稿、V2 继续有效）

1. 技术栈：Node.js 24 ESM + node:sqlite；vendor/codex-supervisor-mcp 以 Submodule 固定，业务代码只经 src/adapters/supervisor/ 访问。
2. MCP transport：stdio Bootstrap + Unix socket Runtime 分层；最小 JSON-RPC façade；Bootstrap 不持有 Runtime/SQLite 业务状态。
3. Runtime 自动发现：`CODEX_BIN` > PATH > standalone managed > `~/.local/bin` > Homebrew > ChatGPT.app > 旧 Codex.app；realpath 去重 + `--version` + schema method 检查 + ephemeral initialize 冒烟；单生命周期不切换 binary。实现于 `src/shared/codex-runtime.mjs`。
4. 配置分层：`~/.codex-as-subagent/config.toml` 是对 Codex 配置的可选增量覆写（`-c key=value` 注入 app-server 前）；Codex 二进制走 `CODEX_BIN` env，不写 config.toml。实现于 `src/shared/codex-runtime.mjs` + `src/cli/serve.mjs`。
5. 兼容性事实：app-server 必须始终显式设置 `CODEX_APP_SERVER_ARGS`（至少 `["app-server"]`）；`turn/completed` 通知复用承载 completed/interrupted/failed（以 canonical turn record status 细分）。
6. 错误规范化：仅 `already has an active writer` → `thread_locked`（Codex writer-lock 层）；V2 新增 `thread_held`（CAS Host Hold 层，含 `data.holderHost`），两层严格分离，不得合并或把 Codex 表示成 holder。
7. 回流事件：ZCode 固定 UserPromptSubmit/PostToolUse/Stop；PostToolUse 省略 matcher 匹配所有工具、不接受 decision；Stop 以 `decision:block` 续轮；不加 `stop_hook_active` 护栏；双通道经 claim 状态互斥。
8. ZCode Hook 协议事实（逆向取证）：恰好 7 事件；stdout 必须以 `{` 开头严格 JSON；Hook env 注入 `ZCODE_SESSION_ID`（session 身份只在 Hook 通道可得）；MCP 进程 env 无 session 变量。取证见 docs/research/2026-09-11-zcode-hook-protocol.md。
9. Kimi Hook 协议事实：stdin JSON `{hook_event_name, session_id, cwd, ...}`（session_id 只在 stdin 字段）；exit 0 allow / exit 2 block；仅 PreToolUse/Stop/UserPromptSubmit 可影响主流程；Hook 对 MCP 工具调用也触发。协议依据见 Kimi 知识库（协议事实部分仍有效）。
10. 插件安装：`plugins/<host>/` 是唯一真源，安装器拷贝+本地化+注册；Kimi MCP 注册到用户级 `$KIMI_CODE_HOME/mcp.json`（宿主以 workspace cwd 拉起），插件 manifest 禁止携带 MCP；K2.7 模型 `kimi-code/kimi-for-coding` 固定用于 Web 投递。
11. V1 串投取证（已由 V2 结构性修复）：host 谓词缺失、session 维度缺失、detached worker 孤儿化；证据见 docs/autonomous-runs/20260911-2320-session-routing-and-isolation-findings.md。

## V2 动态决策（2026-09-12 定稿）

1. **五项裁决**：(a) ZCode 本轮实现 Core Adapter 与全部 Host 维度逻辑，`plugins/zcode` 资源与真实 E2E 推后，旧 ZCode 插件暂时不可用为接受的阶段性状态，禁止为兼容而给 `--host` 默认值/保留 plain/猜 Host/workspace-only；(b) `current_session` 持久化为 SQLite `current_sessions` 表（主键 `(host, workspace)`），是 persisted routing state；(c) 无 `current_session` 时 MCP 调用 fail closed `session_not_established`（self-recovering）；(d) Kimi Web 回流为 Runtime 内部事件驱动 delivery，attach/worker/polling 全部废弃；(e) V1→V2 破坏性重建，不做 migration。
2. **权威优先级**：active Execution（lifecycle truth）> `current_session`（routing state）> Thread Hold（control state）；stale routing/hold 状态不构成占用；conflict 一律为派生状态，durable facts 收敛后自动恢复（Recovery Matrix 见架构设计 §十）。
3. **Thread Hold**：`thread_holds`（thread_id 主键）+ `host_presence`（(host, workspace, instance_id) 主键，heartbeat 20s / lease 60s，MCP Bootstrap 直写 SQLite，不经 Runtime Server RPC）；Hold 无独立 lease，有效性由 Presence + active Execution 判定；取得入口仅 spawn/send；lazy takeover 原子竞争；新 Hold 后 startTurn 失败只按本次 hold_id 释放。
4. **线程操作语义**：send 按 A–F 判定算法（thread_busy/thread_held/lazy takeover）；steer/interrupt 不 takeover；wait 不取 Hold、对他 Host active Execution 报 `thread_held`；status/read_thread 对其他 active Host 有效持有的 Thread 报 `thread_held`；list_threads 只列 caller 持有 + free + stale-held idle。
5. **claim 谓词**：Hook/Direct Wait/Web 一律 `(host, workspace, session_id, delivery_state='pending')`；Hook 缺 session_id 拒绝 claim 不得 fallback；Web 投递用 `claimed_hook` 槽位，`claimed_direct` 不再 web 发送；新增 `delivery.nack`（`WHERE host = ? AND delivery_id = ?`）。
6. **CLI 协议**：`serve` 禁止 `--host/--workspace/--session`；`mcp --host` 必填、 Presence 注册成功后才处理调用、退出 best-effort detach；`hook --host` 必填、移除 plain fallback 与 `--workspace` override；`drain --host/--workspace/--session` 三项必填。
7. **Host 身份**：Host 是产品类型（kimi-code/zcode/...），由 Host integration 静态指定，不得从 cwd/session/进程名/工具参数推断；未知 Host 在任何 CAS 状态读写前 `UnknownHostError` fail closed；TUI/Web 统一 `kimi-code`，`kimi-code-web`/`kimi-code-tui` 禁止。
8. **文档裁决**：三份 V2 文稿为唯一权威，V1 设计降级基线；`src/hosts/<host>.mjs` 是 Host-native 字段唯一出现处，`cli/hook.mjs` 不直接读 Host-native 字段；禁止以 legacy 代码反推产品设计，代码与规范冲突时改代码。
9. **实现边界裁决（2026-09-12，逐条证据见验收记录 §五）**：Hold 接管为"快照读 → 事务外 presence 判定 → CAS 写 + 冲突重读"；Gate 空闲竞争按懒切换语义（先后 allow）；heartbeat UPDATE-only（`refreshed:false` 由调用方重挂）；`resumeThread` 失败同样释放本次新 Hold；无法确定唯一 holder 的 `thread_held` 不带 `data.holderHost`；provenance 显式事件值优先、行一致性校验 fail closed；gate 求值失败 veto（fail closed）、回流渲染失败 fail-open；kimi-web legacy 文件移入 `.archive/v2-removed/`。

## 执行边界

- 主 Agent 负责需求收敛、任务排序、集成、复核（本轮取消独立 Review Agent）、最终验证与用户级验收；验收记录写入 docs/autonomous-runs/。
- 子 Agent 按计划分配互不重叠的写入范围，不创建新的子 Agent，不修改三份 V2 规格文档与 V1 基线文档。
- 所有当前阶段更新写入本文件；稳定使用说明写入 README.md；通用规则写入 AGENTS.md。

## 完成定义（本轮 V2）

三份 V2 规格全部实现并通过确定性验收（含实施规格 §3.13 全部场景与架构设计 §十 Recovery Matrix 的可测行）：V2 schema 重建、Host-scope Store、Session Gate、Thread Hold/Presence、`thread_held`/`session_not_established`/`multiple_active_host_servers` 错误面、hook/drain/mcp 新 CLI 协议、Kimi TUI PreToolUse 双职责、Runtime 内部事件驱动 Web delivery、legacy kimi-web 移除、Kimi 插件与安装器更新；npm test/lint/smoke 全绿；真实 Kimi TUI/Web E2E 与 ZCode 插件集成按看板留给用户或下一轮。
