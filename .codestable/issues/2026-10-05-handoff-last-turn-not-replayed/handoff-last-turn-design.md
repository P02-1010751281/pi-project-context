---
doc_type: design
issue: handoff-last-turn-not-replayed
date: 2026-10-05
status: draft
revision: 1
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
- **仅当** `allEntries.slice(0, snap)` 里仍存在 user/assistant 的上下文消息（即有东西可摘要）时采用 `snap`；
- 否则退回 `cut.firstKeptEntryIndex`，保持现状（不阻塞交接）。
- 效果：整轮装得下时，最近一个回合（含起始 user 消息）**整轮原文重放**，占位标记不再出现。

### A —— 硬保最近一个完整回合的用户侧原文（装不下时的兜底）

当 B 无法吸附（该回合本身超过 keep 窗口）：

- 在该回合内向前找**该回合的起始 user 消息**（真实用户文本，非交接提示词），把它锚定进重放切片首部；
  于是重放块以真实 user 消息开头，`SPLIT_TURN_MARKER` 不再需要。
- 该回合末尾的 assistant 文本本来就在 `firstKeptEntryIndex` 之后的保留片里，因此
  「user 原文 + assistant 收束」两端都在，中间工具交换按下面的索引规则处理。
- 悬空 toolResult 仍由现有 `droppedOrphans` 机制折进摘要（语义不变）。

### 裁切 + 索引（owner 放行的那一条）

装不下的 turn prefix 中间体积允许裁切，但索引必须落地：

- 摘要侧：turn prefix 单独成段，标题 `**Turn Context (split turn):**`（对齐 pi），其中只放
  该回合起始 user 消息的原文 + 工具交换的**索引**（工具名、文件操作，复用 `collectFileOps`/`formatFileOperations`），
  不放全量工具输出。
- 索引沿用文档既有的 `<modified-files>` 块，不另造格式；turn prefix 段只补「本回合做了哪些动作」的一行式条目。

## 3. 变更面（文件级）

| 文件 | 改动 |
| --- | --- |
| `extensions/project-context/handoff/run.ts` | 读 `cut.isSplitTurn`/`cut.turnStartIndex`；有条件吸附（B）；锚定回起始 user 消息进重放切片（A）；把 turn prefix 与历史分开传给摘要 |
| `extensions/project-context/handoff/text.ts` | 回合内「起始 user 消息」定位工具函数；占位标记只在**找不到**真实 user 消息时兜底 |
| `extensions/project-context/handoff/summary.ts` | 可选 `turnPrefixMessages` 入参，产出 `**Turn Context (split turn):**` 段（复用同一次模型调用或第二次调用，二选一，见开放问题） |
| `extensions/project-context/handoff/prompt.ts` | 无结构变化（`summaryWithIndex` 直接承载新段） |
| `tests/handoff-test.mjs` | 新增断言（只加断言，不加测试文件） |
| `docs/architecture.md`、`CHANGELOG.md` | 行为变化（v0.4.x 条目） |

## 4. 断言与单侧变异计划

断言（新增）：

1. 整轮装得下 → 切点吸附到回合起点，重放块首条是**真实 user 文本**，且不含 `SPLIT_TURN_MARKER`。
2. 整轮装不下（单回合超预算）→ 重放块首条仍是**该回合起始 user 文本**（A），且**不返回 skipped**。
3. 吸附会使老侧为空（整个会话就是一轮）→ **不吸附**，交接照常进行（守住 B 的反阻塞条件）。
4. 摘要文本含 `**Turn Context (split turn):**` 且其内容只有索引/标题级信息，不含全量工具输出。
5. 现有 82 条 handoff 断言全绿（回归）。

单侧变异（每项只改一侧，验证"恰好变红"）：

| 变异 | 预期变红的断言 |
| --- | --- |
| 去掉 `isSplitTurn` 判定（回到只用 `firstKeptEntryIndex`） | 1（吸附不再发生） |
| 去掉吸附前的「老侧非空」守卫 | 3 |
| 去掉起始 user 消息锚定 | 2 |
| turn prefix 段改为灌入全量工具输出 | 4 |

## 5. 非目标与残留

- 不引入「把整轮无脑塞进重放」：预算仍守（否则会挤掉摘要，重复旧的卡死路径）。
- 不改 `MIN_SUMMARIZE_TOKENS` / keep 预算语义。
- 索引的粒度（工具名 vs 参数摘要）暂定「工具名 + 首行」，实现时以测试固定。

## 6. 开放问题（实现前收敛）

1. `**Turn Context (split turn):**` 段用**同一次模型调用**（把 turn prefix 作为标注块塞进 prompt）还是
   **第二次调用**（严格对齐 pi）？倾向同一次调用：省一次往返，且本扩展的摘要提示词是自有的九节结构。
2. 锚定的 user 消息若自身超长（远超 keep 预算）是否允许裁切？倾向**不裁切**（它是"最后一轮"的语义核心），
   并把超长风险记入残留。
