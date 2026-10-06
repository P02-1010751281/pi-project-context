---
doc_type: fix-note
issue: consolidation-keeps-entries
status: implemented
date: 2026-10-06
implemented_in: ed51eac（第一版，主规则层）＋ 本轮（对准段预算并改重试句）；随 v0.4.4 发布
relates_to: .agents/skills/pi-project-context-consolidation-prompt-rule/SKILL.md
---

# 合并通道按段预算压缩，而不是丢条目

> **根因更正（第 1 轮独立评审后）**：本说明初版把 F2/F5 的丢失归因为「模型在改写时删条目」，那是**错的**。
> 逐项实测与评审复现都指向同一件事：**模型保留条目的**，条目被删在**渲染器的段预算裁切**里
> （`extensions/project-context/memory/sections.ts::renderMemoryDocument`：某段超出它的配额时，
> 放不下的条目**整条丢弃**）。初版结论已作废，下面的 §1 是更正后的诊断。

## 1. 现场证据与根因

- **F1** `.agents/memory/errors.log` `2026-10-06T04:30:56.155Z [memory] memory regression: 3 Invariants/Pitfalls
  entry(ies) are no longer present, e.g. Release evidence for a behavior-changing version must state that …`
- **F2** 该时刻那次渲染相对已提交版本**净少 11 条**（5 Invariants / 3 Pitfalls / 3 Index；另有 1 条 Pitfall 是
  「/tmp 沙箱 100-130 MB → 180 MB」的**数值改写**，不是丢失），文档 30,202 → 29,920 字符。
- **F3** 更早的同类行：`2026-10-05T14:09:16.272Z`（14 条）与 `2026-10-05T16:46:30.185Z`
  （`memory exceeded a section budget: 3 section(s) exceeded their budget and 20 whole entry(ies) were dropped`）。
  最后这条**直接点名机制**：段预算 + 整条丢弃。
- **F4** 授权层原文有两处，方向一致地偏向「删」：主提示的
  `When over budget, merge duplicates within a section, deduplicate across sections, then drop the least durable
  entries.`，以及**重试句**的 `… merge duplicates, and remove the least durable entries.`
- **F5** 把 F2 丢掉的条目补回并提交后，下一轮渲染（`04:38:57.357Z`）**再丢 10 条、0 新增**，31,774 → 29,915。
- **F6** 守卫只报 3 条而非 11 条：守卫在**裁切前**的 sections 上运行（`pass.ts` 的 `removedSectionEntries`），
  而写盘的是**裁切后**的文本，所以它的条数是下界而非上界；不能用它当损失的度量。

**根因（逐项实测）**：

| 版本 | Project | Invariants | Pitfalls | Index | 段超配额 |
| --- | --- | --- | --- | --- | --- |
| 已提交的「补回版」（31,774 字符） | 4,534 / 6,384 | **13,621 / 12,769（+852）** | **8,220 / 7,981（+239）** | **5,332 / 4,788（+544）** | 3 段 |
| 现场渲染（29,915 字符） | 4,593 / 6,384 | 12,703 / 12,769 | 7,803 / 7,981 | 4,749 / 4,788 | 0 段 |

配额为 `maxMemoryChars × share`（0.2 / 0.4 / 0.25 / 0.15）。把 **已提交版**经 `renderMemoryDocument` 渲染：
`sectionDropped=3`、`droppedItems=9`：这 9 条确定性丢弃**全部落在**现场文件缺的那一批内，另有 4 对是原地改写（同一事实换措辞，非丢失）；第 10 条差额是 `tests/harness.mjs`，它与段配额机制相容（把现场 sections 加上该条再渲染，**逐字节**复现现场文件），但单凭现场文件无法排除「模型回复本身漏了它」。
即：**丢条目发生在写盘渲染，不在模型的回复**；而**我手工补回的那一版本身就超配额**，所以每轮都被裁回同一个形状
（F5 是这条回路的第二次实例，不是新故障）。

设计上本就有对策：`pass.ts` 在 `render.sectionDropped > 0` 时**重试一次**做冷凝，且只在重试结果的
`sectionDropped === 0` 时才采纳。它失败的原因正是 F4 的第二处：重试句让模型「remove the least durable entries」
——**让它删，而不是让它压缩**；在段配额已满的现状下，两条路都通向丢条。

## 2. 修复（两侧一起改，方向一致）

1. **主提示规则句**（`memory/prompt.ts`，替换 F4 的第一处）：

   > Keep every entry that is still true: merge duplicates within a section, deduplicate across sections, then
   > condense the wording until each section fits its budget above. Delete an entry only when it is superseded or
   > already covered elsewhere — never to make room for a new one.

   与 owner 选择的「压缩合并而非删除，只删可证过期者」一致；同时把「必须压到**每段**配额以内」写成显式要求，
   因为段配额才是裁切的触发条件。
2. **内容进入点注记**（`<existing-memory>` 标签前一行、独占一行）：说明该块仍为真的条目必须复现，某段放不下时
   用**压缩措辞**解决，而不是丢条目。
3. **重试句对齐**（`memory/pass.ts`）：删掉 `remove the least durable entries`，改为
   「直到每段都落在配额内：保住仍为真的条目 → 段内合并重复 → 跨段去重 → 压缩措辞」，并把失实的
   「exceeded the N-character cap, so its middle would be dropped」改成「overflowed a section budget, so whole
   entries would be dropped」。
4. **技能同步**（`.agents/skills/pi-project-context-memory-cap-budget-change/SKILL.md` item 5）：它原本把冷凝
   描述成「keep durable facts, merge duplicates, drop the least durable」，改为与上面同向，并注明采纳条件是
   `sectionDropped === 0`。

## 3. 钉子与变异矩阵（`tests/memory-budget-test.mjs`，单侧）

| 变异 | 红点 |
| --- | --- |
| M0 未变异 | 0 红（套件 15/15） |
| M1 删主规则句 | 3 红：`makes compression the default over deletion` / `still allows deleting what is superseded` / `ties the drop rule to each section's budget` |
| M2 删注记 | **1 红**：`the keeping caption sits on its own line at the memory block it protects` |
| M3 旧主措辞放回 | 4 红：上述 3 条 ＋ 负向钉 `no longer offers dropping entries as the over-budget step` |
| M4 重试句回退成 `remove the least durable` | 4 红：新增钉 `the condensation retry asks for compression, not for deleting the least durable`（其余 3 条是同一次调用里哨兵串联动，已注明） |

注记断言按**独占整行**钉（行首必须换行、行尾必须紧跟空行与 `<existing-memory>`），第一版只钉短语前缀时是假阴性。

## 4. 成本

主提示 **+376 字符**（v0.4.3 的 4,145 → 4,521，约 94 tokens），每次合并调用一次；重试句仅在段超配额时才追加
（+约 150 字符），不进入常规路径。

## 5. 验收：它到底能证明什么

- 提示内容断言只证明**这些话在提示里**，不证明模型照做；不得据此宣布损失已消除。本 issue 的现场损失是
  **渲染器裁切**，所以真正的验收在渲染面：
  1. 之后若干次渲染里，`errors.log` **不再出现** `memory exceeded a section budget: …`（这是渲染器丢弃的日志，
     `report.ts:215`）——**不能**用 `memory regression:` 行当验收（F6：它跑在裁切之前）；且
  2. 渲染后的条目数不低于上一版，除了「已被取代/别处已覆盖」的删除。
- **实测结论（2026-10-06，沙箱 + 真实 flash 辅助调用，四次 pass）：本修复不足，验收未通过。** 固定段配额与
  本仓内容分布不符时，模型压不进配额、重试从未达标（四次 `adopt=false`，每轮真实丢失 10–15 条），
  而总文档其实没贴上限（31,774 < 32,000，Project 空余 1,850 足以吸收三段合计 1,635 的超额）。
  完整复现命令、四次跑次的数字与三个可选修复都记在
  `acceptance-2026-10-06-v0.4.4-not-met.md`——**下一步是策略决策，不是再改提示**。

## 6. 非目标与遗留

- **不**把渲染改成「合并而非整篇重写」：那是新机制，需独立设计（技能 §非目标已记）。
- **不**加预发布门禁（需维护外来名单且会误伤合法数字）。
- **第二层（已定并实现，v0.4.5）**：owner 定「总的不超配额就行，四段的数字本来就是预估」，于是 share 降为
  **目标值**：渲染器先把用不完的段配额汇池，超额段按超出比例借用，只有文档到达上限时才丢条目。本仓这一版
  从丢 9 条变成 **0 丢弃**。实现、变异矩阵与端到端对比见 `fix-2026-10-06-shares-are-targets.md`。
  剩余项：记忆贴着上限（31,774 / 32,000），模型每轮新增会把回复推过上限，仍有 1–3 条既有事实的净损失——
  要么抬 `maxMemoryChars`，要么人工裁剪，记在 `.codestable/attention.md`。
- 手改 MEMORY.md 补条目时必须**同时**满足段配额，否则下一轮必被裁回（本次 F5 的教训）。
