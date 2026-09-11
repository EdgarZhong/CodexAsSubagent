# Kimi Web MCP workspace 错配修复 — 方案 A 落地与可做测试验收（2026-09-11 21:00）

> 性质：修复验收记录。上一份交接文档 docs/autonomous-runs/20260911-1824-kimi-web-e2e-handoff.md 定位根因并给出方案候选；本轮完成方案 A 的实现、测试与本机安装。**唯一遗留：Kimi Code 内的真实 E2E 复验，留给用户执行。**

## 1. 背景与根因（沿用交接文档，未变化）

Kimi 插件 manifest 内注册的 MCP server 被宿主以 `cwd = config.cwd ?? pluginRoot` 拉起，CAS bootstrap 的 `process.cwd()` workspace 全部落错 → completion 落盘 workspace=插件目录、kimi-web worker 永不匹配、subagent 跑在插件目录。

## 2. 方案 A 的前提取证（本轮新增，全部来自本机运行的 kimi 0.42.0 二进制）

| # | 证据 | 结论 |
|---|---|---|
| 1 | `lsof -p 67636`（运行中的 Kimi Web Server）显示 fd 34/35/61 打开 `~/.kimi-code/mcp.json` | 用户级 mcp.json 是 Web Server 实时加载的 MCP 配置 |
| 2 | 二进制明文代码（`grep -a` + perl 提取）：`const layers = await Promise.all([readMcpJson(input.fs, paths.user), readMcpJson(..., paths.projectRoot, { stdioCwdBase: dirname(paths.projectRoot) }), readMcpJson(..., paths.project)])` | 配置分三层；用户级层不设 stdioCwdBase |
| 3 | `function normalizeMcpServers(servers, options) { const stdioCwdBase = options.stdioCwdBase; if (stdioCwdBase === void 0) return servers; ... }` | 用户级 server 的 `config.cwd` 保持未处理（为空） |
| 4 | `this.stdioCwd = workspace.cwd` → `new McpConnectionManager({ stdioCwd: this.stdioCwd, ... })` → `new StdioMcpClient(config, { defaultCwd: this.options.stdioCwd, ... })` | WorkspaceMcpService 以 workspace.cwd 作为 stdio MCP 默认工作目录 |

结论：用户级 mcp.json 注册的 stdio MCP 在 Web 模式下 spawn cwd = workspace.cwd，`process.cwd()` 方案天然成立。**方案 A 成立。**

取证方法说明：BSD `grep` 需加 `-a` 才会搜索该二进制（否则当作二进制文件跳过）；上下文提取用 `perl -0777 -ne` 对超长 minified 行截取窗口。

## 3. 实现改动

1. `plugins/kimi-code/kimi.plugin.json`：移除 `mcpServers`，插件 manifest 只承载 hooks / system prompt / interface。
2. `src/install/kimi-code-plugin.mjs`：
   - 新增 `USER_MCP_SERVER_NAME` / `USER_MCP_STARTUP_TIMEOUT_MS`(60000) / `USER_MCP_TOOL_TIMEOUT_MS`(520000，覆盖 codex_wait 500s 上限)；
   - `buildUserMcpServerEntry()`：`command=process.execPath`、`args=[CLI_ENTRY, 'mcp']`（用户级 mcp.json 无插件 command 硬校验，直接用绝对路径，可移植）；
   - `mergeUserMcpConfig()`：合并保留用户已有 server，只覆盖 CAS 条目；
   - `installKimiCodePlugin()`：读 → 备份（`.bak-cas`，文件不存在则不留备份）→ 原子写 `$KIMI_CODE_HOME/mcp.json`；托管副本**先 `rm` 清空再拷贝**，保证与源严格一致；
   - 删除 launcher 相关（`MCP_LAUNCHER_REL`/`MCP_LAUNCHER_COMMAND`/`renderMcpLauncher`）：其存在理由（绕插件 command 硬校验）随 MCP 移出 manifest 消失，不留死代码；
   - `localizeKimiManifest()` 改为剥离 `mcpServers`（防御性：即使 manifest 源残留也不下发）。
3. `src/mcp/workspace-context.mjs`：新增 `assertNotInsidePluginRoot()`——cwd 与 `KIMI_PLUGIN_ROOT` 均做 realpath 规范化后比较前缀（含 `sep` 边界），命中抛 `WorkspaceUnavailableError`，错误信息说明原因与修复方向。`resolveWorkspaceContext` 在 workspace 解析前执行该检测。
4. `plugins/kimi-code/README.md`：同步新机制，并明确**官方 `/plugins install` 路线只装 hooks，MCP 必须走 CLI 安装器或手工写 mcp.json**。

## 4. 测试与验收证据

| 路径 | 预期 | 实际命令 | 证据 |
|---|---|---|---|
| 安装器单测（重写 + 新增） | manifest 剥离 mcpServers；entry 形状/超时；合并保留外部 server；install 写 mcp.json + 幂等 + 备份；dry-run 不写 | `node --test tests/unit/install-kimi-code-plugin.test.mjs` | 7/7 pass |
| fail-closed 单测（新增） | cwd 在插件根内/经 symlink 指向插件根 → 拒绝；外部/无 env → 放行；resolveWorkspaceContext 先于 workspace 解析失败 | `node --test tests/unit/workspace-context-plugin-root.test.mjs` | 5/5 pass |
| 既有布局测试（更新） | 插件 manifest 禁止携带 mcpServers | `npm test` | 全量 149/149 pass（原 137 + 新增 12） |
| 静态检查 | 无语法错误 | `npm run lint` | exit 0 |
| CLI/stdio/socket 回归 | 无回归 | `npm run smoke` | exit 0 |
| 真实 install | mcp.json 合并正确（playwright 保留 + CAS node 绝对路径 + 超时字段）；托管 manifest 无 mcpServers/cas-run；备份齐全 | `node src/cli/main.mjs install --host=kimi-code` | 输出 9 项动作含 mcp.json 注册与备份；`cat ~/.kimi-code/mcp.json` 与托管目录核对通过 |
| 真机 fail-closed | 从插件目录 cwd + `KIMI_PLUGIN_ROOT` 启动 MCP 必须拒绝且信息明确 | `cd <托管副本> && KIMI_PLUGIN_ROOT=$PWD node <repo>/src/cli/main.mjs mcp` | 抛 `WorkspaceUnavailableError`，含原因与「Register the MCP server in user-level MCP config」指引 |

## 5. 用户级 E2E 复验 SOP（留给用户，在 Kimi Code 中执行）

1. **重启 Kimi Code 宿主**（或新开会话）——MCP server 每会话新建进程，`~/.kimi-code/mcp.json` 已由本轮 install 写好。
2. 确认工具暴露：应出现 `mcp__codex-as-subagent__codex_*` 十个工具（用户级注册的工具前缀与旧插件式 `mcp__plugin-...__codex_*` 不同）。
3. **cwd 验证（方案 A 的最终实证点）**：`ps aux | grep 'main.mjs mcp'` 找到本会话 MCP pid → `lsof -p <pid> | grep cwd`，预期 cwd = 当前会话 workspace（仓库根），**不再是** `~/.kimi-code/plugins/managed/codex-as-subagent`。
4. 回流复验：`codex_spawn` 一个探针任务后**不要调 wait**，观察 `<codex-completion>` 是否插队注入（含 turn 运行中注入）。
5. SQLite 确认：`delivery_state='delivered'` 且 `delivery_id` 带 `kimi-web-` 前缀。
6. 通过后清理开发态垃圾（需用户确认）：`~/.codex-as-subagent/mcp-debug` 标志文件与 `mcp-debug.log`；SQLite 中 4 条永不投递的历史 pending completion（两条 workspace=插件目录、两条 workspace=`/private/tmp/cas-e2e-ws`）。`mcp-debug` 探针代码保留（标志文件门控，默认零开销）。

## 6. 风险与边界

- 若官方 `/plugins install` 单独使用（不经 CLI 安装器），只有 hooks 无 MCP 工具——已在插件 README 显著说明。
- 用户级 mcp.json 对该用户全部 Kimi workspace 生效；每个 workspace 的会话各自以自己的 workspace.cwd 拉起独立 MCP 进程，与 V1「单 workspace 单主会话」前提一致。
- `mcp-debug` 探针代码保留在 stdio-bootstrap（标志文件门控、任何失败静默），默认不影响协议行为。
