# Kimi Code 集成 Implementation Plan

> **For agentic workers:** 本轮按仓库规则由主 Agent 内联执行，不启动子 Agent；步骤使用 checkbox (`- [ ]`) 跟踪。

**Goal:** 为新版 Kimi Code 提供可直接安装的 MCP/Hook 插件、`install --host=kimi-code` CLI 安装路径，以及 TUI 与 Web 两种 completion 回流适配。

**Architecture:** 保持 Codex Runtime、TerminalResult、CompletionStore 和十个 MCP 工具不变。Kimi TUI 通过官方插件 manifest 的 `PreToolUse`、`Stop`、`UserPromptSubmit` 调用现有 Hook；Kimi Web 通过 Host 适配层 sidecar 发现本地 Server/session，提交带稳定 `prompt_id` 的专用 prompt，并在 active turn 时只 steer 该 prompt。Web delivery 复用现有 completion lease/ACK 状态，不新建第二套队列。

**Tech Stack:** Node.js 24 ESM、Node 内置 `fetch`、SQLite existing CompletionStore、Kimi Code 0.42+ plugin manifest / REST Server API。

**Spec:** `docs/Codex As Subagent × Kimi Code — 主动回流设计定稿与集成参考知识库.md`；以 Kimi 官方当前文档的 manifest、Hook、MCP、Server API 字段校正实现。

## Global Constraints

- 所有用户可见文档使用中文；公共 Kimi/Codex 协议字段保持官方英文拼写。
- 只修改 Kimi Host 适配、安装器、插件资源、测试和文档；不修改十个 MCP public schema、workspace isolation、TerminalResult canonicalization 或 Codex supervisor vendor。
- 插件源文件不得包含本机绝对路径；CLI 安装时动态本地化到当前安装包中的 Node CLI 路径。
- Kimi Web prompt 固定使用 `kimi-code/kimi-for-coding`（K2.7），本轮真实调用严禁使用 K3。
- Web API 只有在 Server 接受 prompt/steer 后才 ACK completion；网络失败、session 不匹配和未知响应均保留 pending/lease 恢复路径。
- Kimi 官方安装路径只通过 `plugins/kimi-code/` 的干净资源支持，不手工修改 `$KIMI_CODE_HOME` 下的缓存作为源码。

### Task 1: Kimi Host source plugin and TUI envelope

**Files:**
- Create: `plugins/kimi-code/kimi.plugin.json`
- Create: `plugins/kimi-code/SYSTEM.md`
- Create: `plugins/kimi-code/README.md`
- Modify: `src/hook/hosts/kimi-code.mjs`
- Test: `tests/unit/plugin-layout.test.mjs`
- Test: `tests/unit/hook-drain.test.mjs`

**Interfaces:**
- Manifest exposes `mcpServers.codex-as-subagent` with stdio `codex-as-subagent mcp`, `startupTimeoutMs >= 60000`, `toolTimeoutMs > 500000`.
- Manifest declares `PreToolUse`, `Stop`, `UserPromptSubmit`, `TurnStarted`, `SessionStart`, `SessionEnd` using official `event/matcher/command/timeout` fields.
- `wrap(text, completions, context)` returns plain Kimi hook text; when event is `PreToolUse` and completions exist, it emits the explicit “original tool call has NOT been executed” message and `renderHookResult` metadata for the CLI to block.

- [x] 写 manifest/layout failing assertions for official field shape, all MCP timeout values, no ZCode-only `hooks/hooks.json`, and clean bare command。
- [x] Add Kimi-facing SYSTEM instructions describing asynchronous `codex_spawn`, `codex_wait`, and retry semantics without selecting K3。
- [x] Implement Kimi wrapper and hook result policy: no pending means allow; PreToolUse/Stop pending is blockable; UserPromptSubmit returns context; non-blocking events remain informational。
- [x] Run `node --test tests/unit/plugin-layout.test.mjs tests/unit/hook-drain.test.mjs` and verify the new assertions pass。

### Task 2: Kimi Web API client and completion delivery sidecar

**Files:**
- Create: `src/hook/kimi-web.mjs`
- Create: `src/cli/kimi-web.mjs`
- Modify: `src/cli/main.mjs`
- Modify: `src/hook/render-completions.mjs`
- Test: `tests/unit/kimi-web.test.mjs`
- Test: `tests/integration/kimi-web-delivery.integration.test.mjs`

**Interfaces:**
- `discoverKimiServer({home, sessionId, workspace, fetchImpl})` scans `server/instances/*.json`, reads `server.token` without logging it, validates `GET /api/v1/sessions/{sessionId}` and canonical workspace.
- `KimiWebClient.submitCompletion({sessionId, completionId, text, model})` sends one dedicated prompt with deterministic `prompt_id` and explicit `model: 'kimi-code/kimi-for-coding'`; if the session was active, it calls the single-prompt steer endpoint only for that id.
- `runKimiWebWorker({sessionId, workspace, dataDir, kimiHome, pollMs, fetchImpl, store})` claims one pending completion at a time, submits/steers, ACKs only accepted delivery, and leaves failures leased for retry.
- `kimi-web --attach` reads Hook stdin, starts an idempotent detached worker; `kimi-web --detach` removes only a registry entry whose PID/command matches this worker; worker exits quietly when no matching Web server/session is found.

- [x] Write fake-fetch tests for instance discovery, workspace fail-closed, K2.7 model pinning, idle submit, active steer, 404/409 idempotency, and network failure without ACK。
- [x] Implement the dependency-free REST client with envelope/code validation and no token logging。
- [x] Implement deterministic prompt formatting from existing completion renderer and lease/ACK loop using the shared SQLite store。
- [x] Add CLI dispatch and safe attach/detach worker lifecycle without changing core Runtime code。
- [x] Run focused unit/integration tests and confirm only K2.7 appears in request bodies。

### Task 3: Kimi CLI installer and clean source localization

**Files:**
- Create: `src/install/kimi-code-plugin.mjs`
- Modify: `src/cli/install.mjs`
- Modify: `package.json`
- Test: `tests/unit/install-kimi-code-plugin.test.mjs`
- Test: `tests/unit/cli-entry.test.mjs`

**Interfaces:**
- `resolveKimiCodeHome()` honors `--kimi-code-home`, then `KIMI_CODE_HOME`, then `~/.kimi-code`.
- `installKimiCodePlugin({kimiCodeHome, pluginSource, cliPath, dryRun, now})` copies to `$home/plugins/managed/codex-as-subagent`, localizes manifest command strings to `node <absolute cli> ...`, upserts `$home/plugins/installed.json`, preserves unrelated records, enables the plugin, and is idempotent.
- `install --host=kimi-code` accepts both `--host=kimi-code` and `--host kimi-code`, supports `--dry-run`, and reports Kimi paths/actions without development-only paths in source resources.

- [x] Add tests for clean source manifest, computed destination, localized command, K2.7-only Web worker configuration, backup/idempotence, unrelated plugin preservation, and dry-run no-write。
- [x] Implement atomic JSON writes and first-overwrite backups following ZCode installer conventions, with Kimi's `version: 1 / plugins: [] / id/root/source/enabled` record shape。
- [x] Add CLI host routing and `npm run install:kimi-code` / dry-run scripts。
- [x] Run installer tests plus isolated `node src/cli/main.mjs install --host=kimi-code --dry-run` without writing the real Kimi home。

### Task 4: Official Kimi plugin install compatibility

**Files:**
- Modify: `plugins/kimi-code/README.md`
- Modify: `marketplace.json`
- Modify: `README.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- The same clean `plugins/kimi-code/` directory is installable by Kimi `/plugins install <path-or-url>` and by the project CLI; no host cache edits are required.
- Documentation distinguishes the primary project CLI installer from the official Kimi plugin manager path and explains `/reload` or new session activation.

- [x] Document TUI/Web behavior, session lifecycle, official plugin install, CLI install, timeout, and fallback to `codex_wait`。
- [x] Add the copied reference knowledge base and Kimi official links to the stable documentation index without mixing rules into the reference doc。
- [x] Update dynamic task board/decisions with actual implementation status and known limitation: Web sidecar requires a live local Kimi server instance and current session id。

### Task 5: Integrated verification and user-level acceptance

**Files:**
- Create: `docs/autonomous-runs/20260911-HHmm-kimi-code-integration.md`
- Modify: files only if verification finds a defect.

- [x] Run `npm test`, `npm run lint`, `npm run smoke`, and full source syntax checks。
- [x] Run CLI dry-run against an isolated temporary Kimi home, then install into an isolated real-shaped home and inspect `installed.json`, managed manifest, MCP, Hook commands, and backups。
- [x] Run Kimi Web local API discovery and plugin/session checks through the live Server API without mutating a user session; any prompt path is fixed to K2.7 and no K3 invocation occurs。
- [ ] Execute the real user path: install → `/reload`/new session → MCP discovery → `codex_spawn` K2.7 Codex subagent → completion persistence → Web prompt submit/steer or TUI Hook fallback → ACK/delivered state。当前 live session 不属于本 workspace，且本轮未获创建/发送外部 session 的明确授权。
- [x] Record expected result, command/input, evidence, pass/fail, and residual risk for every path in the acceptance document。
- [x] Perform an independent requirements review in the same session, fix Critical/Important issues, and rerun affected tests before claiming completion。
