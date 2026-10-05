---
doc_type: audit
topic: context-cost-and-progressive-disclosure
date: 2026-10-05
status: draft
scope: 评估 memory / 技能 / handoff 三条链的上下文成本与渐进披露可行性；不动代码，不替 owner 做决定
---

# 上下文成本与渐进披露评估

## 0. 结论摘要

- **固定前缀的最大成本是本扩展自己注入的两个块**：MEMORY 29,166 字符（~7.3k tokens）由 `memory/report.ts` 注入，
  CONTEXT 9,670 字符（~2.4k tokens）由 `archive/archive.ts` 注入，两者都拼在 system prompt 末尾、**每轮重复**。
- **技能侧已经是渐进披露**：pi 只注入 name/description/path，两个技能库共 416k 字符正文**不注入**；
  autolearn 侧的「按需取正文」是**生产侧**问题，另有 draft 设计（revision 2），与本节的前缀成本不是同一件事。
- **handoff 侧的大头不是文档**（续接 prompt 实测 7.6k–10.5k 字符 ≈ 1.9k–2.6k tokens），而是它承担的角色：
  successor 没有上下文，把文档改成「索引 + 按需读」会丢掉未知的未知。**真正的现场问题是修复尚未发布**（见 §2）。

## 1. 实测成本表

| 载体 | 实测（字符 / ~tokens） | 注入频率 | 注入点 |
| --- | --- | --- | --- |
| `MEMORY.md` → system prompt | 29,166 / ~7,291 | **每轮** | `memory/report.ts` `before_agent_start` |
| `CONTEXT.md` → system prompt | 9,670 / ~2,417 | **每轮** | `archive/archive.ts` `before_agent_start` |
| 技能 name+description（全局 51 条） | 6,897 / ~1,724 | 每会话（启动） | pi 启动注入 |
| 技能 name+description（本仓 17 条） | 2,500 / ~625 | 每会话（启动） | pi 启动注入 |
| 技能正文（全局 + 本仓） | 314,477 + 102,185 = 416,662 | **不注入** | 由 agent 按需读 |
| `HANDOFF.md`（落盘） | 10,720 / ~2,680 | 每次交接一次 | `handoff/run.ts` 写盘 |
| handoff 续接 prompt | 7,601–10,465 / ~1,900–2,616 | 每次交接一次 | successor 首条 user 消息 |
| handoff 重放尾预算 | 旋钮 `handoffBudgetRecentTokens` 默认 20,000 tokens | 每次交接一次 | `handoff/text.ts` 重放 |

MEMORY.md 各节占比（用于判断「哪些常驻、哪些可披露」）：

| 节 | 字符 | 占比 | 性质 |
| --- | --- | --- | --- |
| `## Invariants`（51 条） | 12,740 | 43.7% | 行为 gate，须动手前在场 |
| `## Pitfalls` | 7,792 | 26.7% | 参考型，踩坑时才需要 |
| `## Index` | 4,756 | 16.3% | 已是索引型（文件→职责） |
| `## Project` | 3,798 | 13.0% | 参考型 |

## 2. 现场事实：A+B 修复未生效

| 检查 | 结果 |
| --- | --- |
| `~/.pi/agent/settings.json` pin | `pi-project-context.git@v0.4.0` |
| installed clone `describe` | `v0.4.0` |
| installed clone HEAD | `f217e7d` |
| installed `handoff/run.ts` 里 `turnStartIndex` 命中 | **0** |

**症状仍在现场**：最近一次真实交接的 successor（本会话 `01a10bf1`）首条重放消息即
`[turn prefix summarized during handoff]`（user，224 字符），其后直接是 assistant 消息，
**没有上一回合的 user 原文** —— 与 `f19dc93` 要修的形状一致。

推论：A+B 的实现（`f19dc93`）**尚未经过任何一次真实交接**；只有发布 + 重启才会改变现场。
这是本评估里唯一带现场证据的结论，也是最便宜的收益（不需要新机制）。

## 3. 三条链的渐进披露可行性

| 链 | 现状 | 按需可行？ | 可省 | 代价 | 缓存影响 |
| --- | --- | --- | --- | --- | --- |
| 技能正文 | 已渐进（name/desc 注入，正文按需） | 已实现 | — | — | 无 |
| autolearn 注入的正文 | v0.3.2 起按需（`inspectSkill`） | 已完成 | 已省 | 已付 | 无 |
| **MEMORY.md 注入** | 全量每轮 | **部分**（混注） | Invariants 常驻，`Pitfalls`/`Index`/`Project`（16,346 字符 ≈ 4.1k tokens）可索引化或按需 | 未知的未知：模型不知道要拉就不会拉；多一次往返 | **改善**：拉取追加在尾部，不改写前缀 |
| CONTEXT.md 注入 | 全量每轮 | 参考型，最像候选 | 至多 2.4k tokens/轮 | 同上 | 同上 |
| HANDOFF.md / 续接 prompt | 一次性、successor 无上下文 | **不适合** | 少 | 丢信息风险高（successor 连「缺什么」都不知道） | 与交接无关 |
| handoff 重放尾 | 已「裁切 + 索引」 | 已是当前最优 | — | — | 首请求必 miss（换了 session 与消息序列） |

缓存拓扑的要点：全量注入写在**前缀最前面**，一次 render 重写会作废其后所有缓存
（同一会话内实测 MEMORY.md 从 31,552 降到 29,166 字符，即它在动）；按需披露把新内容**追加在尾部**，
前缀逐字不变，是单调增长而非作废。

## 4. 未验证项（不写成结论）

- 本机中转路由（scnet / commandcode）是否透传 Anthropic `cache_control` —— 未验证。
- render 频率与 cache miss 之间的因果 —— 只有时间上的相关性，没有对照。
- 「memory 注入过大压垮行为」—— **没有实测**，目前只有成本事实。
- 重放尾的**实际** token 数 —— 只有预算旋钮（默认 20,000），没有一次实测值。

## 5. 待 owner 决定的分叉（本评估不做决定）

1. 是否发 **v0.4.1**：唯一让 A+B 生效的动作（tag + 双推 + pin bump + 证据文件）。
2. 是否立项 **memory 混注**（Invariants 常驻、其余索引化/按需），还是维持全量。
3. CONTEXT.md 的注入（`archive/archive.ts`）是否与 MEMORY 一起评。
4. autolearn 渐进披露设计的 7 个 fork（draft revision 2）。
5. 是否先做一次 **headless 端到端真实交接**，给 A+B 一次真实暴露（比再加机制便宜）。

## 6. 渐进披露的机制重量（按「谁消费」分）

判据：消费该内容的模型**有没有现成的读取工具**。有 → 注入索引即可，无需新机制；没有 → 必须由扩展代取。

| 链 | 消费者 | 有读取工具？ | 需要新机制？ | 机制重量 | 收益 |
| --- | --- | --- | --- | --- | --- |
| 技能正文（pi 原生） | session agent | 有（`read`） | 不需要，已实现 | 0 | 416k 字符不注入 |
| `MEMORY.md` 注入 | session agent | 有（`read`/`grep`） | **不需要**：注入改成「路径 + 节名 + 何时读」，`Invariants` 仍常驻 | 极小（提示词 + 断言） | 至多 ~4.1k tokens/轮 |
| `CONTEXT.md` 注入 | session agent | 有 | 同上 | 极小 | 至多 ~2.4k tokens/轮 |
| autolearn 正文 | **单次 completion 的辅助模型** | **没有**（无工具循环） | **需要**：`inspectSkill` 回溯轮 + 「展示过才可覆盖」代码层门闩（= draft 设计 A） | 中 | 每次 autolearn 调用 32,057 → 13,149 字符 |
| handoff 文档 | successor（无上下文） | 有，但不知道缺什么 | 不需要（索引化会丢信息） | 0 | — |

结论与优先级：

- **不要三处各造一套机制**：统一一个约定（文件路径 + 节名 + 何时读），只有 autolearn 需要真正的「代取」机制。
- 优先序：memory/CONTEXT 混注（最便宜、每轮收益、可测）> autolearn A（已设计，收益在辅助调用侧而非每轮）> handoff（不动）。
- 唯一未验证风险：session agent **会不会主动去 read**。可先做最小试验（只注入索引，看模型是否读了），再决定是否全量切。


## 7. 实验：只给指针，模型会按需去 read 吗？

**结论：不会。** 这是「memory 混注」能否成立的关键现场事实，可复现。

设置：合成项目 `.agents/memory/MEMORY.md`，`## Invariants` 放一条行为约束，`## Pitfalls` 放唯一事实
（`widget.manifest` 的版本字段名是 `specVersion`）。`/tmp` 副本把注入改成 **只给 `## Project` + `## Invariants`，
其余小节留在文件里、需要时用 `read` 读取**。每个变体独立 sandbox，工具用 `--tools read,grep,find,ls`。

| 变体 | 注入 | 是否发起 read | 答案(1) 版本字段 | 答案(2) 删除约束 |
| --- | --- | --- | --- | --- |
| A index-only + 指针 | Invariants + 指针 | **否（0 次工具调用）** | **错**（`schemaVersion`／`apiVersion`，带「取决于规范」的对冲） | 对（Invariants 在） |
| B 全量（现行） | 全部 | 否 | 对（`specVersion`） | 对 |
| C 正对照（显式要求读） | index-only | **是**（真实 `read` 工具调用 + `tool_execution_start/end`） | 对（引原文） | — |

读数：A 面对一个**它没有的事实**，宁可编一个并加对冲，也不去读被明确告知存在的文件；C 证明同一设置下
`read` 工具确实可用且能取到正确事实。即**失败点是「没有读取动机/习惯」，不是「没有工具」**。

对设计的含义：memory/CONTEXT 的渐进披露**不能只靠指针行**。可选的更强形态（任选其一，尚未决定）：
强指令（「不确定必须先读该文件」）、把决策相关事实留在常驻区、或引入强制取回（如 autolearn 的 `inspectSkill`）。

注意事项与限度：单模型（`deepseek/deepseek-v4-pro`）、单提示、每变体一次；`--mode json` 不输出 system prompt，
故「指针确实进了 prompt」是由代码路径与 A 的答案形状（Invariants 在 / Pitfalls 不在）推断的；
`sandbox` 在 `agent_settled` 会被 consolidation 写入，故每变体必须独立目录。

**顺带发现的文档错误**：`.agents/skills/pi-project-context-headless-runs` 把 `-nt` 标成「prompt templates」，
而 CLI 里 `-nt` = `--no-tools`。第一轮实验因此**没有工具**、结果无效 —— 与该技能自己写的
「Do not record a failed probe as a review round」同一条纪律。
