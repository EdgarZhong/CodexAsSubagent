# Task 6：MCP 公共 façade 与十个工具

## 状态

DONE。已完成十个 MCP 工具注册、参数校验、公共响应投影、stdio JSON-RPC 桥接和 CLI `mcp/serve` 接线。本任务由主 Agent 直接完成，没有继续使用子 Agent。

## 实现内容

- `src/mcp/tool-registry.mjs`：固定公开十个工具及闭合 JSON Schema，禁止额外参数。
- `src/mcp/tool-handlers.mjs`：统一校验工具参数并将 Runtime 结果投影为公共响应；保留 `invalid_model`、`invalid_effort`、`default_model_unavailable`、`thread_busy`、`thread_not_found`、`thread_workspace_mismatch`、`no_active_turn`、`history_unavailable`、`workspace_unavailable` 等领域错误。
- `src/mcp/response-projector.mjs`：递归移除 `turnId`、delivery、workspace、cursor、raw event、approval、sandbox、config 等内部字段。
- `src/mcp/stdio-bootstrap.mjs`：接入最小 MCP JSON-RPC `initialize`、`tools/list`、`tools/call`、`ping` 和通知；工具调用仍通过 Unix socket Runtime Server 转发，stdout 写成功后才 ACK direct delivery，Bootstrap 不持有 Runtime/SQLite 状态。
- `src/cli/main.mjs`、`src/cli/mcp.mjs`、`src/cli/serve.mjs`：接通 `serve` 与 `mcp` 命令，并保持帮助输出兼容。

## 关键裁决

1. MCP façade 使用最小 JSON-lines JSON-RPC 实现，不引入额外 SDK；公开工具数量固定为十个，内部 Runtime envelope 继续使用无 `jsonrpc` 字段的独立协议。
2. `tools/call` 的业务错误使用 MCP `result.isError=true` 加 text content 返回；协议级未知方法使用 JSON-RPC `-32601`，避免把内部 Runtime 错误格式泄漏给 Host。
3. MCP 请求在转发前复用同一套闭合参数校验；`cwd`、`workspace`、`sandbox`、`approval`、`cursor`、`eventCursor`、`turnId` 和任意额外字段 fail-closed。
4. Bootstrap 只负责 workspace context、lazy activation、转发、响应投影和 ACK/NACK，不注入或保存 Runtime 业务对象。

## 测试证据

Task 6 focused：

    node --test tests/unit/tool-schema.test.mjs tests/integration/mcp-tools.integration.test.mjs tests/integration/server-bootstrap.integration.test.mjs

结果：8/8 通过。

全量回归：

    npm test

结果：71/71 通过，无失败、取消或跳过。

静态与 CLI：

    npm run lint
    npm run smoke
    find src -type f -name '*.mjs' -exec node --check {} \;
    git diff --check

以上命令均退出码 0。另以临时 `--data-dir` 运行真实 `node src/cli/main.mjs mcp`，输入 `initialize`、`tools/list`、未知 JSON-RPC 方法，分别得到合法初始化响应、十工具列表和 `-32601` 协议错误，进程正常退出。

## 遗留范围

- Task 7 仍需实现 Hook drain、lease 恢复、Host wrapper 与 ZCode 插件骨架。
- Task 8 仍需完成跨任务用户级验收记录、最终 Review 和真实 Codex app-server/ZCode 外部状态限制说明。
