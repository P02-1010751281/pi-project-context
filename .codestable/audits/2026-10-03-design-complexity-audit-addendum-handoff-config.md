---
doc_type: audit
subject: 设计复杂度补审（handoff/* 与 shared/config.ts）
created_at: 2026-10-03
related: [2026-10-03-design-complexity-audit.md, ../issues/2026-10-03-external-edit-adoption-overwritten/external-edit-adoption-overwritten-design.md]
tags: [process, design-review, complexity, evidence, handoff, config, strict-mode]
---

# 补审：`handoff/*` 与 `shared/config.ts`（把主审计的「未查完」做全）

主审计本书的「未查完（诚实声明）」点名了四个文件；本文把那四个全部查完，并顺带把 `handoff/settings.ts`、`handoff/summary.ts`
与「strict/结构化输出」那条论断一起查实。判据沿用主审计的三条：**机制必须能追溯到现场事实**、**膨胀信号**、**规模比**。

## 1. 实测数据（2026-10-03，全部本机亲跑）

| # | 探针 | 结果 |
| --- | --- | --- |
| P1 | 本机所有 `project-context.json`（9 个）的键 | 23 键**全部存在**（扩展每次写全量）⇒ 看「谁被用过」必须与 `DEFAULT_CONFIG` 逐键比，不能看键是否存在 |
| P2 | 9 个配置里**被改过**（≠ 默认）的旋钮 | **只有 1 处**：`UniField` 的 `maxMemoryChars 32000 → 36000`。其余 8 个文件全默认。`autolearnAt` 是机写状态，不算旋钮 |
| P3 | 旧布局/旧文件是否还在 | 嵌套 `features.*`/`autolearn.*`/`handoff.*`：**0/9**；`autolearn.json`：**0**；`~/.pi/agent/auto-handoff.json`：**0** |
| P4 | `errors.log` 里的 handoff 故障 | **有 6 条栈**（含 `handoff/run.ts:262` 与命令入口 `:490`，另有旧合并文件 `handoff.ts:1180/1235/1275`） |
| P5 | `prompt.ts` 的标题映射 vs pi 真模板 | 模板 = `pi/dist/core/compaction/compaction.js:379` `SUMMARIZATION_PROMPT`（更新用模板在 `:411`，标题集相同）：`## Goal`/`## Constraints & Preferences`/`## Progress`(+`### Done`/`### In Progress`/`### Blocked`)/`## Key Decisions`/`## Next Steps`/`## Critical Context` = **9 行**，**全部被映射、无死项**（见 §3.1） |
| P6 | `saveConfig` 是否走锁 + 新鲜读 | 走 `updateConfig`（`withMemoryLock` + 重新 `parseConfig`）✓（见 §3.2） |
| P7 | `run.ts` 的测试覆盖 | `tests/handoff-test.mjs` 覆盖纯构造器 + `statusText`/`resolveThreshold`/`resolveLanguage`/replay/marker，**并且用 `newSession` mock 覆盖了 `runHandoff` 的五条路径与 `maybeTrigger` 的「不叠加」负断言**（见 §2.4 更正） |

## 2. 发现

### 2.1【重要·成本】handoff 的调优面在本机一次都没被用过

8 个 handoff 旋钮（`handoffAdaptive`/`handoffThresholdRatio`/`handoffTargetTokens`/`handoffKeepTokens`/`handoffSummaryThinking`/
`handoffMode`/`handoffGuard`/`handoffLanguage`）在 P2 里**没有任何一个**出现非默认值，却换来：

- 命令 handler ~170 行 / 12 个分支 + 两级补全表（`HANDOFF_VERBS`、`HANDOFF_VALUE_COMPLETIONS`）；
- `statusText` 的分支树（阈值标签 + 拒绝文本 + 覆盖提示 + 目标/摘要投影 + 语言采样）；
- `saveConfig` 的 8 键补丁、`config.ts` 的解析与 legacy 链、以及每个旋钮的 `parseXxx` 校验与用法提示。

**证据边界（必须说清）**：这是**本机**证据。扩展是公开发布品（双远端），别人可能真的在用这些旋钮。
所以结论是「**停止再加旋钮、别再为此扩面**」，不是「删掉」——按主审计判据 1，追不到现场事实的**新增机制**不进方案。

### 2.2【重要·可退役项】旧配置兼容层在本机没有现场证据

`config.ts` 的兼容面（`legacyDefaults()` 读 `autolearn.json` + `~/.pi/agent/auto-handoff.json`；嵌套
`features.*`/`autolearn.*`/`handoff.*`；以及 `threshold`/`ratio`/`autoTargetTokens`/`keepRecentTokens`/`summaryThinking`/
`mode`/`guard`/`language` 的 `??` 回退链）在 P3 里 **9/9 项目都没有对应文件**。成本：每次解析多 2 次文件读 + 约 35 行 fallback 链。

迁移是**单向**的（读旧布局、写新扁平布局），所以这层可以定一个退役窗口（例如再发一版之后删），而不是永久背着。
在此之前它是「面向外部安装的兼容」，不是本机 bug。

> **2026-10-06 收口（现场事实，退役问题按反方向结束）**：用 `legacyConfigPatch` 真正认的六个改名键
> （`autoConsolidate` / `autoLearn` / `handoffTargetTokens` / `handoffKeepTokens` / `handoffAdaptive` / `handoffLanguage`）
> 重扫本机 10 个 `.agents/memory/project-context.json`：**2 个（`形式化证明`、`HWCup-Math-A`）六个键全带**，其余 8 个干净。
>
> 2026-10-08 重扫：9 个文件（`~/.agents` 那一个不是项目配置），**3 个六个键全带**（新增 `Watermarking for VQ-TTS Models`）；键数 22（`handoffThinking` 退役后少一）。上面 10 个/2 个/23 键是 2026-10-03 的快照。
> 也就是说这层兼容**正在真场上干活**——那两个项目的设置只因为迁移存在才没被静默丢掉；而旧键之所以还在，是因为读路径
> 非破坏（只有写路径才重写文档）。原判据「等一条 0 命中以外的现场事实」因此以**相反方向**满足：退役会真丢配置。
> 处置：**保留，不定退役窗口**；此前 §9.10 的「等事实」不再是挂账，而是已决。

### 2.3【现场事实 + 残留·跨特性耦合】handoff 有一条真实的失败链路

P4 的栈显示：`session_shutdown` 期间的**记忆 consolidation 抛错**（`memory/pass.ts:109` ← `report.ts:57` ← `:197`）
沿 `AgentSessionRuntime.teardownCurrent → newSession` 冒泡，让 `runHandoff` 在 `ctx.newSession(...)`（`run.ts:262`）失败 ⇒ 走
catch-all 提示 + 失败退避。

- 这**证实**了失败退避/提示机制有据（不是预防性代码）。
- 同时记一条**跨特性耦合残留**：handoff 事务的成功依赖 memory 特性不在 shutdown 抛错。本次审计不改它（无新机制诉求即有据，但有据也需要单独立项）。

> **2026-10-06 收口**：残留已立成可追踪 issue——`.codestable/issues/2026-10-06-handoff-shutdown-coupling/brief.md`
> （现场事实、现有防御性守卫及其无法在 harness 钉住的原因、三条待 owner 选的处置）。本附注不再单独挂账。

### 2.4【已更正·原为误判】触发门与事务其实有测试

> **更正（2026-10-04，补审二实测）**：本节原文写「`maybeTrigger` 与 `runHandoff` 无测试」，**是错的**。
> `tests/handoff-test.mjs` 第 10 行的自述就是「the `runHandoff` call sites are pinned through a stubbed summarizer
> plus a `newSession` mock (review round 5, F3/F5)」，实测也确实如此：
> - `maybeTrigger`：`runHandlers(..., "agent_settled")` 触发，断言发出了 `/handoff force-auto`（:368-370），
>   并有负断言「an attempted auto handoff does not retrigger on the next settle」（:377）；
> - `runHandoff`：经 `commands.get("handoff").handler(...)` 进入，五条路径都有 mock ——
>   空会话/keep 窗口内跳过（:321-345）、成功路径（`captureNewSession`，:750/:803）、cancel（:1021）、throw（:1032）。
>
> 该误判的来源是把「`maybeTrigger`/`runHandoff` 未被**直接**导出测试」读成了「未被测试」。项目记忆里同一条错误结论
> 已在本次更正（见补审二 §D1）。

**更正后**：`maybeTrigger` 与 `runHandoff` 的行为面（触发、不叠加、五条退出路径）**已由测试钉住**；
真正未被测试的只是需要真实 pi 会话才能覆盖的端到端切换本身（那是集成测试的范围，不是本模块的缺口）。

## 3. 已核无误（负结果同样是审计结论）

### 3.1 `prompt.ts` 的标题映射与 pi 的真模板完全对齐

映射表的存在依据是现场观察（注释记：「观察到 deepseek-flash 即使在 focus 里要求中文，模型仍照抄 pi 的英文标题」）。
P5 用 pi 的真实模板逐行核对：

- 模板标题 9 行，`zh` 侧**全部覆盖**；`en` 侧的中文键另有 3 条变体是**模型真实产出的译名**（`## 进度`、`### 阻塞` 等，注释记录于 TUI run 2026-09-16）。
- 早期怀疑 `## Critical Context` 是死项（它不在 `branch-summarization.js` 里）——**证伪**：它在 handoff 真正走的
  `compaction.js:379` `SUMMARIZATION_PROMPT` 里，必须映射。
- `## Context Needed to Continue` / `## Original Request` / `## Progress So Far` 只出现在 pi 的**其他**模板，不在 handoff 路径上，
  映射表不收录它们是正确的（收录反成死项）。

### 3.2 `saveConfig` 没有「丢失更新」问题

`settings.ts:62-81` 先构造只含 8 个 handoff 键的 patch，再 `Object.assign(config, await updateConfig(...))`；
`updateConfig` 在 `withMemoryLock` 内**重新解析**当前文件再合并 ⇒ 与 `config.ts` 文档块点名的「handoff mirror 读写竞争（丢 `autolearnAt`）」
不是同一情况。原地 `Object.assign` 的理由也有实测注记（重新赋值 `let` 在宿主模块互操作下传不到命令 handler）。

## 4. 对主审计 strict 结论的补正（回答「有没有比 `supportsStrictMode` 更通用的方法」）

主审计说「strict 半边本机不可达」，7198c14 已更正为「可达，冻结是范围决定」。补审把机制本身查到底：

1. **扩展侧已经是通用档**：两个结构化工具都用 `constrainedSampling: { type: "json_schema", strict: "prefer" }`
   （`autolearn/schema.ts:59`、`memory/sections.ts:384`）。pi-ai 的判据是
   `resolveJsonSchemaStrictSampling(tool, supportsStrictMode, …)`：不支持时 `"prefer"` **静默降级**，`"require"` 直接抛错。
2. **本机路由实际发的是非严格工具**：`commandcode`/`scnet` 没声明 compat，而 `detectCompat` 明确写着
   `// OpenAI compatibility alone does not imply strict JSON-schema tool support.` ⇒ `supportsStrictMode: false`。
   所以结构化输出真正靠的是「schema 描述 + 模型自愿遵守 + 事后抽取/回落（`sectionsFromMarkdown`、`memory_markdown` 解码、opaque 回落、condense 重试）」。
3. **第二条通道（更通用也更强）**：`constrainedSampling: { type: "grammar", variants: { openai_lark, openai_regex } }`
   → 发成 OpenAI **custom tool + grammar**，由 `compat.supportsOpenAIGrammarTools` 控制（默认 false），表达力超 JSON-schema strict。
   代价：要为每个 provider 写语法变体；扩展的 `shared/llm.ts:88` 类型目前**只允许 json_schema**。
4. **要在自己的网关上真开 strict**：先探针验证上游是否真遵守 `strict`（把 schema 收紧到模型必须服从），再在**provider 扩展**里声明
   `compat`。pi 的 `models.json` **不透传** compat（`dist/config.js` 只认 `models.json` 这个路径，模型条目字段里没有 compat），
   而 pi 文档写明：*Compatibility flags describe verified differences… Do not enable them based only on an endpoint claiming compatibility.*
5. 结论排序：**grammar（另一条闸）> `prefer` + 事后校验（现况，任何路由都能跑）> `require`（会在无 compat 的路由直接抛错，不要用）**。
   与主审计一致：冻结 strict 清单是**范围选择**，不是不可达；本机没有任何一条路径在跑真 strict。

## 5. 本次补审的规模账

| 文件 | 行数 | 本次结论 |
| --- | --- | --- |
| `shared/config.ts` | 302 | 8+ 旋钮无现场使用（2.1）；legacy 链可退役（2.2）；`saveConfig` 无丢失更新（3.2） |
| `handoff/prompt.ts` | 199 | 映射表与 pi 真模板完全对齐（3.1），无死项无漏项 |
| `handoff/run.ts` | 538 | 事务/触发门无测试（2.4）；真实失败链路在 `newSession`（2.3）；旋钮面成本（2.1） |
| `handoff/settings.ts` / `summary.ts` | 19 + 71 | 无新发现（`saveConfig` 见 3.2；`summary.ts` 的重试仅对 token-cap 截断重试，与 D2 同源） |

## 6. 未查完（诚实声明，第二轮）

本轮之后仍未审计：`handoff/threshold.ts`（自适应阈值本体，另有独立 skill 覆盖）、`handoff/session-settings.ts`、
`handoff/session-lineage.ts`、`handoff/file-ops.ts`、`handoff/state.ts`、`shared/llm.ts`、`shared/lock.ts`、`memory/*`（`store.ts` 除外，它在本轮修过并有两轮代码评审）。
`shared/complete.ts`、`handoff/format.ts`、`handoff/language.ts`、`handoff/question.ts`、`handoff/text.ts` 属于纯函数层，风险低，可最后扫。
