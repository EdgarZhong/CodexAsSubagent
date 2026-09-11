# Task 4：RuntimeManager and execution control

## 状态

DONE。Task 4 由主 Agent 在中止的初始实现之后直接完成；未创建新的子 Agent 或 reviewer。实现 commit：955d8101c7d2405e668e27c8cbc37cfce2c90464。没有修改 Task 5–8 文件、vendor、详细设计或 MCP public schema。

## 实现内容

- 新增 src/core/runtime-manager.mjs，提供 spawn、send、steer、interrupt、status、wait、waitMany、listThreads、readThread 和 models。
- spawn 先解析并验证 model/effort，再创建 thread/turn，将 canonical workspace、owner instance、model、effort 和 internal turn 写入现有 ExecutionStore，只返回不含 turnId/deliveryId/workspace 的 ACK。
- send 对同一 thread 的已有 execution 做前置检查；busy thread 返回 thread_busy，idle thread 通过 adapter resume 后用持久化的 model/effort 启动新 turn。
- steer 与 interrupt 只向 Supervisor 传递内部 turn identity；interrupt 只返回请求 ACK，不自行生成 terminal completion。
- runtime event listener 更新内存 liveness snapshot，并把 verified terminal event 交给现有 CompletionRouter，因而继续保持 completion-first。为覆盖 startTurn 返回前已到达 terminal event 的竞态，增加按 thread 的短暂 terminal-event buffer，在 execution 落库后重放。
- wait/waitMany 使用 SQLite direct reservation；完成结果转换为 TerminalResult，delivery id 只保存在不可枚举的 WeakMap 中。只有 ackDelivery 后才进入 delivered；timeout 释放未完成 reservation，永不调用 interrupt。
- waitMany("all") 在调用瞬间捕获 workspace 内 active thread 快照；后续 spawn 不加入本次批次。批次共用一个隐藏 delivery id，完成行在整个响应 ACK 前保持 claimed_direct。
- status 限制 action 200 字符、assistant preview 600 字符并计算 idleForSec；listThreads 做 canonical workspace 过滤并限制 25 项；readThread 只返回 bounded assistant/history/change projection；models 返回稳定 default/catalog projection。

## 关键裁决

1. Ruling：waitTimeoutMs 默认实现为 500,000 ms，但测试可通过构造器注入更短值；原因是保持公共协议固定 500 秒，同时让单元测试不等待真实超时；代价是调用方若错误注入超时会改变内部运行行为，因此该参数不进入 MCP public API。
2. Ruling：terminal event 在 execution 尚未落库时按 thread 暂存并在落库后重放；原因是 adapter 事件可能与 turn/start 响应竞速，直接丢弃会违反 completion-first；代价是进程在两步之间崩溃时仍需 Task 5 recovery 负责持久状态 reconciliation。
3. Ruling：当前 liveness snapshot 先以内存状态为主，SQLite 只承担 execution/completion 原子状态；原因是 Task 3 的 StateStore 没有 activity-update 接口且本任务禁止改 SQLite；代价是 Runtime Server 重启后的实时 preview 需由 Task 5 recovery/adapter history 补齐。

## 测试证据

### 聚焦测试

命令：

    node --test tests/unit/runtime-manager.test.mjs tests/integration/runtime-manager.integration.test.mjs

输出摘要（退出码 0）：

    ℹ tests 12
    ℹ pass 12
    ℹ fail 0
    ℹ cancelled 0
    ℹ skipped 0

覆盖：spawn ACK/model persistence；idle send 与 busy rejection；steer/interrupt；terminal-before-wait；wait-before-terminal；timeout 不 interrupt；preview cap；workspace filtering/history；model catalog/default error；waitMany snapshot、批次 ACK、timeout release、workspace mismatch。

### 全量回归

命令：

    npm test

输出结尾（退出码 0）：

    ℹ tests 59
    ℹ pass 59
    ℹ fail 0
    ℹ cancelled 0
    ℹ skipped 0
    ℹ todo 0

### 静态检查与基础 smoke

命令：

    node --check src/core/runtime-manager.mjs
    node --check tests/unit/runtime-manager.test.mjs
    node --check tests/integration/runtime-manager.integration.test.mjs
    npm run lint
    npm run smoke
    git diff --check

结果：全部退出码 0；npm run lint 检查 CLI 入口通过；npm run smoke 输出 serve、mcp、hook、drain 四个命令及默认 gpt-5.6-luna/xhigh。

## 文件

- src/core/runtime-manager.mjs
- tests/unit/runtime-manager.test.mjs
- tests/integration/runtime-manager.integration.test.mjs

## Self-review / concerns

- 未使用 repository-level Git diff/status 计算 changed-files；changed-files 仍由 Adapter/turn-scoped normalized event 提供。
- public ACK、status、history、waitMany projection 中没有 turnId、internalTurnId、deliveryId 或 workspace；delivery identity 仅存在于内部 WeakMap。
- 真实 Codex app-server、Unix socket Server、跨进程 recovery、Hook 和真实 Host E2E 尚未在 Task 4 范围内实现，留给 Task 5–7。
- Task 4 的 adapter fake 仍由测试注入；真实 Supervisor 的 process crash/lifecycle 归属由后续 Runtime Server 处理。
