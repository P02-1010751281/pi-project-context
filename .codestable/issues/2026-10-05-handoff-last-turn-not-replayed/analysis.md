---
doc_type: issue-analysis
issue: handoff-last-turn-not-replayed
date: 2026-10-05
status: open
reported_by: owner（现场摩擦：「handoff 的结构化数据缺少最后一轮对话（assistant 和 user），续不上上一个 session」）
---

# handoff 不重放「最后一轮对话」——现场证据与分析

## 1. 现场事实（本机可复现，2026-10-05）

- 六仓（本仓与 5 个消费仓）的 `handoffBudgetRecentTokens` 全是默认 **20000**，所以不是「recent 关掉只给摘要」那条路。
- 交接产物 `HANDOFF.md` **没有任何「最近对话」小节**（`grep -c '最近对话|Recent conversation|最近消息'` = 0）：
  它只承载九节结构化摘要；最近内容**只**靠把 session entry 重放进 successor。
- 实例：上一会话 `01a107b7` 的末尾 4 条是
  `assistant(工具调用) → toolResult → assistant(工具调用) → toolResult`（**没有收束的 assistant 文本**，会话停在工具结果上）。
  该会话被交接后，后续会话 `01a107d0` 的 JSONL 头两条消息是
  **`[turn prefix summarized during handoff]`（= `SPLIT_TURN_MARKER`）→ assistant → toolResult**，
  且头 8 条里**找不到上一会话末轮的任何原文**（命中 0）。
- 即：successor 拿到的是**一个悬空的工具交换**（工具结果没有对应的调用上下文，调用本身在摘要散文里），
  而 owner 说的「最后一轮（user + assistant）」没有以原文/结构化形式进入新会话。

## 2. 机制（代码路径）

1. `handoff/run.ts` 用**金额预算**切分：`findCutPoint(allEntries, 0, len, handoffBudgetRecentTokens)` → `firstKeptIndex`
   （`run.ts:106-112`）。
2. 切点允许落在**回合中间**（代码注释明确说这是有意的：pi 在会话边界切、不在 tool result 切；退到回合起点曾导致
   「一个回合就超过 keep 窗口时无老内容可摘要 → 交接被整个卡住」）。
3. `replayMessagesFor` 对「开头不是 user 角色」的切片补一个 `SPLIT_TURN_MARKER` 占位（`text.ts:21`），
   于是重放块可以**以 assistant 工具调用/工具结果开头**，而不是以最近一轮 user/assistant 对话开头。
4. 重放经 `newSession({ setup: sm => replayEntries(sm, keptSlice) })` 写入 successor（`run.ts:264-268`）；
   `replayEntries` 对 append 失败**静默吞掉**（`text.ts` 的 `catch {}`）。

## 3. 结论

- 「最后一轮对话」不是被某处删掉，而是**从未被单独保证过**：它要么落在被摘要的前缀里（只剩散文），
  要么落在重放切片里但**以半个回合的形式出现**（悬空工具结果 + 占位标记）。摘要文档本身按设计不含原文对话。
- 因此 owner 的直觉正确：**successor 续不上「上一轮说到哪」**，尤其当会话停在工具结果上（本轮实际发生的情形）。

## 4. 候选修法（待 owner 选定后再进设计）

| 方案 | 内容 | 代价 |
| --- | --- | --- |
| A 保证最后一轮完整重放 | 无论预算如何，**最近一个完整的 user→assistant 回合**必须整轮进入重放；切点只能落在此之后 | 需要新的「回合边界」工具函数；预算可能被最后一轮挤爆（但那一轮本来就是继续工作最需要的） |
| B 只在「整轮装得下」时吸附到回合起点 | 保留现在的金额切分，但若 `[回合起点, 切点]` 的 token 量 ≤ 预算则整轮保留，否则维持现状（不阻塞交接） | 小改；部分场景仍会半回合开头 |
| C 文档里加一节「最后一轮」 | `HANDOFF.md` 增加一个原文短节（最近一轮 user/assistant） | 与「文档只放摘要」的既有取向冲突，且会重复重放通道 |

推荐 **A + B 的组合**：先吸附回合边界（B，保持不阻塞），再把「最近一个完整回合」提升为**硬保留**（A）。

## 5. 待 owner 提供（若有差异）

- 该摩擦的具体仓/session（本分析用的是本机 `01a107b7 → 01a107d0` 这一对；若你遇到的是别的仓，请点名，复核后再定稿）。

## 6. 订正（2026-10-05，读 pi 源码后）

本文 §2 把切分说成「我们按预算选点、落在回合中间」，这不够准确：**切点是 pi 的 `findCutPoint` 选的**，
它**同时返回 `turnStartIndex` 与 `isSplitTurn`**，而本扩展只取 `firstKeptEntryIndex`、把这两个字段丢掉了
（`run.ts` 切分处；全仓 grep 零命中）。pi 自己的压缩在 split turn 时会**把 turn prefix 单独摘要**成
`**Turn Context (split turn):**` 段（`core/compaction/compaction.js`），本扩展把 turn prefix 混进历史一次性摘要。

因此「最后一轮丢失」的准确表述是：**我们没用 pi 已经算好的回合信息，也没有 pi 那样的 turn-context 段**，
于是该回合起始的 user 指令只以散文形式埋在历史里，重放块则以 assistant 工具调用/工具结果开头。

另：§4 的 B 方案**不能无条件做** —— 无条件吸附到回合起点正是历史上被回退的行为（整轮超出 keep 窗口时
老侧无内容可摘要、交接被卡死），必须加「吸附后老侧仍有 user/assistant」这一守卫。

owner 决议与实现方案见同目录 `handoff-last-turn-design.md`（A+B，允许裁切+索引）。
