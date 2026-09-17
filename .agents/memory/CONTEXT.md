# Project Context

Last updated: 2026-09-16T13:18:26Z

## Summary

Pi 侧项目上下文插件是 Codex 移植的行为基线。记忆一致性修复（A+C）与 handoff 语言/重放两项改动已全部收尾：代码已 push 并打 tag、安装包已切到 v0.1.4、两个 issue 的 fix-note 均为 `confirmed`、本仓库记忆已迁到 journal 且 fold 与 render 一致。当前没有进行中的实现任务，等待下一批需求或 Codex 移植验证结果。

## Key points

- 发布状态：双远端 `master` = `7b424ab`；`v0.1.3`（`e4d48c4`，记忆日志化 + 写锁加固 + 自适应预算）与 `v0.1.4`（重打到 `7b424ab`，handoff 语言/重放 + 部署记录）均已推送；`~/.pi/agent/settings.json` pin `@v0.1.4`，已装副本在 `7b424ab`。
- 版本切换只对新进程生效：handoff 用 `ctx.newSession()` 在进程内换会话，旧进程会继续跑旧代码；本仓库 `.agents/memory/memory.jsonl` 的 baseline 由新代码在 2026-09-16 13:10 建立（与当时 render 逐字符一致）。
- 记忆是 journal-backed：`memory.jsonl` 为权威（`replace`/`append` 记录），`MEMORY.md` 是其派生注入文本与外部编辑入口；外部编辑按「内容不同且 mtime 更新」被采纳，并在下次写入时折入 journal。
- 已修复并验证：consolidation JSON 不可用导致的记忆污染（读路径按 owner 批准的 B 方案解码 + 写入 fail-closed）、handoff 语言随对话（`handoffLanguage: auto`）、重放窗口以 `[handoff prompt omitted]` 替换旧提示词、静默跳过改 warning + 30s 冷却、摘要标题确定性本地化。
- 下一次预期转变：本会话结束时，当前进程（旧代码）的强制 pass 会重写 `MEMORY.md`/`CONTEXT.md`；新内容先被当作 external edit 采纳，再在之后的新代码写入时折入 journal。
- 兄弟仓：UniField（15055 字符）与 Quantum_Matrix（14784 字符）污染记忆已修复，三份 `.poison-backup-*` 逐份核对后删除，未保留备份。
- `.agents/` 与 `.codestable/features/2026-09-15-codex-project-context-port/` 有意不跟踪（后者由并行 Codex app-server 会话持有），清理时保留。
- 测试：`node tests/run-all.mjs` 9/9；`tests/handoff-test.mjs` 79 断言；探针纪律 `-ne` 会禁用 settings 安装包（只留显式 `-e`）。

## Open tasks

- 继续验证 Codex Desktop 移植在真实任务中的 hook、工具结果归档与跨 agent 复原（并行会话持有）。
- 记录在案的残余（owner 已知）：①单个超大轮次使切点落轮内 → older 为空 → 自动交棒无法进行（pre-existing，现会 warn 一次）；②handoff 调用点未被测试钉住（需可注入 summarizer + `newSession` mock）；③`consolidation-test.mjs` 的 10/20/30ms 固定等待。

<!-- latest-session-title: Pi project-context：v0.1.3/v0.1.4 发布、安装切换与记忆同步收尾 -->
