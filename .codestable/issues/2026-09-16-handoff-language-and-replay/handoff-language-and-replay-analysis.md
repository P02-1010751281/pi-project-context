---
doc_type: issue-analysis
issue: 2026-09-16-handoff-language-and-replay
status: confirmed
path: quick
related: [handoff-language-and-replay-report.md]
tags: [handoff, i18n, replay, root-cause]
---

# handoff 语言与重放窗口 Analysis

## 1. 根因

### 1.1 语言（英文脚手架）

- `extensions/project-context/handoff.ts` 的注入脚手架（preamble、章节标题、`Continue the task…`、
  `# Handoff from pi session …` 文档头）全部是硬编码英文字面量。
- 摘要调用参数 `SUMMARY_FOCUS` 只有内容要求，**没有输出语言指令**；正文写成中文只是因为模型
  自发跟随对话语言。
- 摘要的**章节标题**来自宿主 pi 的 compaction 模板
  （`pi-coding-agent/dist/core/compaction/compaction.js` 的 `SUMMARIZATION_PROMPT` /
  `UPDATE_SUMMARIZATION_INSTRUCTIONS`，含 `Use this EXACT format:` 与英文标题），
  本扩展的 focus 以 `Additional focus: …` 追加，默认不改变标题语言。

### 1.2 重放窗口带入旧 handoff 提示词

- 交棒语义：`older` 部分 → 摘要；最近 `handoffKeepTokens`（默认 20k）**逐字重放**；
  新会话写入顺序 = `setup` 阶段重放块 → `withSession` 注入新提示词。
- 因此若上一会话自身的注入提示词落在 keep 窗口内，会被原样重放进新会话，看起来像"新指令"，
  内容却是上一代（甚至上两代）的状态快照。
- 实测：`01a0a7a9` 的切点恰好是它自己的 entry 81（16% 提示词）→ `01a0a7b1` 重放块以它开头。
- 「为什么 16% 提示词在 entry 81 而不是开头」：不是延迟投递，而是**顺序**——重放块先写入，
  注入提示词随后追加；16% 摘要覆盖的是会话较早部分（设计如此），所以内容看起来"旧"。

## 2. 方案（最终实现）

| 项 | 设计 |
|---|---|
| 配置 | `handoffLanguage: "auto" \| "zh" \| "en"`（默认 `auto`）；兼容嵌套 `handoff.language` 与全局旧文件 |
| 语言判定 | 采样 user 消息（排除 handoff 提示词与省略 marker）；优先最近 8 条（总长 ≥40 字符）否则回退全会话。三级规则：① CJK ≥2 → `zh`；② 否则拉丁字母 ≥20（实质性英文）→ `en`；③ 否则沿用最近一条被识别提示词的语言（`promptLanguage`），无则 `en` |
| 脚手架 | `handoff.ts` 内置 zh/en 文案表（提示词 + `HANDOFF.md` 文档头 + `percentUnknown`）；提示词/文档按语言渲染 |
| 摘要 | `summaryFocus(language)` 在 `SUMMARY_FOCUS` 后追加语言指令（"Write the whole summary in Simplified Chinese, including the section headings."） |
| 重放 | `replayMessagesFor()`：切片起点保持 `findCutPoint`（含 turn 对齐）结果，旧提示词被替换为 `REPLAY_MARKER = "[handoff prompt omitted]"`（保留 user 起始，Anthropic/Gemini 要求；marker 不参与语言采样） |
| 预算 | `sliceTokens` = 原始切片 token（含旧提示词）→ `baselineNow = usage - older - sliceTokens`；新会话内容 = 重放后 `keptTokens`（含 marker） |
| 命令 | `/auto-handoff lang auto\|zh\|en`；`status` 显示 `lang auto (zh)` 解析结果 |
| 通知 | 仍为英文（与扩展其余 notify 文案一致） |

**为何“替换”而不是“删除”**：切片首条若正好是旧提示词，删除会让重放块以 `assistant(toolCall)`
开头，原生 Anthropic/Gemini 路由要求首条为 user（400）。**为何不回填 keep 配额**：回填需要把
`firstKeptIndex` 左移，会破坏 pi 的 turn 对齐、重放孤儿 `toolResult`（round 2 实测 blocking）；
配置的 keep 预算因此是“上界”，丢弃部分不补位（已接受）。

## 3. 验证

- 单测：`tests/handoff-test.mjs`（语言三级规则、zh/en 渲染、guard/carry 变体、旧格式识别、
  引用不误伤、marker 替换与 user 起始、文档头、config 三层解析、命令持久化）。
- 真机探针（2026-09-16，deepseek-flash，thinking off）：用 pi 原始 `SUMMARIZATION_PROMPT`
  + 中文 focus 指令实跑一次，输出标题全部中文（`## 目标`/`## 约束与偏好`/`## 进展`/`### 已完成`/
  `### 进行中`/`### 受阻`/`## 关键决策`/`## 下一步`/`## 关键上下文`），确认指令可覆盖
  `Use this EXACT format:` 的默认标题。
- **修正（同日）**：C2 真 TUI 自动交棒实跑抓到反例 —— 模型正文中文、标题却照抄模板英文
  （`## Goal`/`## Constraints & Preferences`…），即该服从性不稳定。因此新增确定性映射
  `localizeSummaryHeadings()`（按 pi 固定标题集逐行精确匹配，zh→en 双向），不再依赖模型服从；
  映射样本取自该次真机输出。真机复核：注入提示词与 `HANDOFF.md` 标题均全中文。
- 无操作返回可见性：两个静默 return（空会话 / older 为空）改为 warn notify；auto 路径加 30s 冷却。
- 独立审查 round 1–4（独立 pi CLI + 只读沙箱副本，运行前后 md5 比对零写入），记录见同目录
  `…-review-round{1,2,3,4}-independent.txt` 与 `handoff-language-and-replay-review.md`；
  C3 + 标题映射另做 round 5。

## 4. 残余风险（已接受/待观察）

- `auto` 判定是启发式：仅 1 个 CJK 且上下文无提示词时回退 `en`；实质性英文（≥20 拉丁字母）
  会把中文会话判成 `en`（设计如此）；可用 `lang zh`/`lang en` 显式覆盖。
- 语言指令能否覆盖宿主 `Use this EXACT format:` 依赖模型服从；真机实测**不稳定**（C2 抓到正文中文、
  标题英文的反例），已由 `localizeSummaryHeadings()` 确定性映射兜底（标题不再依赖模型）；正文语言仍
  依赖指令（不做后处理）。
- 单轮超大导致无法交接（pre-existing）：切点落在同一轮内时 turn 对齐把切点拉回该轮起点，older 为空
  → 没有可摘要内容，自动交棒持续跳过（现会 warn 一次 + 30s 冷却）。真机数据：54k token 会话中单轮
  4×12.8k toolResult，keep=2000 时 older=0。真正修复需轮内切分 + toolCall/toolResult 配对补齐，风险高，
  本 issue 不做。
- keep 预算成为上界：旧提示词被替换为 marker，丢弃的原文不补位（防 turn 对齐破坏）。
- `older` 部分若含更早的 handoff 提示词，仍会进入摘要输入（不重放，只影响摘要措辞）。
- 识别与格式强耦合：`HANDOFF_PROMPT_PREFIXES/HEADINGS/CLOSINGS` 与脚手架同文件维护，改文案需同步。
- 繁中会话判 `zh`、脚手架输出简体；日语汉字会话会误判 `zh`（只支持 zh/en）。
- compaction 条目不计入 `olderTokens`（pre-existing），预算偏保守。
