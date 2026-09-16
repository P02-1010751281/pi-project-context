---
doc_type: issue-fix
issue: 2026-09-16-handoff-language-and-replay
status: confirmed
path: quick
fix_date: 2026-09-16
related: [handoff-language-and-replay-report.md, handoff-language-and-replay-analysis.md, handoff-language-and-replay-review.md]
tags: [handoff, i18n, replay]
---

# handoff 语言与重放窗口 修复记录

## 1. 改动文件

| 文件 | 内容 |
|---|---|
| `extensions/project-context/config.ts` | 新字段 `handoffLanguage`（auto/zh/en，默认 auto）+ `languageOf()` + 嵌套/全局兼容解析 |
| `extensions/project-context/handoff.ts` | zh/en 脚手架表 `SCAFFOLDING`（含 `percentUnknown`）、`detectHandoffLanguage()`、`resolveLanguage()` 三级规则 + `promptLanguage()` 兜底、`summaryFocus()` 语言指令、`localizeSummaryHeadings()` 模板标题映射、`buildHandoffPrompt()`、`buildHandoffDocument()`、`isHandoffPromptText()`、`replayMessagesFor()` + `REPLAY_MARKER`、空交接/全在 keep 窗口内时的 warn notify + auto 冷却、`status` 显示 lang、`/auto-handoff lang auto\|zh\|en` |
| `tests/handoff-test.mjs` | 新增：语言三级规则/渲染/旧格式识别/引用不误伤/marker 替换与 user 起始/文档头/config 三层解析/命令边界/空交接与 keep 窗口内通知 + 自动触发冷却/标题映射（含真机英文标题样本） |
| `README.md` | 配置示例、handoff 说明、命令表补 `lang` |

## 2. 关键实现点

- `detectHandoffLanguage(samples)`：CJK 计数 ≥ `LANGUAGE_CJK_MIN=2` → `zh`，否则 `en`（纯计数，导出供测试）。
- `languageSamples(messages)`：只取 user 文本，排除 `isHandoffPromptText` 与 `REPLAY_MARKER`；
  优先最近 8 条（总长 ≥40 字符），不足则回退全会话（短回复不会因样本过小误判）。
- `resolveLanguage(messages, configured)`：显式配置优先；`auto` 三级规则 —— ① CJK ≥2 → zh；
  ② 拉丁字母 ≥ `LANGUAGE_LATIN_MIN=20`（实质性英文）→ en；③ 沿用 `promptLanguage()`（倒序找最近一条
  被识别提示词的语言）→ 无则 en。`runHandoff` 传入**未替换**的切片消息（`carriedMessages`），
  因此切点处的旧提示词也能参与规则 ③；`statusText` 用 `buildContextEntries` 与 `runHandoff` 同源。
- `replayMessagesFor(entries)`：逐消息重放；`role==="user"` 且命中 `isHandoffPromptText` 的消息
  替换为一行 `REPLAY_MARKER`（`[handoff prompt omitted]`）。切片起点不动（保持 `findCutPoint`
  的 turn 对齐），旧提示词不再逐字重放，重放块仍以 user 开头。
- 预算：`sliceTokens`（原始切片，含旧提示词）用于 `baselineNow = usage - older - sliceTokens`；
  `keptTokens`（重放内容，含 marker）用于 `estimatedAfter` 与通知。
- `isHandoffPromptText()`：必须同时以已知 preamble 前缀开头、包含已知章节标题、**并以 closing 行结尾**，
  用户引用/引用后追加内容不会被剔除。
- `HANDOFF.md` 文档头（标题/生成时间/项目/日志/索引）随语言渲染（`buildHandoffDocument`）。
- `localizeSummaryHeadings(text, language)`：pi 的摘要提示词要求 **EXACT 格式**，模型会照抄模板英文标题
 （真机实证：见 `handoff-language-and-replay-summary-headings-e2e.txt`），因此在生成后按固定标题集
 （`## Goal`/`## Constraints & Preferences`/`## Progress`/`### Done`/`### In Progress`/`### Blocked`/`## Key Decisions`/`## Next Steps`/`## Critical Context`，及各自中文对应）逐行精确匹配替换；
 只改标题行，正文/行内引用不动，缩进保留。
- 两个无操作返回（空会话、older 为空）改为 warn notify：用户发起时能看到原因；
 `autoTriggered` 时同时写入 30s 冷却，避免每个 settle 重复告警（与 guard=skip 分支同一模式）。

## 3. 验证

- 旧格式回归：真实 16% 提示词格式（`len=7601`、sha 前 12 位 `2fbe4159f558`）可被识别并替换为 marker。
- **C2：真 TUI 自动交棒实跑**（2026-09-16，pexpect 起真 TUI，脚本/日志与完整证据见
  `handoff-language-and-replay-tui-e2e.txt`）：真实阈值触发（非 force）→ notify
  `Auto handoff: summarizing ~34 of context, keeping ~32.0k recent...` → `Auto handoff: continued in a fresh
  session (previous was 3.4% full, summary ~94, kept ~32.0k recent)`；子会话注入提示词全中文，
  `HANDOFF.md` 标题全中文；同次运行另见模型自译标题（变体如 `### 阻塞`），因此该次输出无法区分「映射生效」与
  「模型自译」——映射的隔离验证是单测里的真机 English-heading 样本（旧一轮 TUI 实跑的原始输出）。
- 标题本地化真机复核（`…-summary-headings-e2e.txt`）：被摘要一侧含 12.9k 英文大文件内容时，
  注入提示词与 `HANDOFF.md` 标题仍为中文。
- `node tests/run-all.mjs` → **9/9 通过**；`tests/handoff-test.mjs` 共 **79** 项断言（含自动触发冷却、
  标题映射，映射样本取自真机 English-heading 摘要；围栏内标题不改、en 变体映射均已覆盖）。
- 稳定性：全套 ×16 与单个测试 ×60（含 4×CPU 负载）均通过；提交后曾出现一次未复现的 1/9 失败
 （未捕获到具体测试），因此把本轮新加的 20ms 定时窗口改为轮询式等待（`waitFor`）以消除脆弱点；
  pre-existing 的 `consolidation-test.mjs` 10/20/30ms 等待未动，已记入 review 残余。
- 探针注意：验证 **settings 安装包**是否生效时**不能带 `-ne`（`--no-extensions`）**——它会整包禁用，
  只留显式 `-e`；本次曾因此误判「已装包未加载」，去掉 `-ne` 后真 TUI 立即验证通过。
- 真机探针：pi 原始 compaction 提示词 + 中文语言指令 → 标题与正文全中文。
- **端到端真机实跑**（2026-09-16，RPC 模式 + 真实 deepseek 模型 + 真实 session 文件，脚本与完整证据见
  `handoff-language-and-replay-e2e.txt`）：scratch 项目连做两次 `/auto-handoff now`——
  ① 第一次交棒：新会话重放块 = 真实对话，注入提示词为中文（`本会话接手上一会话（…）`、
  `## 交接摘要`、`## 目标`），`HANDOFF.md` 标题为 `# pi 会话 … 的交接文档`；
  ② 第二次交棒（切点正是上一次的提示词）：新会话重放块首条为 `[handoff prompt omitted]`，
  旧提示词无一处原文重现，注入提示词仍为中文。两次 notify 显示 `summarizing ~61/~72`、`summary ~141/~150`。
- 旧格式回归：真实 16% 提示词格式（`len=7601`、sha 前 12 位 `2fbe4159f558`）可被识别并替换为 marker。
- 独立审查 4 轮（记录见 `…-review-round{1,2,3,4}-independent.txt` 与 `handoff-language-and-replay-review.md`）：
  round 1 提 3 个 important（预算失真/采样污染/引用误杀）；round 2 复现 1 个 blocking（keep 回填破坏
  turn 对齐 → 孤儿 toolResult）与 2 个 important；round 3 确认 blocking 关闭，另有 2 个 important
  （重放块 assistant 起始、`promptLanguage` 看不到切点提示词）；round 4 终审 **无 blocking、无 important**，
  仅剩 N 级（注释/死代码/接线测试缺口）已一并处理；**round 5**（C3 + 标题映射 + 对应测试）同样
  **无 blocking、无 important**，2 minor + 3 N 已按其建议处理或显式记录（F3/F5 调用点缺口），记录见
  `…-review-round5-independent.txt`。

## 4. 部署状态

- 已提交并 **已 push**（`origin` 双远端：Forgejo + GitHub 镜像）：
  `5b9b9ad feat(handoff): follow the conversation language and drop stale prompts from the replay`
  （含 `config.ts`/`handoff.ts`/`README.md`/`tests/handoff-test.mjs` 与新 issue 目录），后续 `2964141`（污染备份
  清理记录）、`f1565dc`（提交哈希）、`6d8b81b`（自动触发断言改轮询）；远端 `master` = `6d8b81b`。
- 发布 tag（已 push）：`v0.1.3`（`e4d48c4`，记忆日志化 + 写锁加固，此前一直是本地未发布）与
  `v0.1.4`（`6d8b81b`，本 issue 的 handoff 改动）。
- **已安装副本已切到 v0.1.4 并生效**：`settings.json` 的 pin 改为 `…pi-project-context.git@v0.1.4`，
  `pi update --extensions` 把 `~/.pi/agent/git/git.lentech.site/C02-1010751281/pi-project-context`
  置于 `6d8b81b`；真 TUI（不带 `-e`）实跑 `/auto-handoff lang zh|auto` 验证命令与
  `handoffLanguage` 写盘生效（v0.1.4 独有）。`settings.json` 改动前的备份在
  `/tmp/settings.json.before-v0.1.4-<stamp>`。

## 5. 残余风险

见 analysis §4（启发式语言判定、keep 预算为上界、识别与文案强耦合、繁中/日语边界等）。

C2 实跑同时暴露一个 **pre-existing** 设计边界（非本次改动引入，已在 analysis §4 注明）：当会话的
大部分上下文落在**同一轮**里（例如首轮就读入多个大文件、后续都是小轮次），`findCutPoint` 的切点会落在
该轮内部，turn 对齐又把切点拉回该轮起点，于是 older 为空、没有可摘要的内容 —— 自动交棒会一直跳过。
真机数据：源会话 54k token，其中单轮 4×12.8k toolResult，`handoffKeepTokens=2000` 时 older=0。
先前是静默跳过；现在会 warn 一次（auto 路径 30s 冷却），用户能看到原因。真正的修复需要在轮内切分
（需为孤儿 toolCall/toolResult 配对补齐，风险高），本 issue 不做。
