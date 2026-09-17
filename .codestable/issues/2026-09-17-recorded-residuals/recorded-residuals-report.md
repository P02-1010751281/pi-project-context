---
doc_type: issue-report
issue: 2026-09-17-recorded-residuals
status: open
path: quick
created_at: 2026-09-17
related: [recorded-residuals-analysis.md, recorded-residuals-fix-note.md]
tags: [residuals, gitignore, handoff, context, status]
---

# 记录在案残余收口 问题报告

触发（2026-09-17）：owner 问「不是还有个残余项没修复吗？」，随后一句「all」要求把盘出的残余全部修掉，并顺带查清
「注入的项目上下文为什么停在 09-16」。

## 盘点：记录在案、此前「接受/可选」而未修的项

| # | 项 | 记录处 | 原判定 |
|---|---|---|---|
| 1 | 用户手写 gitignore header 大小写不同时，`ensureMemoryGitignore` 会再写一条重复 header | `.codestable/issues/2026-09-17-handoff-session-continuity/…-fix-note.md` §7（lane A 第 3 轮唯一 minor） | 接受（注释无语义、修法需额外的折叠集合） |
| 2 | 会话头首行 >64KB 时 `readSessionHeader` 截断 → `JSON.parse` 失败 → 父链扁平化退化为旧行为 | 同 issue fix-note §5（R1-F5） | 接受（无现实触发场景） |
| 3 | staging 与 `newSession()` 之间进程崩溃 → marker 残留，靠 10 分钟 TTL 兜底 | 同 issue fix-note §5 | 接受（TTL + predecessor 双限制） |
| 4 | `/project-context` 命令输出不含 poison / unreadable 等记忆状态字段 | `.codestable/issues/2026-09-15-consolidated-memory-json-poison/…-fix-note.md` §5「自愈可见性：部分解决」 | 可选后续增强，一直未做 |

另注：`CONTEXT.md` 里列的「记录在案的残余（owner 已知）①②③」（超大轮次 / handoff 调用点未钉住 / consolidation-test 固定等待）**均已修复**
（`093dbf3` 轮内切分 + `SPLIT_TURN_MARKER`；`98aeedf` 的 alias-override stub + `newSession` mock；全 tests 目录只剩 yield 用的 `setTimeout 0`）。
该渲染最后更新于 2026-09-16T13:18Z，落在 v0.1.5/v0.1.6 之前 —— 这正是「看起来还有残余」的来源，也牵出第 5 项：

## 新增调查：CONTEXT.md 为什么停更

- 实测：本仓 `MEMORY.md` 于 09-17 22:12 被 consolidation 重写，`CONTEXT.md` 仍是 09-16 13:18 的内容（`Last updated: 2026-09-16T13:18:26Z`），
  `errors.log` 里没有任何相关记录 —— 也就是「什么都没失败，所以哪儿都没痕迹」。
- 影响：注入给模型的 `<project context>` 与项目真实状态脱节（它还写着 v0.1.3/v0.1.4 收尾）。

## 范围

- 4 条残余全部修复（代码 + 探针 + 变异自检），第 2/3 条会改动既有语义，需在 fix-note 与文档中写明。
- CONTEXT.md 停更：定位根因（见 analysis）并按最小修法修掉「静默」这一环。
- 走完整仓库流程：全量测试 → 变异矩阵 → lane A 独立复审（只读沙箱、零写入）→ artifacts → owner 发话后提交/推送/发版。
