---
doc_type: audit
topic: context-cost-and-progressive-disclosure
date: 2026-10-05
status: confirmed
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

**结论（`deepseek-v4-pro` 上）：不会。** 但换模型后翻转 —— 见 §8。这是「memory 混注」能否成立的关键现场事实，可复现。

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

## 8. 实验二：同一注入换模型（`deepseek/deepseek-flash`）会读

§7 的结论**不能外推**：同一份 `/tmp` 副本、同一提示、同一 `--tools read,grep,find,ls`，
只把模型换成 `deepseek/deepseek-flash`：

| 变体（均 flash） | 注入 | 工具执行次数 | 答案(1) | 答案(2) |
| --- | --- | --- | --- | --- |
| A′ index-only + 指针 | Invariants + 指针 | **4** | 对（`specVersion`） | 对 |
| B′ 全量 | 全部 | 0 | 对 | 对 |
| S index-only + 强指令 | Invariants + 「不确定必须先 read」 | **2** | 对 | 对 |

**综合两条实验**：按需读取是**模型相关**的，不是**机制相关**的 —— `v4-pro` 在指针下 0 次工具调用并编造字段名，
`flash` 在同样指针下读 4 次并答对；而两者在显式指令下都会读。

对设计的含义（比 §7 更准）：指针式渐进披露**能工作，但不能保证**——危险不在「读不到」，而在
**不读的模型不会告诉你它在猜**（v4-pro 用「或 `apiVersion`，取决于规范」的对冲掩盖了编造）。
因此对一个**决策级**事实（字段名、路径、阈值、约束），要么常驻，要么把「不确定必须先读」写成强指令，
要么用强制取回；纯指针只适合「读错代价低」的内容。

### 8.1 补测：强指令救回不读的模型

同一 `v4-pro`、同一 index-only 注入，只把指针句换成「凡涉及本项目的具体事实而你不确定时，必须先 read 该文件再回答」：

| 模型 | 注入 | 工具执行次数 | 答案(1) |
| --- | --- | --- | --- |
| `v4-pro` | Invariants + **裸指针** | 0 | **错**（编造 `schemaVersion`／`apiVersion`） |
| `v4-pro` | Invariants + **强指令** | **1** | 对（`specVersion`） |
| `flash` | Invariants + 裸指针 | 4 | 对 |
| `flash` | Invariants + 强指令 | 2 | 对 |

六格合并结论：

- **裸指针是模型相关的**：`flash` 读、`v4-pro` 不读并编造。
- **强指令能救回不读的模型**（`v4-pro` 0 → 1 次读取，错 → 对），且在本来就读的模型上没有代价（`flash` 仍对）。
- 因此 memory/CONTEXT 混注**可行**，条件是注入里带**强指令**而不是裸指针：`Invariants` 常驻，
  其余小节以「路径 + 不确定必须先读」带过。

限度：每个格子 n=1、单提示、两个模型；`--mode json` 不输出 system prompt，注入内容由答案形状推断。

## 9. handoff 载荷实验、注入实测与两条现场事实（2026-10-05，rev 2）

### 9.1 交接载荷四格（`deepseek-v4-pro`，小 fixture，每格独立 sandbox，日志落在磁盘）

| 格 | 载荷 | prompt 字符 | 工具执行 | 结果 |
| --- | --- | --- | --- | --- |
| A | 机械真尾 + 指针 + 强指令 | 387 | 2 | 两问全对 |
| B | A + pi 式九节摘要 | 642 | 1 | 全对 |
| C | 今天形态（LLM 摘要） | 563 | 8 | 全对 |
| C′ | 今天形态 + 现场那份 84,386 字节 `<context><conversation>` 转写 | 67,103 | 28 | **完全跑偏**：两问都没答，最后在自问「我到底有哪些工具」 |

C′ 是负面对照的核心：同一机制把一份真实转写折进 prompt 后，successor 不只是浪费，而是**失去了任务**。
B 的前提查证**不存在**：542 个原始会话文件里严格形状 `"type": "compaction"` 的条目为 **0**，代码里
`previousCompaction` 的读路径现场实例也是 0 → **B ≈ A，选 A**（且不加「摘要形状守卫」）。

### 9.2 A 形态 + 真实日志（同一模型，真 721 KB `session.md`，105 条，约 18 万 tokens）

prompt 仅 427 字符；16 次工具执行（read `INDEX.md` → grep → 按 offset 精读）；**三问全对**（四个分叉、
常驻/索引分节、省 9,386 字符 ≈ 2.3k tokens/轮，连精确值 2,346 都对），花费 **$0.0927**。这是选 A 的正面事实。

### 9.3 注入实测（混注落地后，同一天，当前渲染）

| 载体 | 注入前 | 注入后 | 省下 |
| --- | --- | --- | --- |
| `MEMORY.md` | 29,980 | 20,955 | 9,023（30%） |
| `CONTEXT.md` | 8,481 | 6,820 | 1,655（20%） |
| 合计 | 38,461 | 27,775 | **10,678 字符 ≈ 2.7k tokens/轮** |

注意：数字随渲染变化（consolidation 每次重写两侧文件），是快照不是常量；设计文档 rev 1 预估的
「省 20,100 字符」是上界，因为常驻的 `## Invariants` 本身就占 12,680 字符。

### 9.4 两条现场事实

1. **解耦守卫的现场事实**：`errors.log` 2026-09-22T14:01:29.121Z 那条
   `Error: model call error: Connection error.` 的栈穿过 `consolidate` → `ExtensionRunner.emit` →
   `emitSessionShutdownEvent`（该栈是**旧布局**，`consolidate.ts` 还在顶层未分模块），即 consolidation 的错误确实
   从 `session_shutdown` 逃进了 pi 的 runner；而交接就在同一个事件里 `await ctx.newSession` —— 这是耦合的现场证据。
   但它**在 mock 面上不可达**：实测五种失败形态（模型调用直接 throw、`sessionManager`/`modelRegistry` 缺失、
   cwd 不存在、memory 目录被文件顶替、干净对照）全部被 pass 自己吞掉，去掉守卫没有任何断言变红 →
   该守卫记为**有现场依据的防御**，不写进「已验证」。
2. **渲染语言会翻**：同一会话内，会话启动时注入的 `MEMORY.md` 是中文，而磁盘与 HEAD 上的同一文件是英文
   （mtime 2026-10-05 13:50:55），`errors.log` 同时段另有两条 `memory regression`（13:29 丢 3 条、13:50 丢 1 条）。
   含义：渲染语言没有被任何东西固定，所以「指针语言跟随正文」是**必须**而不是偏好。

### 9.5 未做与限度

每格 n=1、单提示、单模型族；A/B/C/C′ 的 prompt 文本只存在于当时的 `/tmp` sandbox（已清理），结论以本表为准；
A 形态端到端（真实交接一次）留待发布后；9.2 成本只测了一次，不当作均值。

### 9.6 渲染丢失是可恢复的（现场证据，同日早先会话测得）

逐条比对当前渲染：按空白归一化后，渲染缺失的条目 **11/11** 与 **13/13**（两组分别比对 `MEMORY.md` 与
`CONTEXT.md` 的历史渲染）在 `memory.jsonl`（442,700 B）里仍**逐字存在**，此外还有 6 份字节级备份与 git 历史。
但「条目少了」不自动等于回归：被丢的条目里也有模块计数、渲染字符数这类规则本身禁止的挥发事实，而且按前缀比对
会高估丢失（合并或重写的条目会被算成缺失）。含义：渲染是从 journal 加本会话上下文重建的，**丢的是渲染不是数据**，
`errors.log` 的 `memory regression` 行是检测器而不是损失证据。

### 9.7 v0.4.2 收尾：审3 的五条 nit 与一次退役（2026-10-05，发布后）

v0.4.1 的 tag 停在审3 判定通过的那一版，五条 nit 按停止规则留作残留；owner 随后决定「全修，无用就退役」，
本片即该决定。五条 nit 全修（其中一条是不可 pin 的精度修正），并退役 `handoffThinking` 键与 `/handoff thinking` 动词
——它在本仓零行为读者（回执里「stored for the dsh profile」的承诺因此在本仓无据；本段原文随后写的「dsh 读的是它自己的
`handoffPendingQuestion`」经审 3 判为无据，**见 §9.12 R-2**）。**下方原文曾把退役理由写成「它写下的值活不过任何一次 pi 写」，该说法经 v0.4.2 校验轮
实测证伪**（v0.4.1 的 `config.ts:52/111/229/263/324` 显示它当时是已知键，读回+写回，值会持久化；退役才是把它
变成未知键的那一步），已按「硬切不是改名」改写见 §9.11；常量 `MIN_SUMMARIZE_TOKENS` 随之更名
`MIN_DROP_TOKENS`（语义=最小可丢弃前缀），代码里最后一个 `summarize` 词消失。

单侧变异 8 格（每格只改回一处）：M1 标题判定退回 fence 盲目扫描 → 3 条具名红；M2 关闭 fence 不再比较长度 → 1 条；
M3 补回动词补全 → 3 条（含注册面的退役检查）；M4 补回二级补全 → 1 条；M5 补回动词分支 → 1 条；
M6 持久化补回退役键 → 1 条；M8 `parseConfig` 单侧补回退役键 → 2 条（嵌套与改名两条读取路径）。（**数字订正**：全量套件下为 3 条——第三条是
`handoff-test` 的持久化断言，当时只跑了 switches-test；见 §9.11 的订正史。）
**M7 是负向对照**：把 `session_shutdown` 失败回退里的 `.agents/memory` 退回 `.agents`，全绿 —— 该分支只在
`getProjectRoot` 拒绝时可达，而它自身的回退就是会话 cwd，所以这是精度修正而非行为修正，与 §9.4 的 shutdown 守卫
同类，记为不可 pin。套件 15/15。发布事实与三审三校证据见
`.codestable/issues/2026-10-05-memory-progressive-disclosure/release-v0.4.1-evidence.md`。

### 9.8 旋钮体检：22/22 有活读者，现场仅 1 处被手改的值（2026-10-05，owner 令「旋钮没用就删」后的实测）

> 口径（v0.4.2 校验轮补写）：键存在 ≠ 被改过。下面的比对必须先把 v0.4.0 之前的旧键名按 `legacyConfigPatch` 的
> 映射折算，再与 `DEFAULT_CONFIG` 逐值比；直接按字面键名比会把**仍未被 v0.4.x 重写过**的文件里的旧默认值
> 误报成「非默认」。计数随扫描口径变：本机 `Projects`（深度 9）+ `$HOME` 下可复现 11 个文件、其中 8 个仍带
> v0.4.0 前的旧键名（审 2 在 13 文件口径下数到 10 个）。这也是现场事实：读时折算不写回，只有 `updateConfig`
> 才重写文档。

判据只有两条，都可复测：**代码里有没有读者**（`git grep -n <键> -- extensions/`，除 `shared/config.ts` 自身），
以及**本机现场有没有被改过**（`DEFAULT_CONFIG` 由 `tests/harness.mjs` 的 `loadNamespace` 取权威值，再与全域
`project-context.json` 逐键比对）。

- 读者普查：22 个键**全部**有本文件之外的读者站点（`maxMemoryChars` 43、`maxTokens` 34、`provider` 48、
  `handoffBudgetSummaryTokens` 11、`handoffBudgetRecentTokens` 12、`handoffLang` 7、`handoffGuard` 6、
  `handoffMode` 4、`autolearnTurns`/`autolearnIntervalMs`/`consolidateIntervalMs`/`forceDedupeMs` 各 1 ……）。
- 现场普查：13 个 `project-context.json`（含 `~/.pi`、`~/.agents`、Trash 副本）里，**唯一的非默认值是
  UniField 的 `maxMemoryChars=36000`**；`autolearnAt` 是状态戳不算旋钮；其余 21 个键在所有文件里都等于默认值。
- 结论：**没有任何旋钮满足「没用」**——「本机没人改过」是使用量证据，不是机制证据，而扩展是双远端公开发布品，
  旧审计已把这条证据边界写明（「停止再加旋钮，别再为此扩面」，不是「删掉」）。因此 `handoffBudgetSummaryTokens`
  与 `/handoff budget summary` 的命名分叉按同一份证据结案：**保留**（键名镜射命令路径 `budget summary`，有活读者
  `threshold.ts:135`，改名要动 11 处站点 + dsh 共享拼写，而现场无任何需求信号）。本结论如需推翻，请给出一条
  现场事实（而非「我没用过」）。

### 9.9 死代码与不可达分支清扫（2026-10-05）

**导出面**：对全部 314 个导出符号做「定义文件之外全仓（extensions/tests/docs）出现次数」探针，34 个为 0。
（口径复核，v0.4.2 校验轮：换一种收集法得 347 个导出符号——差异来自是否把 `export { … }` barrel 与重名计入；
在 extensions+tests 口径下 HEAD 剩余导出零外部引用 = **0**，与「2 删 + 32 降级」的结论一致。数字随收集口径浮动，
结论不变。）
其中 2 个连定义文件内也无引用——`handoff/format.ts::cleanHeaders`（handoff.ts 拆分时留下的孤儿）与
`memory/journal.ts::newestMemoryArchiveSync`（旧审计 D2 那条死导出，其 JSDoc 还引着已不存在的 `loadMemorySync`，
且是 journal.ts 唯一使用 `readdirSync`/`statSync` 的地方）——直接删除；其余 32 个只在定义模块内使用，
`export` 关键字承诺了一个无人消费的接口，一并降级（`8f4eab7`）。

**不可达分支（比死代码更硬的一条）**：`handoff/run.ts` 的 `runHandoff` 只有两个调用点，分别传 `"force"` 与
`"force-auto"`，所以 `const force` 恒为真，三处 `!force` 分支**从未执行**：阈值/启用复检、`MIN_DROP_TOKENS`
下限（含锚点减法）、以及 `estimatedAfter` 预检。调度路径的门（enabled、TUI、idle、冷却、阈值）都在
`maybeTrigger` 里，它在发 `/handoff force-auto` 之前就做完了判断；2026-09-16 的第四轮评审早已记下
「`estimatedAfter` / `baselineNow` 对孤儿结果双重扣减（minor；**当前路径不可达**）」，而 v0.4.2 的矩阵也正因此
无法 pin「floor 的锚点减法」——**不可达的代码用删除收尾，不用测试**（`8f4eab7` 之后的第二片）。`force`、
`threshold`、`sliceTokens`、`promptTokens`、`baselineNow`、`estimatedAfter` 随之一并退场。

**最后一处 blind spot 转正**：v0.4.2 矩阵里 M7（`.agents/memory` → `.agents`）全绿，因为
`session_shutdown` 的 catch 在机具里够不到（pass 自己吞掉失败）。把 root 选择抽成 `shutdownErrorRoot` 后，
三条直接断言钉住了它，单侧变异**精确红一条**（`a cwd that only has .agents is not the memory layer`）。

### 9.10 两条「未证残留」的实测收口（2026-10-05）

探针 `migrateProjectState` 与 autolearn 清单各量一次，把两条一直以「未证/不可观测」记账的残留换成数字：

| 残留 | 实测 | 收口 |
| --- | --- | --- |
| D4：`migrateProjectState` 每次 `session_start` 都跑的持续成本 | 在「已迁移」的临时项目上 5 次取平均 = **0.78 ms/会话** | 成本可忽略，不是缺陷；是否退役旧形态兼容层改为「等一条 0 命中以外的现场事实」再定，不再以「有成本」为由挂账 |
| `AUTOLEARN_INVENTORY_CHARS = 8000` 截断不可观测 | 本仓清单 **3,810 字符 / 18 技能**；全域清单 **6,353 / 51**；**合并 7,892 / 69，余量仅 108 字符** | 截断在本机已贴边（更别说技能更多的消费仓），但它**不是新机制级缺陷**：被截掉的名字进不了提示词，模型若据此重建，写盘门会以 `already exists` 拒绝（`shapeRejection`/gate 两道），损害被限制为一次被拒的写入噪音。可观测性（截断时留一条记录）会成为一次提示词/回执面变更，属需 owner 点头的范围，因此记为**已量化的残留**而不是「未证」 |

两处数字都取自 `tests/harness.mjs` 的 `loadNamespace`（与生产同一条加载路径），不是估读。

### 9.11 校验轮 R1（2026-10-05）：审 1 判定与两条 important 的证伪

冻结版 `15b65cb`，沙箱 `/tmp/pc-v042-r1`（byte-identical `cp -a`，基线 status + mtime/size 双快照），
判定模型 **deepseek/deepseek-flash**（owner 指定；v4-pro 路线的第一次发起在 12 分钟后无声死亡——0 字节输出、
沙箱零写入，属该 skill 记过的「未成轮」，非阻塞）。**VERDICT: CHANGES-REQUESTED —— 0 blocking / 2 important /
6 nit / 2 suggestion**。零写入证明：status 与文件 mtime/size 双 diff 皆空（按 skill 剪掉扩展自身启动写的
`.agents/memory`）。记录：`.codestable/issues/2026-10-05-v042-cleanup/review-round1-independent.txt`。

两条 important 都是**发布文档的事实性错误**，不涉代码，且我都独立复核过：

| # | 断言 | 证伪证据（本仓可复测） | 修法 |
| --- | --- | --- | --- |
| I1 | 「`handoffThinking` 写下的值活不过任何一次 pi 写」 | **假**。`git show v0.4.1:extensions/project-context/shared/config.ts` 的 `:52/111/229/263/324` 显示它在 v0.4.1 是**已知键**（类型、默认值、旧名映射、`put`、`parseConfig` 读），值会随 `updateConfig` 持久化；是 v0.4.2 的退役才把它变成未知键 | 改 6 处措辞为「硬切不是改名：v0.4.1 它会持久化，v0.4.2 起被忽略、下次写回消失」，退役依据改回可证的理由（pi 侧零行为读者 + 回执承诺在本仓无据；dsh 侧不可复验，见 §9.12 R-2） |
| I2 | 「块内 `## X` 既截断前言、又变成一个假小节」 | **半假**。v0.4.1 的 `splitSections`（`inject.ts:59-69`）本来就 fence 感知，块内 `## X` 从未成为小节；真实损害是**前言**那次 fence 盲目扫描把前言切在假标题处并丢掉围栏内容 | 只改 CHANGELOG 的叙述，不动 `scanDocument` 与断言（断言靠内容判定，本身正确） |

nits 全修：`run.ts` 调用点注释（手动 `/handoff now` 不经 `maybeTrigger`）、`journal.ts` 与 `report.ts` 的多余空行、
审计标题「现场 0 个非默认值」与正文自相矛盾、`config.ts` 头部「seven flat keys」在退役后只剩 6 条的指向、
CHANGELOG「精度修正而非行为修正」补上唯一的可感差异（cwd 只有 `.agents` 时旧代码落日志并建目录）。
suggestion 采纳一条：`runHandoff` 的 `args: string` 收窄为 `"force" | "force-auto"`，把「只有两个 force 调用点」
这条隐式不变量变成编译期约束——它是本次三处删除的安全前提。另一条（给固定比例模式加最小可丢下限）**不采纳**，
降级为文档化语义 + 记名残留，理由见下。

**记名残留 R-1：固定比例模式没有最小可丢下限。** 实测（评审脚本 `/tmp/fixed-ratio-probe.mjs`，本轮复算）：
`handoffThresholdAuto:false, handoffThresholdRatio:0.1`、window 1M、usage 100k、可丢前缀 ~2.0k 时，
`maybeTrigger` 照样发 `/handoff force-auto`，交接执行、回执写 `dropping ~2.0k`。**同一脚本指向 v0.4.1 树输出逐字相同**
（`maybeTrigger sent: true` / `newSession ran: true`），即这是 v0.4.1 就有的既存行为，不是本轮删除引入的回归；
本次删掉的事后下限在 v0.4.1 起就不可达。修它要新增判定点（`threshold.ts` 固定分支或 `maybeTrigger`），
需 owner 决策，故按「既定语义」写进 `docs/handoff.md` 而不是改机制。

**矩阵重跑（本轮 7 格，冻结 `15b65cb`，每格只单侧改回一处；只数具名 `FAIL ` 行，不把 `FAILURES: N`
汇总行算进去）**：M1 标题判定退回 fence 盲目扫描 → **3 红**（`a heading-shaped line inside a fence does not
split the document`、`a heading-shaped line in a fenced preamble does not become a section`、`a shorter fence
run inside a block does not close it`）；M2 关闭 fence 不再比较长度 → **1 红**（`a shorter fence run inside a
block does not close it`）；M3 补回退役动词补全 → **1 红**、M4 补回退役二级补全 → **1 红**（两者都红
`the retired thinking verb is gone from the completion surface`）；M5 补回退役动词分支 → **1 红**
（`the retired thinking verb is refused as an unknown option`）；M6 `parseConfig` 补回退役键 → **3 红（全量套件）**（switches 的 `a retired key is not resurrected by the nested
layout`、`the retired thinking name folds into nothing`，**加上** `tests/handoff-test.mjs` 的
`the retired thinking verb persists nothing`——注入的默认键会被下一次 `updateConfig` 整份写回，所以只跑
switches-test 的格子会漏掉第三条）；
M7 shutdown 回退只查 `.agents` → **1 红**（`a cwd that only has .agents is not the memory layer`）——抽取
`shutdownErrorRoot` 之前该格是全绿（§9.7 的负向对照），抽取后同一次变异精确红一条，与 CHANGELOG、§9.9 一致。

数字订正史（三轮各纠一次）：首轮把 `FAILURES: N` 汇总行也计成红，写成 M6=3、M7=2；审 2 指出 M7 实为 1 红，脚本改为
只数具名 `FAIL ` 行；审 3 又指出 M6 那一格只跑了 switches-test、漏掉 handoff-test 的持久化断言，全量套件下是 3 红——
脚本现改为每格跑全套件、只数具名行，上面是订正后的数字。格定义与 §9.7 的旧矩阵不同（本轮每格是「补回/退回一处」，落点与红数不可与旧表逐格对齐），
负向对照是同一棵未改动的树跑全套件 15/15。脚本：`/tmp/matrix-v042.py`。

### 9.12 记名残留 R-2：dsh 侧有没有 `handoffThinking` 读者，本仓不可复验（2026-10-05）

审 3 抓到一处**新的过度主张**：本轮与 v0.4.2 前几片把「dsh 读的是它自己的 `handoffPendingQuestion`，不是这个
拼写」当成事实写进 6 个活动面（CHANGELOG、`docs/configuration.md`、词汇表、`config.ts` 注释、设计文档、测试注释）
来支撑退役。本仓真正站得住的只有两半：

- **pi 侧**：零行为读者（只有那个动词写它）——`git grep -n handoffThinking -- extensions/` 可复测。
- **dsh 侧**：本机所有 dsh 产物都不含 `handoff` 字样——已装的 `~/.local/lib/node_modules/@deepseek-ai/dsh`
  （283 MB，`lib/` 全部 bundle，大小写不敏感）、`~/.dsh/settings.yaml`、`~/.dsh/profiles/**`、
  `~/.dsh/dsh-memento`、`~/.dsh/dsh-config-manager` 全为 0 命中。**但这不等于 dsh 没有读者**：这些产物里根本
  没有 handoff 面，而 v0.4.0 的证据（`.codestable/issues/2026-10-05-vocabulary-consistency/release-v0.4.0-evidence.md:62`）
  只说「七个改名两仓同名」，没有说 dsh 是否读它。

因此退役依据已改写为「pi 侧零行为读者 + 回执里的 dsh 承诺在本仓无证据」，跨仓结论列为残留。

**关闭判据**：在 dsh 插件源码里 `grep -rn 'handoffThinking\|handoffSummaryThinking\|handoffPendingQuestion'`，
确认是否存在读取路径。**订正注（2026-10-05，审 9 nit）**：本节标题下的证据句曾写作「本机所有 dsh 产物都不含 `handoff` 字样」，实测过宽
——`handoff` 一词在 dsh 的 telemetry bundle 与 web profile 里都有命中（`handoffCursor`、"web boot handoff"）；
真正 0 命中且与本键相关的是两个**键拼写** `handoffThinking`/`handoffSummaryThinking`。活动面（CHANGELOG、
`docs/configuration.md`）已按后者改写，本节按冻结档案惯例保留原文并加此订正注。
**本仓处置（2026-10-05）**：owner 决定 dsh 侧在 dsh 仓处理，本仓不再挂账（见 §9.13）。

**影响面**：若 dsh 侧确有读者，这次退役对 dsh 用户就是一次无提示的破坏性变更——
`parseConfig` 只保留已知键、`updateConfig` 整份重写，所以升级后任意一次写配置都会静默删掉该键
（`docs/configuration.md` 已按「硬切」明说，但对 dsh 侧读者仍是行为变化）。

### 9.13 残留收口（2026-10-05，v0.4.3）

- **R-1 已修**：固定比例模式此前不经过物理下限（§9.11 记为「既定语义」），现改为与自适应分支共用同一条拒绝门
  ——比例阈值低于 `baseline + keep + MIN_DROP_TOKENS` 时不触发，状态行点名 `fixed <pct> (…)` 而不是照抄一个永远
  不会触发的比例（固定模式的拒绝此前根本不渲染）。测试：六条直连断言（经 `loadShared` 共享模块后改比例，含 `baselineTokens` 钉住的
  包含性边界与三条比例解析器↔常量耦合断言）＋三条端到端回执断言；`switches-test` 的合成语料同时补到真实体量，
  因为该门使「会话自身小于 `keep + 8000` token 时固定比例交接不可能发生」成为结构约束。
- **R-2 已交接**：dsh 侧是否存在 `handoffThinking` 读者由 owner 在 dsh 仓处理（本仓不再挂账）；本仓保留的只是
  「回执里的 dsh 承诺无证据」这一条可复验陈述。
- **autolearn 清单截断已可见**：`inventoryText` 被上限截断时追加一行
  `- (N more skill(s) not listed: the 8000-character inventory cap was reached)`，模型与读 prompt 的人都能看到
  列表不完整（原先静默丢弃尾巴）。证据：`tests/autolearn-test.mjs` 的六条断言。
