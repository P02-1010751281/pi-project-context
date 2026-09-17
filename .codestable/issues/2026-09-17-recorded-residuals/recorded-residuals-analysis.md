---
doc_type: issue-analysis
issue: 2026-09-17-recorded-residuals
status: open
path: quick
created_at: 2026-09-17
related: [recorded-residuals-report.md]
tags: [residuals, gitignore, handoff, context, status]
---

# 记录在案残余收口 分析

## 1. 残余 1：gitignore header 的大小写

`ensureMemoryGitignore`（`project-state.ts`）只用 `lines.has(MEMORY_GITIGNORE_HEADER)` 判断 header 是否存在 —— 大小写敏感。
用户若手写过 `# Project-Context: LOCAL artifacts, do not commit` 这类变体，下一次追加缺行时会再写一条标准 header。

- 语义：header 是注释，对 git 无影响；但重复注释会持续堆积（每次追加缺行都可能再加一条）。
- 关键约束：**忽略模式本身必须保持大小写敏感**（git 的匹配语义），只有 header 判定可以折叠大小写。
- 修法：判定改为 `[...lines].some((line) => line.toLowerCase() === MEMORY_GITIGNORE_HEADER.toLowerCase())`，其余不变。

## 2. 残余 2：会话头固定 64KB

`readSessionHeader` 原实现：一次 `read` 64KB，`split("\n")[0]` 后 `JSON.parse`。首行超过 64KB 时 JSON 必然截断 → 抛错 → 返回 undefined →
`resolveHandoffParentSession` 退化为「挂当前会话」（旧行为，树又变深）。

- 现实性：会话头只有 `type/version/id/timestamp/cwd/parentSession`，正常几 KB；但这是**静默降级**，且代价只是「按行读到换行」。
- 修法：按 64KB chunk 读到第一个 `\n`（缓冲合并后再解码，避免多字节字符被 chunk 边界切断），病态上限 1MB；
  上限外无换行 → 视为不可读（fail-open 到旧行为）；无换行的单行文件仍按已读内容解析。
- 边界：`type !== "session"`、缺失、环、hop 上限等既有分支不变；读取仍是「首行 + 提前退出」，不会整文件读入。

## 3. 残余 3：崩溃残留 marker

`stageHandoffSessionSettings` 写 marker → `ctx.newSession()`。两者之间进程崩溃时 marker 留在盘上，原设计靠 10 分钟 TTL 兜底
（`reason === "new"` 且前驱匹配才会消费并清理）。

- 观察：**只有那一个前驱的继任者**能消费 marker。前驱不匹配（例如用户随后 `/new`）时，旧代码把它留着等 TTL —— 这是白留。
- 修法：前驱不匹配即清（fail-open，不影响本会话）。正常 handoff 的前驱仍然命中 → 继承语义不变；`resume` 仍在廉价 guard 处提前返回（不解析项目根）。
- 语义变更（需记录）：此前「外部新会话不会清理 marker，marker 存活到 TTL 或下一个匹配的继任者」；现在「前驱不匹配即清」。

## 4. 残余 4：命令输出缺记忆状态

`/project-context status` 原本只有三行（features / aux / config path），记忆的存储形态（journal-backed）、可读性、污染与损坏都只在 `/memory` 里看得到。
`loadMemory()` 是纯读（折叠 journal；带锁的写路径在 consolidation 侧），因此可以直接用于只读状态输出。

- 修法：新增两行 ——
  - `Memory: <source> (<n> chars)`，并按 `unreadable` / `poisoned` / `damaged` 变体给出可诊断文案；
  - `Context: <path> — updated <ISO> (<age> ago)`（无 CONTEXT.md 时写 `none yet`）。
- 意义：第 5 项的「停更」之所以能潜伏，就是因为状态输出里看不见 CONTEXT.md 的时间。

## 5. CONTEXT.md 停更的根因

证据链：

1. `CONTEXT.md` mtime = 2026-09-16 13:18，`MEMORY.md`/`memory.jsonl` = 2026-09-17 22:12（同一仓库、同一扩展）；
2. `errors.log` 仅 1 行（09-16 08:36，外部编辑采纳），没有任何失败记录；
3. `project-context.json` 的 `provider`/`model` 均为空 → 辅助模型 = **会话模型**（随会话变化）；
4. 写入路径 `const update = outcome.result.context ?? (existingContext.trim() ? undefined : fallbackUpdate(ctx));` ——
   模型没给出可用 `context` 时，已存在的 `CONTEXT.md` 保持不动（这是有意的「不覆盖未知」策略），但**没有任何记录**。

而 `parseContext` 要求 `context` 是对象且含字符串 `summary`；prompt 里只用自然语言描述「a short title, a summary … key points, and open tasks」，
**从未写出键名与类型**。于是模型（尤其换了会话模型之后）完全可能回答成 Markdown 字符串或 `keyPoints/openTasks` 这类别的键名：
memory 照写，context 被静默丢弃，`CONTEXT.md` 停在原地，日志里一个字也没有 —— 与本仓实测完全吻合。

修法（三件小事，都不改写入语义）：

1. prompt 明确写出 `context` 的键与类型，并说明「非该形状的 context 会被丢弃」；
2. `parseConsolidated` 增加 `contextUnusable` 标记（键缺失或为 `null` 视为「无 context」，不算不可用）；
3. 调用侧在 `contextUnusable` 时向 `errors.log` 记一次（每项目每进程最多一次，避免每个 pass 刷屏），并在 status 里暴露 CONTEXT.md 的年龄。

保留：模型没给 context 时仍不覆盖既有 `CONTEXT.md`（不引入「用空内容清空上下文」的新风险）。

## 6. 残余风险（本轮之后仍接受）

- 会话头 >1MB 仍退化为旧行为（病态输入；无换行的单行文件正常解析）。
- `context` 形状仍无 schema 强制（模型可自由回答）：本轮只保证「mis-shape 可诊断 + prompt 已给出键名」。
- `errors.log` 不轮转（既有设计），本轮新增的 note 每项目每进程最多 1 行。
