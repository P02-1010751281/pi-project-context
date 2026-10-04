---
doc_type: fix-note
issue: consolidation-boundary-instruction
date: 2026-10-04
released_in: v0.2.3
decision: owner approved the prompt wording ("新的prompt可以") and asked for the boundary to be handled further
---

# 修复说明：consolidation 提示词的跨仓边界

## 现场事实

1. 三轮渲染把兄弟仓的状态写回本仓 `MEMORY.md`（最近一次 10:54:28，写入 `UF 207/205`、`42,006/18,976` 一类数值）；
   每次手工清掉后，下一轮 pass 又回来。
2. 泄漏路径唯一且明确：`memory/pass.ts` 把 `conversationText(ctx.sessionManager.buildContextEntries())`
   交给 `buildPrompt()`，模型据此**整篇重生成**文档。`MEMORY.md` 当前字节不参与生成，所以手工清理不持久。
3. 提示词原有固定规则里**没有任何一条**限定事实来源：secrets/凭据那条管**种类**，指针那条管**指针**，
   预算那两条管**体积**——异仓数值三类都不违反，因此合法穿过。

## 改动（提示词层，两处）

- **规则**（紧邻 secrets 那条）：只写本项目自身的持久事实；绝不搬运其他仓的状态或测量值（提交距离、文件大小、
  研究数值、键数）；点名他仓只允许用于记录「谁拥有哪个未决项」。
- **注入点说明**：`<recent-conversation>` 块内首行加一句同义提醒（这是本会话的工作状态，可能引用其他项目及其数值，
  那些不是 memory 材料）。理由：异仓文本正是从那个块进来，说明放在入口比放在规则列表中间更贴近泄漏点。

## 钉子与变异

`tests/memory-budget-test.mjs` 新增四条断言（规则句在、归属句在、说明行开在 conversation 块首行、
说明行位于 `<existing-memory>`/`<existing-context>` 两块之后）。变异实测：

| 变异 | 期望 | 实测 |
| --- | --- | --- |
| 删规则句 | 规则类断言变红 | FAIL "the prompt states the boundary as a rule" + 归属断言 |
| 删注入点说明行 | caption 断言变红 | FAIL 两条 caption 断言 |
| 还原 | 全绿 | 15/15 |

**局限（诚实）**：提示词内容断言**不能证明**模型遵守。验收标准只能写在现场侧：之后若干轮渲染后跑边界 grep
（hygiene 技能 §2）命中 0。这次改动是**预防性**的，不是当前复发的止损（最近两轮渲染已 0 泄漏）。

## 顺带修掉的命令措辞（同一版本，同类问题：一个事实一个名字）

`/context` 与 `/project-context status` 的困惑来自**三条字符串覆盖两个事实**，其中一条被重载：

| 事实 | 旧叫法 | 新叫法 |
| --- | --- | --- |
| 四个特性的开关状态 | 伞形首行 `Project context: archive=on …` | `Features: …` |
| `CONTEXT.md` 文件 | status 里 `Context:`；`/context` 里 `Project context:` | 两处都是 `Context file:` |

实测重合（用户面）：status 6 行 / 761 字符，`/context` 3 行 / 379 字符；**只重合 context 文件一条路径**，
session index 与 session-logs 目录只在 `/context`。此前 `docs/configuration.md` 与
`command-surface-audit` 技能 §3 都写成「三条路径在 status 里没有」——已按实测更正。
