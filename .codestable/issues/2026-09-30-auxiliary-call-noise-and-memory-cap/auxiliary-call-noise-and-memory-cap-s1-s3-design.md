---
doc_type: design
issue: 2026-09-30-auxiliary-call-noise-and-memory-cap
status: implemented-pending-owner-review
created_at: 2026-09-30
related: [auxiliary-call-noise-and-memory-cap-analysis.md, auxiliary-call-noise-and-memory-cap-fix-note.md]
tags: [memory, schema, pointerization, budgets, s1, s3]
---

# S1 + S3 设计（固定 schema + 指针化）

## 目标

- 记忆的顶层结构不再每轮由模型自由生成；给每节挂字符预算，让“只增不删”有闸（S1）。
- 细节指针化：记忆只留“索引 + 不变量 + 路径”，长解释进版本化 docs/（S3）。

## 硬约束

- **向后兼容**：已有自由结构的 `MEMORY.md` 仍能读、能渲染、能剪裁；不得为套 schema 重排或丢事实。
- 不改文件格式：仍是 `# Project Memory` + Markdown，只固定**顶层小节**与预算。
- 改记忆对外形态 → 落地前走 `.agents/skills/pi-project-context-sandboxed-independent-review`（三审三校 6 轮）。

## 现状

- `memory/` 无任何小节解析，`MEMORY.md` 是不透明 Markdown；`prompt.ts` 只给“project facts / decisions / preferences”这类内容提示，不给结构。
- 实测两种形态：UniField 11 节/101 bullet（知识库式内联事实），Quantum_Matrix 5 节/50 bullet（索引式）。体量 ≈ bullet 数 × 单条长度，结构直接决定容量。
- 剪裁目前是 M3 的头尾保留（60/40，整行）；`S4`（按节优先序丢）依赖本节 schema，属后续。

## 决策 1：schema 形态

| | A 角色型（float 原文） | B 领域型 | C 混合（推荐） |
|---|---|---|---|
| 小节 | `定位 / 不变量 / 操作陷阱 / 索引` | `Project / Stack / Conventions / Commands / Pitfalls / Index` | `Project / Invariants / Pitfalls / Index` |
| 迁移 | 9 个领域节压平进 4 角色，大量内容挤进「不变量」 | 自然，丢失少 | 语义按领域放宽，迁移自然 |
| 代价 | 领域信息被压平 | 项目间领域不同，仍需少量自定义节 | 定义略宽，靠 prompt 收敛 |

**推荐 C**：`Project`（purpose / stack / structure）、`Invariants`（决定 / 约定 / 硬约束）、`Pitfalls`（坑与教训）、`Index`（指向 docs / 源文件 / 命令的指针）。丢序（S4 用）：`Index` 最先、`Invariants` 最后。

## 决策 2：强制程度

**推荐软强制（fail-open）**：

- prompt 要求固定 4 节 + 每节预算；写路径**不改内容**，只做 cap 剪裁（沿用 M3）。
- 非符合的记忆照常读 / 写 / 剪裁，下一轮由 prompt 收敛；不做拒绝。
- 理由：硬拒绝（fail-closed）会丢掉整轮记忆，风险高于收益。现有 `context` 用 fail-closed 是因为它是短状态、丢了可重建；记忆是长期事实，不能这样处理。
- 可选增强（本设计**不做**，留 S4 / 后续）：非符合时一次性 reshape 重试；`status` 显示 schema 符合度。

## 决策 3：每节预算

- 每节预算 = (`maxMemoryChars` − 固定开销) × share；固定开销 = `# Project Memory` 标题 + 各 `##` 节标题及其空行。建议 share：`Project 20% / Invariants 40% / Pitfalls 25% / Index 15%`。
- prompt 注入“每节 ≤ N 字符，总计 ≤ cap；超了先节内合并、再跨节去重、最后删最不持久”。
- 剪裁仍用 M3 头尾保留；**按节优先序丢是 S4，不在本次范围**（step 3 列为 `S1 + S3 + M3/M4/M7`，S4 未列）。

## S3 指针化规则（写进 prompt）

- 正例：一行不变量 + 指向来源的指针，如 `see docs/<topic>.md` 或 `file.ts:123`。
- 反例：内联 10 行公式、命令输出、表格。
- **安全规则**：只能指向本项目中**已存在且确实承载该细节**的路径，不得虚构路径；没有归属的细节保持一行内联，绝不“移出后不留指针”。
- 命令 / 配置这类可再生的细节进 `Index`（`路径:行` 或命令名 + 一句作用）。

## 向后兼容与迁移

- 读 / 写 / 剪裁路径不变；无 schema 的旧记忆原样工作（回归测试覆盖）。
- 迁移靠 prompt：下一轮 consolidation 时模型把现有内容归入 4 节并保事实；**不做离线重写工具**（会丢事实）。

## 测试计划

- prompt 含 4 节标题、按 cap 计算的每节预算数字、指针正 / 反例、“不得虚构路径”。
- 非符合记忆仍可 `normalizeMemoryDocument` / 渲染 / 剪裁，且幂等。
- 预算数字随 `maxMemoryChars` 变化（复用 `tests/memory-budget-test.mjs` 框架）。
- 所有既有记忆测试保持通过（向后兼容）。

## 评审计划

- 6 轮只读 sandbox 评审，每轮 before/after `git status` + `stat` 快照证明零写入；artifact 存本 issue 目录。

## 决策记录（本轮落地）

owner 经「继续」委派推进，本轮按**推荐默认**落地：schema C（`Project / Invariants / Pitfalls / Index`）+ 软强制 fail-open + 份额 `20 / 40 / 25 / 15`。每节带一句内容说明（F3）；固定开销（标题 + 4 个节标题及其空行）先扣除再分预算（F1/R3）；指针示例改为通用占位，且要求目标已存在并确实承载细节（F2）。三项确认仍待 owner 复核；若改选，只动 `memory/schema.ts` 常量与 prompt 文案，机制不变。

独立只读评审 6 轮已完成（对 `a3f8370`…`c23cf5f`，transcript 见本目录 `…-s1-s3-review-roundN-*`）：round1/2/5 CHANGES-REQUESTED，round3/6 PASSED/REVIEW-SOUND，round4 REVIEW-SOUND。

## 残余（已知且接受）

- 无符合度可见性（status 不报告记忆是否收敛到 schema）；模型可以永远忽略 prompt 的结构要求。属本设计明确的可选增强，留给 S4 / 后续。
- `memorySectionBudgets` 的 `Math.max(0, cap − overhead)` 在 `MIN_MEMORY_CHARS = 4000` 下不可达（fixed schema 开销 76）；保留为防御分支，无回归用例。
- `schema.ts` 从 `document.ts` 导入 `MEMORY_HEADER`。当前无环；S4（按节优先序丢）若落在 `document.ts` 的 clip 路径并反向引用 `schema.ts`，需先把 header 拆到叶子常量模块。
- 固定开销对每节都预留一个空行（2 字符），最后一节多预留 1 字符；已用 `overhead === 76` 钉住，属保守方向。
