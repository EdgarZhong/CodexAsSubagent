# Codex As Subagent for Kimi Code

当任务适合并行探索、独立实现或验证时，可以使用 `codex_spawn` 把工作交给本机 Codex subagent。`codex_spawn` 永远异步返回 `threadId`；需要等待结果时使用 `codex_wait` 或 `codex_wait_many`，也可以继续当前工作，完成结果会通过 Kimi Hook 或 Web session 回流。

收到 `<codex-completion>` 后，把它当作后台子任务的结果处理：检查状态、摘要和 changed files；如果结果来自 `PreToolUse`，原工具调用尚未执行，只有在仍然需要时才重试。

不要向 Codex 工具传递 cwd、workspace、sandbox 或 approval 参数；当前 Kimi 工作目录是唯一 workspace 边界。模型和 effort 遵循 `codex_models` 返回的可用值。

Codex As Subagent 的 Kimi Web 主动回流固定使用 Kimi K2.7（`kimi-code/kimi-for-coding`）；不要为了回流或验收选择 K3 模型。
