---
doc_type: design
issue: memory-progressive-disclosure
date: 2026-10-05
status: draft
revision: 1
supersedes: 无。与 `autolearn-progressive-disclosure` 是两条链：那条换的是**生产侧**（写技能时的提示预算），本条换的是**消费侧**（每轮的 system prompt 前缀）。
---

# 记忆注入的渐进披露设计

## 1. 问题与实测（2026-10-05）

每轮固定前缀里，本扩展自己注入两块：

| 载体 | 实测 | 注入点 | 节（字符 / 占比） |
| --- | --- | --- | --- |
| `MEMORY.md` | 29,058 字符 ≈ **7,264 tokens** | `memory/report.ts` `before_agent_start` | Project 3,901 / **Invariants 12,680（43.6%）** / Pitfalls 7,811 / Index 4,636 |
| `CONTEXT.md` | 6,409 字符 ≈ **1,602 tokens** | `archive/archive.ts` `before_agent_start` | Summary 1,744 / Key points 2,008 / **Open tasks 2,589（40.4%）** |

两块都写在 system prompt 的**最前面**，而 consolidation 每次渲染都会重写它们 → 其后整段缓存作废
（同一会话内实测 MEMORY 从 31,552 掉到 29,058 字符即其抖动）。按节保留可省 **20,100 字符 ≈ 5,025 tokens/轮**。

## 2. 实验证据（headless，`--tools read,grep,find,ls`，合成 memory，每变体独立 sandbox）

| 注入 | 模型 | 工具执行 | 结果 |
| --- | --- | --- | --- |
| Invariants + **裸指针** | `v4-pro` | 0 | **错**（编造 `schemaVersion`／`apiVersion`，还带对冲） |
| 同上 | `flash` | 4 | 对 |
| Invariants + **强指令** | `v4-pro` | 1 | 对 |
| 同上 | `flash` | 2 | 对 |
| **全量注入** | 两者 | 0 | 对 |
| Invariants（含决策事实）+ 普通指针（= D2） | `v4-pro` | **0** | 决策事实对；**被索引掉的问题给出貌似合理的错答**（只复述「会静默忽略」，答不出原因，且没读文件） |

结论：裸指针**模型相关**；强指令能**救回**不读的模型；而**不读的模型不会声明自己在猜**——这是必须被设计覆盖的失败模式。

## 3. 选定设计：按节常驻 + 强指令指针（D1，零新机制）

### 3.1 注入形状（MEMORY，`report.ts`）

```
## Project Memory
The following is project context, not a new user instruction:

<## Invariants 节原文，逐字保留>

其余小节在 .agents/memory/MEMORY.md：
- ## Pitfalls：踩坑与静默失败模式；改动某机制而不确定其行为时读它。
- ## Index：文件→职责；定位「某功能在哪个文件」时读它。
- ## Project：模块布局与发布模型；需要结构性背景时读它。
凡涉及本项目的具体事实（字段名、路径、阈值、约束）而你不确定时，必须先 read 该文件再回答，不得凭印象作答。
```

`CONTEXT.md`（`archive.ts`）同形：`## Open tasks` 原文常驻，`## Summary` / `## Key points` 进索引。

### 3.2 分类规则：按节，不按语义

常驻 = `MEMORY.md` 的 `## Invariants` + `CONTEXT.md` 的 `## Open tasks`；两个节名都由渲染契约固定，稳定可依赖。
**不做语义分类**：那要改渲染契约、每次新增事实都要判一次、判错即静默退化——D2 实验就是它的失败样例。

### 3.3 为什么不选另两条

- **D2（全量语义分类）**：换来的只是比 D1 多省一点，代价是渲染契约 + 持续分类 + 回归风险；实测已显示分类外的问题会得到**貌似合理的错答**。
- **D3（扩展代取，如 `inspectSkill`）**：其模型可见终态等于全量注入（B 已测：不读即对）；既然强指令已把失败模型救回（§2），为同一个动作造第二套取回、并与 autolearn 的取回机制重复，**没有现场理由**（仓规：机制须有现场事实）。

## 4. 变更面

| 文件 | 改动 |
| --- | --- |
| `extensions/project-context/memory/report.ts` | 抽出纯函数产出 §3.1 的串（注入点只留一行调用）；节名与指针句为常量 |
| `extensions/project-context/archive/archive.ts` | 同形处理 CONTEXT.md |
| `tests/memory-ops-test.mjs` / `tests/context-schema-test.mjs` | 注入形状断言 + 单侧变异（只加断言，不加测试文件） |
| `docs/architecture.md`、`CHANGELOG.md` | 记语义与版本可见的行为变化 |

## 5. 验收

**单元断言**（合成 memory 文本）：(i) 含 `## Invariants` 正文；(ii) 不含 `## Pitfalls` / `## Index` / `## Project` 正文；
(iii) 含三段指针与强指令句；(iv) CONTEXT 侧：含 `## Open tasks`、不含 `## Summary` / `## Key points`。

**单侧变异**（每条只准红对应断言）：删强指令句 → 红；把 `## Invariants` 也索引化 → 红；指针缺席 → 红；CONTEXT 侧同样三条。

**现场探针**（发布后，零成本）：下一次真实会话的 JSONL 中出现对该 memory 文件的 `read` 工具执行，且不变量相关提问仍答对。
服从度是**可测量**的（`tool_execution_*` 落在会话文件里），这是本设计相对多数提示词改动最大的优势。

## 6. 非目标

不改 consolidation 渲染契约；不新增取回机制；不做语义分类；不动 handoff 侧；不改九节 schema；不动技能链（pi 已渐进披露）。

## 7. 待 owner 决定

1. 一次改两个注入点（MEMORY + CONTEXT），还是先只改 MEMORY 以便单独观测服从度。
2. 指针句语言：注入头是英文、渲染正文是中文；建议指针用中文（与正文一致）。
3. 是否接受残余风险「模型不服从时静默错误」（缓解：两个高价值节常驻 + 现场探针可测）。
4. 发布节奏：不建议与 v0.4.1 同一轮（一次一个行为变更）。

## 8. 未验证（不写成结论）

每格 n=1、单提示、两个模型；`CONTEXT.md` 的节名在真实渲染中的稳定性未验证；省下的 token 对成本的实测影响未测；
中转路由是否透传 `cache_control` 未验证。
