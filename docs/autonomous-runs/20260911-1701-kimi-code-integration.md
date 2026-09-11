# Kimi Code 集成自主实现与验收记录

日期：2026-09-11 17:01（Asia/Singapore）

## 结论

Kimi Code 集成的代码、插件资源、安装器、确定性 Web 回流和共享 SQLite delivery 状态机已完成并通过验证。真实 Kimi Server 的只读 discovery 已通过；没有向现有用户会话发送测试 prompt，因此“新 session → MCP → Codex spawn → Web prompt/steer → delivered”的外部用户路径保留为待授权验收项。

实现依据了 Kimi 官方 [Server API](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/server-api.html) 的 `{code,msg,data}` envelope、`content` text block、`prompt_id` 幂等字段和 prompt steer endpoint，以及官方 [Plugins](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/plugins) / [Hooks](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/hooks.html) 的 manifest 与 exit code 2 block 语义。

## 用户行为路径

| 路径 | 预期结果 | 实际命令/输入 | 证据 | 结果 |
|---|---|---|---|---|
| Kimi TUI 无 pending | `PreToolUse` 正常 allow，不影响原工具 | `renderCompletions([], "kimi-code", {event:"PreToolUse"})` 及 Hook wrapper 回归 | `tests/unit/hook-drain.test.mjs` | 通过 |
| Kimi TUI 命中 pending | `PreToolUse`/`Stop` 以 exit 2 block，并明确原工具尚未执行；`UserPromptSubmit` 注入上下文 | `renderCompletions([completion], "kimi-code", {event})` | `Kimi blockable hooks explain...` | 通过 |
| 插件资源检查 | manifest 使用官方 `event/command/timeout`、无 ZCode 专属字段、MCP timeout 覆盖 500 秒 | `node --test tests/unit/plugin-layout.test.mjs` | Kimi manifest 6 个事件、`startupTimeoutMs=60000`、`toolTimeoutMs=520000` | 通过 |
| Web 实例发现 | 扫描 `server/instances`，Bearer 访问 session API，并校验 session id 与 canonical workspace | `node --test tests/unit/kimi-web.test.mjs` | discovery、workspace mismatch fail-closed 测试 | 通过 |
| Web 活动轮次 | 独立提交 completion prompt，固定 `kimi-code/kimi-for-coding`，只 steer 自己的 `prompt_id` | `node --test tests/unit/kimi-web.test.mjs` | body 含 `content:[{type:"text"}]`、`prompt_id`、K2.7；仅目标 prompt steer | 通过 |
| Web 幂等重试 | 40903/40927 等已接受冲突视作幂等成功；网络失败不 ACK | `node --test tests/unit/kimi-web.test.mjs tests/integration/kimi-web-delivery.integration.test.mjs` | 132 项总回归中含 prompt replay、network failure lease 测试 | 通过 |
| completion 持久交付 | SQLite 先落 terminal；Web worker claim 后仅在 Server 接受时 ACK 为 delivered | `node --test tests/integration/kimi-web-delivery.integration.test.mjs` | 成功路径为 `delivered`；失败路径为 `claimed_hook`，时间推进后回到 `pending` | 通过 |
| attach/detach | 同一 session/workspace 只启动一个 worker；detach 只处理命令标记匹配的 PID | `node --test tests/unit/kimi-web-cli.test.mjs` | registry 幂等和 command-marker 安全匹配 | 通过 |
| CLI 安装 | 托管副本命令本地化为绝对 Node + CLI 路径，保留其它插件，首次覆盖留 `.bak-cas` | 隔离 home 执行 `node src/cli/main.mjs install --host=kimi-code` | `tests/unit/install-kimi-code-plugin.test.mjs`；实际检查 6 个 hooks 和 localized MCP command | 通过 |
| dry-run | 不写入 Kimi home | `node src/cli/main.mjs install --host=kimi-code --kimi-code-home <tmp> --dry-run` | 输出安装计划；临时目录已移入废纸篓 | 通过 |
| 真实只读 discovery | 现有 Kimi 0.42.0 session 可被发现；错配当前仓库 workspace 必须返回 null | 对现有 session 调 `discoverKimiServer`，不发送 prompt | 返回 server `127.0.0.1:58627`；错配返回 `null` | 通过 |
| 完整外部 Web 投递 | 新 session + MCP + Codex completion + prompt/steer + delivered | 本轮未执行：现有 live session 属于其他 workspace，创建新 session/发送 prompt 会改变外部用户状态 | 代码和 fake Server/SQLite 集成已覆盖；待用户明确授权隔离 session 后执行 | 待授权 |

## 集成验证

已执行并通过：

```text
npm test                         # 137/137 pass（最终回归）
npm run lint                    # pass（覆盖全部 src/**/*.mjs 的 Node 语法检查）
npm run smoke                   # pass
find src tests -name '*.mjs' ... node --check  # pass
git diff --check                # pass
隔离 Kimi home 实际 install     # pass：managed manifest、6 hooks、localized MCP、installed.json
```

## 遗留风险与边界

- Kimi Web Server API 官方标注为 experimental；运行时因此每次通过实例记录、session API 和 canonical workspace 重新校验，不缓存 token 或 session owner。
- Web sidecar 不会因为网络失败标记 delivered；失败 completion 依赖 lease expiry 和 TUI/后续 worker 重试。
- 本轮没有创建临时 Kimi session，也没有调用 Kimi 模型；因此没有宣称真实 prompt/steer 用户路径已经通过。
- Web delivery 固定 K2.7 `kimi-code/kimi-for-coding`，代码和测试均拒绝 K3。
