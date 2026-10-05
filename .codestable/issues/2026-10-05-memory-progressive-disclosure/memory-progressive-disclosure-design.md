---
doc_type: design
issue: memory-progressive-disclosure
date: 2026-10-05
status: design-frozen
revision: 2
implemented_in: 9821320（注入片）+ 9abd971/a0bcdd1（审后修订，见 §9.6）
supersedes: 无。与 `autolearn-progressive-disclosure` 是两条链：那条换的是**生产侧**（写技能时的提示预算），本条换的是**消费侧**（每轮的 system prompt 前缀）。
rev2_note: rev 1 的 §4/§5/§7 是实施前的预估与待决；§9 记录落地后的实际变更面、实际保存量与实测结果，二者不一致处以 §9 为准。
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
| `extensions/project-context/shared/inject.ts` | 新建：`splitSections` + `renderProgressiveBody` + `InjectionSpec`，两个注入点共用一次遍历（选中与指针文本绑在同一次查找） |
| `extensions/project-context/shared/lang.ts` | 新建：CJK 判定单一 owner（`CJK_PATTERN`/`LANGUAGE_CJK_MIN`/`countCjk`/`documentLanguage`） |
| `extensions/project-context/memory/injection.ts` | 新建：`MEMORY_INJECTION`（常驻 Invariants/Pitfalls，索引 Project/Index）与 `CONTEXT_INJECTION`（常驻 Key points/Open tasks，索引 Summary）两份规格 |
| `extensions/project-context/memory/report.ts`、`archive/archive.ts` | 注入点各换成一行 `buildMemoryInjection(...)` / `buildContextInjection(...)` |
| `extensions/project-context/handoff/language.ts` | 改用 `countCjk`（同一 owner，行为不变） |
| `tests/sections-test.mjs` | 13 条断言（节序、常驻逐字、指针行、强指令、totality、未知节 fail-safe、语言跟随、无标题整篇） |
| `docs/architecture.md`、`CHANGELOG.md` | 语义与版本可见行为变化（同轮末尾一次写） |

## 5. 验收

**单元断言**（合成 memory 文本）：(i) 含 `## Invariants` 正文；(ii) 不含 `## Pitfalls` / `## Index` / `## Project` 正文；
(iii) 含三段指针与强指令句；(iv) CONTEXT 侧：含 `## Open tasks`、不含 `## Summary` / `## Key points`。

**单侧变异**（每条只准红对应断言）：删强指令句 → 红；把 `## Invariants` 也索引化 → 红；指针缺席 → 红；CONTEXT 侧同样三条。

**现场探针**（发布后，零成本）：下一次真实会话的 JSONL 中出现对该 memory 文件的 `read` 工具执行，且不变量相关提问仍答对。
服从度是**可测量**的（`tool_execution_*` 落在会话文件里），这是本设计相对多数提示词改动最大的优势。

## 6. 非目标

不改 consolidation 渲染契约；不新增取回机制；不做语义分类；不动 handoff 侧；不改九节 schema；不动技能链（pi 已渐进披露）。

## 7. owner 决议（2026-10-05，均已回答）

1. **一次改两个注入点**（MEMORY + CONTEXT），不等分步观测。
2. **指针语言跟随正文**（auto）：复用同一 CJK 阈值，不做新的语言探测。
3. **接受残余风险**「模型不服从时静默错误」：两个高价值节常驻 + 后文探针可测，不为此再造机制。
4. **与 v0.4.1 同轮**发布（一条版本记录同时说明注入与 handoff 摘要链删除）。

§7 的旧编号在此保留为历史：以上四条在 rev 2 冻结时按此执行。

## 8. 未验证（不写成结论）

每格 n=1、单提示、两个模型；`CONTEXT.md` 的节名在真实渲染中的稳定性未验证；省下的 token 对成本的实测影响未测；
中转路由是否透传 `cache_control` 未验证。

## 9. 落地记录（rev 2，2026-10-05）

### 9.1 实际变更面与设计的两处偏差

- 注入渲染抽到了 `shared/inject.ts`（两个注入点共用），因此本片**动了 handoff 侧一行**（`handoff/language.ts` 改用共享 CJK owner），
  §6「不动 handoff 侧」按语义（handoff 行为）成立，按文件面不成立。
- §4 预估的测试文件是 `memory-ops-test`/`context-schema-test`，实际落在新文件 `tests/sections-test.mjs`（只加断言、不加测试文件的口径不变）。

### 9.2 实测保存量（当前渲染，非恒定值）

| 载体 | 注入前 | 注入后 | 省下 |
| --- | --- | --- | --- |
| `MEMORY.md` | 29,980 | 20,955 | 9,023（30%） |
| `CONTEXT.md` | 8,481 | 6,820 | 1,655（20%） |
| 合计 | 38,461 | 27,775 | **10,678 字符 ≈ 2.7k tokens/轮** |

§1 预估的「省 20,100 字符」是上界：常驻的 `## Invariants` 本身就是最大一节（12,680 字符），省下来的只能是非常驻节。
数字随渲染变化（consolidation 每次重写两侧文件），所以它是快照，不是常量。

### 9.3 单侧变异矩阵（实测，全部具名断言变红，无盲区）

| 变异 | 变红的断言 |
| --- | --- |
| 删强指令句 | the read-first instruction follows the pointers |
| 给被 keep 的节也加指针 | the memory split covers the schema exactly / keeps nothing it also points at / kept bodies stay verbatim |
| 删 Index 指针 | the memory split covers the schema exactly / indexed bodies are dropped / indexed sections become one named line each |
| 无指针时不再整篇注入 | a document without headings is injected whole |
| 未知节也塞空指针 | kept bodies stay verbatim / context keeps its two decision sections / an unlisted heading stays inline |
| 指针语言不再跟随正文 | an English body gets English pointers |

矩阵自身发现过一个真缺陷：指针文本与选区曾是两次独立查找，选中一个没有指针模板的节会 `undefined[language]` 抛错；
现为一次遍历内绑定（`shared/inject.ts`），因此「未知节 fail-safe」是**结构性**的，不再依赖一次判空。
`keep` 列表随之退化为纯声明（渲染只认「有没有指针」），规格两侧由断言钉住互斥（keeps nothing it also points at）。

### 9.4 一条未写入结论的现场事实：渲染语言会翻

同一会话内实测：会话启动时注入的 `MEMORY.md` 是**中文**，磁盘与 HEAD 上的同一文件是**英文**（mtime 13:50:55），
且 errors.log 同时段有两条 `memory regression`（13:29 丢 3 条、13:50 丢 1 条）。含义：渲染语言没有被任何东西固定，
指针语言必须跟随正文（§7 第 2 条）才不至于语言分裂——这条实测验证了那个决议。

### 9.5 现场探针（仍未做）

§5 的「下一次真实会话里出现对该 memory 文件的 `read` 工具执行」属发布后观测。设计期与三审三校期都只做了单元/变异层，
服从度现场数据留待发布后（v0.4.1 已于 2026-10-05 发布，tag `v0.4.1` → `7b6fc98`；发布后探针计划见 `release-v0.4.1-evidence.md`）。

### 9.6 审后修订（v0.4.1 三审带出的机制增量）

独立审查三轮（transcript 见同目录 `v0.4.1-review-round{1,2,3}-independent.txt`）在实施后又带出三处机制增量，
它们同属本设计的机制面，实施提交为 `9abd971` 与 `a0bcdd1`（tag `v0.4.1` 指向 `7b6fc98`）：

1. **指针路径按项目根渲染为绝对路径**（审1 对抗轮）：`read` 工具按会话 cwd 解析相对路径，而注入块此前只写了
   `.agents/memory/MEMORY.md`；调用方给出项目根时渲染 `join(root, path)`，未给根时保持相对（测试用）。
2. **前言与文档级注记恒常驻**（审1 nit / 审2 复核）：`# Project Memory`、`Last updated: …` 与截断标记
   `_[memory truncated at …]_` 不属于任何节，此前会被最后一节的索引一并压掉 —— 现在前言与「末节的注记行」进注入，
   且注记只在最后一节被识别（正文中段的 `_[x]_` 行留在原处）。
3. **分节恢复 fence 追踪**（审2 nit；v0.4.2 起由 `scanDocument` 一次遍历同时给出前言与分节）：fence 内的 `## X` 行是内容而不是节标题；被删的
   `localizeSummaryHeadings` 里原有这段逻辑，实施时漏掉。

对应新增断言（v0.4.2 追加前言的 fence 感知与 fence 关闭长度两条）：`the document preamble stays inline`、`a document-level note stays inline next to the pointers`、
`the pointer path resolves against the project root when it is known`、
`a heading-shaped line inside a fence does not split the document`，以及两条语言边界的记录性断言。

`implemented_in` 因此扩展为：`9821320`（注入片）+ `9abd971`/`a0bcdd1`（审后修订）；
发布事实、三审三校证据与残留见同目录 `release-v0.4.1-evidence.md`。
