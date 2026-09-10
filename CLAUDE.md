# CLAUDE.md

## 当前阶段

- 目标：按 docs/Codex As Subagent — 详细设计与编码规格.md 自主交付尽可能完整的 V1，并形成可运行、可测试、可继续演进的 Git 仓库。
- 阶段：Task 1 仓库基础已完成；后续继续实现 Runtime、MCP、Hook、生命周期和插件。
- 基线：2026-09-11，已完成 Git 分支、package manifest、CLI/共享常量、源码与测试目录骨架及 pinned Submodule。
- 默认裁决：使用 Node.js ESM 与内置 node:sqlite；以 fake/in-memory Supervisor Adapter 支撑确定性单元测试，同时保留真实上游 Adapter 接口。

## 任务看板

- [x] 通读详细设计，提取 V1 固定契约、目录结构、关键测试和核心不变量。
- [x] 创建 README.md、AGENTS.md、CLAUDE.md，明确三者职责。
- [x] 初始化 Git 分支与 .gitignore，固定上游 codex-supervisor-mcp Submodule。
- [x] 建立 package/CLI/源码目录和共享协议常量。
- [ ] 实现 Supervisor Adapter、WorkspaceGuard、SQLite StateStore。
- [ ] 实现 RuntimeManager、TerminalResult、CompletionRouter 与双消费者 delivery。
- [ ] 实现 Unix Socket Runtime Server、stdio Bootstrap、lazy start、startup lock、idle shutdown 与 recovery。
- [ ] 注册并实现十个 MCP 工具的稳定 schema 与 compact response projection。
- [ ] 实现 Hook drain、lease 恢复和 Host wrapper；补齐 ZCode 插件配置。
- [ ] 完成 unit/integration/smoke 回归、独立 Review 和用户级验收记录。
- [x] 自主执行 git commit；不执行 push、发布或跨工作区合并。

## 当前动态决策

1. Runtime 技术栈：选用 Node.js 24 ESM + node:sqlite，避免 V1 为数据库引入额外 native 依赖；代价是 Node 版本要求提升到 24+。
2. 上游接入：主仓库通过 vendor/codex-supervisor-mcp 固定 Submodule；业务代码只依赖 Adapter 的稳定接口，测试默认使用 fake adapter，避免依赖本机 Codex session 才能跑通回归。
3. MCP transport：V1 保持 stdio Bootstrap 与 Unix socket Runtime 的分层；若 MCP SDK 引入量过大，先用最小 JSON-RPC/MCP 兼容实现，接口行为与工具 schema 优先。
4. 不确定项处理：详细设计没有锁定上游具体 commit、Host Hook stdin/additionalContext 协议细节、Codex app-server 当前 wire schema 和 dedicated profile 安装方式；本轮先提供可替换 Adapter、Host wrapper 配置和明确错误边界，并在最终报告列出待确认项。

## 执行边界

- 主 Agent 负责需求收敛、任务排序、集成、独立 Review、最终验证与用户级验收。
- 子 Agent 按计划分配互不重叠的写入范围，不创建新的子 Agent，不修改 docs/Codex As Subagent — 详细设计与编码规格.md。
- 所有当前阶段更新写入本文件；稳定使用说明写入 README.md；通用规则写入 AGENTS.md。

## 完成定义

本轮至少应具备：可安装的 Node 项目；固定 Submodule；SQLite completion-first 状态机；workspace fail-closed；十个工具的 schema/handler；wait/wait_many 与 Hook 的同库双消费者；stdio/Unix socket 运行骨架；ZCode 插件配置；关键状态机和用户路径测试；完整验收记录。真实 Codex app-server 与 ZCode E2E 若受本机外部状态限制，必须明确记录证据和遗留风险。
