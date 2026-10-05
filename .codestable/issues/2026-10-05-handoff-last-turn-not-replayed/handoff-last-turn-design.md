---
doc_type: design
issue: handoff-last-turn-not-replayed
date: 2026-10-05
status: design-frozen
revision: 1
implemented_in: f19dc93536ba
---

# handoff 保住「最后一轮」：A+B 设计与裁切+索引

## 0. owner 决议

- **采用 A+B**（A 硬保最近一个完整回合的原文；B 有条件吸附到回合边界）。
- **允许裁切 + 索引**：装不下的中间体积可以裁切，但必须带索引（裁了什么、剩什么）。

## 1. 现场事实（本轮核对，非推断）

1. **pi 已经把答案递到手边，本扩展丢掉了。** `findCutPoint` 返回
   `{ firstKeptEntryIndex, turnStartIndex, isSplitTurn }`；`run.ts:106-107` 只取 `firstKeptEntryIndex`，
   全仓 `grep isSplitTurn|turnStartIndex` **零命中**（未使用）。
2. **pi 自己的压缩（`core/compaction/compaction.js`）在 split turn 时做两段摘要**：
   `historyEnd = isSplitTurn ? turnStartIndex : firstKeptEntryIndex`，把
   `[turnStartIndex, firstKeptEntryIndex)` 作为 `turnPrefixMessages` 单独摘要，并合并成
   ``${history}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefix}``；turn prefix 还单独抽 file ops（同文件 630-703）。
3. **本扩展把 turn prefix 混进 `olderEntries` 一次性摘要**（`run.ts` 的 `olderEntries`/`olderMessages`），
   重放端只用 `SPLIT_TURN_MARKER` 占位（`text.ts`）→ 重放块可以以 assistant 工具调用 + toolResult 开头，
   而**该回合起始的 user 指令不以原文进入新会话**，只以散文形式埋在历史摘要里（或没有）。
4. **本机实例**（已记录在 `analysis.md`）：`01a107b7 → 01a107d0`，后继会话头两条 = 占位标记 + assistant + toolResult，
   头 8 条内无上一轮任何原文。
5. **B 必须有条件**：无条件吸附曾因「整轮超出 keep 窗口 → 老侧无内容可摘要 → 交接被整个卡死」被回退
   （`run.ts` 切分处注释），所以吸附前后都要保住「老侧仍有 user/assistant」这一条件。

## 2. 方案

### B —— 有条件吸附到回合边界（优先，成本最低）

在 `findCutPoint` 之后：

- 若 `cut.isSplitTurn && cut.turnStartIndex >= 0`，候选切点 `snap = cut.turnStartIndex`；
- **两个条件同时成立**才采用 `snap`：
  1. **前缀溢出量在一窗内**：`tokens(allEntries[turnStartIndex, firstKeptEntryIndex)) <= handoffBudgetRecentTokens`；
  2. **老侧仍有东西可摘要**：`allEntries.slice(0, snap)` 里存在 user/assistant 的上下文消息。
- 否则退回 `cut.firstKeptEntryIndex`，保持现状（不阻塞交接）。
- 效果：前缀不大时，最近一个回合（含起始 user 消息）**整轮原文重放**，占位标记不再出现。

**为什么条件 1 不是「整轮装得下」**：split turn 之所以存在，正是因为该回合自身的 token 量已经超过 keep 窗口
（否则回扫会在上一个回合内停下），所以「整轮装得下」这个条件**恒假**、是空条件。能守住的是**溢出上界**：
吸附后保留片最多比预算多一个窗口。

### A —— 硬保最近一个完整回合的用户侧原文（装不下时的兜底）

当 B 无法吸附（该回合本身超过 keep 窗口）：

- `cut.turnStartIndex` 本身就指向**该回合的起始条目**（pi 的 `isTurnStartMessage` 只认
  user/bashExecution/custom/branchSummary/compactionSummary，不认 assistant/toolResult），把它锚定进重放切片首部；
  于是重放块以真实 user 消息开头，`SPLIT_TURN_MARKER` 不再需要。
- 该条目**同时仍在摘要输入里**（`olderEntries` 含它），即「摘要散文 + 原文锚点」双份。这是有意为之：
  摘要给上下文，锚点保证「最后问了什么」以原文出现；成本是一小段重复。
- 该回合末尾的 assistant 文本本来就在 `firstKeptEntryIndex` 之后的保留片里，因此
  「user 原文 + assistant 收束」两端都在，中间工具交换按下面的索引规则处理。
- 悬空 toolResult 仍由现有 `droppedOrphans` 机制折进摘要（语义不变）。

### 裁切 + 索引（owner 放行的那一条）

装不下的 turn prefix 中间体积允许裁切，但索引必须落地：

- **本片已实现的部分**：裁切 = 超窗的 turn prefix **不进重放**（仍进摘要输入，悬空 tool 结果按既有 `droppedOrphans`
  折进摘要）；索引 = 文档既有的 `<modified-files>` 块（`collectFileOps`/`formatFileOperations`），**未另造格式**。
- **本片未实现**：pi 那种把 turn prefix 单独摘要成 `**Turn Context (split turn):**` 段的第二段摘要（见 §7）。

## 3. 变更面（文件级）

| 文件 | 改动 |
| --- | --- |
| `extensions/project-context/handoff/run.ts` | 读 `cut.isSplitTurn`/`cut.turnStartIndex`；有条件吸附（B）；锚定回起始 user 消息进重放切片（A）；把 turn prefix 与历史分开传给摘要 |
| `extensions/project-context/handoff/text.ts` | 回合内「起始 user 消息」定位工具函数；占位标记只在**找不到**真实 user 消息时兜底 |
| `extensions/project-context/handoff/summary.ts` | **本片未改**（Turn Context 段留待 §7） |
| `extensions/project-context/handoff/prompt.ts` | **本片未改** |
| `tests/handoff-test.mjs` | 新增断言（只加断言，不加测试文件） |
| `docs/architecture.md`、`CHANGELOG.md` | 行为变化（v0.4.x 条目） |

## 4. 断言与单侧变异计划

断言（新增 8 条，已实现）：

1. 「the split turn's opening question is anchored into the replay」——A：前缀超窗时锚定起始 user 文本，且角色序列保持 `user,assistant,user`。
2. 「a turn whose prefix fits the window snaps to the turn start」——B：前缀在一窗内时吸附。
3. 「the snapped turn is replayed whole and stays out of the summary」——吸附后整轮原文进重放、不进摘要输入。
4. 「the older side still reaches the summarizer」——吸附不吞掉老侧摘要。
5. 「an overrun prefix is not snapped whole」+「the bulky prefix stays out of the replay」——裁切：超窗前缀不进重放。
6. 「a single-turn session still hands off…」+「the single turn replays its opening question」——守卫：单回合会话不因吸附而中止。
7. 全量回归：handoff 189 条 + `run-all.mjs` 15/15 绿。

单侧变异（每项只改一侧，**实测**结果）：

| 变异 | 实测变红的断言 |
| --- | --- |
| 去掉前缀预算条件（只留老侧非空） | 1 条：「the bulky prefix stays out of the replay」 |
| 去掉老侧非空守卫（只留前缀预算） | 2 条：「a single-turn session still hands off…」「the single turn replays its opening question」 |
| 去掉起始 user 消息锚定 | 2 条：「the split turn's opening question is anchored into the replay」「the single turn replays its opening question」 |
| 去掉两个守卫（无条件吸附） | 19 条级联 |

实测入口：`node tests/handoff-test.mjs` 基线 189 OK / 0 FAIL，`node tests/run-all.mjs` 15/15 绿。

## 5. 非目标与残留

- 不引入「把整轮无脑塞进重放」：预算仍守（否则会挤掉摘要，重复旧的卡死路径）。
- 不改 `MIN_SUMMARIZE_TOKENS` / keep 预算语义。
- 索引的粒度（工具名 vs 参数摘要）暂定「工具名 + 首行」，实现时以测试固定。

## 6. 开放问题（实现前收敛）

1. `**Turn Context (split turn):**` 段用**同一次模型调用**（把 turn prefix 作为标注块塞进 prompt）还是
   **第二次调用**（严格对齐 pi）？倾向同一次调用：省一次往返，且本扩展的摘要提示词是自有的九节结构。
2. 锚定的 user 消息若自身超长（远超 keep 预算）是否允许裁切？倾向**不裁切**（它是"最后一轮"的语义核心），
   并把超长风险记入残留。

## 7. 本片未实现（留待后续，需要 owner 再点头）

- **pi 式的 turn-prefix 第二段摘要**：pi 在 split turn 时用 `TURN_PREFIX_SUMMARIZATION_PROMPT`
  （`## Original Request` / `## Progress So Far` / `## Context Needed to Continue`）单独摘要 turn prefix，
  再拼成 `**Turn Context (split turn):**` 段。本扩展只调 pi 的 `generateSummaryWithUsage`（单段九节格式），
  没有走 `compact()`，所以没有这一段。本片的替代是 **A（起始 user 消息原文锚定进重放）+ 裁切**。
- 若后续要做，改动面是 `summary.ts` 增加一次调用或一个标注块 + `run.ts` 传 `turnPrefixMessages`，
  断言落在「摘要含该段但其内容只有索引级信息」。
- 结论：**「最后一轮的问题」已经以原文到达 successor（本片已达成）**；「那一轮做过什么」仍是普通摘要散文，
  没有独立小节。