---
doc_type: issue-review
issue: 2026-09-16-handoff-language-and-replay
status: passed
path: quick
reviewer: independent pi CLI (lane A, read-only sandbox copy)
rounds: 4
created_at: 2026-09-16
---

# handoff 语言与重放窗口 Review

## 审查方式

- lane A：独立 `pi` CLI 进程（独立上下文），参数
  `pi -p --no-session --no-extensions --no-skills --no-prompt-templates --tools read,bash`。
- 每次在 `/tmp/pi-context-rev-handoff<N>/` 只读沙箱副本上审查工作树 diff（基线 HEAD `e4d48c4`）。
- 每次运行前后快照 `git status --porcelain` 与全仓库 md5 清单并 diff：**四轮均零写入**。
- 记录：`handoff-language-and-replay-review-round{1,2,3,4}-independent.txt`。

## 逐轮记录

| 轮次 | 结论 | findings 与处置 |
|---|---|---|
| round 1 | 无 blocking，3 important | I-1 预算失真（过滤后 keptTokens 反算 baseline）、I-2 语言采样被旧提示词污染（自锁）、I-3 引用+追加会被误杀 → 全部修复（sliceTokens 口径、采样排除提示词+最近窗口、结尾 closing 校验）；N-1..N-7 一并处理或记录 |
| round 2 | **1 blocking**，2 important | B-1 keep 回填破坏 pi turn 对齐 → 重放块以孤儿 toolResult 开头（实测真实会话，Provider 可 400）；I-1 回填按累计计数导致位移 ×4/可推平 older；I-2 短中文续接会话（keep 窗口小）翻回 en → 修复：**删除回填**（keep 预算改为上界并记录）、语言三级规则 + `promptLanguage` 兜底 |
| round 3 | 无 blocking，2 important | I-3 删除切片首条提示词后重放块以 `assistant(toolCall)` 开头（Anthropic/Gemini 400）；I-2a `promptLanguage` 看不到切点处提示词（status 与 runHandoff 不一致）→ 修复：**marker 替换**（保留 user 起始）、`languageMessagesFor` 传未替换切片；N-3 文档同步 |
| round 4 | **无 blocking、无 important** | N-1 config 注释、N-2 死代码 `entryIsHandoffPrompt`、N-3 测试头注释、N-4 调用点接线测试缺口、N-5 文档引用未落盘文件 → 已修；N-6（仅 marker 时 carry 措辞，极端不可达）记录为残余 |
| round 5 | **无 blocking、无 important**（C3 + 标题映射 + 对应测试） | F1 en 反向映射未覆盖模型自产变体（`## 进度`/`### 阻塞`）→ 已补；F2 无 fenced-code 感知（围栏内 `## Goal` 会被改）→ 已加围栏跟踪；F4 空会话通知未断言级别 → 已补；F3/F5 调用点未被测试钉住（`localizeSummaryHeadings` 应用点、`languageMessagesFor(...)` 传参）→ 记入测试头注释作为显式缺口（需可注入 summarizer + `newSession` mock，本轮不做）；治理漂移（断言数、映射功劳过度归因）→ 已修 |

## 关闭结论

- 五轮内全部 blocking 与 important 均已修复并由下一轮独立验证关闭；round 4 与 round 5 均无 blocking/important。
- round 5 fix（F1/F2/F4，均为该轮建议的改法）后未再起独立轮次：改动限于纯字符串函数的 10 行围栏守卫 + 2 个映射项 +
  测试断言，新增分支由单测直接覆盖（含围栏开/闭、en 变体），且不影响已验证的调用链；此处按 focus closure 处理。
- 关键验证证据（round 4）：真实旧提示词 `01a0a7a9` entry 81（`len=7601`、sha 前缀 `2fbe4159f558`）被替换为
  `REPLAY_MARKER`，其余 43 条消息逐字节不变、toolCall/toolResult 配对完整；预算分区
  `older + kept + (slice-kept) + baseline == usage` 精确成立；语言判定在真实会话与构造的切点场景下
  runHandoff 与 status 同判 `zh`；en 渲染与旧版 24/24 组合逐字节一致。
- 关键验证证据（round 5）：映射集与宿主 `SUMMARIZATION_PROMPT` 逐项一致（含层级），zh/en 逐键 round-trip；
  行内引用/引文/列表项/缩进不被误改；变异验证（删 notify / 删 cooldown / 删整分支）均能让测试失败；
  冷却只影响自动触发，显式 `/auto-handoff now` 连调两次仍给两次通知。
- 测试：`node tests/run-all.mjs` → 9/9；`tests/handoff-test.mjs` 共 **79** 项断言全 OK（round 5 fix 后复跑）。

## 残余风险（接受，详见 analysis §4）

- keep 预算为上界（旧提示词被替换为 marker，不补位，避免 turn 对齐破坏）。
- 语言启发式边界（1 个 CJK 且无提示词 → en；≥20 拉丁字母判 en；繁中输出简体、日语汉字误判）。
- 识别与脚手架文案字面量强耦合；整段引用且结尾恰好复现 closing 行会被替换（无法与真实提示词区分）。
- `older` 内旧提示词仍进摘要输入；**标题语言由确定性映射保证（round 5 起），正文语言仍靠模型服从 focus 指令**；
  compaction 记账偏高（pre-existing，保守）。
- 调用点未被测试钉住（round 5 F3/F5，已在 `tests/handoff-test.mjs` 头注释显式记录）：`localizeSummaryHeadings`
  的应用点与 `languageMessagesFor(olderMessages, carriedMessages)` 的传参只能靠纯函数测试保护，
  钉住它们需要可注入 summarizer + harness 的 `newSession` mock。
