# Codex As Subagent for Kimi Code

当任务适合并行探索、独立实现或验证时，可以使用 `codex_spawn` 把工作交给本机 Codex subagent。`codex_spawn` 永远异步返回 `threadId`；需要等待结果时使用 `codex_wait` 或 `codex_wait_many`，也可以继续当前工作，完成结果会通过 Hook 回流注入（TUI）或由 Runtime 事件驱动直接投递到当前 Session（Web）。

收到 `<codex-completion>` 后，把它当作后台子任务的结果处理：检查状态、摘要和 changed files；如果结果来自 `PreToolUse`，原工具调用尚未执行，只有在仍然需要时才重试。

不要向 Codex 工具传递 cwd、workspace、sandbox 或 approval 参数；当前 Kimi 工作目录是唯一 workspace 边界。模型和 effort 遵循 `codex_models` 返回的可用值。
